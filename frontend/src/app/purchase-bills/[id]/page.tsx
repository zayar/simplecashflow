'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { formatDateInTimeZone } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ArrowLeft } from 'lucide-react';

function statusBadge(status: string) {
  switch (status) {
    case 'PAID':
      return <Badge variant="secondary">Paid</Badge>;
    case 'POSTED':
      return <Badge variant="outline">Posted</Badge>;
    case 'PARTIAL':
      return <Badge variant="outline">Partial</Badge>;
    case 'DRAFT':
      return <Badge variant="outline">Draft</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function PurchaseBillDetailPage() {
  const { user, companySettings } = useAuth();
  const params = useParams<{ id: string }>();
  const id = Number(params?.id);
  const tz = companySettings?.timeZone ?? 'Asia/Yangon';

  const [bill, setBill] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  const makeIdempotencyKey = () => {
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? (crypto as any).randomUUID()
      : `idem_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  };

  async function load() {
    if (!user?.companyId || !id || Number.isNaN(id)) return;
    setLoading(true);
    try {
      const data = await fetchApi(`/companies/${user.companyId}/purchase-bills/${id}`);
      setBill(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.companyId, id]);

  const total = useMemo(() => Number(bill?.total ?? 0), [bill]);
  const totalPaid = useMemo(() => Number(bill?.totalPaid ?? 0), [bill]);
  const remaining = useMemo(() => Number(bill?.remainingBalance ?? 0), [bill]);

  const postBill = async () => {
    if (!user?.companyId) return;
    if (!confirm('Post this purchase bill? This will increase Inventory and Accounts Payable.')) return;
    try {
      await fetchApi(`/companies/${user.companyId}/purchase-bills/${id}/post`, {
        method: 'POST',
        headers: { 'Idempotency-Key': makeIdempotencyKey() },
        body: JSON.stringify({}),
      });
      await load();
    } catch (err: any) {
      alert(err.message || 'Failed to post purchase bill');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link href="/purchase-bills">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">
              {bill?.billNumber ?? (loading ? 'Loading...' : 'Purchase Bill')}
            </h1>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {bill?.status ? statusBadge(bill.status) : null}
              <span>•</span>
              <span>{bill?.warehouse?.name ?? '—'}</span>
              <span>•</span>
              <span>{bill?.vendor?.name ?? '—'}</span>
            </div>
          </div>
        </div>

        <div className="flex gap-2">
          {bill?.status === 'DRAFT' ? (
            <Button onClick={postBill}>Post</Button>
          ) : null}
          {(bill?.status === 'POSTED' || bill?.status === 'PARTIAL') && remaining > 0 ? (
            <Button asChild>
              <Link href={`/purchase-bills/${id}/payment`}>Record payment</Link>
            </Button>
          ) : null}
          {bill?.journalEntryId ? (
            <Button asChild variant="outline">
              <Link href={`/journal/${bill.journalEntryId}`}>View Journal Entry</Link>
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="shadow-sm md:col-span-2">
          <CardHeader>
            <CardTitle className="text-lg">Lines</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="w-[140px] text-right">Qty</TableHead>
                  <TableHead className="w-[180px] text-right">Unit Cost</TableHead>
                  <TableHead className="w-[160px] text-right">Line Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(bill?.lines ?? []).map((l: any) => (
                  <TableRow key={l.id}>
                    <TableCell className="font-medium">{l.item?.name ?? `Item #${l.itemId}`}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {l.account ? `${l.account.code} - ${l.account.name}` : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{Number(l.quantity ?? 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(l.unitCost ?? 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{Number(l.lineTotal ?? 0).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
                {(bill?.lines ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                      No lines.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Bill date</span>
              <span className="font-medium">{bill?.billDate ? String(bill.billDate).slice(0, 10) : '—'}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Due date</span>
              <span className="font-medium">{bill?.dueDate ? String(bill.dueDate).slice(0, 10) : '—'}</span>
            </div>
            <div className="flex justify-between gap-4 pt-2">
              <span className="text-muted-foreground">Total</span>
              <span className="font-semibold tabular-nums">{total.toLocaleString()}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Paid</span>
              <span className="font-medium text-green-700 tabular-nums">{totalPaid.toLocaleString()}</span>
            </div>
            <div className="flex justify-between gap-4 pt-2 border-t">
              <span className="font-semibold">Remaining</span>
              <span className={`font-semibold tabular-nums ${remaining > 0 ? 'text-orange-600' : 'text-green-600'}`}>
                {remaining.toLocaleString()}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Payments</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[160px]">Date</TableHead>
                <TableHead>Pay From</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="w-[160px]">Journal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(bill?.payments ?? []).map((p: any) => (
                <TableRow key={p.id}>
                  <TableCell className="text-muted-foreground">{formatDateInTimeZone(p.paymentDate, tz)}</TableCell>
                  <TableCell>{p.bankAccount ? `${p.bankAccount.code} - ${p.bankAccount.name}` : '—'}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{Number(p.amount ?? 0).toLocaleString()}</TableCell>
                  <TableCell>
                    {p.journalEntryId ? (
                      <Link className="text-sm text-blue-600 hover:underline" href={`/journal/${p.journalEntryId}`}>
                        View
                      </Link>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {(bill?.payments ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
                    No payments yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}


