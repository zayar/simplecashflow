'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { useAuth } from '@/contexts/auth-context';
import { applyVendorCreditToBill, fetchApi, getVendorCredits, VendorCreditListRow } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectNative } from '@/components/ui/select-native';
import { todayInTimeZone } from '@/lib/utils';

export default function ApplyCreditsToBillPage() {
  const { user, companySettings } = useAuth();
  const params = useParams<{ id: string }>();
  const purchaseBillId = Number(params?.id);
  const tz = companySettings?.timeZone ?? 'Asia/Yangon';

  const [bill, setBill] = useState<any | null>(null);
  const [credits, setCredits] = useState<VendorCreditListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [form, setForm] = useState({ vendorCreditId: '', amount: '', appliedDate: '' });

  useEffect(() => {
    if (!user?.companyId || !purchaseBillId || Number.isNaN(purchaseBillId)) return;
    setLoading(true);
    fetchApi(`/companies/${user.companyId}/purchase-bills/${purchaseBillId}`)
      .then(async (b) => {
        setBill(b);
        const vendorId = Number(b?.vendor?.id ?? 0) || null;
        if (!vendorId) {
          setCredits([]);
          return;
        }
        const cs = await getVendorCredits(user.companyId!, { vendorId, eligibleOnly: true });
        setCredits(cs);
      })
      .finally(() => setLoading(false));
  }, [user?.companyId, purchaseBillId]);

  useEffect(() => {
    if (!form.appliedDate) setForm((p) => ({ ...p, appliedDate: todayInTimeZone(tz) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tz]);

  const remainingBill = useMemo(() => Number(bill?.remainingBalance ?? 0), [bill]);
  const eligibleCredits = useMemo(() => (credits ?? []).filter((c) => c.status === 'POSTED' && Number(c.remaining) > 0), [credits]);
  const selected = useMemo(() => eligibleCredits.find((c) => String(c.id) === String(form.vendorCreditId)) ?? null, [eligibleCredits, form.vendorCreditId]);

  const suggestedMax = useMemo(() => {
    const creditRemaining = Number(selected?.remaining ?? 0);
    return Math.max(0, Math.min(creditRemaining, remainingBill));
  }, [selected, remainingBill]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!user?.companyId) return;
    if (!form.vendorCreditId) return alert('Select a vendor credit');
    const amt = Number(form.amount);
    if (!amt || amt <= 0) return alert('Enter amount > 0');

    setSubmitting(true);
    try {
      await applyVendorCreditToBill(user.companyId, purchaseBillId, {
        vendorCreditId: Number(form.vendorCreditId),
        amount: amt,
        appliedDate: form.appliedDate || undefined,
      });
      if (typeof window !== 'undefined') window.location.assign(`/purchase-bills/${purchaseBillId}`);
    } catch (err: any) {
      alert(err?.message ?? 'Failed to apply credit');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href={`/purchase-bills/${purchaseBillId}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Apply Credits</h1>
          <p className="text-sm text-muted-foreground">Apply a vendor credit to this purchase bill.</p>
        </div>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Bill</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <div className="flex items-center justify-between">
            <div className="text-muted-foreground">Bill</div>
            <div className="font-medium">{bill?.billNumber ?? (loading ? 'Loading…' : '—')}</div>
          </div>
          <div className="mt-2 flex items-center justify-between">
            <div className="text-muted-foreground">Remaining</div>
            <div className="font-semibold tabular-nums">{remainingBill.toLocaleString()}</div>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Apply</CardTitle>
        </CardHeader>
        <CardContent>
          {!loading && eligibleCredits.length === 0 ? (
            <div className="space-y-2 text-sm">
              <div className="font-medium">No credits available</div>
              <div className="text-muted-foreground">
                This vendor has no posted credits with remaining balance.
              </div>
              <div className="pt-2">
                <Link href={`/purchase-bills/${purchaseBillId}`}>
                  <Button variant="outline">Back to bill</Button>
                </Link>
              </div>
            </div>
          ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="grid gap-2 md:col-span-2">
                <Label>Vendor Credit</Label>
                <SelectNative value={form.vendorCreditId} onChange={(e) => setForm((p) => ({ ...p, vendorCreditId: e.target.value }))}>
                  <option value="">Select a vendor credit…</option>
                  {eligibleCredits.map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {c.creditNumber} — remaining {Number(c.remaining).toLocaleString()}
                    </option>
                  ))}
                </SelectNative>
                <div className="text-xs text-muted-foreground">
                  Only posted credits with remaining balance are shown.
                </div>
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
              <Link href={`/purchase-bills/${purchaseBillId}`}>
                <Button type="button" variant="outline">Cancel</Button>
              </Link>
              <Button type="submit" loading={submitting} loadingText="Applying..." disabled={remainingBill <= 0}>
                Apply Credit
              </Button>
            </div>
          </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}


