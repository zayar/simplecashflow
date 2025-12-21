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

export default function PurchasesPaymentDetailPage() {
  const { user } = useAuth()
  const params = useParams<{ type: string; id: string }>()
  const type = params?.type
  const id = params?.id

  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!user?.companyId || !type || !id) return
    setLoading(true)
    setError(null)
    fetchApi(`/companies/${user.companyId}/purchases/payments/${type}/${id}`)
      .then(setData)
      .catch((e) => setError(e?.message ?? String(e)))
      .finally(() => setLoading(false))
  }, [user?.companyId, type, id])

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/purchases/payments">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="text-sm text-muted-foreground">Loading…</div>
        </div>
      </div>
    )
  }

  if (error || !data?.payment) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/purchases/payments">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="text-sm text-red-600">{error ?? "Payment not found"}</div>
        </div>
      </div>
    )
  }

  const p = data.payment
  const isExpense = data.type === "expense"
  const ref = isExpense ? p.expense : p.purchaseBill
  const vendor = ref?.vendor
  const bank = p.bankAccount

  const refHref = isExpense ? `/expenses/${ref?.id}` : `/purchase-bills/${ref?.id}`

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link href="/purchases/payments">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">
              Payment #{p.id}
            </h1>
            <div className="text-sm text-muted-foreground">
              {String(p.paymentDate).slice(0, 10)} • {p.reversedAt ? "Reversed" : "Posted"} • {isExpense ? "Expense" : "Purchase Bill"}
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
              <div className="text-xs text-muted-foreground">Vendor</div>
              <div className="font-medium">{vendor?.name ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Reference</div>
              <div className="font-medium">{isExpense ? ref?.expenseNumber : ref?.billNumber}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Pay from</div>
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
            {ref?.id ? (
              <Link href={refHref} className="block text-sm text-primary hover:underline">
                View {isExpense ? "expense" : "purchase bill"}
              </Link>
            ) : null}
            <Link href="/purchases/payments" className="block text-sm text-primary hover:underline">
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


