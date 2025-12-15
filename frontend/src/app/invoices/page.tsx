"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { CheckCircle, DollarSign, Eye, MoreHorizontal, Plus } from "lucide-react"

import { useAuth } from "@/contexts/auth-context"
import { fetchApi } from "@/lib/api"
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

export default function InvoicesPage() {
  const { user } = useAuth();
  const [invoices, setInvoices] = useState<any[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  const makeIdempotencyKey = () => {
    // Browser-safe unique key (best effort).
    // crypto.randomUUID is supported in modern browsers; fallback is timestamp+random.
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? (crypto as any).randomUUID()
      : `idem_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  };

  useEffect(() => {
    if (user?.companyId) {
      fetchApi(`/companies/${user.companyId}/invoices`)
        .then(setInvoices)
        .catch(console.error);
    }
  }, [user?.companyId, refreshKey]);

  const handlePost = async (invoiceId: number) => {
    if (!user?.companyId) return;
    if (!confirm('Are you sure you want to POST this invoice? This will create journal entries.')) return;

    try {
      await fetchApi(`/companies/${user.companyId}/invoices/${invoiceId}/post`, {
        method: 'POST',
        headers: {
          'Idempotency-Key': makeIdempotencyKey(),
        },
        body: JSON.stringify({}), // Fix: Send empty JSON object to satisfy Content-Type
      });
      setRefreshKey((k) => k + 1); // Refresh list
    } catch (err: any) {
      console.error(err);
      alert(err.message || 'Failed to post invoice');
    }
  };

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
                <TableHead className="w-[64px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell className="text-muted-foreground">
                    {new Date(inv.invoiceDate).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="font-medium">{inv.invoiceNumber}</TableCell>
                  <TableCell>{inv.customerName}</TableCell>
                  <TableCell>{statusBadge(inv.status)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {Number(inv.total ?? 0).toLocaleString()}
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
                          <Link href={`/invoices/${inv.id}`}>
                            <Eye className="mr-2 h-4 w-4" />
                            View
                          </Link>
                        </DropdownMenuItem>
                        {inv.status === "DRAFT" && (
                          <DropdownMenuItem onClick={() => handlePost(inv.id)}>
                            <CheckCircle className="mr-2 h-4 w-4" />
                            Post
                          </DropdownMenuItem>
                        )}
                        {(inv.status === "POSTED" || inv.status === "PARTIAL") && (
                          <DropdownMenuItem asChild>
                            <Link href={`/invoices/${inv.id}/payment`}>
                              <DollarSign className="mr-2 h-4 w-4" />
                              Record payment
                            </Link>
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem asChild>
                          <Link href={`/invoices/${inv.id}`}>Open</Link>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
              {invoices.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
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
