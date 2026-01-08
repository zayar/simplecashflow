'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';

import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { formatDateInTimeZone } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function statusBadge(status: string) {
  switch (status) {
    case 'APPROVED':
      return <Badge variant="outline">Approved</Badge>;
    case 'CANCELLED':
      return <Badge variant="destructive">Cancelled</Badge>;
    case 'DRAFT':
      return <Badge variant="outline">Draft</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function PurchaseOrdersPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const tz = companySettings?.timeZone ?? 'Asia/Yangon';
  const [rows, setRows] = useState<any[]>([]);

  useEffect(() => {
    if (!user?.companyId) return;
    fetchApi(`/companies/${user.companyId}/purchase-orders`).then(setRows).catch(console.error);
  }, [user?.companyId]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Purchase Orders</h1>
          <p className="text-sm text-muted-foreground">Create and manage purchase orders before receiving goods.</p>
        </div>
        <Link href="/purchase-orders/new">
          <Button className="gap-2">
            <Plus className="h-4 w-4" /> New Purchase Order
          </Button>
        </Link>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">All purchase orders</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px]">Date</TableHead>
                <TableHead className="w-[180px]">Number</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Location</TableHead>
                <TableHead className="w-[120px]">Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((po) => (
                <TableRow
                  key={po.id}
                  className="cursor-pointer hover:bg-muted/40"
                  role="link"
                  tabIndex={0}
                  onClick={() => router.push(`/purchase-orders/${po.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') router.push(`/purchase-orders/${po.id}`);
                  }}
                >
                  <TableCell className="text-muted-foreground">{po.orderDate ? formatDateInTimeZone(po.orderDate, tz) : '—'}</TableCell>
                  <TableCell className="font-medium">{po.poNumber ?? `PO-${po.id}`}</TableCell>
                  <TableCell>{po.vendorName ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{po.locationName ?? '—'}</TableCell>
                  <TableCell>{statusBadge(po.status)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{Number(po.total ?? 0).toLocaleString()}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    No purchase orders yet.
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

