'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SelectNative } from '@/components/ui/select-native';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { todayInTimeZone } from '@/lib/utils';

export default function InventoryValuationReportPage() {
  const { user, companySettings } = useAuth();
  const [asOf, setAsOf] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const tz = companySettings?.timeZone ?? 'Asia/Yangon';
    if (!asOf) setAsOf(todayInTimeZone(tz));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companySettings?.timeZone]);

  useEffect(() => {
    if (!user?.companyId) return;
    fetchApi(`/companies/${user.companyId}/warehouses`).then(setWarehouses).catch(console.error);
  }, [user?.companyId]);

  const load = async () => {
    if (!user?.companyId) return;
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set('asOf', asOf);
      if (warehouseId) qs.set('warehouseId', warehouseId);
      const res = await fetchApi(`/companies/${user.companyId}/reports/inventory-valuation?${qs.toString()}`);
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
        <div className="grid gap-1">
          <div className="text-sm text-muted-foreground">Warehouse</div>
          <SelectNative value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">All warehouses</option>
            {warehouses.map((w) => (
              <option key={w.id} value={String(w.id)}>
                {w.name}
                {w.isDefault ? ' (Default)' : ''}
              </option>
            ))}
          </SelectNative>
        </div>
        <Button onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Run'}
        </Button>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">Inventory Valuation</CardTitle>
          {totals ? (
            <div className="text-sm text-muted-foreground">
              Total value: <span className="font-medium tabular-nums">{Number(totals.inventoryValue ?? 0).toLocaleString()}</span>
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Avg Cost</TableHead>
                <TableHead className="text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.rows ?? []).map((r: any) => (
                <TableRow key={`${r.warehouseId}-${r.itemId}`}>
                  <TableCell className="font-medium">{r.itemName}</TableCell>
                  <TableCell className="text-muted-foreground">{r.warehouseName}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(r.qtyOnHand ?? 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(r.avgUnitCost ?? 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{Number(r.inventoryValue ?? 0).toLocaleString()}</TableCell>
                </TableRow>
              ))}
              {(data?.rows ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    No inventory movements found for this as-of date.
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


