'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Landmark, Plus } from 'lucide-react';

export default function BankingPage() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.companyId) return;
    setLoading(true);
    fetchApi(`/companies/${user.companyId}/banking-accounts`)
      .then(setAccounts)
      .finally(() => setLoading(false));
  }, [user?.companyId]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <Landmark className="h-6 w-6" /> Banking
        </h1>
        <Link href="/banking/new">
          <Button className="gap-2">
            <Plus className="h-4 w-4" /> New Account
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Deposit Accounts (Cash / Bank / E‑wallet)</CardTitle>
        </CardHeader>
        <CardContent>
          {loading && <div className="text-sm text-muted-foreground">Loading...</div>}
          {!loading && accounts.length === 0 && (
            <div className="text-sm text-muted-foreground">No banking accounts yet.</div>
          )}
          {!loading && accounts.length > 0 && (
            <div className="relative w-full overflow-auto">
              <table className="w-full caption-bottom text-sm text-left">
                <thead className="[&_tr]:border-b">
                  <tr>
                    <th className="h-12 px-4 align-middle font-medium text-muted-foreground">Code</th>
                    <th className="h-12 px-4 align-middle font-medium text-muted-foreground">Name</th>
                    <th className="h-12 px-4 align-middle font-medium text-muted-foreground">Kind</th>
                    <th className="h-12 px-4 align-middle font-medium text-muted-foreground">Bank</th>
                    <th className="h-12 px-4 align-middle font-medium text-muted-foreground">Primary</th>
                  </tr>
                </thead>
                <tbody className="[&_tr:last-child]:border-0">
                  {accounts.map((a) => (
                    <tr key={`${a.id}-${a.account?.id ?? ''}`} className="border-b transition-colors hover:bg-muted/50">
                      <td className="p-4 align-middle font-medium">{a.account?.code}</td>
                      <td className="p-4 align-middle">
                        <Link href={`/banking/${a.id}`} className="font-medium text-slate-900 hover:underline">
                          {a.account?.name}
                        </Link>
                      </td>
                      <td className="p-4 align-middle">
                        <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-800">
                          {a.kind}
                        </span>
                      </td>
                      <td className="p-4 align-middle text-muted-foreground">{a.bankName ?? '—'}</td>
                      <td className="p-4 align-middle">{a.isPrimary ? '✓' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}


