'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi, getInvoiceTemplate, unapplyCreditNote, type InvoiceTemplate } from '@/lib/api';
import { formatDateInTimeZone } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ArrowLeft, Loader2, Pencil } from 'lucide-react';
import { InvoicePaper } from '@/components/invoice/InvoicePaper';

function formatMoney(n: any) {
  const num = Number(n ?? 0);
  if (Number.isNaN(num)) return String(n ?? '');
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function CreditNoteDetailPage() {
  const { user, companySettings } = useAuth();
  const params = useParams();
  const id = params.id;
  const tz = companySettings?.timeZone ?? 'Asia/Yangon';
  const companyName = companySettings?.name ?? 'Company';

  const [cn, setCn] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [unapplying, setUnapplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [template, setTemplate] = useState<InvoiceTemplate | null>(null);

  async function refresh() {
    if (!user?.companyId || !id) return;
    setLoading(true);
    try {
      const data = await fetchApi(`/companies/${user.companyId}/credit-notes/${id}`);
      setCn(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.companyId, id]);

  useEffect(() => {
    if (!user?.companyId) return;
    getInvoiceTemplate(user.companyId)
      .then((t) => setTemplate(t))
      .catch(() => setTemplate(null));
  }, [user?.companyId]);

  async function post() {
    if (!user?.companyId || !id) return;
    setError(null);
    setPosting(true);
    try {
      await fetchApi(`/companies/${user.companyId}/credit-notes/${id}/post`, { method: 'POST', body: JSON.stringify({}) });
      await refresh();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setPosting(false);
    }
  }

  async function deleteDraft() {
    if (!user?.companyId || !id) return;
    if (deleting) return;
    if (!confirm('Delete this credit note? This is only allowed for DRAFT/APPROVED credit notes.')) return;
    setError(null);
    setDeleting(true);
    try {
      await fetchApi(`/companies/${user.companyId}/credit-notes/${id}`, { method: 'DELETE' });
      // back to list
      if (typeof window !== 'undefined') window.location.assign('/credit-notes');
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setDeleting(false);
    }
  }

  async function removeFromInvoice() {
    if (!user?.companyId || !id) return;
    if (unapplying) return;
    if (!confirm('Remove this credit note from the applied invoice?')) return;
    setError(null);
    setUnapplying(true);
    try {
      await unapplyCreditNote(user.companyId, Number(id));
      await refresh();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setUnapplying(false);
    }
  }

  const missingAccountLines = useMemo(() => {
    const lines = (cn?.lines ?? []) as any[];
    const missing: number[] = [];
    for (let idx = 0; idx < lines.length; idx++) {
      const l = lines[idx];
      if (!l?.incomeAccountId) missing.push(idx + 1);
    }
    return missing;
  }, [cn]);

  const canPost = useMemo(() => cn?.status === 'DRAFT' && missingAccountLines.length === 0, [cn, missingAccountLines]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/credit-notes">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Credit Note</h1>
            <p className="text-sm text-muted-foreground">Loading…</p>
          </div>
        </div>
        <Card className="shadow-sm">
          <CardContent className="pt-6 space-y-3">
            <Skeleton className="h-7 w-72" />
            <Skeleton className="h-64 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!cn) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/credit-notes">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Credit Note</h1>
            <p className="text-sm text-muted-foreground">Not found</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Print styles: show the paper only */}
      <style jsx global>{`
        @media print {
          body * {
            visibility: hidden !important;
          }
          .print-area,
          .print-area * {
            visibility: visible !important;
          }
          .print-area {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
          }
          .no-print {
            display: none !important;
            visibility: hidden !important;
          }
          .print-paper {
            box-shadow: none !important;
            border: none !important;
          }
          body {
            background: white !important;
          }
        }
      `}</style>

      {/* Top actions */}
      <div className="no-print flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <Link href="/credit-notes">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Credit Note</h1>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{cn.creditNoteNumber ?? `CN-${cn.id}`}</span>
              <span>•</span>
              <span>{cn.customer?.name ?? '—'}</span>
              <span>•</span>
              <Badge variant={cn.status === 'POSTED' ? 'secondary' : 'outline'}>{cn.status}</Badge>
              <span>•</span>
              <span>{formatDateInTimeZone(cn.creditNoteDate, tz)}</span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" onClick={() => window.print()}>Print</Button>
          {cn.status === 'POSTED' && Number(cn.creditsRemaining ?? 0) > 0 ? (
            <Link href={`/credit-notes/${cn.id}/refund`}>
              <Button variant="outline">Refund</Button>
            </Link>
          ) : null}
          {cn.journalEntryId ? (
            <Link href={`/journal/${cn.journalEntryId}`}>
              <Button variant="outline">View Journal Entry</Button>
            </Link>
          ) : null}
          {(cn.status === 'DRAFT' || cn.status === 'APPROVED') ? (
            <>
              {cn.status === 'DRAFT' ? (
                <Link href={`/credit-notes/${cn.id}/edit`}>
                  <Button variant="outline" className="gap-2">
                    <Pencil className="h-4 w-4" /> Edit
                  </Button>
                </Link>
              ) : null}
              {cn.status === 'DRAFT' ? (
                <Button
                  onClick={post}
                  disabled={posting || !canPost}
                  title={!canPost ? 'Set an income account for all lines before posting.' : undefined}
                >
                  {posting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Post Credit Note
                </Button>
              ) : null}
              {!cn.journalEntryId ? (
                <Button variant="destructive" onClick={deleteDraft} disabled={deleting || posting}>
                  {deleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {deleting ? 'Deleting…' : 'Delete'}
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {/* Credit Note paper preview (uses the same invoice template renderer) */}
      <div className="print-area rounded-lg border bg-muted/20 p-4 sm:p-6">
        <div className="print-paper mx-auto max-w-4xl rounded-lg border bg-white shadow-sm">
          <div className="p-0">
            {(() => {
              const refunded = Math.max(0, Number((cn as any).amountRefunded ?? 0));
              const applied = Math.max(0, Number((cn as any).amountApplied ?? 0));
              const showRefunded = refunded > 0;
              // In the paper totals block, show "Refunded" when refunds exist (instead of lumping it into "Credit used").
              const settledLabel = showRefunded ? 'Refunded' : 'Credit used';
              const settledValue = showRefunded ? refunded : Math.max(0, Number(cn.total ?? 0) - Number(cn.creditsRemaining ?? 0));
              return (
            <InvoicePaper
              invoice={{
                invoiceNumber: cn.creditNoteNumber ?? `CN-${cn.id}`,
                status: cn.status,
                invoiceDate: cn.creditNoteDate,
                dueDate: null,
                currency: cn.currency ?? null,
                total: cn.total ?? 0,
                totalPaid: settledValue,
                remainingBalance: cn.creditsRemaining ?? 0,
                customer: { name: cn.customer?.name ?? null },
                location: { name: cn.location?.name ?? cn.warehouse?.name ?? null },
                warehouse: { name: cn.warehouse?.name ?? null },
                customerNotes: cn.customerNotes ?? null,
                termsAndConditions: cn.termsAndConditions ?? null,
                taxAmount: cn.taxAmount ?? 0,
                lines: (cn.lines ?? []).map((l: any) => ({
                  id: l.id,
                  quantity: l.quantity,
                  unitPrice: l.unitPrice,
                  discountAmount: 0,
                  description: l.description ?? null,
                  item: l.item ?? null,
                })),
              } as any}
              companyName={companyName}
              tz={tz}
              template={template}
              documentTitle="Credit Note"
              partyLabel="Customer"
              dateLabel="Credit Note Date"
              dueDateLabel="—"
              locationLabel="Location"
              rateLabel="Unit price"
              balanceLabel="Credits remaining"
              settledLabel={settledLabel}
            />
              );
            })()}
          </div>
        </div>
      </div>

      {/* Everything below is details UI (hide on print; printed output should be paper only) */}
      {error && <div className="no-print text-sm text-red-600">{error}</div>}
      {cn?.status === 'DRAFT' && missingAccountLines.length > 0 ? (
        <div className="no-print rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm">
          <div className="font-medium">Account mapping required to post</div>
          <div className="text-muted-foreground">
            Please select an income account for line(s): <b>{missingAccountLines.join(', ')}</b>. You can still keep this as a draft.
          </div>
        </div>
      ) : null}

      <Card className="no-print shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <div>
            <div className="text-xs text-muted-foreground">Customer</div>
            <div className="font-medium">{cn.customer?.name ?? '—'}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Total</div>
            <div className="font-semibold tabular-nums">{formatMoney(cn.total)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Credits remaining</div>
            <div className="font-semibold tabular-nums">{formatMoney(cn.creditsRemaining ?? 0)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Applied (to invoices)</div>
            <div className="font-medium tabular-nums">{formatMoney((cn as any).amountApplied ?? 0)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Refunded</div>
            <div className="font-medium tabular-nums">{formatMoney((cn as any).amountRefunded ?? 0)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Subtotal / Tax</div>
            <div className="font-medium tabular-nums">
              {formatMoney(cn.subtotal ?? 0)} / {formatMoney(cn.taxAmount ?? 0)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Journal Entry</div>
            <div className="font-medium">{cn.journalEntryId ? `JE #${cn.journalEntryId}` : '—'}</div>
          </div>
        </CardContent>
      </Card>

      {Array.isArray((cn as any).applications) && (cn as any).applications.length > 0 ? (
        <Card className="no-print shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-lg">Credit Applied Invoices</CardTitle>
            {((cn as any).applications ?? []).length === 1 ? (
              <Button variant="outline" onClick={removeFromInvoice} disabled={unapplying}>
                {unapplying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Remove
              </Button>
            ) : null}
          </CardHeader>
          <CardContent className="pt-0">
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead className="w-[160px]">Applied Date</TableHead>
                    <TableHead>Invoice Number</TableHead>
                    <TableHead className="text-right">Amount Credited</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {((cn as any).applications ?? []).map((a: any) => (
                    <TableRow key={a.id}>
                      <TableCell className="text-muted-foreground">{String(a.appliedDate ?? '').slice(0, 10)}</TableCell>
                      <TableCell className="font-medium">
                        <Link href={`/invoices/${a.invoice?.id ?? a.invoiceId}`} className="text-primary hover:underline">
                          {a.invoice?.invoiceNumber ?? `#${a.invoiceId}`}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{formatMoney(a.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {((cn as any).applications ?? []).length > 1 ? (
              <div className="mt-2 text-xs text-muted-foreground">
                This credit note is applied to multiple invoices. To unapply, please unapply from the invoice side (v2).
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {(cn.refunds ?? []).length > 0 ? (
        <Card className="no-print shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Refunds</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead className="w-[160px]">Date</TableHead>
                    <TableHead>From account</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="w-[120px]">Journal</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(cn.refunds ?? []).map((r: any) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-muted-foreground">{String(r.refundDate ?? '').slice(0, 10)}</TableCell>
                      <TableCell className="font-medium">
                        {r.bankAccount?.code ? `${r.bankAccount.code} - ` : ''}{r.bankAccount?.name ?? '—'}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{formatMoney(r.amount)}</TableCell>
                      <TableCell>
                        {r.journalEntryId ? (
                          <Link className="text-sm text-blue-600 hover:underline" href={`/journal/${r.journalEntryId}`}>
                            View
                          </Link>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className="no-print shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Lines</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right w-[120px]">Qty</TableHead>
                  <TableHead className="text-right w-[140px]">Unit price</TableHead>
                  <TableHead className="text-right w-[140px]">Tax</TableHead>
                  <TableHead className="text-right w-[160px]">Line total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(cn.lines ?? []).map((l: any) => (
                  <TableRow key={l.id}>
                    <TableCell>
                      <div className="font-medium">{l.item?.name ?? '—'}</div>
                      <div className="text-xs text-muted-foreground">{l.description ?? ''}</div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(l.quantity)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(l.unitPrice)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(l.taxAmount ?? 0)}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatMoney(Number(l.lineTotal ?? 0) + Number(l.taxAmount ?? 0))}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/40">
                  <TableCell colSpan={4} className="text-right font-medium">Total</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{formatMoney(cn.total)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {(cn.customerNotes || cn.termsAndConditions) ? (
        <Card className="no-print shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Notes &amp; Terms</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {cn.customerNotes ? (
              <div>
                <div className="text-xs text-muted-foreground">Customer Notes</div>
                <div className="whitespace-pre-wrap">{cn.customerNotes}</div>
              </div>
            ) : null}
            {cn.termsAndConditions ? (
              <div>
                <div className="text-xs text-muted-foreground">Terms &amp; Conditions</div>
                <div className="whitespace-pre-wrap">{cn.termsAndConditions}</div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {cn.journalEntry ? (
        <Card className="no-print shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Journal Entry</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
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
                  {(cn.journalEntry.lines ?? []).map((jl: any) => (
                    <TableRow key={jl.id}>
                      <TableCell>
                        <div className="font-medium">
                          {jl.account?.code ? `${jl.account.code} ` : ''}
                          {jl.account?.name ?? '—'}
                        </div>
                        <div className="text-xs text-muted-foreground">{jl.account?.type ?? ''}</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{Number(jl.debit) !== 0 ? formatMoney(jl.debit) : '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{Number(jl.credit) !== 0 ? formatMoney(jl.credit) : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}


