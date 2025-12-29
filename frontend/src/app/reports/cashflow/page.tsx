'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi, getCashflowStatement, CashflowStatement } from '@/lib/api';
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

function fmtAxis(n: number) {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  const s = abs.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return n < 0 ? `(${s})` : s;
}

function ZeroBaselineChart({
  buckets,
}: {
  buckets: Array<{ label: string; net: string; inflow?: string; outflow?: string; from?: string; to?: string }>;
}) {
  const [selected, setSelected] = useState<string | null>(buckets[0]?.label ?? null);
  const maxAbs = Math.max(
    1,
    ...buckets.flatMap((b) => {
      const inflow = Number(b.inflow ?? 0);
      const outflow = Number(b.outflow ?? 0);
      const net = Number(b.net ?? 0);
      return [Math.abs(inflow), Math.abs(outflow), Math.abs(net)];
    })
  );

  const selectedBucket = buckets.find((b) => b.label === selected) ?? null;
  const selectedValue = selectedBucket ? Number(selectedBucket.net ?? 0) : 0;
  const isNeg = selectedValue < 0;

  return (
    <Card className="shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="space-y-1">
          <CardTitle className="text-lg">Cashflow</CardTitle>
          <div className="text-sm text-muted-foreground">
            In K. Inflow above zero, outflow below zero. Click a period to highlight.
          </div>
        </div>
        {selectedBucket ? (
          <div className="text-sm text-muted-foreground">
            {selectedBucket.from && selectedBucket.to ? `${selectedBucket.from} → ${selectedBucket.to}` : selectedBucket.label}
          </div>
        ) : null}
      </CardHeader>
      <CardContent>
        <div className="relative overflow-hidden rounded-xl border bg-background/60 p-4">
          {/* Right-side axis labels (screenshot style) */}
          <div className="pointer-events-none absolute right-3 top-3 text-xs text-muted-foreground tabular-nums">
            {fmtAxis(maxAbs)}
          </div>
          <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground tabular-nums">
            {fmtAxis(0)}
          </div>
          <div className="pointer-events-none absolute right-3 bottom-3 text-xs text-muted-foreground tabular-nums">
            {fmtAxis(-maxAbs)}
          </div>

          <div className="relative h-64">
            {/* Zero baseline */}
            <div className="absolute inset-x-0 top-1/2 h-px bg-muted" />

            {/* Selected period highlight (plot band) */}
            {selected ? (
              <div
                className="absolute top-0 bottom-0 rounded-lg bg-primary/10"
                style={{
                  left: `calc(${buckets.findIndex((b) => b.label === selected)} * (100% / ${Math.max(1, buckets.length)}))`,
                  width: `calc(100% / ${Math.max(1, buckets.length)})`,
                }}
              />
            ) : null}

            {/* Bars */}
            <div className="absolute inset-0 flex items-end gap-2 px-2">
              {buckets.map((b) => {
                const inflow = Number(b.inflow ?? (Number(b.net ?? 0) > 0 ? b.net : 0));
                const outflow = Number(b.outflow ?? (Number(b.net ?? 0) < 0 ? Math.abs(Number(b.net ?? 0)) : 0));
                const inflowH = Math.round((Math.abs(inflow) / maxAbs) * 150);
                const outflowH = Math.round((Math.abs(outflow) / maxAbs) * 150);
                const active = b.label === selected;
                return (
                  <button
                    key={b.label}
                    type="button"
                    onClick={() => setSelected(b.label)}
                    className={[
                      'relative flex h-full flex-1 flex-col justify-end gap-2 rounded-md px-1',
                      active ? 'z-10' : 'z-0',
                    ].join(' ')}
                    title={`${b.label}: Inflow ${fmtAxis(inflow)} / Outflow ${fmtAxis(-outflow)} / Net ${fmtAxis(Number(b.net ?? 0))}`}
                  >
                    <div className="relative h-[180px]">
                      <div
                        className={[
                          'absolute left-1/2 w-8 -translate-x-1/2 rounded-md transition-colors',
                          'bg-emerald-500/70',
                          active ? 'ring-2 ring-primary/30' : '',
                        ].join(' ')}
                        style={{
                          height: `${inflowH}px`,
                          bottom: '50%',
                        }}
                      />
                      <div
                        className={[
                          'absolute left-1/2 w-8 -translate-x-1/2 rounded-md transition-colors',
                          'bg-sky-500/55',
                          active ? 'ring-2 ring-primary/30' : '',
                        ].join(' ')}
                        style={{
                          height: `${outflowH}px`,
                          top: '50%',
                        }}
                      />
                    </div>
                    <div className="text-center text-xs text-muted-foreground">{b.label}</div>
                  </button>
                );
              })}
            </div>

            {/* Tooltip bubble (simple) */}
            {selectedBucket ? (
              <div className="pointer-events-none absolute left-1/2 top-8 -translate-x-1/2 rounded-xl border bg-background px-4 py-2 shadow-sm">
                <div className="text-xs text-muted-foreground">Selected period</div>
                <div className="mt-1 space-y-0.5 text-sm">
                  <div className="flex items-center justify-between gap-6">
                    <span className="text-muted-foreground">Inflow</span>
                    <span className="font-medium tabular-nums">{fmtAxis(Number(selectedBucket.inflow ?? 0))}</span>
                  </div>
                  <div className="flex items-center justify-between gap-6">
                    <span className="text-muted-foreground">Outflow</span>
                    <span className="font-medium tabular-nums">{fmtAxis(-Number(selectedBucket.outflow ?? 0))}</span>
                  </div>
                  <div className="flex items-center justify-between gap-6 border-t pt-1">
                    <span className="text-muted-foreground">Net</span>
                    <span className="font-semibold tabular-nums">{fmtAxis(selectedValue)}</span>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
          <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500/70" /> Inflow
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-sm bg-sky-500/55" /> Outflow
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
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
  const [chartBuckets, setChartBuckets] = useState<
    Array<{ label: string; net: string; inflow?: string; outflow?: string; from?: string; to?: string }>
  >([]);
  const [error, setError] = useState<string | null>(null);

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
    if (!from || !to) {
      setError('Please select both From and To dates.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [data, dash] = await Promise.all([
        getCashflowStatement(user.companyId, from, to),
        fetchApi(`/companies/${user.companyId}/dashboard?from=${from}&to=${to}`),
      ]);
      setReport(data);
      setChartBuckets((dash?.cashflow?.buckets ?? []) as any[]);
    } catch (err: any) {
      console.error(err);
      setError(err?.message ?? 'Failed to load cashflow statement');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Auto-run only once we have a valid date range
    if (user?.companyId && from && to) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.companyId, from, to]);

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

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {report && (
        <>
          {chartBuckets.length > 0 ? <ZeroBaselineChart buckets={chartBuckets} /> : null}

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
