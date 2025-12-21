"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { useAuth } from "@/contexts/auth-context"
import { fetchApi } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ArrowLeft } from "lucide-react"

function fmtMoney(n: any) {
  const num = Number(n ?? 0)
  if (!Number.isFinite(num)) return String(n ?? "")
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function SalesPaymentDetailPage() {
  const { user } = useAuth()
  const params = useParams<{ id: string }>()
  const id = params?.id

  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!user?.companyId || !id) return
    setLoading(true)
    setError(null)
    fetchApi(`/companies/${user.companyId}/sales/payments/${id}`)
      .then(setData)
      .catch((e) => setError(e?.message ?? String(e)))
      .finally(() => setLoading(false))
  }, [user?.companyId, id])

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/sales/payments">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="text-sm text-muted-foreground">Loading…</div>
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/sales/payments">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="text-sm text-red-600">{error ?? "Payment not found"}</div>
        </div>
      </div>
    )
  }

  const p = data
  const invoice = p.invoice
  const bank = p.bankAccount

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link href="/sales/payments">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Payment #{p.id}</h1>
            <div className="text-sm text-muted-foreground">
              {String(p.paymentDate).slice(0, 10)} • {p.reversedAt ? "Reversed" : "Posted"}
            </div>
          </div>
        </div>
        {p.journalEntryId ? (
          <Link href={`/journal/${p.journalEntryId}`}>
            <Button variant="outline">View Journal Entry</Button>
          </Link>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="shadow-sm md:col-span-2">
          <CardHeader>
            <CardTitle className="text-lg">Details</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Customer</div>
              <div className="font-medium">{invoice?.customer?.name ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Invoice</div>
              <div className="font-medium">{invoice?.invoiceNumber ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Deposit to</div>
              <div className="font-medium">{bank ? `${bank.code} - ${bank.name}` : "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Amount</div>
              <div className="font-semibold tabular-nums">{fmtMoney(p.amount)}</div>
            </div>
            {p.reversedAt ? (
              <div className="md:col-span-2 rounded-lg border bg-muted/30 p-3">
                <div className="text-xs text-muted-foreground">Reversed at</div>
                <div className="font-medium">{String(p.reversedAt)}</div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Quick links</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {invoice?.id ? (
              <Link href={`/invoices/${invoice.id}`} className="block text-sm text-primary hover:underline">
                View invoice
              </Link>
            ) : null}
            <Link href="/sales/payments" className="block text-sm text-primary hover:underline">
              Back to payments
            </Link>
          </CardContent>
        </Card>
      </div>

      {p.journalEntry?.lines?.length ? (
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Journal lines</CardTitle>
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
                  {p.journalEntry.lines.map((l: any) => (
                    <TableRow key={l.id}>
                      <TableCell>
                        <div className="font-medium">{l.account?.code ? `${l.account.code} ` : ""}{l.account?.name ?? "—"}</div>
                        <div className="text-xs text-muted-foreground">{l.account?.type ?? ""}</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{Number(l.debit) ? fmtMoney(l.debit) : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{Number(l.credit) ? fmtMoney(l.credit) : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}


