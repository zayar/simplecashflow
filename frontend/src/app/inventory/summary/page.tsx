'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SelectNative } from '@/components/ui/select-native';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export default function InventorySummaryPage() {
  const { user } = useAuth();
  const [locations, setLocations] = useState<any[]>([]);
  const [locationId, setLocationId] = useState<string>('');
  const [rows, setRows] = useState<any[]>([]);

  useEffect(() => {
    if (!user?.companyId) return;
    fetchApi(`/companies/${user.companyId}/locations`)
      .then((l) => setLocations(l))
      .catch(console.error);
  }, [user?.companyId]);

  async function load() {
    if (!user?.companyId) return;
    const qs = locationId ? `?locationId=${encodeURIComponent(locationId)}` : '';
    const data = await fetchApi(`/companies/${user.companyId}/reports/inventory-summary${qs}`);
    setRows(data);
  }

  useEffect(() => {
    load().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.companyId, locationId]);

  const totals = useMemo(() => {
    const totalValue = rows.reduce((sum, r) => sum + Number(r.inventoryValue ?? 0), 0);
    return { totalValue };
  }, [rows]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Inventory Summary</h1>
        <p className="text-sm text-muted-foreground">Accounting stock on hand (WAC).</p>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">Filters</CardTitle>
          <div className="text-sm text-muted-foreground">
            Total Value: <span className="font-medium tabular-nums">{totals.totalValue.toLocaleString()}</span>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="grid gap-2 md:max-w-sm">
            <SelectNative value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">All locations</option>
              {locations.map((l) => (
                <option key={l.id} value={String(l.id)}>
                  {l.name}
                  {l.isDefault ? ' (Default)' : ''}
                </option>
              ))}
            </SelectNative>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Stock balances</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[220px]">Location</TableHead>
                <TableHead>Item</TableHead>
                <TableHead className="w-[140px] text-right">Qty</TableHead>
                <TableHead className="w-[160px] text-right">Avg Cost</TableHead>
                <TableHead className="w-[180px] text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, idx) => (
                <TableRow key={`${r.location?.id ?? 'l'}-${r.item?.id ?? 'i'}-${idx}`}>
                  <TableCell className="text-muted-foreground">{r.location?.name ?? '—'}</TableCell>
                  <TableCell className="font-medium">{r.item?.name ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(r.qtyOnHand ?? 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(r.avgUnitCost ?? 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{Number(r.inventoryValue ?? 0).toLocaleString()}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    No stock yet.
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


