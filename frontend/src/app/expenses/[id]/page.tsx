'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, FileText, Calendar, Building2, BookOpen, DollarSign } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function formatMoney(n: any) {
  const num = Number(n ?? 0);
  if (Number.isNaN(num)) return String(n ?? '');
  return num.toLocaleString();
}

export default function BillDetailPage() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useParams();
  const billId = params.id;

  const [bill, setBill] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!user?.companyId || !billId) return;
    setLoading(true);
    try {
      const data = await fetchApi(`/companies/${user.companyId}/expenses/${billId}`);
      setBill(data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load().catch(console.error);
  }, [user?.companyId, billId]);

  const journals = useMemo(() => (bill?.journalEntries ?? []) as any[], [bill]);
  const showJournal = bill?.status && bill.status !== 'DRAFT';

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/expenses">
            <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Bill</h1>
            <p className="text-sm text-muted-foreground">Loading…</p>
          </div>
        </div>
        <Card className="shadow-sm"><CardContent className="pt-6"><p className="text-center text-muted-foreground">Loading...</p></CardContent></Card>
      </div>
    );
  }

  if (!bill) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/expenses">
            <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Bill</h1>
            <p className="text-sm text-muted-foreground">Not found</p>
          </div>
        </div>
        <Card className="shadow-sm"><CardContent className="pt-6"><p className="text-center text-muted-foreground">Bill not found.</p></CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/expenses">
            <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
          </Link>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Bill</h1>
            <div className="text-sm text-muted-foreground">{bill.expenseNumber}</div>
          </div>
        </div>
        {(bill.status === 'POSTED' || bill.status === 'PARTIAL') && (
          <Link href={`/expenses/${bill.id}/payment`}>
            <Button>Pay Bill</Button>
          </Link>
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><FileText className="h-5 w-5" /> Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Building2 className="h-4 w-4" /> Vendor</div>
            <div className="font-medium">{bill.vendor?.name ?? '—'}</div>

            <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Calendar className="h-4 w-4" /> Bill Date</div>
            <div>{new Date(bill.expenseDate).toLocaleDateString()}</div>

            {bill.dueDate && (
              <>
                <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Calendar className="h-4 w-4" /> Due Date</div>
                <div>{new Date(bill.dueDate).toLocaleDateString()}</div>
              </>
            )}

            <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">Expense Account</div>
            <div className="font-medium">{bill.expenseAccount ? `${bill.expenseAccount.code} - ${bill.expenseAccount.name}` : '—'}</div>

            <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">Description</div>
            <div className="font-medium">{bill.description}</div>

            <div className="mt-6 border-t pt-4 space-y-2">
              <div className="flex justify-between"><span className="text-muted-foreground">Total</span><span className="font-semibold">{formatMoney(bill.amount)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Paid</span><span className="font-semibold text-green-700">{formatMoney(bill.totalPaid)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Remaining</span><span className="font-semibold">{formatMoney(bill.remainingBalance)}</span></div>
            </div>

            <div className="pt-2">
              <Badge variant="outline">{bill.status}</Badge>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <DollarSign className="h-5 w-5" /> Payments
              <Badge variant="secondary">{(bill.payments ?? []).length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {(bill.payments ?? []).length === 0 && (
              <div className="text-sm text-muted-foreground">No payments yet.</div>
            )}

            {(bill.payments ?? []).length > 0 && (
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[140px]">Date</TableHead>
                      <TableHead>Account</TableHead>
                      <TableHead className="text-right w-[180px]">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {bill.payments.map((p: any) => (
                      <TableRow key={p.id}>
                        <TableCell className="text-muted-foreground">{new Date(p.paymentDate).toLocaleDateString()}</TableCell>
                        <TableCell className="font-medium">{p.bankAccount?.name ?? '—'}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{formatMoney(p.amount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><BookOpen className="h-5 w-5" /> Journal Entries</CardTitle>
        </CardHeader>
        <CardContent className="space-y-8">
          {!showJournal && (
            <div className="text-sm text-muted-foreground">This bill is <b>DRAFT</b>. No journal entry yet. Post the bill first.</div>
          )}

          {showJournal && journals.length === 0 && (
            <div className="text-sm text-muted-foreground">No journal entries found yet.</div>
          )}

          {showJournal && journals.map((je) => {
            const totalDebit = (je.lines ?? []).reduce((sum: number, l: any) => sum + Number(l.debit ?? 0), 0);
            const totalCredit = (je.lines ?? []).reduce((sum: number, l: any) => sum + Number(l.credit ?? 0), 0);

            const label = je.kind === 'BILL_POSTED' ? 'Bill Posted' : 'Bill Payment';

            return (
              <div key={`${je.kind}-${je.journalEntryId}`}>
                <div className="mb-2 flex items-baseline gap-2">
                  <h3 className="text-lg font-semibold text-slate-900">{label}</h3>
                  <span className="text-sm text-muted-foreground">JE #{je.journalEntryId} • {new Date(je.date).toLocaleDateString()}</span>
                </div>
                <div className="rounded-md border bg-white">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="h-10 px-4 text-left font-medium">Account</th>
                        <th className="h-10 px-4 text-left font-medium">Branch</th>
                        <th className="h-10 px-4 text-right font-medium">Debit</th>
                        <th className="h-10 px-4 text-right font-medium">Credit</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {(je.lines ?? []).map((l: any, idx: number) => (
                        <tr key={idx} className="hover:bg-slate-50/50">
                          <td className="px-4 py-3">
                            <div className="font-medium text-slate-900">{l.account?.name ?? '—'}</div>
                            <div className="text-xs text-slate-500">{l.account?.code}</div>
                          </td>
                          <td className="px-4 py-3 text-slate-600">Head Office</td>
                          <td className="px-4 py-3 text-right font-mono">{formatMoney(l.debit)}</td>
                          <td className="px-4 py-3 text-right font-mono">{formatMoney(l.credit)}</td>
                        </tr>
                      ))}
                      <tr className="bg-slate-50/80 font-semibold">
                        <td className="px-4 py-3" colSpan={2}></td>
                        <td className="px-4 py-3 text-right font-mono">{formatMoney(totalDebit)}</td>
                        <td className="px-4 py-3 text-right font-mono">{formatMoney(totalCredit)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
