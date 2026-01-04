import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '../lib/auth';
import { getBankingAccounts, type BankingAccountRow } from '../lib/ar';
import { createExpense, getAccounts, getVendors, postExpense } from '../lib/expenses';
import { yyyyMmDd, toNumber } from '../lib/format';
import { AppBar, BackIcon, IconButton } from '../components/AppBar';
import { Fab, SaveIcon } from '../components/Fab';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select } from '../components/ui/select';
import { Textarea } from '../components/ui/textarea';

function clampMoney(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export default function ExpenseNew() {
  const { user } = useAuth();
  const companyId = user?.companyId ?? 0;
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(() => ({
    expenseDate: yyyyMmDd(new Date()),
    vendorId: '',
    categoryAccountId: '',
    amount: '',
    reference: '',
    notes: '',
    paidThroughAccountId: ''
  }));

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

  const bankingQuery = useQuery({
    queryKey: ['banking-accounts', companyId],
    queryFn: async () => await getBankingAccounts(companyId),
    enabled: companyId > 0
  });

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

  const bankingAccounts = useMemo(() => {
    return (bankingQuery.data ?? []).slice().sort((a: BankingAccountRow, b: BankingAccountRow) => {
      const ak = String(a.kind);
      const bk = String(b.kind);
      if (ak !== bk) return ak.localeCompare(bk);
      return String(a.account?.name ?? '').localeCompare(String(b.account?.name ?? ''));
    });
  }, [bankingQuery.data]);

  const createMutation = useMutation({
    mutationFn: async () => {
      setError(null);
      if (!companyId) throw new Error('Missing companyId');
      if (!form.expenseDate) throw new Error('Please select date');

      const amount = clampMoney(toNumber(form.amount));
      if (!amount || amount <= 0) throw new Error('Amount must be > 0');
      if (!form.categoryAccountId) throw new Error('Please select a Category');

      // Build description similar to web app: reference is prepended to notes.
      const ref = String(form.reference ?? '').trim();
      const notes = String(form.notes ?? '').trim();
      let description = notes;
      if (ref) description = description ? `Ref: ${ref} - ${description}` : `Ref: ${ref}`;
      if (!description) description = 'Expense';

      const expense = await createExpense(companyId, {
        vendorId: form.vendorId ? Number(form.vendorId) : null,
        expenseDate: form.expenseDate,
        // Paid now => due date irrelevant, but keep simple (unset).
        description,
        amount,
        expenseAccountId: Number(form.categoryAccountId)
      });

      const id = expense && typeof expense === 'object' && 'id' in expense ? Number((expense as any).id) : 0;
      if (id > 0 && form.paidThroughAccountId) {
        await postExpense(companyId, id, { bankAccountId: Number(form.paidThroughAccountId) });
      }

      return { id };
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['expenses', companyId] });
      navigate('/expenses', { replace: true });
    },
    onError: (err: any) => {
      setError(err?.message ?? 'Failed to record expense');
    }
  });

  return (
    <div className="min-h-dvh bg-background pb-24">
      <AppBar
        title="Expense"
        left={
          <IconButton ariaLabel="Back" onClick={() => navigate(-1)}>
            <BackIcon />
          </IconButton>
        }
        right={<div className="h-10 w-10" />}
      />

      <div className="mx-auto max-w-xl px-3 pt-3">
        <Card className="rounded-2xl shadow-sm">
          <div className="px-4 py-3">
            <div className="text-3xl font-extrabold tracking-tight">New</div>
            <div className="mt-1 text-sm text-muted-foreground">Record a new expense. Select “Paid Through” to pay now.</div>
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
              <Label htmlFor="expense-category">Category*</Label>
              <Select
                id="expense-category"
                value={form.categoryAccountId}
                onChange={(e) => setForm((p) => ({ ...p, categoryAccountId: e.target.value }))}
                required
              >
                <option value="">Select a category</option>
                {expenseCategories.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} - {a.name}
                  </option>
                ))}
              </Select>
              <div className="text-xs text-muted-foreground">Categories are pulled from your Chart of Accounts (Expense type).</div>
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

            <div className="grid gap-2">
              <Label htmlFor="expense-paid-through" className="text-destructive">
                Paid Through (select to pay now)
              </Label>
              <Select
                id="expense-paid-through"
                value={form.paidThroughAccountId}
                onChange={(e) => setForm((p) => ({ ...p, paidThroughAccountId: e.target.value }))}
              >
                <option value="">(None — create Draft)</option>
                {bankingAccounts.map((b) => (
                  <option key={b.id} value={b.account?.id}>
                    {b.kind} - {b.account.name} ({b.account.code})
                  </option>
                ))}
              </Select>
              <div className="text-xs text-muted-foreground">
                If selected, this will post the expense and record payment immediately.
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
      </div>

      <Fab
        ariaLabel="Save expense"
        icon={<SaveIcon />}
        label={createMutation.isPending ? 'Saving…' : 'Save'}
        disabled={createMutation.isPending || companyId <= 0}
        onClick={() => createMutation.mutate()}
      />
    </div>
  );
}


