'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { useRouter, useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { ArrowLeft, DollarSign, Calendar, FileText } from 'lucide-react';
import Link from 'next/link';
import { SelectNative } from '@/components/ui/select-native';
import { todayInTimeZone } from '@/lib/utils';
import { formatDateInTimeZone } from '@/lib/utils';

export default function PayPurchaseBillPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const params = useParams();
  const billId = params.id;
  const tz = companySettings?.timeZone ?? 'Asia/Yangon';

  const [loading, setLoading] = useState(false);
  const [bill, setBill] = useState<any>(null);
  const [depositAccounts, setDepositAccounts] = useState<any[]>([]);

  const [form, setForm] = useState({
    paymentDate: '',
    amount: '',
    bankAccountId: '',
  });

  useEffect(() => {
    if (!user?.companyId || !billId) return;

    fetchApi(`/companies/${user.companyId}/purchase-bills/${billId}`)
      .then(setBill)
      .catch((err) => {
        console.error(err);
        alert('Failed to load purchase bill details');
        router.push('/purchase-bills');
      });

    fetchApi(`/companies/${user.companyId}/banking-accounts`)
      .then(setDepositAccounts)
      .catch(console.error);
  }, [user?.companyId, billId, router]);

  useEffect(() => {
    const tz = companySettings?.timeZone ?? 'Asia/Yangon';
    if (!form.paymentDate) {
      setForm((prev) => ({ ...prev, paymentDate: todayInTimeZone(tz) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companySettings?.timeZone]);

  useEffect(() => {
    if (bill && bill.remainingBalance > 0 && !form.amount) {
      setForm((prev) => ({ ...prev, amount: Number(bill.remainingBalance).toFixed(2) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bill]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.companyId || !bill) return;

    const amount = Number(form.amount);
    if (amount <= 0) {
      alert('Amount must be > 0');
      return;
    }

    if (amount > bill.remainingBalance) {
      alert(`Amount cannot exceed remaining balance of ${Number(bill.remainingBalance).toLocaleString()}`);
      return;
    }

    if (!form.bankAccountId) {
      alert('Please select Pay From account');
      return;
    }

    setLoading(true);
    try {
      await fetchApi(`/companies/${user.companyId}/purchase-bills/${billId}/payments`, {
        method: 'POST',
        body: JSON.stringify({
          paymentDate: form.paymentDate,
          amount,
          bankAccountId: Number(form.bankAccountId),
        }),
      });
      router.push(`/purchase-bills/${billId}`);
    } catch (err: any) {
      console.error(err);
      alert(err.message || 'Failed to pay purchase bill');
    } finally {
      setLoading(false);
    }
  };

  if (!bill) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/purchase-bills">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Pay purchase bill</h1>
            <p className="text-sm text-muted-foreground">Loading purchase bill details…</p>
          </div>
        </div>
        <Card className="shadow-sm">
          <CardContent className="pt-6">
            <p className="text-center text-muted-foreground">Loading purchase bill details...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const canPay = bill.status === 'POSTED' || bill.status === 'PARTIAL';
  const isFullyPaid = bill.remainingBalance <= 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href={`/purchase-bills/${billId}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Pay purchase bill</h1>
          <p className="text-sm text-muted-foreground">{bill.billNumber}</p>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" /> Purchase Bill Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="text-sm text-muted-foreground">Bill Number</div>
              <div className="font-semibold">{bill.billNumber}</div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground">Vendor</div>
              <div className="font-medium">{bill.vendor?.name ?? '—'}</div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground">Bill Date</div>
              <div>{formatDateInTimeZone(bill.billDate, tz)}</div>
            </div>
            <div className="pt-4 border-t space-y-2">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total:</span>
                <span className="font-bold">{Number(bill.total).toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Paid:</span>
                <span className="font-medium text-green-700">{Number(bill.totalPaid ?? 0).toLocaleString()}</span>
              </div>
              <div className="flex justify-between pt-2 border-t">
                <span className="font-semibold">Remaining:</span>
                <span className={`font-bold ${bill.remainingBalance > 0 ? 'text-orange-600' : 'text-green-600'}`}>
                  {Number(bill.remainingBalance).toLocaleString()}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <DollarSign className="h-5 w-5" /> Payment
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!canPay && (
              <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-md">
                <p className="text-sm text-yellow-800">
                  {bill.status === 'DRAFT' ? 'Post the purchase bill before paying.' : 'This purchase bill cannot be paid.'}
                </p>
              </div>
            )}

            {isFullyPaid && (
              <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-md">
                <p className="text-sm text-green-800 font-medium">✓ This purchase bill is fully paid.</p>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid gap-2">
                <Label className="flex items-center gap-2">
                  <Calendar className="h-4 w-4" /> Payment Date
                </Label>
                <Input type="date" value={form.paymentDate} onChange={(e) => setForm({ ...form, paymentDate: e.target.value })} />
              </div>

              <div className="grid gap-2">
                <Label>Amount</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max={bill.remainingBalance}
                  disabled={!canPay || isFullyPaid}
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                />
              </div>

              <div className="grid gap-2">
                <Label>Pay From*</Label>
                <SelectNative
                  required
                  disabled={!canPay || isFullyPaid}
                  value={form.bankAccountId}
                  onChange={(e) => setForm({ ...form, bankAccountId: e.target.value })}
                >
                  <option value="">Select account</option>
                  {depositAccounts.map((row: any) => (
                    <option key={`${row.id}-${row.account?.id ?? ''}`} value={row.account.id}>
                      {row.account.code} - {row.account.name}
                    </option>
                  ))}
                </SelectNative>
                <p className="text-xs text-muted-foreground">
                  Only accounts created under <b>Banking</b> can be used here.
                </p>
              </div>

              <div className="flex justify-end gap-3 pt-4">
                <Button type="button" variant="outline" onClick={() => router.back()} disabled={loading}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  loading={loading}
                  loadingText="Paying..."
                  disabled={!canPay || isFullyPaid || !form.bankAccountId}
                >
                  Pay Purchase Bill
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}


