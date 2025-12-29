'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2 } from 'lucide-react';
import { formatDateInputInTimeZone, todayInTimeZone } from '@/lib/utils';

export default function ReceivableSummaryReportPage() {
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
      const res = await fetchApi(`/companies/${user.companyId}/reports/receivable-summary?${qs.toString()}`);
      setData(res);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user?.companyId) load().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.companyId]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Receivable Summary</h1>
        <p className="text-sm text-muted-foreground">Invoice-level receivables for a date range.</p>
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
          <CardTitle className="text-lg">Receivable Summary</CardTitle>
          <div className="text-sm text-muted-foreground">
            Rows: <span className="font-medium tabular-nums">{(data?.rows ?? []).length}</span>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="rounded-lg border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer Name</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Transaction#</TableHead>
                  <TableHead>Reference#</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Transaction Type</TableHead>
                  <TableHead className="text-right">Total (BCY)</TableHead>
                  <TableHead className="text-right">Total (FCY)</TableHead>
                  <TableHead className="text-right">Balance (BCY)</TableHead>
                  <TableHead className="text-right">Balance (FCY)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.rows ?? []).map((r: any) => (
                  <TableRow key={String(r.invoiceId ?? `${r.transactionNumber}-${r.date}`)}>
                    <TableCell className="font-medium">{r.customerName}</TableCell>
                    <TableCell className="tabular-nums">{r.date}</TableCell>
                    <TableCell className="tabular-nums">{r.transactionNumber}</TableCell>
                    <TableCell className="tabular-nums">{r.referenceNumber ?? '—'}</TableCell>
                    <TableCell>{r.status}</TableCell>
                    <TableCell>{r.transactionType}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(r.totalBCY ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(r.totalFCY ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {Number(r.balanceBCY ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {Number(r.balanceFCY ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </TableCell>
                  </TableRow>
                ))}
                {(data?.rows ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="py-10 text-center text-muted-foreground">
                      No receivables found for this period.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}


