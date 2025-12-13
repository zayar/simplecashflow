'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, FileText, Calendar, User, BookOpen } from 'lucide-react';

function formatMoney(n: any) {
  const num = Number(n ?? 0);
  if (Number.isNaN(num)) return String(n ?? '');
  return num.toLocaleString();
}

function StatusPill({ status }: { status: 'Paid' | 'Reversed' }) {
  const cls =
    status === 'Paid'
      ? 'bg-green-100 text-green-800'
      : 'bg-slate-100 text-slate-800';
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
      {status}
    </span>
  );
}

export default function InvoiceDetailPage() {
  const { user } = useAuth();
  const params = useParams();
  const invoiceId = params.id;

  const [invoice, setInvoice] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [reversingPaymentId, setReversingPaymentId] = useState<number | null>(null);
  const [refundModalOpen, setRefundModalOpen] = useState(false);
  const [refundPayment, setRefundPayment] = useState<any>(null);
  const [refundReason, setRefundReason] = useState('');

  const makeIdempotencyKey = () => {
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? (crypto as any).randomUUID()
      : `idem_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  };

  const loadInvoice = async () => {
    if (!user?.companyId || !invoiceId) return;
    setLoading(true);
    try {
      const inv = await fetchApi(`/companies/${user.companyId}/invoices/${invoiceId}`);
      setInvoice(inv);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadInvoice();
  }, [user?.companyId, invoiceId]);

  const reversePayment = async (paymentId: number, reason?: string) => {
    if (!user?.companyId || !invoiceId) return;
    setReversingPaymentId(paymentId);
    try {
      await fetchApi(`/companies/${user.companyId}/invoices/${invoiceId}/payments/${paymentId}/reverse`, {
        method: 'POST',
        headers: { 'Idempotency-Key': makeIdempotencyKey() },
        body: JSON.stringify({ reason: reason || undefined }),
      });
      await loadInvoice();
    } catch (err: any) {
      console.error(err);
      alert(err.message || 'Failed to reverse payment');
    } finally {
      setReversingPaymentId(null);
    }
  };

  const openRefundModal = (p: any) => {
    setRefundPayment(p);
    setRefundReason('');
    setRefundModalOpen(true);
  };

  const confirmRefund = async () => {
    if (!refundPayment) return;
    await reversePayment(refundPayment.id, refundReason.trim() || undefined);
    setRefundModalOpen(false);
    setRefundPayment(null);
    setRefundReason('');
  };

  const journals = useMemo(() => (invoice?.journalEntries ?? []) as any[], [invoice]);
  const showJournal = invoice?.status && invoice.status !== 'DRAFT';

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/invoices">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Invoice</h1>
        </div>
        <Card>
          <CardContent className="pt-6">
            <p className="text-center text-muted-foreground">Loading...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/invoices">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Invoice</h1>
        </div>
        <Card>
          <CardContent className="pt-6">
            <p className="text-center text-muted-foreground">Invoice not found.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/invoices">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Invoice</h1>
            <div className="text-sm text-muted-foreground">{invoice.invoiceNumber}</div>
          </div>
        </div>
        {(invoice.status === 'POSTED' || invoice.status === 'PARTIAL') && (
          <Link href={`/invoices/${invoice.id}/payment`}>
            <Button>Record Payment</Button>
          </Link>
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <User className="h-4 w-4" /> Customer
            </div>
            <div className="font-medium">{invoice.customer?.name ?? '—'}</div>

            <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
              <Calendar className="h-4 w-4" /> Invoice Date
            </div>
            <div>{new Date(invoice.invoiceDate).toLocaleDateString()}</div>

            {invoice.dueDate && (
              <>
                <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                  <Calendar className="h-4 w-4" /> Due Date
                </div>
                <div>{new Date(invoice.dueDate).toLocaleDateString()}</div>
              </>
            )}

            <div className="mt-6 border-t pt-4 space-y-2">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total</span>
                <span className="font-semibold">{formatMoney(invoice.total)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Paid</span>
                <span className="font-semibold text-green-700">{formatMoney(invoice.totalPaid)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Remaining</span>
                <span className="font-semibold">{formatMoney(invoice.remainingBalance)}</span>
              </div>
            </div>

            <div className="pt-2">
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                  invoice.status === 'POSTED'
                    ? 'bg-green-100 text-green-800'
                    : invoice.status === 'PAID'
                      ? 'bg-blue-100 text-blue-800'
                      : invoice.status === 'DRAFT'
                        ? 'bg-yellow-100 text-yellow-800'
                        : 'bg-gray-100 text-gray-800'
                }`}
              >
                {invoice.status}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BookOpen className="h-5 w-5" />
              Journal
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!showJournal && (
              <div className="rounded-md border bg-white p-4 text-sm text-muted-foreground">
                This invoice is <b>DRAFT</b>. No journal entry yet. Post the invoice first.
              </div>
            )}

            {showJournal && journals.length === 0 && (
              <div className="rounded-md border bg-white p-4 text-sm text-muted-foreground">
                No journal entries found yet.
              </div>
            )}

            {showJournal &&
              journals.map((je) => {
                const totalDebit = (je.lines ?? []).reduce(
                  (sum: number, l: any) => sum + Number(l.debit ?? 0),
                  0
                );
                const totalCredit = (je.lines ?? []).reduce(
                  (sum: number, l: any) => sum + Number(l.credit ?? 0),
                  0
                );

                return (
                  <div key={`${je.kind}-${je.journalEntryId}`} className="rounded-lg border bg-white">
                    <div className="flex items-center justify-between border-b px-4 py-3">
                      <div className="text-sm">
                        <div className="font-semibold">{je.kind === 'INVOICE_POSTED' ? 'Invoice Posted' : 'Payment'}</div>
                        <div className="text-muted-foreground">
                          {new Date(je.date).toLocaleDateString()} • JE #{je.journalEntryId}
                        </div>
                      </div>
                      <Link href={`/journal/${je.journalEntryId}`}>
                        <Button variant="ghost" size="sm">
                          View
                        </Button>
                      </Link>
                    </div>
                    <div className="p-4">
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
                            {(je.lines ?? []).map((l: any, idx: number) => (
                              <tr key={idx}>
                                <td className="px-2 py-2">
                                  <div className="font-medium">
                                    {l.account?.code ? `${l.account.code} ` : ''}
                                    {l.account?.name ?? '—'}
                                  </div>
                                </td>
                                <td className="px-2 py-2 text-right">{formatMoney(l.debit)}</td>
                                <td className="px-2 py-2 text-right">{formatMoney(l.credit)}</td>
                              </tr>
                            ))}
                            <tr className="border-b-0">
                              <td className="px-2 py-2 text-right font-semibold">Total</td>
                              <td className="px-2 py-2 text-right font-semibold">{formatMoney(totalDebit)}</td>
                              <td className="px-2 py-2 text-right font-semibold">{formatMoney(totalCredit)}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                );
              })}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Payments Received
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-100 px-1.5 text-xs font-semibold text-blue-800">
              {(invoice.payments ?? []).length}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {(invoice.payments ?? []).length === 0 && (
            <div className="text-sm text-muted-foreground">No payments yet.</div>
          )}

          {(invoice.payments ?? []).length > 0 && (
            <div className="relative w-full overflow-auto">
              <table className="w-full caption-bottom text-sm text-left">
                <thead className="[&_tr]:border-b">
                  <tr>
                    <th className="h-12 px-4 align-middle font-medium text-muted-foreground">Date</th>
                    <th className="h-12 px-4 align-middle font-medium text-muted-foreground">Payment #</th>
                    <th className="h-12 px-4 align-middle font-medium text-muted-foreground">Status</th>
                    <th className="h-12 px-4 align-middle font-medium text-muted-foreground">Payment Mode</th>
                    <th className="h-12 px-4 align-middle font-medium text-muted-foreground text-right">Amount</th>
                    <th className="h-12 px-4 align-middle font-medium text-muted-foreground text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="[&_tr:last-child]:border-0">
                  {invoice.payments.map((p: any) => {
                    const isReversed = !!p.reversedAt;
                    const statusLabel: 'Paid' | 'Reversed' = isReversed ? 'Reversed' : 'Paid';
                    return (
                      <tr key={p.id} className="border-b transition-colors hover:bg-muted/50">
                        <td className="p-4 align-middle">{new Date(p.paymentDate).toLocaleDateString()}</td>
                        <td className="p-4 align-middle font-medium text-blue-700">{p.id}</td>
                        <td className="p-4 align-middle">
                          <StatusPill status={statusLabel} />
                        </td>
                        <td className="p-4 align-middle">
                          <div className="font-medium">{p.bankAccount?.name ?? '—'}</div>
                          <div className="text-xs text-muted-foreground">
                            {p.journalEntryId ? `JE #${p.journalEntryId}` : 'No journal'}
                            {p.reversalJournalEntryId ? ` • Reversal JE #${p.reversalJournalEntryId}` : ''}
                          </div>
                        </td>
                        <td className="p-4 align-middle text-right font-medium">{formatMoney(p.amount)}</td>
                        <td className="p-4 align-middle text-right">
                          <details className="relative inline-block text-left">
                            <summary className="list-none cursor-pointer select-none text-blue-700 hover:underline">
                              Actions <span className="text-xs">▼</span>
                            </summary>
                            <div className="absolute right-0 z-20 mt-2 w-40 rounded-md border bg-white shadow-lg">
                              <button
                                type="button"
                                className="block w-full px-3 py-2 text-left text-sm text-slate-400 cursor-not-allowed"
                                disabled
                              >
                                Edit
                              </button>
                              <Link
                                href={p.journalEntryId ? `/journal/${p.journalEntryId}` : '#'}
                                className={`block w-full px-3 py-2 text-left text-sm ${
                                  p.journalEntryId ? 'text-slate-900 hover:bg-slate-50' : 'text-slate-400 cursor-not-allowed'
                                }`}
                                onClick={(e) => {
                                  if (!p.journalEntryId) e.preventDefault();
                                }}
                              >
                                View Journal
                              </Link>
                              <Link
                                href={p.reversalJournalEntryId ? `/journal/${p.reversalJournalEntryId}` : '#'}
                                className={`block w-full px-3 py-2 text-left text-sm ${
                                  p.reversalJournalEntryId
                                    ? 'text-slate-900 hover:bg-slate-50'
                                    : 'text-slate-400 cursor-not-allowed'
                                }`}
                                onClick={(e) => {
                                  if (!p.reversalJournalEntryId) e.preventDefault();
                                }}
                              >
                                View Refund Journal
                              </Link>
                              <button
                                type="button"
                                className={`block w-full px-3 py-2 text-left text-sm ${
                                  isReversed ? 'text-slate-400 cursor-not-allowed' : 'text-red-600 hover:bg-slate-50'
                                }`}
                                disabled={isReversed || reversingPaymentId === p.id}
                                onClick={() => openRefundModal(p)}
                              >
                                {reversingPaymentId === p.id ? 'Refunding...' : 'Refund'}
                              </button>
                            </div>
                          </details>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {(invoice.payments ?? []).some((p: any) => p.reversedAt && p.reversalReason) && (
                <div className="mt-3 text-xs text-muted-foreground">
                  Tip: click a payment’s JE number to trace the ledger entry; refunds are recorded as reversing journal entries.
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {refundModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white shadow-lg">
            <div className="border-b px-4 py-3">
              <div className="text-lg font-semibold">Refund payment</div>
              <div className="text-sm text-muted-foreground">
                Payment #{refundPayment?.id} • Amount {formatMoney(refundPayment?.amount)}
              </div>
            </div>
            <div className="px-4 py-4 space-y-3">
              <label className="text-sm font-medium">Reason (optional)</label>
              <textarea
                className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
                placeholder="e.g. Customer returned goods / Payment recorded to wrong account"
              />
              <div className="text-xs text-muted-foreground">
                This will create an immutable reversing journal entry. Nothing will be deleted.
              </div>
            </div>
            <div className="flex justify-end gap-3 border-t px-4 py-3">
              <Button
                variant="outline"
                onClick={() => {
                  setRefundModalOpen(false);
                  setRefundPayment(null);
                  setRefundReason('');
                }}
                disabled={reversingPaymentId === refundPayment?.id}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={confirmRefund}
                disabled={!refundPayment || reversingPaymentId === refundPayment?.id}
              >
                {reversingPaymentId === refundPayment?.id ? 'Refunding...' : 'Confirm Refund'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


