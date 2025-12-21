'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { formatDateInTimeZone } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function formatMoney(n: any) {
  const num = Number(n ?? 0);
  if (Number.isNaN(num)) return String(n ?? '');
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function CreditNotesPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const tz = companySettings?.timeZone ?? 'Asia/Yangon';
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.companyId) return;
    setLoading(true);
    fetchApi(`/companies/${user.companyId}/credit-notes`)
      .then(setRows)
      .finally(() => setLoading(false));
  }, [user?.companyId]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Credit Notes</h1>
          <p className="text-sm text-muted-foreground">
            Sales returns / credits that reduce Accounts Receivable.
          </p>
        </div>
        <Link href="/credit-notes/new">
          <Button className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            New Credit Note
          </Button>
        </Link>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">Credit Notes</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {loading && (
            <div className="space-y-3 py-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          )}

          {!loading && rows.length === 0 && (
            <div className="py-10 text-center text-sm text-muted-foreground">
              No credit notes yet.
            </div>
          )}

          {!loading && rows.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[140px]">Date</TableHead>
                  <TableHead>Credit Note</TableHead>
                  <TableHead className="w-[200px]">Customer</TableHead>
                  <TableHead className="text-right w-[160px]">Total</TableHead>
                  <TableHead className="text-right w-[160px]">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((cn) => (
                  <TableRow
                    key={cn.id}
                    className="cursor-pointer hover:bg-muted/40"
                    role="link"
                    tabIndex={0}
                    onClick={() => router.push(`/credit-notes/${cn.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') router.push(`/credit-notes/${cn.id}`);
                    }}
                  >
                    <TableCell className="text-muted-foreground">
                      {formatDateInTimeZone(cn.creditNoteDate, tz)}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{cn.creditNoteNumber}</div>
                      <div className="text-xs text-muted-foreground">CN #{cn.id}</div>
                    </TableCell>
                    <TableCell>{cn.customerName ?? '—'}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatMoney(cn.total)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant={cn.status === 'POSTED' ? 'secondary' : 'outline'}>
                        {cn.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}


