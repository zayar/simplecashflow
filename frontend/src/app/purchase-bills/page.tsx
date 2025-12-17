'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { formatDateInTimeZone } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CheckCircle, Eye, MoreHorizontal, Plus } from 'lucide-react';

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
  const [rows, setRows] = useState<any[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const tz = companySettings?.timeZone ?? 'Asia/Yangon';

  const makeIdempotencyKey = () => {
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? (crypto as any).randomUUID()
      : `idem_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  };

  useEffect(() => {
    if (!user?.companyId) return;
    fetchApi(`/companies/${user.companyId}/purchase-bills`)
      .then(setRows)
      .catch(console.error);
  }, [user?.companyId, refreshKey]);

  const handlePost = async (id: number) => {
    if (!user?.companyId) return;
    if (!confirm('Post this purchase bill? This will increase Inventory and Accounts Payable.')) return;
    try {
      await fetchApi(`/companies/${user.companyId}/purchase-bills/${id}/post`, {
        method: 'POST',
        headers: { 'Idempotency-Key': makeIdempotencyKey() },
        body: JSON.stringify({}),
      });
      setRefreshKey((k) => k + 1);
    } catch (err: any) {
      alert(err.message || 'Failed to post purchase bill');
    }
  };

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
                <TableHead>Warehouse</TableHead>
                <TableHead className="w-[120px]">Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="w-[64px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="text-muted-foreground">
                    {b.billDate ? formatDateInTimeZone(b.billDate, tz) : '—'}
                  </TableCell>
                  <TableCell className="font-medium">{b.billNumber}</TableCell>
                  <TableCell>{b.vendorName ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{b.warehouseName ?? '—'}</TableCell>
                  <TableCell>{statusBadge(b.status)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {Number(b.total ?? 0).toLocaleString()}
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
                          <Link href={`/purchase-bills/${b.id}`}>
                            <Eye className="mr-2 h-4 w-4" />
                            View
                          </Link>
                        </DropdownMenuItem>
                        {b.status === 'DRAFT' && (
                          <DropdownMenuItem onClick={() => handlePost(b.id)}>
                            <CheckCircle className="mr-2 h-4 w-4" />
                            Post
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem asChild>
                          <Link href={`/purchase-bills/${b.id}`}>Open</Link>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
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


