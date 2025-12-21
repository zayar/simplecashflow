'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi, getAccounts, getVendors, updateBill } from '@/lib/api';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, FileText, Calendar, Building2, BookOpen, DollarSign, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateInTimeZone } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectNative } from '@/components/ui/select-native';
import { Textarea } from '@/components/ui/textarea';

function formatMoney(n: any) {
  const num = Number(n ?? 0);
  if (Number.isNaN(num)) return String(n ?? '');
  return num.toLocaleString();
}

export default function ExpenseDetailPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const params = useParams();
  const billId = params.id;
  const tz = companySettings?.timeZone ?? 'Asia/Yangon';

  const [bill, setBill] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [vendors, setVendors] = useState<any[]>([]);
  const [expenseAccounts, setExpenseAccounts] = useState<any[]>([]);
  const [form, setForm] = useState({
    vendorId: '',
    expenseDate: '',
    dueDate: '',
    description: '',
    amount: '',
    currency: '',
    expenseAccountId: '',
  });

  const load = async () => {
    if (!user?.companyId || !billId) return;
    setLoading(true);
    try {
      const data = await fetchApi(`/companies/${user.companyId}/expenses/${billId}`);
      setBill(data);
      // keep form in sync when not actively editing
      if (!editMode) {
        setForm({
          vendorId: data?.vendor?.id ? String(data.vendor.id) : '',
          expenseDate: data?.expenseDate ? String(data.expenseDate).slice(0, 10) : '',
          dueDate: data?.dueDate ? String(data.dueDate).slice(0, 10) : '',
          description: data?.description ?? '',
          amount: data?.amount ? String(Number(data.amount)) : '',
          currency: data?.currency ?? '',
          expenseAccountId: data?.expenseAccount?.id ? String(data.expenseAccount.id) : '',
        });
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load().catch(console.error);
  }, [user?.companyId, billId]);

  useEffect(() => {
    if (!user?.companyId) return;
    getVendors(user.companyId).then(setVendors).catch(console.error);
    getAccounts(user.companyId)
      .then((all) => setExpenseAccounts(all.filter((a: any) => a.type === 'EXPENSE')))
      .catch(console.error);
  }, [user?.companyId]);

  const journals = useMemo(() => (bill?.journalEntries ?? []) as any[], [bill]);
  const showJournal = bill?.status && bill.status !== 'DRAFT';

  const baseCurrency = (companySettings?.baseCurrency ?? '').trim().toUpperCase();
  const effectiveCurrency = baseCurrency || (form.currency ?? '').trim().toUpperCase();
  const canEdit = bill?.status === 'DRAFT';

  const makeIdempotencyKey = () => {
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? (crypto as any).randomUUID()
      : `idem_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  };

  const startEdit = () => {
    if (!canEdit) return;
    setEditMode(true);
  };

  const cancelEdit = () => {
    setEditMode(false);
    // restore from current bill
    setForm({
      vendorId: bill?.vendor?.id ? String(bill.vendor.id) : '',
      expenseDate: bill?.expenseDate ? String(bill.expenseDate).slice(0, 10) : '',
      dueDate: bill?.dueDate ? String(bill.dueDate).slice(0, 10) : '',
      description: bill?.description ?? '',
      amount: bill?.amount ? String(Number(bill.amount)) : '',
      currency: bill?.currency ?? '',
      expenseAccountId: bill?.expenseAccount?.id ? String(bill.expenseAccount.id) : '',
    });
  };

  const saveEdit = async () => {
    if (!user?.companyId || !bill?.id) return;
    const amountNum = Number(form.amount);
    if (!amountNum || amountNum <= 0) {
      alert('Amount must be > 0');
      return;
    }
    if (!form.description || !form.description.trim()) {
      alert('Description is required');
      return;
    }
    if (!form.expenseAccountId) {
      alert('Please select an expense account');
      return;
    }
    if (baseCurrency) {
      // In single-currency mode currency is fixed.
      // Keep silent and let backend enforce, but ensure we send the correct one.
    } else if (form.currency && !/^[A-Za-z]{3}$/.test(form.currency.trim())) {
      alert('Currency must be a 3-letter code (e.g. MMK, USD)');
      return;
    }

    setSaving(true);
    try {
      await updateBill(user.companyId, Number(bill.id), {
        vendorId: form.vendorId ? Number(form.vendorId) : null,
        expenseDate: form.expenseDate || undefined,
        dueDate: form.dueDate ? form.dueDate : null,
        description: form.description,
        amount: amountNum,
        currency: baseCurrency ? baseCurrency : (form.currency ? form.currency.trim().toUpperCase() : null),
        expenseAccountId: form.expenseAccountId ? Number(form.expenseAccountId) : null,
      });
      setEditMode(false);
      await load();
    } catch (err: any) {
      console.error(err);
      alert(err.message || 'Failed to update expense');
    } finally {
      setSaving(false);
    }
  };

  const postExpense = async () => {
    if (!user?.companyId || !bill?.id) return;
    if (posting) return;
    if (!confirm('Post this expense? This will create journal entries and increase Accounts Payable.')) return;
    setPostError(null);
    setPosting(true);
    try {
      await fetchApi(`/companies/${user.companyId}/expenses/${bill.id}/post`, {
        method: 'POST',
        headers: { 'Idempotency-Key': makeIdempotencyKey() },
        body: JSON.stringify({}),
      });
      await load();
    } catch (err: any) {
      console.error(err);
      setPostError(err?.message ?? 'Failed to post expense');
    } finally {
      setPosting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/expenses">
            <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Expense</h1>
            <p className="text-sm text-muted-foreground">Loading…</p>
          </div>
        </div>
        <Card className="shadow-sm"><CardContent className="pt-6"><p className="text-center text-muted-foreground">Loading...</p></CardContent></Card>
      </div>
    );
  }

  if (!bill) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/expenses">
            <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Expense</h1>
            <p className="text-sm text-muted-foreground">Not found</p>
          </div>
        </div>
        <Card className="shadow-sm"><CardContent className="pt-6"><p className="text-center text-muted-foreground">Expense not found.</p></CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/expenses">
            <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
          </Link>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Expense</h1>
            <div className="text-sm text-muted-foreground">{bill.expenseNumber}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {bill.status === 'DRAFT' && !editMode && (
            <Button onClick={postExpense} disabled={posting}>
              {posting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {posting ? 'Posting...' : 'Post'}
            </Button>
          )}
          {bill.status === 'DRAFT' && !editMode && (
            <Button variant="outline" onClick={startEdit}>
              Edit
            </Button>
          )}
        {(bill.status === 'POSTED' || bill.status === 'PARTIAL') && (
          <Link href={`/expenses/${bill.id}/payment`}>
            <Button>Pay Expense</Button>
          </Link>
        )}
      </div>
      </div>

      {postError ? <div className="text-sm text-red-600">{postError}</div> : null}

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><FileText className="h-5 w-5" /> Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {editMode ? (
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label>Vendor</Label>
                  <SelectNative
                    value={form.vendorId}
                    onChange={(e) => setForm((p) => ({ ...p, vendorId: e.target.value }))}
                  >
                    <option value="">—</option>
                    {vendors.map((v: any) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </SelectNative>
                </div>

                <div className="grid gap-2">
                  <Label>Expense Date</Label>
                  <Input
                    type="date"
                    value={form.expenseDate}
                    onChange={(e) => setForm((p) => ({ ...p, expenseDate: e.target.value }))}
                  />
                </div>

                <div className="grid gap-2">
                  <Label>Due Date</Label>
                  <Input
                    type="date"
                    value={form.dueDate}
                    onChange={(e) => setForm((p) => ({ ...p, dueDate: e.target.value }))}
                  />
                </div>

                <div className="grid gap-2">
                  <Label>Expense Account</Label>
                  <SelectNative
                    value={form.expenseAccountId}
                    onChange={(e) => setForm((p) => ({ ...p, expenseAccountId: e.target.value }))}
                  >
                    <option value="">Select an account</option>
                    {expenseAccounts.map((a: any) => (
                      <option key={a.id} value={a.id}>
                        {a.code} - {a.name}
                      </option>
                    ))}
                  </SelectNative>
                </div>

                <div className="grid gap-2">
                  <Label>Description</Label>
                  <Textarea
                    value={form.description}
                    onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                    className="min-h-[90px]"
                  />
                </div>

                <div className="grid gap-2">
                  <Label>Amount</Label>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min="1"
                    step="1"
                    value={form.amount}
                    onChange={(e) => setForm((p) => ({ ...p, amount: e.target.value }))}
                  />
                </div>

                <div className="grid gap-2">
                  <Label>Currency</Label>
                  <Input
                    value={effectiveCurrency}
                    disabled={!!baseCurrency}
                    placeholder="MMK"
                    onChange={(e) => setForm((p) => ({ ...p, currency: e.target.value }))}
                  />
                  {baseCurrency && (
                    <p className="text-xs text-muted-foreground">
                      Currency is locked to company base currency ({baseCurrency}).
                    </p>
                  )}
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="outline" onClick={cancelEdit} disabled={saving}>
                    Cancel
                  </Button>
                  <Button onClick={saveEdit} disabled={saving}>
                    {saving ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              </div>
            ) : (
              <>
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Building2 className="h-4 w-4" /> Vendor</div>
            <div className="font-medium">{bill.vendor?.name ?? '—'}</div>

            <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Calendar className="h-4 w-4" /> Expense Date</div>
            <div>{formatDateInTimeZone(bill.expenseDate, tz)}</div>

            {bill.dueDate && (
              <>
                <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Calendar className="h-4 w-4" /> Due Date</div>
                <div>{formatDateInTimeZone(bill.dueDate, tz)}</div>
              </>
            )}

            <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">Expense Account</div>
            <div className="font-medium">{bill.expenseAccount ? `${bill.expenseAccount.code} - ${bill.expenseAccount.name}` : '—'}</div>

            <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">Description</div>
            <div className="font-medium">{bill.description}</div>

            <div className="mt-6 border-t pt-4 space-y-2">
              <div className="flex justify-between"><span className="text-muted-foreground">Total</span><span className="font-semibold">{formatMoney(bill.amount)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Paid</span><span className="font-semibold text-green-700">{formatMoney(bill.totalPaid)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Remaining</span><span className="font-semibold">{formatMoney(bill.remainingBalance)}</span></div>
            </div>

            <div className="pt-2">
              <Badge variant="outline">{bill.status}</Badge>
            </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <DollarSign className="h-5 w-5" /> Payments
              <Badge variant="secondary">{(bill.payments ?? []).length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {(bill.payments ?? []).length === 0 && (
              <div className="text-sm text-muted-foreground">No payments yet.</div>
            )}

            {(bill.payments ?? []).length > 0 && (
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[140px]">Date</TableHead>
                      <TableHead>Account</TableHead>
                      <TableHead className="text-right w-[180px]">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {bill.payments.map((p: any) => (
                      <TableRow key={p.id}>
                        <TableCell className="text-muted-foreground">{formatDateInTimeZone(p.paymentDate, tz)}</TableCell>
                        <TableCell className="font-medium">{p.bankAccount?.name ?? '—'}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{formatMoney(p.amount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><BookOpen className="h-5 w-5" /> Journal Entries</CardTitle>
        </CardHeader>
        <CardContent className="space-y-8">
          {!showJournal && (
            <div className="text-sm text-muted-foreground">This expense is <b>DRAFT</b>. No journal entry yet. Post the expense first.</div>
          )}

          {showJournal && journals.length === 0 && (
            <div className="text-sm text-muted-foreground">No journal entries found yet.</div>
          )}

          {showJournal && journals.map((je) => {
            const totalDebit = (je.lines ?? []).reduce((sum: number, l: any) => sum + Number(l.debit ?? 0), 0);
            const totalCredit = (je.lines ?? []).reduce((sum: number, l: any) => sum + Number(l.credit ?? 0), 0);

            const label = je.kind === 'BILL_POSTED' ? 'Expense Posted' : 'Expense Payment';

            return (
              <div key={`${je.kind}-${je.journalEntryId}`}>
                <div className="mb-2 flex items-baseline gap-2">
                  <h3 className="text-lg font-semibold text-slate-900">{label}</h3>
                  <span className="text-sm text-muted-foreground">JE #{je.journalEntryId} • {formatDateInTimeZone(je.date, tz)}</span>
                </div>
                <div className="rounded-md border bg-white">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="h-10 px-4 text-left font-medium">Account</th>
                        <th className="h-10 px-4 text-left font-medium">Branch</th>
                        <th className="h-10 px-4 text-right font-medium">Debit</th>
                        <th className="h-10 px-4 text-right font-medium">Credit</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {(je.lines ?? []).map((l: any, idx: number) => (
                        <tr key={idx} className="hover:bg-slate-50/50">
                          <td className="px-4 py-3">
                            <div className="font-medium text-slate-900">{l.account?.name ?? '—'}</div>
                            <div className="text-xs text-slate-500">{l.account?.code}</div>
                          </td>
                          <td className="px-4 py-3 text-slate-600">Head Office</td>
                          <td className="px-4 py-3 text-right font-mono">{formatMoney(l.debit)}</td>
                          <td className="px-4 py-3 text-right font-mono">{formatMoney(l.credit)}</td>
                        </tr>
                      ))}
                      <tr className="bg-slate-50/80 font-semibold">
                        <td className="px-4 py-3" colSpan={2}></td>
                        <td className="px-4 py-3 text-right font-mono">{formatMoney(totalDebit)}</td>
                        <td className="px-4 py-3 text-right font-mono">{formatMoney(totalCredit)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
