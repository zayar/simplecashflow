'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { useAuth } from '@/contexts/auth-context';
import { applyCustomerAdvanceToInvoice, fetchApi, getCustomerAdvances, CustomerAdvanceListRow } from '@/lib/api';
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
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [form, setForm] = useState({ customerAdvanceId: '', amount: '', appliedDate: '' });

  useEffect(() => {
    if (!user?.companyId || !invoiceId || Number.isNaN(invoiceId)) return;
    setLoading(true);
    fetchApi(`/companies/${user.companyId}/invoices/${invoiceId}`)
      .then((inv) => {
        setInvoice(inv);
        const customerId = Number(inv?.customer?.id ?? 0);
        if (customerId) {
          return getCustomerAdvances(user.companyId, customerId, true).then(setCredits);
        }
        setCredits([]);
      })
      .finally(() => setLoading(false));
  }, [user?.companyId, invoiceId]);

  useEffect(() => {
    if (!form.appliedDate) setForm((p) => ({ ...p, appliedDate: todayInTimeZone(tz) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tz]);

  const remainingInvoice = useMemo(() => Number(invoice?.remainingBalance ?? 0), [invoice]);
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
          <p className="text-sm text-muted-foreground">Apply customer advance (deposit) to this invoice.</p>
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


