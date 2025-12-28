'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SelectNative } from '@/components/ui/select-native';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateInputInTimeZone, todayInTimeZone } from '@/lib/utils';

export default function InventoryMovementReportPage() {
  const { user, companySettings } = useAuth();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [locationId, setLocationId] = useState('');
  const [locations, setLocations] = useState<any[]>([]);
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const tz = companySettings?.timeZone ?? 'Asia/Yangon';
    if (from && to) return;
    const today = todayInTimeZone(tz);
    const parts = today.split('-').map((x) => Number(x));
    const y = parts[0];
    const m = parts[1]; // 1-12
    if (!y || !m) return;
    if (!from) setFrom(formatDateInputInTimeZone(new Date(Date.UTC(y, m - 1, 1)), tz));
    if (!to) setTo(today);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companySettings?.timeZone]);

  useEffect(() => {
    if (!user?.companyId) return;
    fetchApi(`/companies/${user.companyId}/locations`).then(setLocations).catch(console.error);
  }, [user?.companyId]);

  const load = async () => {
    if (!user?.companyId) return;
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set('from', from);
      qs.set('to', to);
      if (locationId) qs.set('locationId', locationId);
      const res = await fetchApi(`/companies/${user.companyId}/reports/inventory-movement?${qs.toString()}`);
      setData(res);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.companyId]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1">
          <div className="text-sm text-muted-foreground">From</div>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <div className="text-sm text-muted-foreground">To</div>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <div className="text-sm text-muted-foreground">Location</div>
          <SelectNative value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">All locations</option>
            {locations.map((l) => (
              <option key={l.id} value={String(l.id)}>
                {l.name}
              </option>
            ))}
          </SelectNative>
        </div>
        <Button onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Run'}
        </Button>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Inventory Movement</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="mb-3 text-xs text-muted-foreground">
            Net Qty/Value is the movement inside the selected date range. Begin/End columns include all history before the range for context.
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Location</TableHead>
                <TableHead className="text-right">Begin Qty</TableHead>
                <TableHead className="text-right">Qty In</TableHead>
                <TableHead className="text-right">Qty Out</TableHead>
                <TableHead className="text-right">Net Qty</TableHead>
                <TableHead className="text-right">End Qty</TableHead>
                <TableHead className="text-right">Net Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.rows ?? []).map((r: any) => (
                <TableRow key={`${r.locationId}-${r.itemId}`}>
                  <TableCell className="font-medium">{r.itemName}</TableCell>
                  <TableCell className="text-muted-foreground">{r.locationName}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(r.beginQty ?? 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(r.qtyIn ?? 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(r.qtyOut ?? 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(r.netQty ?? 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(r.endQty ?? 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(r.netValue ?? 0).toLocaleString()}</TableCell>
                </TableRow>
              ))}
              {(data?.rows ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                    No movements found for this period.
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


