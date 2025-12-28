'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { formatDateInTimeZone } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Plus } from 'lucide-react';

function statusBadge(status: string) {
  switch (status) {
    case 'PAID':
      return <Badge variant="secondary">Paid</Badge>;
    case 'POSTED':
      return <Badge variant="outline">Posted</Badge>;
    case 'PARTIAL':
      return <Badge variant="outline">Partial</Badge>;
    case 'DRAFT':
      return <Badge variant="outline">Draft</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function PurchaseBillsPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const [rows, setRows] = useState<any[]>([]);
  const tz = companySettings?.timeZone ?? 'Asia/Yangon';

  useEffect(() => {
    if (!user?.companyId) return;
    fetchApi(`/companies/${user.companyId}/purchase-bills`)
      .then(setRows)
      .catch(console.error);
  }, [user?.companyId]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Purchase Bills</h1>
          <p className="text-sm text-muted-foreground">
            Record inventory purchases (Dr Inventory / Cr Accounts Payable).
          </p>
        </div>
        <Link href="/purchase-bills/new">
          <Button className="gap-2">
            <Plus className="h-4 w-4" /> New Purchase Bill
          </Button>
        </Link>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">All purchase bills</CardTitle>
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
              {rows.map((b) => (
                <TableRow
                  key={b.id}
                  className="cursor-pointer hover:bg-muted/40"
                  role="link"
                  tabIndex={0}
                  onClick={() => router.push(`/purchase-bills/${b.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') router.push(`/purchase-bills/${b.id}`);
                  }}
                >
                  <TableCell className="text-muted-foreground">
                    {b.billDate ? formatDateInTimeZone(b.billDate, tz) : '—'}
                  </TableCell>
                  <TableCell className="font-medium">{b.billNumber}</TableCell>
                  <TableCell>{b.vendorName ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{b.locationName ?? b.warehouseName ?? '—'}</TableCell>
                  <TableCell>{statusBadge(b.status)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {Number(b.total ?? 0).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    No purchase bills yet.
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


