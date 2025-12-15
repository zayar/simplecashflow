"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { CheckCircle, DollarSign, Eye, MoreHorizontal, Plus } from "lucide-react"

import { useAuth } from "@/contexts/auth-context"
import { fetchApi, getBills, BillListRow } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
  const { user } = useAuth();
  const [bills, setBills] = useState<BillListRow[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  const makeIdempotencyKey = () => {
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? (crypto as any).randomUUID()
      : `idem_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  };

  useEffect(() => {
    if (user?.companyId) {
      getBills(user.companyId).then(setBills).catch(console.error);
    }
  }, [user?.companyId, refreshKey]);

  const handlePost = async (billId: number) => {
    if (!user?.companyId) return;
    if (!confirm('Post this bill? This will create journal entries and increase Accounts Payable.')) return;

    try {
      await fetchApi(`/companies/${user.companyId}/expenses/${billId}/post`, {
        method: 'POST',
        headers: { 'Idempotency-Key': makeIdempotencyKey() },
        body: JSON.stringify({}),
      });
      setRefreshKey((k) => k + 1);
    } catch (err: any) {
      alert(err.message || 'Failed to post bill');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Bills</h1>
          <p className="text-sm text-muted-foreground">
            Track payables and record outgoing payments.
          </p>
        </div>
        <Link href="/expenses/new">
          <Button className="gap-2">
            <Plus className="h-4 w-4" /> New Bill
          </Button>
        </Link>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-lg">All bills</CardTitle>
            <p className="text-sm text-muted-foreground">
              Post bills to create accounting entries and track AP.
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
                <TableHead className="w-[64px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {bills.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="text-muted-foreground">
                    {new Date(b.expenseDate).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="font-medium">{b.expenseNumber}</TableCell>
                  <TableCell>{b.vendorName ?? "—"}</TableCell>
                  <TableCell>{statusBadge(b.status)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {Number(b.amount ?? 0).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label="Row actions">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link href={`/expenses/${b.id}`}>
                            <Eye className="mr-2 h-4 w-4" />
                            View
                          </Link>
                        </DropdownMenuItem>
                        {b.status === "DRAFT" && (
                          <DropdownMenuItem onClick={() => handlePost(b.id)}>
                            <CheckCircle className="mr-2 h-4 w-4" />
                            Post
                          </DropdownMenuItem>
                        )}
                        {(b.status === "POSTED" || b.status === "PARTIAL") && (
                          <DropdownMenuItem asChild>
                            <Link href={`/expenses/${b.id}/payment`}>
                              <DollarSign className="mr-2 h-4 w-4" />
                              Record payment
                            </Link>
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem asChild>
                          <Link href={`/expenses/${b.id}`}>Open</Link>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
              {bills.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    No bills yet. Create a bill to start tracking payables.
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
