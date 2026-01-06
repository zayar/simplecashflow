'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { getBalanceSheetWithCompare, BalanceSheetReport } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { todayInTimeZone } from '@/lib/utils';
import Link from 'next/link';

export default function BalanceSheetPage() {
  const { user, companySettings } = useAuth();
  const [report, setReport] = useState<BalanceSheetReport | null>(null);
  const [loading, setLoading] = useState(false);
  
  const [asOf, setAsOf] = useState('');
  const [compareYears, setCompareYears] = useState<number>(0);

  useEffect(() => {
    const tz = companySettings?.timeZone ?? 'Asia/Yangon';
    if (!asOf) setAsOf(todayInTimeZone(tz));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companySettings?.timeZone]);

  async function fetchReport() {
    if (!user?.companyId) return;
    setLoading(true);
    try {
      const data = await getBalanceSheetWithCompare(user.companyId, asOf, compareYears);
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

  function fromForAsOf(asOfStr: string) {
    const fyStartMonth = Number(companySettings?.fiscalYearStartMonth ?? 1); // 1-12
    const safeMonth = Number.isFinite(fyStartMonth) && fyStartMonth >= 1 && fyStartMonth <= 12 ? fyStartMonth : 1;
    const asOfYear = Number(String(asOfStr ?? '').slice(0, 4)) || new Date().getUTCFullYear();
    const asOfMonth = Number(String(asOfStr ?? '').slice(5, 7)) || 1;
    const fyStartYear = asOfMonth >= safeMonth ? asOfYear : asOfYear - 1;
    return `${fyStartYear}-${String(safeMonth).padStart(2, '0')}-01`;
  }

  function SectionTable({ title, rows }: { title: string; rows: any[] }) {
    // For an as-of balance sheet, drill-down uses a sensible default range:
    // fiscal-year-to-date if known, otherwise calendar-year-to-date.
    const cols = report?.columns?.length ? report.columns : [{ asOf: asOf, label: asOf }];
    const toForDrillDefault = asOf || todayInTimeZone(companySettings?.timeZone ?? 'Asia/Yangon');

    return (
      <Card className="shadow-sm">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-lg">{title}</CardTitle>
            {cols.length > 1 ? (
              <div className="text-xs text-muted-foreground">
                Compare: {cols.map((c) => c.asOf).join(' · ')}
              </div>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[120px]">Code</TableHead>
                  <TableHead>Account</TableHead>
                  {cols.map((c, idx) => {
                    // Format as "31 DEC 2025"
                    const d = new Date(c.asOf);
                    const day = d.getUTCDate();
                    const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();
                    const year = d.getUTCFullYear();
                    const label = `${day} ${month} ${year}`;
                    return (
                      <TableHead key={`${c.asOf}-${idx}`} className="text-right w-[180px]">
                        {label}
                      </TableHead>
                    );
                  })}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={2 + cols.length} className="py-10 text-center text-muted-foreground">
                      No {title.toLowerCase()} found.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.accountId}>
                      <TableCell className="font-medium">{row.code}</TableCell>
                      <TableCell>
                        <Link
                          className="text-primary hover:underline"
                          href={`/reports/account-transactions?accountId=${row.accountId}&from=${encodeURIComponent(fromForAsOf(cols[0]?.asOf || asOf))}&to=${encodeURIComponent(cols[0]?.asOf || toForDrillDefault)}`}
                        >
                          {row.name}
                        </Link>
                      </TableCell>
                      {cols.map((c, idx) => {
                        const bal = Array.isArray(row?.balances) ? String(row.balances[idx] ?? '0') : String(idx === 0 ? row.balance : '0');
                        const fromForDrill = fromForAsOf(c.asOf);
                        const toForDrill = c.asOf || toForDrillDefault;
                        return (
                          <TableCell key={`${row.accountId}-${c.asOf}-${idx}`} className="text-right font-medium tabular-nums">
                            <Link
                              className="hover:underline"
                              href={`/reports/account-transactions?accountId=${row.accountId}&from=${encodeURIComponent(fromForDrill)}&to=${encodeURIComponent(toForDrill)}`}
                            >
                              {Number(bal).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                            </Link>
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))
                )}
                {/* Totals row per section */}
                {rows.length > 0 ? (
                  <TableRow className="bg-muted/40">
                    <TableCell colSpan={2} className="text-right font-medium">
                      Total {title}
                    </TableCell>
                    {cols.map((c, idx) => {
                      const sectionKey = title.toLowerCase().replace(/ /g, '') as 'assets' | 'liabilities' | 'equity';
                      const total = report?.totalsByColumn?.[idx]?.[sectionKey] ?? (idx === 0 ? report?.totals[sectionKey] ?? '0' : '0');
                      return (
                        <TableCell key={`total-${c.asOf}-${idx}`} className="text-right font-semibold tabular-nums">
                          {Number(total).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Balance Sheet</h1>
        <p className="text-sm text-muted-foreground">
          Assets, liabilities, and equity at a point in time.
        </p>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Filter</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-4">
          <div className="grid w-full max-w-sm items-center gap-1.5">
            <Label htmlFor="asOf">As Of Date</Label>
            <Input 
              type="date" 
              id="asOf" 
              value={asOf} 
              onChange={(e) => setAsOf(e.target.value)} 
            />
          </div>
          <div className="grid w-full max-w-xs items-center gap-1.5">
            <Label htmlFor="compareYears">Compare</Label>
            <select
              id="compareYears"
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              value={compareYears}
              onChange={(e) => setCompareYears(Number(e.target.value))}
            >
              <option value={0}>None</option>
              <option value={1}>Previous Year</option>
              <option value={2}>Previous 2 Years</option>
            </select>
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
                <CardTitle className="text-sm font-medium text-muted-foreground">Total assets</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold tabular-nums">
                  {Number(report.totals.assets).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </div>
              </CardContent>
            </Card>
            <Card className="shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Total liabilities</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold tabular-nums">
                  {Number(report.totals.liabilities).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </div>
              </CardContent>
            </Card>
            <Card className="shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Total equity</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold tabular-nums">
                  {Number(report.totals.equity).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </div>
              </CardContent>
            </Card>
          </div>

          <div>
            {report.totals.balanced ? (
              <Badge variant="secondary">Balanced</Badge>
            ) : (
              <Badge variant="destructive">Out of balance</Badge>
            )}
          </div>

          <SectionTable title="Assets" rows={report.assets} />
          <SectionTable title="Liabilities" rows={report.liabilities} />
          <SectionTable title="Equity" rows={report.equity} />
        </div>
      )}
    </div>
  );
}
