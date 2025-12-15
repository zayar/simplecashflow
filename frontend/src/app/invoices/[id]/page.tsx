"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { ArrowLeft, ChevronDown } from "lucide-react"

import { useAuth } from "@/contexts/auth-context"
import { fetchApi } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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

function formatMoney(n: any) {
  const num = Number(n ?? 0)
  if (Number.isNaN(num)) return String(n ?? "")
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 })
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
  const { user } = useAuth()
  const params = useParams()
  const invoiceId = params.id

  const [invoice, setInvoice] = useState<any>(null)
  const [loading, setLoading] = useState(true)
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

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
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

        {canReceivePayment && (
          <Link href={`/invoices/${invoice.id}/payment`}>
            <Button>Record payment</Button>
          </Link>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="grid gap-1">
              <div className="text-muted-foreground">Invoice date</div>
              <div className="font-medium">
                {new Date(invoice.invoiceDate).toLocaleDateString()}
              </div>
            </div>
            {invoice.dueDate ? (
              <div className="grid gap-1">
                <div className="text-muted-foreground">Due date</div>
                <div className="font-medium">{new Date(invoice.dueDate).toLocaleDateString()}</div>
              </div>
            ) : null}

            <div className="rounded-md border bg-muted/20 p-4">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Total</span>
                <span className="font-semibold tabular-nums">{formatMoney(invoice.total)}</span>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-muted-foreground">Paid</span>
                <span className="font-semibold tabular-nums">{formatMoney(invoice.totalPaid)}</span>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-muted-foreground">Remaining</span>
                <span className="font-semibold tabular-nums">{formatMoney(invoice.remainingBalance)}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-lg">Payments</CardTitle>
            <Badge variant="secondary">{(invoice.payments ?? []).length}</Badge>
          </CardHeader>
          <CardContent className="pt-0">
            {(invoice.payments ?? []).length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                No payments yet.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[140px]">Date</TableHead>
                    <TableHead className="w-[110px]">Ref</TableHead>
                    <TableHead>Deposit to</TableHead>
                    <TableHead className="text-right w-[140px]">Amount</TableHead>
                    <TableHead className="w-[60px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(invoice.payments ?? []).map((p: any) => {
                    const isReversed = !!p.reversedAt
                    const isWorking = reversingPaymentId === p.id
                    return (
                      <TableRow key={p.id}>
                        <TableCell className="text-muted-foreground">
                          {new Date(p.paymentDate).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="font-medium tabular-nums">
                          {p.id}
                        </TableCell>
                        <TableCell>
                          <div className="font-medium">{p.bankAccount?.name ?? "—"}</div>
                          <div className="mt-1">
                            {isReversed ? (
                              <Badge variant="destructive">Reversed</Badge>
                            ) : (
                              <Badge variant="secondary">Paid</Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {formatMoney(p.amount)}
                        </TableCell>
                        <TableCell className="text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="outline" size="sm" className="gap-2">
                                Actions <ChevronDown className="h-4 w-4 opacity-60" />
                              </Button>
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
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-sm">
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
                  : je.kind === "PAYMENT"
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
                        JE #{je.journalEntryId} • {new Date(je.date).toLocaleDateString()}
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
              Payment #{refundPayment?.id} • Amount {formatMoney(refundPayment?.amount)}
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


