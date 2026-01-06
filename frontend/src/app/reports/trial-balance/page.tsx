'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { getTrialBalance, TrialBalanceReport } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateInputInTimeZone, todayInTimeZone } from '@/lib/utils';
import Link from 'next/link';

export default function TrialBalancePage() {
  const { user, companySettings } = useAuth();
  const [report, setReport] = useState<TrialBalanceReport | null>(null);
  const [loading, setLoading] = useState(false);
  
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  useEffect(() => {
    const tz = companySettings?.timeZone ?? 'Asia/Yangon';
    if (from && to) return;
    const today = todayInTimeZone(tz);
    const parts = today.split('-').map((x) => Number(x));
    const y = parts[0];
    const m = parts[1]; // 1-12
    if (!y || !m) return;
    const first = formatDateInputInTimeZone(new Date(Date.UTC(y, m - 1, 1)), tz);
    const last = formatDateInputInTimeZone(new Date(Date.UTC(y, m, 0)), tz);
    if (!from) setFrom(first);
    if (!to) setTo(last);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companySettings?.timeZone]);

  async function fetchReport() {
    if (!user?.companyId) return;
    setLoading(true);
    try {
      const data = await getTrialBalance(user.companyId, from, to);
      setReport(data);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (user?.companyId) {
      fetchReport();
    }
  }, [user?.companyId]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Trial Balance</h1>
        <p className="text-sm text-muted-foreground">
          Validate that total debits equal total credits for a period.
        </p>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Filter</CardTitle>
        </CardHeader>
        <CardContent className="flex items-end gap-4">
          <div className="grid w-full max-w-sm items-center gap-1.5">
            <Label htmlFor="from">From Date</Label>
            <Input 
              type="date" 
              id="from" 
              value={from} 
              onChange={(e) => setFrom(e.target.value)} 
            />
          </div>
          <div className="grid w-full max-w-sm items-center gap-1.5">
            <Label htmlFor="to">To Date</Label>
            <Input 
              type="date" 
              id="to" 
              value={to} 
              onChange={(e) => setTo(e.target.value)} 
            />
          </div>
          <Button onClick={fetchReport} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Run Report
          </Button>
        </CardContent>
      </Card>

      {report && (
        <Card className="shadow-sm">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">Results</CardTitle>
              {report.balanced ? (
                <Badge variant="secondary">Balanced</Badge>
              ) : (
                <Badge variant="destructive">Unbalanced</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[120px]">Code</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead className="w-[140px]">Type</TableHead>
                    <TableHead className="text-right w-[140px]">Debit</TableHead>
                    <TableHead className="text-right w-[140px]">Credit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.accounts.map((row) => (
                    <TableRow key={row.accountId}>
                      <TableCell className="font-medium">{row.code}</TableCell>
                      <TableCell>
                        <Link
                          className="text-primary hover:underline"
                          href={`/reports/account-transactions?accountId=${row.accountId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`}
                        >
                          {row.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{row.type}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {Number(row.debit) !== 0
                          ? Number(row.debit).toLocaleString(undefined, { minimumFractionDigits: 2 })
                          : '—'}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {Number(row.credit) !== 0
                          ? Number(row.credit).toLocaleString(undefined, { minimumFractionDigits: 2 })
                          : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-muted/40">
                    <TableCell colSpan={3} className="text-right font-medium">
                      Totals
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {Number(report.totalDebit).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {Number(report.totalCredit).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
