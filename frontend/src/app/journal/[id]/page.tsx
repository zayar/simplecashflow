'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function formatMoney(n: any) {
  const num = Number(n ?? 0);
  if (Number.isNaN(num)) return String(n ?? '');
  return num.toLocaleString();
}

export default function JournalEntryDetailPage() {
  const { user } = useAuth();
  const params = useParams();
  const journalEntryId = params.id;

  const [entry, setEntry] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.companyId || !journalEntryId) return;
    setLoading(true);
    fetchApi(`/companies/${user.companyId}/journal-entries/${journalEntryId}`)
      .then(setEntry)
      .finally(() => setLoading(false));
  }, [user?.companyId, journalEntryId]);

  const totals = useMemo(() => {
    if (!entry?.lines) return { debit: 0, credit: 0 };
    return entry.lines.reduce(
      (acc: any, l: any) => ({
        debit: acc.debit + Number(l.debit ?? 0),
        credit: acc.credit + Number(l.credit ?? 0),
      }),
      { debit: 0, credit: 0 }
    );
  }, [entry]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/journal">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Journal entry</h1>
            <p className="text-sm text-muted-foreground">Loading…</p>
          </div>
        </div>
        <Card className="shadow-sm">
          <CardContent className="pt-6 space-y-3">
            <Skeleton className="h-7 w-72" />
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-64 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!entry) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/journal">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Journal entry</h1>
            <p className="text-sm text-muted-foreground">Not found</p>
          </div>
        </div>
        <Card className="shadow-sm">
          <CardContent className="pt-6">
            <p className="text-center text-muted-foreground">Journal entry not found.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/journal">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Journal entry #{entry.id}</h1>
          <p className="text-sm text-muted-foreground">{new Date(entry.date).toLocaleDateString()}</p>
        </div>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">{entry.description}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right w-[160px]">Debit</TableHead>
                  <TableHead className="text-right w-[160px]">Credit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(entry.lines ?? []).map((l: any) => (
                  <TableRow key={l.id}>
                    <TableCell>
                      <div className="font-medium">
                        {l.account?.code ? `${l.account.code} ` : ''}
                        {l.account?.name ?? '—'}
                      </div>
                      <div className="text-xs text-muted-foreground">{l.account?.type ?? ''}</div>
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{formatMoney(l.debit)}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{formatMoney(l.credit)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/40">
                  <TableCell className="text-right font-medium">Total</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{formatMoney(totals.debit)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{formatMoney(totals.credit)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          <div>
            {entry.balanced ? (
              <Badge variant="secondary">Balanced</Badge>
            ) : (
              <Badge variant="destructive">Unbalanced</Badge>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}


