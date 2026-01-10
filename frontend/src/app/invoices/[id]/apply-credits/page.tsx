'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { useAuth } from '@/contexts/auth-context';
import {
  applyCreditNoteToInvoice,
  applyCustomerAdvanceToInvoice,
  fetchApi,
  getCustomerAdvances,
  getCustomerCreditNotes,
  CreditNoteListRow,
  CustomerAdvanceListRow,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectNative } from '@/components/ui/select-native';
import { todayInTimeZone } from '@/lib/utils';

export default function ApplyCreditsToInvoicePage() {
  const { user, companySettings } = useAuth();
  const params = useParams<{ id: string }>();
  const invoiceId = Number(params?.id);
  const tz = companySettings?.timeZone ?? 'Asia/Yangon';

  const [invoice, setInvoice] = useState<any | null>(null);
  const [credits, setCredits] = useState<CustomerAdvanceListRow[]>([]);
  const [creditNotes, setCreditNotes] = useState<CreditNoteListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [form, setForm] = useState({ customerAdvanceId: '', amount: '', appliedDate: '' });
  const [cnId, setCnId] = useState('');
  const [cnAmount, setCnAmount] = useState('');

  useEffect(() => {
    if (!user?.companyId || !invoiceId || Number.isNaN(invoiceId)) return;
    setLoading(true);
    fetchApi(`/companies/${user.companyId}/invoices/${invoiceId}`)
      .then((inv) => {
        setInvoice(inv);
        const customerId = Number(inv?.customer?.id ?? 0);
        if (customerId) {
          return Promise.all([
            getCustomerAdvances(user.companyId, customerId, true).then(setCredits),
            getCustomerCreditNotes(user.companyId, customerId, true).then(setCreditNotes),
          ]).then(() => {});
        }
        setCredits([]);
        setCreditNotes([]);
      })
      .finally(() => setLoading(false));
  }, [user?.companyId, invoiceId]);

  useEffect(() => {
    if (!form.appliedDate) setForm((p) => ({ ...p, appliedDate: todayInTimeZone(tz) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tz]);

  const remainingInvoice = useMemo(() => Number(invoice?.remainingBalance ?? 0), [invoice]);
  const eligibleCreditNotes = useMemo(() => (creditNotes ?? []).filter((c) => Number((c as any).remaining ?? 0) > 0), [creditNotes]);
  const selectedCn = useMemo(
    () => eligibleCreditNotes.find((c) => String(c.id) === String(cnId)) ?? null,
    [eligibleCreditNotes, cnId]
  );

  const suggestedCnMax = useMemo(() => {
    const cnRemaining = Number((selectedCn as any)?.remaining ?? 0);
    return Math.max(0, Math.min(cnRemaining, remainingInvoice));
  }, [selectedCn, remainingInvoice]);

  useEffect(() => {
    // Prefill suggested amount when selecting a credit note
    if (!selectedCn) return;
    if (!cnAmount || Number(cnAmount) <= 0) {
      if (suggestedCnMax > 0) setCnAmount(String(suggestedCnMax));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCn?.id, suggestedCnMax]);
  const eligibleCredits = useMemo(() => (credits ?? []).filter((c) => Number(c.remaining) > 0), [credits]);
  const selected = useMemo(
    () => eligibleCredits.find((c) => String(c.id) === String(form.customerAdvanceId)) ?? null,
    [eligibleCredits, form.customerAdvanceId]
  );

  const suggestedMax = useMemo(() => {
    const creditRemaining = Number(selected?.remaining ?? 0);
    return Math.max(0, Math.min(creditRemaining, remainingInvoice));
  }, [selected, remainingInvoice]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!user?.companyId) return;
    if (!form.customerAdvanceId) return alert('Select a customer advance');
    const amt = Number(form.amount);
    if (!amt || amt <= 0) return alert('Enter amount > 0');

    setSubmitting(true);
    try {
      await applyCustomerAdvanceToInvoice(user.companyId, invoiceId, {
        customerAdvanceId: Number(form.customerAdvanceId),
        amount: amt,
        appliedDate: form.appliedDate || undefined,
      });
      if (typeof window !== 'undefined') window.location.assign(`/invoices/${invoiceId}`);
    } catch (err: any) {
      alert(err?.message ?? 'Failed to apply credit');
    } finally {
      setSubmitting(false);
    }
  }

  async function applyCreditNote(e: React.FormEvent) {
    e.preventDefault();
    if (!user?.companyId) return;
    if (!cnId) return alert('Select a credit note');
    const amt = Number(cnAmount);
    if (!amt || amt <= 0) return alert('Enter amount > 0');
    setSubmitting(true);
    try {
      await applyCreditNoteToInvoice(user.companyId, invoiceId, Number(cnId), {
        amount: amt,
        appliedDate: form.appliedDate || undefined,
      });
      if (typeof window !== 'undefined') window.location.assign(`/invoices/${invoiceId}`);
    } catch (err: any) {
      alert(err?.message ?? 'Failed to apply credit note');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href={`/invoices/${invoiceId}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Apply Credits</h1>
          <p className="text-sm text-muted-foreground">Apply customer credits (credit notes) or customer advances to this invoice.</p>
        </div>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Invoice</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <div className="flex items-center justify-between">
            <div className="text-muted-foreground">Invoice</div>
            <div className="font-medium">{invoice?.invoiceNumber ?? (loading ? 'Loading…' : '—')}</div>
          </div>
          <div className="mt-2 flex items-center justify-between">
            <div className="text-muted-foreground">Balance due</div>
            <div className="font-semibold tabular-nums">{remainingInvoice.toLocaleString()}</div>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Apply</CardTitle>
        </CardHeader>
        <CardContent>
          {creditNotes.length > 0 ? (
            <div className="mb-6 rounded-lg border bg-muted/10 p-4">
              <div className="mb-2 text-sm font-medium">Apply Credit Note (Return)</div>
              <form onSubmit={applyCreditNote} className="grid gap-3 md:grid-cols-4 md:items-end">
                <div className="grid gap-2 md:flex-1">
                  <Label>Credit Note</Label>
                  <SelectNative value={cnId} onChange={(e) => setCnId(e.target.value)}>
                    <option value="">Select a credit note…</option>
                    {eligibleCreditNotes.map((cn) => (
                      <option key={cn.id} value={String(cn.id)}>
                        {cn.creditNoteNumber} — remaining {Number((cn as any).remaining ?? 0).toLocaleString()}
                      </option>
                    ))}
                  </SelectNative>
                  <div className="text-xs text-muted-foreground">
                    Only POSTED credit notes with remaining balance are shown.
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label>Apply Date</Label>
                  <Input
                    type="date"
                    value={form.appliedDate}
                    onChange={(e) => setForm((p) => ({ ...p, appliedDate: e.target.value }))}
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Amount</Label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    value={cnAmount}
                    onChange={(e) => setCnAmount(e.target.value)}
                    placeholder={suggestedCnMax ? `Max ${suggestedCnMax.toLocaleString()}` : '0'}
                    disabled={!cnId}
                  />
                  {selectedCn ? (
                    <div className="text-xs text-muted-foreground">
                      Credit remaining: <b>{Number((selectedCn as any).remaining ?? 0).toLocaleString()}</b>
                    </div>
                  ) : null}
                </div>
                <div className="flex justify-end">
                  <Button type="submit" loading={submitting} loadingText="Applying..." disabled={remainingInvoice <= 0 || !cnId}>
                    Apply
                  </Button>
                </div>
              </form>
            </div>
          ) : null}

          <form onSubmit={submit} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="grid gap-2 md:col-span-2">
                <Label>Customer Advance</Label>
                <SelectNative
                  value={form.customerAdvanceId}
                  onChange={(e) => setForm((p) => ({ ...p, customerAdvanceId: e.target.value }))}
                >
                  <option value="">Select an advance…</option>
                  {eligibleCredits.map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      #{c.id} — remaining {Number(c.remaining).toLocaleString()}
                    </option>
                  ))}
                </SelectNative>
                <div className="text-xs text-muted-foreground">Only advances with remaining balance are shown.</div>
              </div>
              <div className="grid gap-2">
                <Label>Apply Date</Label>
                <Input type="date" value={form.appliedDate} onChange={(e) => setForm((p) => ({ ...p, appliedDate: e.target.value }))} />
              </div>
            </div>

            <div className="grid gap-2 md:max-w-sm">
              <Label>Amount</Label>
              <Input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={form.amount}
                onChange={(e) => setForm((p) => ({ ...p, amount: e.target.value }))}
                placeholder={suggestedMax ? `Max ${suggestedMax.toLocaleString()}` : '0'}
              />
              {selected ? (
                <div className="text-xs text-muted-foreground">
                  Selected credit remaining: <b>{Number(selected.remaining).toLocaleString()}</b>
                </div>
              ) : null}
            </div>

            <div className="flex justify-end gap-2">
              <Link href={`/invoices/${invoiceId}`}>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </Link>
              <Button type="submit" loading={submitting} loadingText="Applying..." disabled={remainingInvoice <= 0}>
                Apply Credit
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}


