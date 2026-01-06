'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { getProfitLoss, ProfitLossReport } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateInputInTimeZone, todayInTimeZone } from '@/lib/utils';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

export default function ProfitLossPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const sp = useSearchParams();
  const [report, setReport] = useState<ProfitLossReport | null>(null);
  const [loading, setLoading] = useState(false);
  
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  // Restore from/to from URL query params (so Back from drill-down preserves filters).
  useEffect(() => {
    const qFrom = sp.get('from');
    const qTo = sp.get('to');
    if (qFrom && !from) setFrom(String(qFrom));
    if (qTo && !to) setTo(String(qTo));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp]);

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
    if (!from || !to) return;
    setLoading(true);
    try {
      const data = await getProfitLoss(user.companyId, from, to);
      setReport(data);
      // Persist filters in URL for shareability and back navigation.
      router.replace(`/reports/profit-loss?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!user?.companyId) return;
    if (!from || !to) return;
    fetchReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.companyId, from, to]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Profit &amp; Loss</h1>
        <p className="text-sm text-muted-foreground">
          Revenue, expenses, and net profit for a period.
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
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-3">
            <Card className="shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Total income</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold tabular-nums">
                  {Number(report.totalIncome).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </div>
              </CardContent>
            </Card>
            <Card className="shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Total expenses</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold tabular-nums">
                  {Number(report.totalExpense).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </div>
              </CardContent>
            </Card>
            <Card className="shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Net profit</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold tabular-nums">
                  {Number(report.netProfit).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Income</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[120px]">Code</TableHead>
                      <TableHead>Account</TableHead>
                      <TableHead className="text-right w-[180px]">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.incomeAccounts.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={3} className="py-10 text-center text-muted-foreground">
                          No income records found for this period.
                        </TableCell>
                      </TableRow>
                    ) : (
                      report.incomeAccounts.map((row) => (
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
                          <TableCell className="text-right font-medium tabular-nums">
                            {Number(row.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                    <TableRow className="bg-muted/40">
                      <TableCell colSpan={2} className="text-right font-medium">
                        Total income
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        {Number(report.totalIncome).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Expenses</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[120px]">Code</TableHead>
                      <TableHead>Account</TableHead>
                      <TableHead className="text-right w-[180px]">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.expenseAccounts.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={3} className="py-10 text-center text-muted-foreground">
                          No expense records found for this period.
                        </TableCell>
                      </TableRow>
                    ) : (
                      report.expenseAccounts.map((row) => (
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
                          <TableCell className="text-right font-medium tabular-nums">
                            {Number(row.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                    <TableRow className="bg-muted/40">
                      <TableCell colSpan={2} className="text-right font-medium">
                        Total expenses
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        {Number(report.totalExpense).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
