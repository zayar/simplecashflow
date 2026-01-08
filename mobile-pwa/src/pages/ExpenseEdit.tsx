import React, { useMemo, useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '../lib/auth';
import { getBankingAccounts, type BankingAccountRow } from '../lib/ar';
import { getExpense, getAccounts, getVendors, updateExpense, uploadExpenseAttachment } from '../lib/expenses';
import { yyyyMmDd, toNumber } from '../lib/format';
import { AppBar, BackIcon, IconButton } from '../components/AppBar';
import { Fab, SaveIcon } from '../components/Fab';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select } from '../components/ui/select';
import { Textarea } from '../components/ui/textarea';
import { Button } from '../components/ui/button';

function clampMoney(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export default function ExpenseEdit() {
  const { user } = useAuth();
  const companyId = user?.companyId ?? 0;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams();
  const expenseId = Number(params.id);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [attachmentPreview, setAttachmentPreview] = useState<string | null>(null);
  const [form, setForm] = useState(() => ({
    expenseDate: yyyyMmDd(new Date()),
    vendorId: '',
    categoryAccountId: '',
    amount: '',
    reference: '',
    notes: '',
    attachmentUrl: ''
  }));

  const expenseQuery = useQuery({
    queryKey: ['expense', companyId, expenseId],
    queryFn: async () => await getExpense(companyId, expenseId),
    enabled: companyId > 0 && Number.isFinite(expenseId) && expenseId > 0
  });

  const vendorsQuery = useQuery({
    queryKey: ['vendors', companyId],
    queryFn: async () => await getVendors(companyId),
    enabled: companyId > 0
  });

  const accountsQuery = useQuery({
    queryKey: ['accounts', companyId],
    queryFn: async () => await getAccounts(companyId),
    enabled: companyId > 0
  });

  // Populate form when expense loads
  useEffect(() => {
    if (expenseQuery.data) {
      const exp = expenseQuery.data;
      // Parse description to extract reference and notes
      const desc = exp.description ?? '';
      let ref = '';
      let notes = desc;
      if (desc.startsWith('Ref: ')) {
        const dashIndex = desc.indexOf(' - ');
        if (dashIndex > 0) {
          ref = desc.slice(5, dashIndex);
          notes = desc.slice(dashIndex + 3);
        } else {
          ref = desc.slice(5);
          notes = '';
        }
      }

      setForm({
        expenseDate: exp.expenseDate ? exp.expenseDate.slice(0, 10) : yyyyMmDd(new Date()),
        vendorId: exp.vendorId ? String(exp.vendorId) : '',
        categoryAccountId: '',
        amount: String(toNumber(exp.amount)),
        reference: ref,
        notes,
        attachmentUrl: exp.attachmentUrl ?? ''
      });

      if (exp.attachmentUrl) {
        setAttachmentPreview(exp.attachmentUrl);
      }
    }
  }, [expenseQuery.data]);

  const expenseCategories = useMemo(() => {
    const all = accountsQuery.data ?? [];
    return all
      .filter((a) => String(a.type).toUpperCase() === 'EXPENSE' && a.isActive !== false)
      .slice()
      .sort((a, b) => {
        const ac = String(a.code ?? '');
        const bc = String(b.code ?? '');
        if (ac && bc) return ac.localeCompare(bc);
        return String(a.name ?? '').localeCompare(String(b.name ?? ''));
      });
  }, [accountsQuery.data]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !companyId) return;

    // Show preview immediately
    const reader = new FileReader();
    reader.onload = (ev) => {
      setAttachmentPreview(ev.target?.result as string);
    };
    reader.readAsDataURL(file);

    setUploading(true);
    try {
      const { url } = await uploadExpenseAttachment(companyId, file);
      setForm((p) => ({ ...p, attachmentUrl: url }));
      setAttachmentPreview(url);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to upload attachment');
      setAttachmentPreview(form.attachmentUrl || null);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const removeAttachment = () => {
    setForm((p) => ({ ...p, attachmentUrl: '' }));
    setAttachmentPreview(null);
  };

  const updateMutation = useMutation({
    mutationFn: async () => {
      setError(null);
      if (!companyId) throw new Error('Missing companyId');
      if (!expenseId) throw new Error('Missing expenseId');
      if (!form.expenseDate) throw new Error('Please select date');

      const amount = clampMoney(toNumber(form.amount));
      if (!amount || amount <= 0) throw new Error('Amount must be > 0');

      // Build description
      const ref = String(form.reference ?? '').trim();
      const notes = String(form.notes ?? '').trim();
      let description = notes;
      if (ref) description = description ? `Ref: ${ref} - ${description}` : `Ref: ${ref}`;
      if (!description) description = 'Expense';

      await updateExpense(companyId, expenseId, {
        vendorId: form.vendorId ? Number(form.vendorId) : null,
        expenseDate: form.expenseDate,
        description,
        amount,
        expenseAccountId: form.categoryAccountId ? Number(form.categoryAccountId) : undefined,
        attachmentUrl: form.attachmentUrl || null
      });

      return { id: expenseId };
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['expenses', companyId] });
      await queryClient.invalidateQueries({ queryKey: ['expense', companyId, expenseId] });
      navigate('/expenses', { replace: true });
    },
    onError: (err: any) => {
      setError(err?.message ?? 'Failed to update expense');
    }
  });

  const canEdit = expenseQuery.data?.status === 'DRAFT';

  return (
    <div className="min-h-dvh bg-background pb-24">
      <AppBar
        title="Edit Expense"
        left={
          <IconButton ariaLabel="Back" onClick={() => navigate(-1)}>
            <BackIcon />
          </IconButton>
        }
        right={<div className="h-10 w-10" />}
      />

      <div className="mx-auto max-w-xl px-3 pt-3">
        {expenseQuery.isLoading ? (
          <Card className="rounded-2xl p-4 shadow-sm">
            <div className="text-sm text-muted-foreground">Loading…</div>
          </Card>
        ) : expenseQuery.isError ? (
          <Card className="rounded-2xl p-4 shadow-sm">
            <div className="text-sm text-destructive">Failed to load expense.</div>
          </Card>
        ) : !canEdit ? (
          <Card className="rounded-2xl p-4 shadow-sm">
            <div className="text-sm text-muted-foreground">
              This expense has been posted and cannot be edited.
            </div>
          </Card>
        ) : (
          <>
            <Card className="rounded-2xl shadow-sm">
              <div className="px-4 py-3">
                <div className="text-3xl font-extrabold tracking-tight">Edit</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  #{expenseQuery.data?.expenseNumber}
                </div>
              </div>
            </Card>

            {error ? (
              <Card className="mt-3 rounded-2xl border-destructive/40 bg-destructive/5 shadow-sm">
                <div className="px-4 py-3 text-sm text-destructive">{error}</div>
              </Card>
            ) : null}

            <Card className="mt-3 rounded-2xl shadow-sm">
              <div className="space-y-4 p-4">
                <div className="grid gap-2">
                  <Label htmlFor="expense-date">Date*</Label>
                  <Input
                    id="expense-date"
                    type="date"
                    value={form.expenseDate}
                    onChange={(e) => setForm((p) => ({ ...p, expenseDate: e.target.value }))}
                    required
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="expense-vendor">Vendor</Label>
                  <Select
                    id="expense-vendor"
                    value={form.vendorId}
                    onChange={(e) => setForm((p) => ({ ...p, vendorId: e.target.value }))}
                  >
                    <option value="">Select vendor</option>
                    {(vendorsQuery.data ?? []).map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </Select>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="expense-category">Category</Label>
                  <Select
                    id="expense-category"
                    value={form.categoryAccountId}
                    onChange={(e) => setForm((p) => ({ ...p, categoryAccountId: e.target.value }))}
                  >
                    <option value="">(Keep existing)</option>
                    {expenseCategories.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} - {a.name}
                      </option>
                    ))}
                  </Select>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="expense-amount">Amount*</Label>
                  <div className="flex gap-2">
                    <Input value="MMK" disabled className="w-[92px]" aria-label="Currency" />
                    <Input
                      id="expense-amount"
                      type="number"
                      inputMode="numeric"
                      step="1"
                      min="1"
                      value={form.amount}
                      onChange={(e) => setForm((p) => ({ ...p, amount: e.target.value }))}
                      placeholder="0"
                      required
                    />
                  </div>
                </div>
              </div>
            </Card>

            {/* Attachment Section */}
            <Card className="mt-3 rounded-2xl shadow-sm">
              <div className="space-y-4 p-4">
                <div className="grid gap-2">
                  <Label>Receipt / Attachment</Label>
                  
                  {attachmentPreview ? (
                    <div className="relative">
                      <img
                        src={attachmentPreview}
                        alt="Attachment"
                        className="h-48 w-full rounded-xl border border-border object-cover"
                      />
                      <button
                        type="button"
                        onClick={removeAttachment}
                        className="absolute right-2 top-2 rounded-full bg-destructive p-2 text-white shadow-lg"
                        aria-label="Remove attachment"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                      {uploading && (
                        <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/40">
                          <svg className="h-8 w-8 animate-spin text-white" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        onChange={handleFileSelect}
                        className="hidden"
                        id="expense-attachment"
                      />
                      <label
                        htmlFor="expense-attachment"
                        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border p-8 transition-colors hover:border-primary hover:bg-primary/5 ${
                          uploading ? 'pointer-events-none opacity-50' : ''
                        }`}
                      >
                        {uploading ? (
                          <svg className="h-8 w-8 animate-spin text-primary" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                        ) : (
                          <>
                            <svg className="h-8 w-8 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
                              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zM18.75 10.5h.008v.008h-.008V10.5z" />
                            </svg>
                            <span className="text-sm text-muted-foreground">Tap to add receipt photo</span>
                          </>
                        )}
                      </label>
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    Attach a photo of the receipt or invoice.
                  </div>
                </div>
              </div>
            </Card>

            <Card className="mt-3 rounded-2xl shadow-sm">
              <div className="space-y-4 p-4">
                <div className="grid gap-2">
                  <Label htmlFor="expense-ref">Reference#</Label>
                  <Input
                    id="expense-ref"
                    value={form.reference}
                    onChange={(e) => setForm((p) => ({ ...p, reference: e.target.value }))}
                    placeholder="e.g. INV-001"
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="expense-notes">Notes</Label>
                  <Textarea
                    id="expense-notes"
                    value={form.notes}
                    onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
                    placeholder="Max. 500 characters"
                    className="min-h-[120px]"
                  />
                </div>
              </div>
            </Card>
          </>
        )}
      </div>

      {canEdit && (
        <Fab
          ariaLabel="Save expense"
          icon={<SaveIcon />}
          label={updateMutation.isPending ? 'Saving…' : 'Save'}
          disabled={updateMutation.isPending || companyId <= 0 || uploading}
          onClick={() => updateMutation.mutate()}
        />
      )}
    </div>
  );
}

