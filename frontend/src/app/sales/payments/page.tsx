"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useAuth } from "@/contexts/auth-context"
import { fetchApi } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ChevronDown, Search } from "lucide-react"

function fmtMoney(n: any) {
  const num = Number(n ?? 0)
  if (!Number.isFinite(num)) return String(n ?? "")
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtDateShort(value: any) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return "—"
  return new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "short", year: "numeric" }).format(d)
}

export default function SalesPaymentsListPage() {
  const { user, companySettings } = useAuth()
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState("")

  const currency = (companySettings?.baseCurrency ?? "MMK").trim().toUpperCase() || "MMK"

  useEffect(() => {
    if (!user?.companyId) return
    setLoading(true)
    fetchApi(`/companies/${user.companyId}/sales/payments`)
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
        r?.invoiceNumber,
        r?.customerName,
        r?.bankAccountName,
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="px-0 text-xl font-semibold tracking-tight hover:bg-transparent">
              All Received Payments <ChevronDown className="ml-1 h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem disabled>All Received Payments</DropdownMenuItem>
            <DropdownMenuItem disabled>Reversed (coming soon)</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex items-center gap-2">
          <Link href="/invoices">
            <Button>+ New</Button>
          </Link>
          <Button variant="outline" size="icon" aria-label="More">
            <span className="text-lg leading-none">…</span>
          </Button>
        </div>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">Payments</CardTitle>
          <div className="relative w-[320px]">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search"
            />
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[140px]">DATE</TableHead>
                  <TableHead className="w-[160px]">BRANCH</TableHead>
                  <TableHead className="w-[120px]">PAYMENT #</TableHead>
                  <TableHead className="w-[200px]">REFERENCE NUMBER</TableHead>
                  <TableHead>CUSTOMER NAME</TableHead>
                  <TableHead className="w-[140px]">INVOICE#</TableHead>
                  <TableHead className="w-[180px]">MODE</TableHead>
                  <TableHead className="text-right w-[160px]">AMOUNT</TableHead>
                  <TableHead className="text-right w-[170px]">UNUSED AMOUNT</TableHead>
                  <TableHead className="w-[120px]">STATUS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={10} className="py-10 text-center text-muted-foreground">
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="py-10 text-center text-muted-foreground">
                      No payments.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((r) => (
                    <TableRow key={r.id} className="hover:bg-muted/40">
                      <TableCell className="whitespace-nowrap">{fmtDateShort(r.paymentDate)}</TableCell>
                      <TableCell className="text-muted-foreground">Head Office</TableCell>
                      <TableCell>
                        <Link className="text-primary underline" href={`/sales/payments/${r.id}`}>
                          {r.id}
                        </Link>
                        {r.attachmentUrl && (
                          <span className="ml-1 text-blue-500" title="Has payment proof">📎</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">—</TableCell>
                      <TableCell className="font-medium">{r.customerName ?? "—"}</TableCell>
                      <TableCell>
                        {r.invoiceId ? (
                          <Link className="text-primary underline" href={`/invoices/${r.invoiceId}`}>
                            {r.invoiceNumber ?? `INV-${r.invoiceId}`}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">{r.invoiceNumber ?? "—"}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{r.bankAccountName ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {currency}
                        {fmtMoney(r.amount)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {currency}
                        {fmtMoney(0)}
                      </TableCell>
                      <TableCell>
                        {r.reversedAt ? <Badge variant="outline">REVERSED</Badge> : <Badge variant="secondary">PAID</Badge>}
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


