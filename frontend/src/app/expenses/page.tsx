"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Plus } from "lucide-react"

import { useAuth } from "@/contexts/auth-context"
import { getBills, BillListRow } from "@/lib/api"
import { formatDateInTimeZone } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
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

export default function BillsPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const [bills, setBills] = useState<BillListRow[]>([]);
  const tz = companySettings?.timeZone ?? "Asia/Yangon"

  useEffect(() => {
    if (user?.companyId) {
      getBills(user.companyId).then(setBills).catch(console.error);
    }
  }, [user?.companyId]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Expenses</h1>
          <p className="text-sm text-muted-foreground">
            Track expenses and record outgoing payments.
          </p>
        </div>
        <Link href="/expenses/new">
          <Button className="gap-2">
            <Plus className="h-4 w-4" /> New Expense
          </Button>
        </Link>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-lg">All expenses</CardTitle>
            <p className="text-sm text-muted-foreground">
              Post expenses to create accounting entries and track AP.
            </p>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px]">Date</TableHead>
                <TableHead className="w-[140px]">Number</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead className="w-[120px]">Status</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bills.map((b) => (
                <TableRow
                  key={b.id}
                  className="cursor-pointer hover:bg-muted/40"
                  role="link"
                  tabIndex={0}
                  onClick={() => router.push(`/expenses/${b.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") router.push(`/expenses/${b.id}`)
                  }}
                >
                  <TableCell className="text-muted-foreground">
                    {formatDateInTimeZone(b.expenseDate, tz)}
                  </TableCell>
                  <TableCell className="font-medium">{b.expenseNumber}</TableCell>
                  <TableCell>{b.vendorName ?? "—"}</TableCell>
                  <TableCell>{statusBadge(b.status)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {Number(b.amount ?? 0).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
              {bills.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    No expenses yet. Create an expense to start tracking payables.
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
