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
    case 'POSTED':
      return <Badge variant="outline">Posted</Badge>;
    case 'DRAFT':
      return <Badge variant="outline">Draft</Badge>;
    case 'VOID':
      return <Badge variant="destructive">Void</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function PurchaseReceiptsPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const tz = companySettings?.timeZone ?? 'Asia/Yangon';
  const [rows, setRows] = useState<any[]>([]);

  useEffect(() => {
    if (!user?.companyId) return;
    fetchApi(`/companies/${user.companyId}/purchase-receipts`).then(setRows).catch(console.error);
  }, [user?.companyId]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Purchase Receipts</h1>
          <p className="text-sm text-muted-foreground">Receive goods (DRAFT → POSTED) and record GRNI.</p>
        </div>
        <Link href="/purchase-orders">
          <Button variant="outline" className="gap-2">
            <Plus className="h-4 w-4" /> Create from PO
          </Button>
        </Link>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">All purchase receipts</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px]">Date</TableHead>
                <TableHead className="w-[180px]">Number</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>PO</TableHead>
                <TableHead>Location</TableHead>
                <TableHead className="w-[120px]">Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow
                  key={r.id}
                  className="cursor-pointer hover:bg-muted/40"
                  role="link"
                  tabIndex={0}
                  onClick={() => router.push(`/purchase-receipts/${r.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') router.push(`/purchase-receipts/${r.id}`);
                  }}
                >
                  <TableCell className="text-muted-foreground">{r.receiptDate ? formatDateInTimeZone(r.receiptDate, tz) : '—'}</TableCell>
                  <TableCell className="font-medium">{r.receiptNumber ?? `PR-${r.id}`}</TableCell>
                  <TableCell>{r.vendorName ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{r.purchaseOrderNumber ?? (r.purchaseOrderId ? `#${r.purchaseOrderId}` : '—')}</TableCell>
                  <TableCell className="text-muted-foreground">{r.locationName ?? '—'}</TableCell>
                  <TableCell>{statusBadge(r.status)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{Number(r.total ?? 0).toLocaleString()}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                    No purchase receipts yet.
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

