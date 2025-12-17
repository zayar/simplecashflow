'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { todayInTimeZone } from '@/lib/utils';

export default function ApAgingReportPage() {
  const { user, companySettings } = useAuth();
  const [asOf, setAsOf] = useState('');
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const tz = companySettings?.timeZone ?? 'Asia/Yangon';
    if (!asOf) setAsOf(todayInTimeZone(tz));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companySettings?.timeZone]);

  const load = async () => {
    if (!user?.companyId) return;
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set('asOf', asOf);
      const res = await fetchApi(`/companies/${user.companyId}/reports/ap-aging?${qs.toString()}`);
      setData(res);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.companyId]);

  const totals = useMemo(() => data?.totals ?? null, [data]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1">
          <div className="text-sm text-muted-foreground">As of</div>
          <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </div>
        <Button onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Run'}
        </Button>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">AP Aging by Vendor</CardTitle>
          {totals ? (
            <div className="text-sm text-muted-foreground">
              Total: <span className="font-medium tabular-nums">{Number(totals.total ?? 0).toLocaleString()}</span>
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vendor</TableHead>
                <TableHead className="text-right">Current</TableHead>
                <TableHead className="text-right">1-30</TableHead>
                <TableHead className="text-right">31-60</TableHead>
                <TableHead className="text-right">61-90</TableHead>
                <TableHead className="text-right">90+</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.rows ?? []).map((r: any) => (
                <TableRow key={String(r.vendorId ?? r.vendorName)}>
                  <TableCell className="font-medium">{r.vendorName}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(r.current ?? 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(r.due_1_30 ?? 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(r.due_31_60 ?? 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(r.due_61_90 ?? 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(r.due_90_plus ?? 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{Number(r.total ?? 0).toLocaleString()}</TableCell>
                </TableRow>
              ))}
              {(data?.rows ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                    No outstanding payables.
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


