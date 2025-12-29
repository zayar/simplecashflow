"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Plus } from "lucide-react"

import { useAuth } from "@/contexts/auth-context"
import { fetchApi } from "@/lib/api"
import { formatDateInTimeZone } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

function statusBadge(status: string) {
  const cls =
    "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-wide";
  switch (status) {
    case "VOID":
      return <span className={`${cls} border-rose-200 bg-rose-50 text-rose-700`}>Void</span>
    case "PAID":
      return <span className={`${cls} border-emerald-200 bg-emerald-50 text-emerald-700`}>Paid</span>
    case "POSTED":
      return <span className={`${cls} border-blue-200 bg-blue-50 text-blue-700`}>Posted</span>
    case "PARTIAL":
      return <span className={`${cls} border-amber-200 bg-amber-50 text-amber-800`}>Partial</span>
    case "APPROVED":
      return <span className={`${cls} border-violet-200 bg-violet-50 text-violet-700`}>Approved</span>
    case "DRAFT":
      return <span className={`${cls} border-slate-200 bg-slate-50 text-slate-700`}>Draft</span>
    default:
      return <span className={`${cls} border-slate-200 bg-slate-50 text-slate-700`}>{status}</span>
  }
}

export default function InvoicesPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const [invoices, setInvoices] = useState<any[]>([]);
  const tz = companySettings?.timeZone ?? "Asia/Yangon"

  useEffect(() => {
    if (user?.companyId) {
      fetchApi(`/companies/${user.companyId}/invoices`)
        .then(setInvoices)
        .catch(console.error);
    }
  }, [user?.companyId]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Invoices</h1>
          <p className="text-sm text-muted-foreground">
            Create, post, and record payments.
          </p>
        </div>
        <Link href="/invoices/new">
          <Button className="gap-2">
            <Plus className="h-4 w-4" /> New Invoice
          </Button>
        </Link>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-lg">All invoices</CardTitle>
            <p className="text-sm text-muted-foreground">
              Keep actions lightweight; details live on the invoice page.
            </p>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px]">Date</TableHead>
                <TableHead className="w-[140px]">Number</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead className="w-[120px]">Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((inv) => (
                <TableRow
                  key={inv.id}
                  className="cursor-pointer hover:bg-muted/40"
                  role="link"
                  tabIndex={0}
                  onClick={() => router.push(`/invoices/${inv.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") router.push(`/invoices/${inv.id}`)
                  }}
                >
                  <TableCell className="text-muted-foreground">
                    {formatDateInTimeZone(inv.invoiceDate, tz)}
                  </TableCell>
                  <TableCell className="font-medium">{inv.invoiceNumber}</TableCell>
                  <TableCell>{inv.customerName}</TableCell>
                  <TableCell>{statusBadge(inv.status)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {Number(inv.total ?? 0).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
              {invoices.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    No invoices yet. Create your first invoice to start tracking revenue.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
