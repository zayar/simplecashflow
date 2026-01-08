'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2 } from 'lucide-react';
import { formatDateInputInTimeZone, todayInTimeZone } from '@/lib/utils';

export default function VendorBalanceSummaryReportPage() {
  const { user, companySettings } = useAuth();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const tz = companySettings?.timeZone ?? 'Asia/Yangon';
    if (from && to) return;
    const today = todayInTimeZone(tz);
    const [y, m] = today.split('-').map((x) => Number(x));
    if (!y || !m) return;
    const first = formatDateInputInTimeZone(new Date(Date.UTC(y, m - 1, 1)), tz);
    const last = formatDateInputInTimeZone(new Date(Date.UTC(y, m, 0)), tz);
    if (!from) setFrom(first);
    if (!to) setTo(last);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companySettings?.timeZone]);

  const load = async () => {
    if (!user?.companyId) return;
    setLoading(true);
    try {
      const qs = new URLSearchParams({ from, to });
      const res = await fetchApi(`/companies/${user.companyId}/reports/vendor-balance-summary?${qs.toString()}`);
      setData(res);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user?.companyId) load().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.companyId]);

  const totals = useMemo(() => data?.totals ?? null, [data]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Vendor Balance Summary</h1>
        <p className="text-sm text-muted-foreground">Billed amount, amount paid, and closing balance by vendor.</p>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Filter</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-4">
          <div className="grid w-full max-w-sm items-center gap-1.5">
            <Label htmlFor="from">From Date</Label>
            <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="grid w-full max-w-sm items-center gap-1.5">
            <Label htmlFor="to">To Date</Label>
            <Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button onClick={load} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Run Report
          </Button>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">Results</CardTitle>
          {totals ? (
            <div className="text-sm text-muted-foreground">
              Total closing:{' '}
              <span className="font-medium tabular-nums">
                {Number(totals.closingBalance ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </span>
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="pt-0">
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Vendor Name</TableHead>
                  <TableHead className="text-right">Opening Balance</TableHead>
                  <TableHead className="text-right">Billed Amount</TableHead>
                  <TableHead className="text-right">Amount Paid</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead className="text-right">Closing Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.rows ?? []).map((r: any) => (
                  <TableRow key={String(r.vendorId ?? r.vendorName)}>
                    <TableCell className="font-medium">{r.vendorName}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(r.openingBalance ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(r.billedAmount ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(r.amountPaid ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(r.credit ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {Number(r.closingBalance ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </TableCell>
                  </TableRow>
                ))}
                {(data?.rows ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                      No vendors found.
                    </TableCell>
                  </TableRow>
                ) : null}
                {totals ? (
                  <TableRow className="bg-muted/40">
                    <TableCell className="font-medium">Total</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {Number((totals as any).openingBalance ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {Number(totals.billedAmount ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {Number(totals.amountPaid ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {Number(totals.credit ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {Number(totals.closingBalance ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            Notes: “Amount Paid” is cash payments. “Credit” includes POSTED vendor credits and applied vendor advances (prepayments).
          </div>
        </CardContent>
      </Card>
    </div>
  );
}


