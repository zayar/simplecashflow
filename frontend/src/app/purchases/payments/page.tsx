"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useAuth } from "@/contexts/auth-context"
import { fetchApi } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

function fmtMoney(n: any) {
  const num = Number(n ?? 0)
  if (!Number.isFinite(num)) return String(n ?? "")
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function PurchasesPaymentsListPage() {
  const { user } = useAuth()
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState("")

  useEffect(() => {
    if (!user?.companyId) return
    setLoading(true)
    fetchApi(`/companies/${user.companyId}/purchases/payments`)
      .then((data) => setRows(Array.isArray(data) ? data : []))
      .catch((e) => {
        console.error(e)
        setRows([])
      })
      .finally(() => setLoading(false))
  }, [user?.companyId])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return rows
    return rows.filter((r) => {
      const hay = [
        r?.vendorName,
        r?.referenceNumber,
        r?.bankAccountName,
        r?.type,
        r?.id,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
      return hay.includes(s)
    })
  }, [rows, q])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Payments Made</h1>
          <p className="text-sm text-muted-foreground">All recorded vendor payments (latest first).</p>
        </div>
        <div className="w-[320px]">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search vendor, bill, bank…" />
        </div>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">List</CardTitle>
          <Link href="/purchase-bills">
            <Button variant="outline">Go to Purchase Bills</Button>
          </Link>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[140px]">Date</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Pay from</TableHead>
                  <TableHead className="text-right w-[160px]">Amount</TableHead>
                  <TableHead className="w-[120px]">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                      No payments.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((r) => (
                    <TableRow key={`${r.type}-${r.id}`} className="cursor-pointer hover:bg-muted/40">
                      <TableCell>
                        <Link className="block" href={`/purchases/payments/${r.type}/${r.id}`}>
                          {String(r.paymentDate).slice(0, 10)}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Link className="block font-medium" href={`/purchases/payments/${r.type}/${r.id}`}>
                          {r.vendorName ?? "—"}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {r.type === "expense" ? "Expense" : "Purchase Bill"} • {r.referenceNumber ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{r.bankAccountName ?? "—"}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{fmtMoney(r.amount)}</TableCell>
                      <TableCell className="text-sm">
                        {r.reversedAt ? <span className="text-muted-foreground">Reversed</span> : <span>Posted</span>}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}


