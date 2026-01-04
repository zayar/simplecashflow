"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import { ArrowLeft, ChevronDown, Loader2, Pencil } from "lucide-react"

import { useAuth } from "@/contexts/auth-context"
import {
  createPublicInvoiceLink,
  fetchApi,
  getExchangeRates,
  getInvoiceTemplate,
  type InvoiceTemplate,
} from "@/lib/api"
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
import { InvoicePaper } from "@/components/invoice/InvoicePaper"

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
  const [template, setTemplate] = useState<InvoiceTemplate | null>(null)
  const [fxInfo, setFxInfo] = useState<{ displayCurrency: string; rateToBase: number; asOfDate: string | null } | null>(null)
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)
  const [reversingPaymentId, setReversingPaymentId] = useState<number | null>(
    null
  )

  const [refundModalOpen, setRefundModalOpen] = useState(false)
  const [refundPayment, setRefundPayment] = useState<any>(null)
  const [refundReason, setRefundReason] = useState("")
  const [shareError, setShareError] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)

  // Payment proof viewer (thumbnail -> modal)
  const [proofViewerOpen, setProofViewerOpen] = useState(false)
  const [activeProof, setActiveProof] = useState<any>(null)

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

  const baseCurrency = useMemo(() => {
    const cur = (companySettings?.baseCurrency ?? "").trim().toUpperCase()
    return cur || null
  }, [companySettings?.baseCurrency])

  const customerCurrency = useMemo(() => {
    const cur = (invoice?.customer?.currency ?? "").trim().toUpperCase()
    return cur || null
  }, [invoice?.customer?.currency])

  useEffect(() => {
    loadInvoice()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.companyId, invoiceId])

  // FX (display-only): if customer currency differs from base currency, fetch the latest rate.
  useEffect(() => {
    if (!user?.companyId) return
    if (!baseCurrency || !customerCurrency) {
      setFxInfo(null)
      return
    }
    if (customerCurrency === baseCurrency) {
      setFxInfo(null)
      return
    }

    let cancelled = false
    getExchangeRates(user.companyId, customerCurrency)
      .then((rows) => {
        if (cancelled) return
        const invoiceDateStr = String(invoice?.invoiceDate ?? "").slice(0, 10)
        const invoiceDate = invoiceDateStr ? new Date(invoiceDateStr) : null
        const pick =
          (rows ?? []).find((r) => {
            if (!invoiceDate) return true
            const d = new Date(String((r as any).asOfDate ?? ""))
            if (Number.isNaN(d.getTime())) return false
            return d.getTime() <= invoiceDate.getTime()
          }) ?? (rows ?? [])[0]

        const rate = pick ? Number((pick as any).rateToBase) : 0
        if (!pick || !Number.isFinite(rate) || rate <= 0) {
          setFxInfo(null)
          return
        }
        setFxInfo({ displayCurrency: customerCurrency, rateToBase: rate, asOfDate: (pick as any).asOfDate ?? null })
      })
      .catch(() => {
        if (cancelled) return
        setFxInfo(null)
      })

    return () => {
      cancelled = true
    }
  }, [user?.companyId, baseCurrency, customerCurrency, invoice?.invoiceDate])

  useEffect(() => {
    if (!user?.companyId) return
    let cancelled = false
    getInvoiceTemplate(user.companyId)
      .then((t) => {
        if (cancelled) return
        setTemplate(t)
      })
      .catch(() => {
        // best-effort; invoice can still render with defaults
      })
    return () => {
      cancelled = true
    }
  }, [user?.companyId])

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

  const shareInvoice = async () => {
    if (!user?.companyId || !invoiceId) return
    if (sharing) return
    setShareError(null)
    setSharing(true)
    try {
      const { token } = await createPublicInvoiceLink(user.companyId, Number(invoiceId))
      const url = `${window.location.origin}/public/invoices/${encodeURIComponent(token)}`
      const title = invoice?.invoiceNumber ? `Invoice ${invoice.invoiceNumber}` : "Invoice"
      const text = invoice?.customer?.name ? `Invoice for ${invoice.customer.name}` : "Invoice link"

      // Try native share sheet first (mobile). If it fails or is cancelled, fall back to copy/prompt.
      if (navigator.share) {
        try {
          await navigator.share({ title, text, url })
          return
        } catch {
          // ignore and fall back
        }
      }

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
        window.alert("Invoice link copied.")
        return
      }

      window.prompt("Copy invoice link:", url)
    } catch (e: any) {
      setShareError(e?.message ?? "Failed to generate share link")
    } finally {
      setSharing(false)
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
  const creditsAvailable = Number((invoice as any)?.creditsAvailable ?? 0)
  const canApplyCredits = canReceivePayment && creditsAvailable > 0 && Number((invoice as any)?.remainingBalance ?? 0) > 0

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
          <Button variant="outline" onClick={shareInvoice} disabled={sharing}>
            {sharing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Share link
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

      {shareError ? <div className="no-print text-sm text-red-600">{shareError}</div> : null}

      {canApplyCredits ? (
        <div className="no-print rounded-lg border bg-background px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm">
              <span className="font-medium">Credits Available:</span>{" "}
              <span className="font-semibold tabular-nums">
                {formatMoneyWithCurrency(creditsAvailable, invoice?.currency)}
              </span>
            </div>
            <Link href={`/invoices/${invoice.id}/apply-credits`} className="text-sm text-primary hover:underline">
              Apply Now
            </Link>
          </div>
        </div>
      ) : null}

      {/* Pending Payment Proofs from Customer */}
      {Array.isArray(invoice?.pendingPaymentProofs) && invoice.pendingPaymentProofs.length > 0 && (
        <Card className="no-print border-amber-200 bg-amber-50/40">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <span className="text-lg">📷</span>
              Customer Payment Proofs
              <Badge variant="secondary" className="bg-amber-100 text-amber-700">
                {invoice.pendingPaymentProofs.length} pending
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Customer uploaded proof images. Click a thumbnail to preview; then record the payment.
            </p>

            {/* Compact, non-overwhelming thumbnail strip (prevents giant tiles on wide screens) */}
            <div className="mt-4 flex gap-3 overflow-x-auto pb-2">
              {invoice.pendingPaymentProofs.map((proof: any, idx: number) => (
                <button
                  key={`${proof?.url ?? idx}`}
                  type="button"
                  onClick={() => {
                    setActiveProof({ ...proof, idx })
                    setProofViewerOpen(true)
                  }}
                  className="group relative h-28 w-28 shrink-0 overflow-hidden rounded-lg border bg-white shadow-sm transition hover:border-amber-300 hover:shadow-md"
                  title="Click to preview"
                >
                  <img
                    src={proof.url}
                    alt={`Payment proof ${idx + 1}`}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 to-transparent px-2 pb-1 pt-6 text-left opacity-0 transition group-hover:opacity-100">
                    <div className="text-[11px] font-medium text-white">
                      Proof {idx + 1}
                    </div>
                  </div>
                </button>
              ))}
            </div>

            <div className="mt-2 text-xs text-muted-foreground">
              Tip: You can attach one of these proofs when recording a payment.
            </div>

            {canReceivePayment && (
              <div className="mt-4 pt-4 border-t border-amber-200">
                <Link href={`/invoices/${invoice.id}/payment`}>
                  <Button className="w-full sm:w-auto">
                    Record Payment with Proof
                  </Button>
                </Link>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Proof viewer modal */}
      <Dialog open={proofViewerOpen} onOpenChange={(o) => { setProofViewerOpen(o); if (!o) setActiveProof(null) }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Payment proof</DialogTitle>
            <DialogDescription>
              {activeProof?.submittedAt ? formatDateInTimeZone(activeProof.submittedAt, tz) : "—"}
              {activeProof?.note ? ` • ${activeProof.note}` : ""}
            </DialogDescription>
          </DialogHeader>

          {activeProof?.url ? (
            <div className="overflow-hidden rounded-lg border bg-white">
              <img
                src={activeProof.url}
                alt={`Payment proof ${Number(activeProof.idx ?? 0) + 1}`}
                className="max-h-[70vh] w-full object-contain"
              />
            </div>
          ) : null}

          <DialogFooter className="gap-2 sm:gap-0">
            {activeProof?.url ? (
              <a
                href={activeProof.url}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ variant: "outline" }))}
              >
                Open original
              </a>
            ) : null}
            <Button type="button" onClick={() => setProofViewerOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Invoice paper preview */}
      <div className="print-area rounded-lg border bg-muted/20 p-4 sm:p-6">
        <div className="print-paper mx-auto max-w-4xl rounded-lg border bg-white shadow-sm">
          <div className="p-0">
            <InvoicePaper
              invoice={invoice}
              companyName={companyName}
              tz={tz}
              template={template}
              displayCurrency={fxInfo?.displayCurrency ?? null}
              baseCurrency={baseCurrency ?? invoice?.currency ?? null}
              fxRateToBase={fxInfo?.rateToBase ?? null}
            />

            {/* Payment info */}
            {(invoice.payments ?? []).length > 0 ? (
              <div className="no-print mt-10 px-6 pb-6 sm:px-10 sm:pb-10">
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
                              <div className="font-medium">
                                {p.bankAccount?.name ?? "—"}
                                {p.attachmentUrl && (
                                  <a
                                    href={p.attachmentUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="ml-2 inline-flex items-center text-blue-600 hover:text-blue-800"
                                    title="View payment proof"
                                  >
                                    📎
                                  </a>
                                )}
                              </div>
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
                          <TableHead className="w-[140px]">Location</TableHead>
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


