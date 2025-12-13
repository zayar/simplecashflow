'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BookOpen, ArrowRight } from 'lucide-react';

function formatMoney(n: any) {
  const num = Number(n ?? 0);
  if (Number.isNaN(num)) return String(n ?? '');
  return num.toLocaleString();
}

export default function JournalPage() {
  const { user } = useAuth();
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.companyId) return;
    setLoading(true);
    fetchApi(`/companies/${user.companyId}/journal-entries?take=100`)
      .then(setEntries)
      .finally(() => setLoading(false));
  }, [user?.companyId]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <BookOpen className="h-6 w-6" /> Journal
        </h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Journal Entries</CardTitle>
        </CardHeader>
        <CardContent>
          {loading && <div className="text-sm text-muted-foreground">Loading...</div>}
          {!loading && entries.length === 0 && (
            <div className="text-sm text-muted-foreground">No journal entries yet.</div>
          )}

          {!loading && entries.length > 0 && (
            <div className="relative w-full overflow-auto">
              <table className="w-full caption-bottom text-sm text-left">
                <thead className="[&_tr]:border-b">
                  <tr>
                    <th className="h-12 px-4 align-middle font-medium text-muted-foreground">Date</th>
                    <th className="h-12 px-4 align-middle font-medium text-muted-foreground">Description</th>
                    <th className="h-12 px-4 align-middle font-medium text-muted-foreground text-right">Debit</th>
                    <th className="h-12 px-4 align-middle font-medium text-muted-foreground text-right">Credit</th>
                    <th className="h-12 px-4 align-middle font-medium text-muted-foreground text-right">Status</th>
                    <th className="h-12 px-4 align-middle font-medium text-muted-foreground text-right"></th>
                  </tr>
                </thead>
                <tbody className="[&_tr:last-child]:border-0">
                  {entries.map((e) => (
                    <tr key={e.id} className="border-b transition-colors hover:bg-muted/50">
                      <td className="p-4 align-middle">{new Date(e.date).toLocaleDateString()}</td>
                      <td className="p-4 align-middle">
                        <div className="font-medium">JE #{e.id}</div>
                        <div className="text-muted-foreground text-xs">{e.description}</div>
                      </td>
                      <td className="p-4 align-middle text-right font-medium">{formatMoney(e.totalDebit)}</td>
                      <td className="p-4 align-middle text-right font-medium">{formatMoney(e.totalCredit)}</td>
                      <td className="p-4 align-middle text-right">
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                            e.balanced ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                          }`}
                        >
                          {e.balanced ? 'BALANCED' : 'UNBALANCED'}
                        </span>
                      </td>
                      <td className="p-4 align-middle text-right">
                        <Link href={`/journal/${e.id}`}>
                          <Button variant="ghost" size="sm" className="gap-2">
                            View <ArrowRight className="h-4 w-4" />
                          </Button>
                        </Link>
                      </td>
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


