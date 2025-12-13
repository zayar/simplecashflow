'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, Landmark } from 'lucide-react';

function formatMoney(n: any) {
  const num = Number(n ?? 0);
  if (Number.isNaN(num)) return String(n ?? '');
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export default function BankingAccountDetailPage() {
  const { user } = useAuth();
  const params = useParams();
  const id = params.id;

  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.companyId || !id) return;
    setLoading(true);
    fetchApi(`/companies/${user.companyId}/banking-accounts/${id}`)
      .then(setData)
      .finally(() => setLoading(false));
  }, [user?.companyId, id]);

  const balanceLabel = useMemo(() => {
    if (!data) return '';
    const b = Number(data.balance ?? 0);
    const suffix = b >= 0 ? 'Dr' : 'Cr';
    return `${formatMoney(Math.abs(b))} (${suffix})`;
  }, [data]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/banking">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Banking</h1>
        </div>
        <Card>
          <CardContent className="pt-6">
            <p className="text-center text-muted-foreground">Loading...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/banking">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Banking</h1>
        </div>
        <Card>
          <CardContent className="pt-6">
            <p className="text-center text-muted-foreground">Account not found.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/banking">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <Landmark className="h-6 w-6" /> {data.account?.name}
        </h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Closing Balance</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-4xl font-bold tracking-tight">{balanceLabel}</div>
          <div className="text-sm text-muted-foreground mt-2">
            {data.kind} • COA {data.account?.code} • {data.bankName ?? '—'}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Transactions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="relative w-full overflow-auto">
            <table className="w-full caption-bottom text-sm text-left">
              <thead className="[&_tr]:border-b">
                <tr>
                  <th className="h-12 px-4 align-middle font-medium text-muted-foreground">Date</th>
                  <th className="h-12 px-4 align-middle font-medium text-muted-foreground">Transaction Details</th>
                  <th className="h-12 px-4 align-middle font-medium text-muted-foreground">Type</th>
                  <th className="h-12 px-4 align-middle font-medium text-muted-foreground text-right">Debit</th>
                  <th className="h-12 px-4 align-middle font-medium text-muted-foreground text-right">Credit</th>
                </tr>
              </thead>
              <tbody className="[&_tr:last-child]:border-0">
                {(data.transactions ?? []).map((t: any, idx: number) => (
                  <tr key={idx} className="border-b transition-colors hover:bg-muted/50">
                    <td className="p-4 align-middle">{t.date ? new Date(t.date).toLocaleDateString() : '—'}</td>
                    <td className="p-4 align-middle">
                      <div className="font-medium">{t.details}</div>
                      <div className="text-xs text-muted-foreground">
                        JE #{t.journalEntryId}
                      </div>
                    </td>
                    <td className="p-4 align-middle">{t.type}</td>
                    <td className="p-4 align-middle text-right font-medium">{formatMoney(t.debit)}</td>
                    <td className="p-4 align-middle text-right font-medium">{formatMoney(t.credit)}</td>
                  </tr>
                ))}
                {(data.transactions ?? []).length === 0 && (
                  <tr>
                    <td colSpan={5} className="p-4 text-center text-muted-foreground">
                      No transactions yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}


