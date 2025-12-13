'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, BookOpen } from 'lucide-react';

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
          <h1 className="text-3xl font-bold tracking-tight">Journal Entry</h1>
        </div>
        <Card>
          <CardContent className="pt-6">
            <p className="text-center text-muted-foreground">Loading...</p>
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
          <h1 className="text-3xl font-bold tracking-tight">Journal Entry</h1>
        </div>
        <Card>
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
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <BookOpen className="h-6 w-6" /> Journal Entry #{entry.id}
        </h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{entry.description}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm text-muted-foreground">
            Date: <span className="text-slate-900">{new Date(entry.date).toLocaleDateString()}</span>
          </div>

          <div className="relative w-full overflow-auto">
            <table className="w-full text-sm">
              <thead className="[&_tr]:border-b">
                <tr>
                  <th className="h-10 px-2 text-left font-medium text-muted-foreground">Account</th>
                  <th className="h-10 px-2 text-right font-medium text-muted-foreground">Debit</th>
                  <th className="h-10 px-2 text-right font-medium text-muted-foreground">Credit</th>
                </tr>
              </thead>
              <tbody className="[&_tr]:border-b">
                {(entry.lines ?? []).map((l: any) => (
                  <tr key={l.id}>
                    <td className="px-2 py-2">
                      <div className="font-medium">
                        {l.account?.code ? `${l.account.code} ` : ''}
                        {l.account?.name ?? '—'}
                      </div>
                      <div className="text-xs text-muted-foreground">{l.account?.type ?? ''}</div>
                    </td>
                    <td className="px-2 py-2 text-right">{formatMoney(l.debit)}</td>
                    <td className="px-2 py-2 text-right">{formatMoney(l.credit)}</td>
                  </tr>
                ))}
                <tr className="border-b-0">
                  <td className="px-2 py-2 text-right font-semibold">Total</td>
                  <td className="px-2 py-2 text-right font-semibold">{formatMoney(totals.debit)}</td>
                  <td className="px-2 py-2 text-right font-semibold">{formatMoney(totals.credit)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                entry.balanced ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
              }`}
            >
              {entry.balanced ? 'BALANCED' : 'UNBALANCED'}
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}


