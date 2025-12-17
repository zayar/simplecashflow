'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { getCashflowStatement, CashflowStatement } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateInputInTimeZone, todayInTimeZone } from '@/lib/utils';

function fmt(n: string) {
  const num = Number(n);
  if (Number.isNaN(num)) return n;
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function Section({ title, total, lines }: { title: string; total: string; lines: { label: string; amount: string }[] }) {
  return (
    <Card className="shadow-sm">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">{title}</CardTitle>
          <div className="text-sm font-medium tabular-nums">{fmt(total)}</div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right w-[180px]">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={2} className="py-10 text-center text-muted-foreground">
                    No lines.
                  </TableCell>
                </TableRow>
              ) : (
                lines.map((l, idx) => (
                  <TableRow key={idx}>
                    <TableCell>{l.label}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{fmt(l.amount)}</TableCell>
                  </TableRow>
                ))
              )}
              <TableRow className="bg-muted/40">
                <TableCell className="text-right font-medium">Total</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{fmt(total)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export default function CashflowPage() {
  const { user, companySettings } = useAuth();
  const [report, setReport] = useState<CashflowStatement | null>(null);
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

  async function run() {
    if (!user?.companyId) return;
    setLoading(true);
    try {
      const data = await getCashflowStatement(user.companyId, from, to);
      setReport(data);
    } catch (err: any) {
      console.error(err);
      alert(err.message || 'Failed to load cashflow statement');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (user?.companyId) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.companyId]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Cashflow Statement</h1>
        <p className="text-sm text-muted-foreground">
          Indirect method (operating, investing, financing) with reconciliation.
        </p>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Filter</CardTitle>
        </CardHeader>
        <CardContent className="flex items-end gap-4">
          <div className="grid w-full max-w-sm items-center gap-1.5">
            <Label htmlFor="from">From</Label>
            <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="grid w-full max-w-sm items-center gap-1.5">
            <Label htmlFor="to">To</Label>
            <Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button onClick={run} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Run Report
          </Button>
        </CardContent>
      </Card>

      {report && (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="shadow-sm">
              <CardHeader>
                <CardTitle className="text-lg">Reconciliation</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Cash begin</span>
                  <span className="font-medium tabular-nums">{fmt(report.reconciliation.cashBegin)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Cash end</span>
                  <span className="font-medium tabular-nums">{fmt(report.reconciliation.cashEnd)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Net change in cash</span>
                  <span className="font-medium tabular-nums">{fmt(report.reconciliation.netChangeInCash)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Computed net change</span>
                  <span className="font-medium tabular-nums">{fmt(report.reconciliation.computedNetChangeInCash)}</span>
                </div>
                <div className="pt-2">
                  {report.reconciliation.reconciled ? (
                    <Badge variant="secondary">Reconciled</Badge>
                  ) : (
                    <Badge variant="outline">Not fully reconciled</Badge>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card className="shadow-sm">
              <CardHeader>
                <CardTitle className="text-lg">Notes</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                <ul className="list-disc pl-5 space-y-1">
                  {report.notes.map((n, idx) => (
                    <li key={idx}>{n}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div>

          <Section title="Operating Activities" total={report.operating.total} lines={report.operating.lines} />
          <Section title="Investing Activities" total={report.investing.total} lines={report.investing.lines} />
          <Section title="Financing Activities" total={report.financing.total} lines={report.financing.lines} />
        </>
      )}
    </div>
  );
}
