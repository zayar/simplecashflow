'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';

import { useAuth } from '@/contexts/auth-context';
import { getAccountTransactions, type AccountTransactionsReport } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, ArrowLeft } from 'lucide-react';

function fmt(n: string) {
  const num = Number(n ?? 0);
  if (!Number.isFinite(num)) return String(n ?? '');
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function AccountTransactionsPage() {
  const { user } = useAuth();
  const sp = useSearchParams();

  const accountId = useMemo(() => Number(sp.get('accountId') ?? 0), [sp]);
  const from = useMemo(() => String(sp.get('from') ?? ''), [sp]);
  const to = useMemo(() => String(sp.get('to') ?? ''), [sp]);

  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<AccountTransactionsReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.companyId) return;
    if (!accountId || !from || !to) return;
    setLoading(true);
    setError(null);
    getAccountTransactions(user.companyId, accountId, from, to)
      .then(setReport)
      .catch((e: any) => setError(e?.message ? String(e.message) : 'Failed to load transactions'))
      .finally(() => setLoading(false));
  }, [user?.companyId, accountId, from, to]);

  const title = report ? `${report.account.code} - ${report.account.name}` : 'Account Transactions';
  const backHref = `/reports/profit-loss?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href={backHref} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Link>
        <div className="space-y-0.5">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <div className="text-sm text-muted-foreground">
            Period: <b>{from}</b> to <b>{to}</b>
            {' · '}
            <Link className="text-primary hover:underline" href={backHref}>
              Profit &amp; Loss
            </Link>
          </div>
        </div>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Account Transactions</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {loading ? (
            <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : error ? (
            <div className="py-10 text-sm text-destructive">{error}</div>
          ) : !report ? (
            <div className="py-10 text-sm text-muted-foreground">
              Select an account from P&amp;L to view transactions.
            </div>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[120px]">Date</TableHead>
                    <TableHead className="w-[220px]">Account</TableHead>
                    <TableHead>Transaction Details</TableHead>
                    <TableHead className="w-[160px]">Transaction Type</TableHead>
                    <TableHead className="w-[160px]">Transaction#</TableHead>
                    <TableHead className="w-[160px]">Reference#</TableHead>
                    <TableHead className="text-right w-[140px]">Debit</TableHead>
                    <TableHead className="text-right w-[140px]">Credit</TableHead>
                    <TableHead className="text-right w-[160px]">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {/* Opening balance row */}
                  <TableRow className="bg-muted/30">
                    <TableCell>{`As on ${from}`}</TableCell>
                    <TableCell className="font-medium">
                      {report.account.code} - {report.account.name}
                    </TableCell>
                    <TableCell className="text-muted-foreground">Opening Balance</TableCell>
                    <TableCell>—</TableCell>
                    <TableCell>—</TableCell>
                    <TableCell>—</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {report.openingBalance.side === 'Dr' ? fmt(report.openingBalance.amount) : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {report.openingBalance.side === 'Cr' ? fmt(report.openingBalance.amount) : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmt(report.openingBalance.amount)} {report.openingBalance.side}
                    </TableCell>
                  </TableRow>

                  {report.rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                        No transactions found for this period.
                      </TableCell>
                    </TableRow>
                  ) : (
                    report.rows.map((r) => (
                      <TableRow key={r.journalEntryId}>
                        <TableCell>{r.date}</TableCell>
                        <TableCell className="font-medium">
                          {report.account.code} - {report.account.name}
                        </TableCell>
                        <TableCell className="min-w-[240px]">
                          <div className="font-medium">{r.description || '—'}</div>
                          <div className="text-xs text-muted-foreground">JE: {r.entryNumber}</div>
                        </TableCell>
                        <TableCell>{r.transactionType}</TableCell>
                        <TableCell>{r.transactionNo}</TableCell>
                        <TableCell>{r.referenceNo ?? '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">{Number(r.debit) ? fmt(r.debit) : '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">{Number(r.credit) ? fmt(r.credit) : '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {fmt(r.amount)} {r.side}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}


