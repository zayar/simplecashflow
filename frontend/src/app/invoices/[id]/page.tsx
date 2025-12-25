"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import { ArrowLeft, ChevronDown, Loader2, Pencil } from "lucide-react"

import { useAuth } from "@/contexts/auth-context"
import { fetchApi } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { cn, formatDateInTimeZone } from "@/lib/utils"

function formatMoney(n: any) {
  const num = Number(n ?? 0)
  if (Number.isNaN(num)) return String(n ?? "")
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function formatMoneyWithCurrency(n: any, currency?: string) {
  const num = Number(n ?? 0)
  if (Number.isNaN(num)) return String(n ?? "")
  const cur = (currency ?? "").trim()
  return cur ? `${cur}${formatMoney(num)}` : formatMoney(num)
}

function statusBadge(status: string) {
  switch (status) {
    case "PAID":
      return <Badge variant="secondary">Paid</Badge>
    case "POSTED":
      return <Badge variant="outline">Posted</Badge>
    case "PARTIAL":
      return <Badge variant="outline">Partial</Badge>
    case "DRAFT":
      return <Badge variant="outline">Draft</Badge>
    default:
      return <Badge variant="outline">{status}</Badge>
  }
}

export default function InvoiceDetailPage() {
  const { user, companySettings } = useAuth()
  const router = useRouter()
  const params = useParams()
  const invoiceId = params.id
  const tz = companySettings?.timeZone ?? "Asia/Yangon"
  const companyName = companySettings?.name ?? "Company"

  const [invoice, setInvoice] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)
  const [reversingPaymentId, setReversingPaymentId] = useState<number | null>(
    null
  )

  const [refundModalOpen, setRefundModalOpen] = useState(false)
  const [refundPayment, setRefundPayment] = useState<any>(null)
  const [refundReason, setRefundReason] = useState("")

  const makeIdempotencyKey = () => {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
      ? (crypto as any).randomUUID()
      : `idem_${Date.now()}_${Math.random().toString(16).slice(2)}`
  }

  const loadInvoice = async () => {
    if (!user?.companyId || !invoiceId) return
    setLoading(true)
    try {
      const inv = await fetchApi(
        `/companies/${user.companyId}/invoices/${invoiceId}`
      )
      setInvoice(inv)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadInvoice()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.companyId, invoiceId])

  const postInvoice = async () => {
    if (!user?.companyId || !invoiceId) return
    if (posting) return
    if (!confirm("Post this invoice? This will create journal entries.")) return
    setPostError(null)
    setPosting(true)
    try {
      await fetchApi(`/companies/${user.companyId}/invoices/${invoiceId}/post`, {
        method: "POST",
        headers: { "Idempotency-Key": makeIdempotencyKey() },
        body: JSON.stringify({}),
      })
      await loadInvoice()
    } catch (err: any) {
      console.error(err)
      setPostError(err?.message ?? "Failed to post invoice")
    } finally {
      setPosting(false)
    }
  }

  const deleteInvoice = async () => {
    if (!user?.companyId || !invoiceId) return
    if (!confirm("Delete this invoice? This is only allowed for DRAFT/APPROVED invoices.")) return
    try {
      await fetchApi(`/companies/${user.companyId}/invoices/${invoiceId}`, {
        method: "DELETE",
      })
      router.push("/invoices")
    } catch (err: any) {
      console.error(err)
      alert(err?.message ?? "Failed to delete invoice")
    }
  }

  const reversePayment = async (paymentId: number, reason?: string) => {
    if (!user?.companyId || !invoiceId) return
    setReversingPaymentId(paymentId)
    try {
      await fetchApi(
        `/companies/${user.companyId}/invoices/${invoiceId}/payments/${paymentId}/reverse`,
        {
          method: "POST",
          headers: { "Idempotency-Key": makeIdempotencyKey() },
          body: JSON.stringify({ reason: reason || undefined }),
        }
      )
      await loadInvoice()
    } catch (err: any) {
      console.error(err)
      alert(err.message || "Failed to reverse payment")
    } finally {
      setReversingPaymentId(null)
    }
  }

  const openRefundDialog = (p: any) => {
    setRefundPayment(p)
    setRefundReason("")
    setRefundModalOpen(true)
  }

  const confirmRefund = async () => {
    if (!refundPayment) return
    await reversePayment(refundPayment.id, refundReason.trim() || undefined)
    setRefundModalOpen(false)
    setRefundPayment(null)
    setRefundReason("")
  }

  const journals = useMemo(() => (invoice?.journalEntries ?? []) as any[], [invoice])
  const showJournal = invoice?.status && invoice.status !== "DRAFT"

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/invoices">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Invoice</h1>
            <p className="text-sm text-muted-foreground">Loading…</p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Card className="shadow-sm">
            <CardContent className="pt-6 space-y-3">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-9 w-64" />
              <Skeleton className="h-24 w-full" />
            </CardContent>
          </Card>
          <Card className="shadow-sm">
            <CardContent className="pt-6 space-y-3">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-40 w-full" />
            </CardContent>
          </Card>
        </div>
      </div>
    )
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
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Invoice</h1>
            <p className="text-sm text-muted-foreground">Not found</p>
          </div>
        </div>
        <Card className="shadow-sm">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Invoice not found.
          </CardContent>
        </Card>
      </div>
    )
  }

  const canReceivePayment = invoice.status === "POSTED" || invoice.status === "PARTIAL"
  const invoiceLines = (invoice.lines ?? []) as any[]
  const grossSubtotal = invoiceLines.reduce((sum: number, l: any) => {
    const qty = Number(l.quantity ?? 0)
    const rate = Number(l.unitPrice ?? 0)
    return sum + qty * rate
  }, 0)
  const discountTotal = invoiceLines.reduce((sum: number, l: any) => {
    return sum + Math.max(0, Number(l.discountAmount ?? 0))
  }, 0)
  const netSubtotal = Math.max(0, grossSubtotal - discountTotal)
  const taxAmount = Number(invoice.taxAmount ?? 0)

  return (
    <div className="space-y-6">
      {/* Print styles: show the paper only */}
      <style jsx global>{`
        @media print {
          /* Hide everything by default, then show only the invoice paper area. */
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

          /* Explicitly hide non-invoice sections even if nested. */
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
          <Link href="/invoices">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Invoice</h1>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{invoice.invoiceNumber}</span>
              <span>•</span>
              <span>{invoice.customer?.name ?? "—"}</span>
              <span>•</span>
              {statusBadge(invoice.status)}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" onClick={() => window.print()}>
            Print
          </Button>
          {invoice.status === "DRAFT" ? (
            <>
              <Link href={`/invoices/${invoice.id}/edit`}>
                <Button variant="outline" className="gap-2">
                  <Pencil className="h-4 w-4" /> Edit
                </Button>
              </Link>
              <Button onClick={postInvoice} disabled={posting}>
                {posting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {posting ? "Posting..." : "Post"}
              </Button>
            </>
          ) : null}
          {canReceivePayment && (
            <Link href={`/invoices/${invoice.id}/payment`}>
              <Button>Record payment</Button>
            </Link>
          )}
        </div>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" className="gap-2">
                Actions <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => router.push(`/credit-notes/new?invoiceId=${invoice.id}`)}
              >
                Create Credit Note (Return)
              </DropdownMenuItem>
              {invoice.status !== "POSTED" &&
              invoice.status !== "PAID" &&
              invoice.status !== "PARTIAL" &&
              !invoice.journalEntryId ? (
                <DropdownMenuItem
                  onClick={deleteInvoice}
                  className="text-destructive focus:text-destructive"
                >
                  Delete invoice
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {postError ? (
        <div className="no-print text-sm text-red-600">{postError}</div>
      ) : null}

      {/* Invoice paper preview */}
      <div className="print-area rounded-lg border bg-muted/20 p-4 sm:p-6">
        <div className="print-paper mx-auto max-w-4xl rounded-lg border bg-white shadow-sm">
          <div className="p-6 sm:p-10">
            {/* Header */}
            <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-2">
                <div className="text-xl font-semibold tracking-tight">{companyName}</div>
                <div className="text-sm text-muted-foreground">
                  <div>Address line (optional)</div>
                  <div>City, Country</div>
                </div>
              </div>

              <div className="space-y-2 text-left sm:text-right">
                <div className="text-3xl font-semibold tracking-tight">Invoice</div>
                <div className="text-sm text-muted-foreground">
                  <div>
                    <span className="font-medium text-foreground">#{invoice.invoiceNumber}</span>
                  </div>
                  <div className="mt-1">{statusBadge(invoice.status)}</div>
                </div>
                <div className="mt-3 rounded-md bg-slate-50 p-3 text-sm">
                  <div className="text-xs font-medium text-muted-foreground">Balance Due</div>
                  <div className="text-lg font-semibold tabular-nums">
                    {formatMoneyWithCurrency(invoice.remainingBalance, invoice.currency)}
                  </div>
                </div>
              </div>
            </div>

            <div className="my-8 border-t" />

            {/* Bill to + meta */}
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Bill To
                </div>
                <div className="text-base font-semibold">{invoice.customer?.name ?? "—"}</div>
                <div className="text-sm text-muted-foreground">Customer address (optional)</div>
              </div>

              <div className="space-y-2 sm:justify-self-end sm:text-right">
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <div className="text-muted-foreground">Invoice Date</div>
                  <div className="font-medium">{formatDateInTimeZone(invoice.invoiceDate, tz)}</div>
                  <div className="text-muted-foreground">Due Date</div>
                  <div className="font-medium">
                    {invoice.dueDate ? formatDateInTimeZone(invoice.dueDate, tz) : "—"}
                  </div>
                  <div className="text-muted-foreground">Branch</div>
                  <div className="font-medium">{invoice.warehouse?.name ?? "—"}</div>
                  <div className="text-muted-foreground">Terms</div>
                  <div className="font-medium">{invoice.dueDate ? "Net" : "—"}</div>
                </div>
              </div>
            </div>

            <div className="my-8 border-t" />

            {/* Lines */}
            <div className="overflow-hidden rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">#</th>
                    <th className="px-4 py-3 text-left font-medium">Item</th>
                    <th className="px-4 py-3 text-right font-medium">Qty</th>
                    <th className="px-4 py-3 text-right font-medium">Rate</th>
                    <th className="px-4 py-3 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {invoiceLines.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                        No invoice lines.
                      </td>
                    </tr>
                  ) : (
                    invoiceLines.map((l: any, idx: number) => {
                      const qty = Number(l.quantity ?? 0)
                      const rate = Number(l.unitPrice ?? 0)
                      const discount = Math.max(0, Number(l.discountAmount ?? 0))
                      const amount = Math.max(0, qty * rate - discount)
                      const itemName = l.item?.name ?? (l.description ?? "—")
                      const desc = String(l.description ?? "").trim()
                      const showDesc = Boolean(desc && l.item?.name && desc !== l.item.name)
                      return (
                        <tr key={l.id ?? idx} className={idx % 2 === 0 ? "bg-white" : "bg-slate-50/30"}>
                          <td className="px-4 py-3 text-muted-foreground">{idx + 1}</td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-slate-900">{itemName}</div>
                            {showDesc ? <div className="mt-1 text-xs text-muted-foreground">{desc}</div> : null}
                            {discount > 0 ? (
                              <div className="mt-1 text-xs text-muted-foreground">
                                Discount: {formatMoneyWithCurrency(discount, invoice.currency)}
                              </div>
                            ) : null}
                          </td>
                          <td className="px-4 py-3 text-right font-medium tabular-nums">{formatMoney(qty)}</td>
                          <td className="px-4 py-3 text-right font-medium tabular-nums">
                            {formatMoneyWithCurrency(rate, invoice.currency)}
                          </td>
                          <td className="px-4 py-3 text-right font-medium tabular-nums">
                            {formatMoneyWithCurrency(amount, invoice.currency)}
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Totals */}
            <div className="mt-6 grid gap-6 sm:grid-cols-2">
              <div className="text-sm text-muted-foreground space-y-4">
                {(invoice.customerNotes ?? "").trim() ? (
                  <div>
                    <div className="font-medium text-slate-900">Customer Notes</div>
                    <div className="mt-1 whitespace-pre-wrap">{invoice.customerNotes}</div>
                  </div>
                ) : null}

                {(invoice.termsAndConditions ?? "").trim() ? (
                  <div>
                    <div className="font-medium text-slate-900">Terms &amp; Conditions</div>
                    <div className="mt-1 whitespace-pre-wrap">{invoice.termsAndConditions}</div>
                  </div>
                ) : null}

                {!(invoice.customerNotes ?? "").trim() && !(invoice.termsAndConditions ?? "").trim() ? (
                  <div>
                    <div className="font-medium text-slate-900">Notes</div>
                    <div className="mt-1">—</div>
                  </div>
                ) : null}
              </div>

              <div className="sm:justify-self-end sm:text-right">
                <div className="ml-auto w-full max-w-sm space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Sub Total</span>
                    <span className="font-medium tabular-nums">
                      {formatMoneyWithCurrency(grossSubtotal, invoice.currency)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Discount</span>
                    <span className="font-medium tabular-nums">
                      {formatMoneyWithCurrency(discountTotal, invoice.currency)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Tax</span>
                    <span className="font-medium tabular-nums">
                      {formatMoneyWithCurrency(taxAmount, invoice.currency)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Total</span>
                    <span className="font-semibold tabular-nums">
                      {formatMoneyWithCurrency(invoice.total, invoice.currency)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Payment Made</span>
                    <span className="font-medium tabular-nums">
                      {formatMoneyWithCurrency(invoice.totalPaid, invoice.currency)}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between border-t pt-2">
                    <span className="font-semibold">Balance Due</span>
                    <span className="font-semibold tabular-nums">
                      {formatMoneyWithCurrency(invoice.remainingBalance, invoice.currency)}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Payment info */}
            {(invoice.payments ?? []).length > 0 ? (
              <div className="no-print mt-10">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-semibold">Payments Received</div>
                  <Badge variant="secondary">{(invoice.payments ?? []).length}</Badge>
                </div>
                <div className="overflow-hidden rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="px-4 py-2 text-left font-medium">Date</th>
                        <th className="px-4 py-2 text-left font-medium">Account</th>
                        <th className="px-4 py-2 text-right font-medium">Amount</th>
                        <th className="px-4 py-2 text-right font-medium no-print">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {(invoice.payments ?? []).map((p: any) => {
                        const isReversed = !!p.reversedAt
                        const isWorking = reversingPaymentId === p.id
                        return (
                          <tr key={p.id}>
                            <td className="px-4 py-2 text-muted-foreground">
                              {formatDateInTimeZone(p.paymentDate, tz)}
                            </td>
                            <td className="px-4 py-2">
                              <div className="font-medium">{p.bankAccount?.name ?? "—"}</div>
                              <div className="mt-1">
                                {isReversed ? (
                                  <Badge variant="destructive">Reversed</Badge>
                                ) : (
                                  <Badge variant="secondary">Paid</Badge>
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-2 text-right font-medium tabular-nums">
                              {formatMoneyWithCurrency(p.amount, invoice.currency)}
                            </td>
                            <td className="px-4 py-2 text-right no-print">
                              <DropdownMenu modal={false}>
                                <DropdownMenuTrigger
                                  className={cn(
                                    buttonVariants({ variant: "outline", size: "sm" }),
                                    "gap-2"
                                  )}
                                  type="button"
                                >
                                  Actions <ChevronDown className="h-4 w-4 opacity-60" />
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem
                                    disabled={isReversed || isWorking}
                                    onClick={() => openRefundDialog(p)}
                                    className="text-destructive focus:text-destructive"
                                  >
                                    {isWorking ? "Refunding..." : "Refund (reverse)"}
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <Card className="shadow-sm no-print">
        <CardHeader>
          <CardTitle className="text-lg">Journal entries</CardTitle>
        </CardHeader>
        <CardContent className="space-y-8">
          {!showJournal ? (
            <div className="text-sm text-muted-foreground">
              This invoice is <b>DRAFT</b>. Post it before accounting entries are created.
            </div>
          ) : null}

          {showJournal && journals.length === 0 ? (
            <div className="text-sm text-muted-foreground">No journal entries found yet.</div>
          ) : null}

          {showJournal &&
            journals.map((je) => {
              const totalDebit = (je.lines ?? []).reduce(
                (sum: number, l: any) => sum + Number(l.debit ?? 0),
                0
              )
              const totalCredit = (je.lines ?? []).reduce(
                (sum: number, l: any) => sum + Number(l.credit ?? 0),
                0
              )

              const typeLabel =
                je.kind === "INVOICE_POSTED"
                  ? "Invoice posted"
                  : je.kind === "PAYMENT" || je.kind === "PAYMENT_RECORDED"
                    ? "Payment received"
                    : je.kind === "PAYMENT_REVERSAL"
                      ? "Payment reversal"
                      : "Journal entry"

              return (
                <div key={`${je.kind}-${je.journalEntryId}`} className="space-y-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="space-y-0.5">
                      <div className="text-sm font-medium">{typeLabel}</div>
                      <div className="text-xs text-muted-foreground">
                        JE #{je.journalEntryId} • {formatDateInTimeZone(je.date, tz)}
                      </div>
                    </div>
                    <Badge variant="outline">Balanced</Badge>
                  </div>

                  <div className="rounded-lg border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Account</TableHead>
                          <TableHead className="w-[140px]">Branch</TableHead>
                          <TableHead className="text-right w-[140px]">Debit</TableHead>
                          <TableHead className="text-right w-[140px]">Credit</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(je.lines ?? []).map((l: any, idx: number) => (
                          <TableRow key={idx}>
                            <TableCell>
                              <div className="font-medium">{l.account?.name ?? "—"}</div>
                              <div className="text-xs text-muted-foreground">{l.account?.code ?? ""}</div>
                            </TableCell>
                            <TableCell className="text-muted-foreground">Head Office</TableCell>
                            <TableCell className="text-right font-medium tabular-nums">
                              {Number(l.debit) > 0 ? formatMoney(l.debit) : "0.00"}
                            </TableCell>
                            <TableCell className="text-right font-medium tabular-nums">
                              {Number(l.credit) > 0 ? formatMoney(l.credit) : "0.00"}
                            </TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="bg-muted/40">
                          <TableCell colSpan={2} className="text-right font-medium">
                            Totals
                          </TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">
                            {formatMoney(totalDebit)}
                          </TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">
                            {formatMoney(totalCredit)}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )
            })}
        </CardContent>
      </Card>

      <Dialog open={refundModalOpen} onOpenChange={setRefundModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Refund payment</DialogTitle>
            <DialogDescription>
              Payment #{refundPayment?.id} • Amount{" "}
              {formatMoneyWithCurrency(refundPayment?.amount, invoice?.currency)}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <div className="text-sm font-medium">Reason (optional)</div>
            <Textarea
              value={refundReason}
              onChange={(e) => setRefundReason(e.target.value)}
              placeholder="e.g. Payment recorded to wrong account"
              className="min-h-24"
            />
            <div className="text-xs text-muted-foreground">
              This creates a reversing journal entry. Nothing is deleted.
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setRefundModalOpen(false)
                setRefundPayment(null)
                setRefundReason("")
              }}
              disabled={reversingPaymentId === refundPayment?.id}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={confirmRefund}
              disabled={!refundPayment || reversingPaymentId === refundPayment?.id}
            >
              {reversingPaymentId === refundPayment?.id ? "Refunding..." : "Confirm refund"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}


