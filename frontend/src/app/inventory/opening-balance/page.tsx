'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectNative } from '@/components/ui/select-native';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type Line = { itemId: string; quantity: string; unitCost: string };

export default function OpeningBalancePage() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<Line[]>([{ itemId: '', quantity: '', unitCost: '' }]);
  const [loading, setLoading] = useState(false);

  const lockedItemId = (searchParams?.get('itemId') ?? '').trim();
  const isSingleItemMode = Boolean(lockedItemId);

  // Optional: prefill from query string (e.g. /inventory/opening-balance?itemId=123&warehouseId=1)
  useEffect(() => {
    const itemId = lockedItemId;
    const wid = searchParams?.get('warehouseId') ?? '';
    if (wid) setWarehouseId(wid);
    if (itemId) {
      // Single-item mode: enforce a single line locked to the item.
      setLines((prev) => {
        const qty = prev?.[0]?.quantity ?? '';
        const unitCost = prev?.[0]?.unitCost ?? '';
        return [{ itemId, quantity: qty, unitCost }];
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!user?.companyId) return;
    fetchApi(`/companies/${user.companyId}/warehouses`).then(setWarehouses).catch(console.error);
    fetchApi(`/companies/${user.companyId}/items`).then(setItems).catch(console.error);
  }, [user?.companyId]);

  const goodsItems = useMemo(() => items.filter((i) => i.type === 'GOODS'), [items]);

  const totalValue = useMemo(() => {
    return lines.reduce((sum, l) => sum + Number(l.quantity || 0) * Number(l.unitCost || 0), 0);
  }, [lines]);

  function updateLine(idx: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  function addLine() {
    if (isSingleItemMode) return;
    setLines((prev) => [...prev, { itemId: '', quantity: '', unitCost: '' }]);
  }

  function removeLine(idx: number) {
    if (isSingleItemMode) return;
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  async function submit() {
    if (!user?.companyId) return;
    setLoading(true);
    try {
      const payloadLines = lines
        .filter((l) => l.itemId && l.quantity && l.unitCost)
        .map((l) => ({
          itemId: Number(l.itemId),
          quantity: Number(l.quantity),
          unitCost: Number(l.unitCost),
        }))
        .filter((l) => l.itemId && l.quantity > 0 && l.unitCost > 0);

      if (payloadLines.length === 0) {
        alert('Please add at least 1 line with item, quantity (>0), and unit cost (>0).');
        return;
      }

      await fetchApi(`/companies/${user.companyId}/inventory/opening-balance`, {
        method: 'POST',
        body: JSON.stringify({
          date,
          warehouseId: warehouseId ? Number(warehouseId) : undefined,
          lines: payloadLines,
        }),
      });
      alert('Opening stock posted');
    } catch (err) {
      console.error(err);
      alert(String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Opening Balance</h1>
        <p className="text-sm text-muted-foreground">Post opening stock into Inventory (WAC) + GL.</p>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">Details</CardTitle>
          <div className="text-sm text-muted-foreground">
            Total Value: <span className="font-medium tabular-nums">{totalValue.toLocaleString()}</span>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div className="grid gap-2">
            <Label>Date</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>Warehouse</Label>
            <SelectNative value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">Company default</option>
              {warehouses.map((w) => (
                <option key={w.id} value={String(w.id)}>
                  {w.name}
                  {w.isDefault ? ' (Default)' : ''}
                </option>
              ))}
            </SelectNative>
          </div>
          <div className="md:col-span-3 flex justify-end">
            <Button onClick={submit} disabled={loading}>
              {loading ? 'Posting...' : 'Post Opening Stock'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">Lines</CardTitle>
          {!isSingleItemMode ? (
            <Button variant="outline" onClick={addLine}>
              Add line
            </Button>
          ) : (
            <div className="text-xs text-muted-foreground">
              Single-item mode (opened from item detail)
            </div>
          )}
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="w-[160px] text-right">Qty</TableHead>
                <TableHead className="w-[200px] text-right">Unit Cost</TableHead>
                <TableHead className="w-[110px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l, idx) => (
                <TableRow key={idx}>
                  <TableCell>
                    <SelectNative
                      value={l.itemId}
                      onChange={(e) => updateLine(idx, { itemId: e.target.value })}
                      disabled={isSingleItemMode}
                    >
                      <option value="">Select item</option>
                      {goodsItems.map((it) => (
                        <option key={it.id} value={String(it.id)}>
                          {it.name}
                        </option>
                      ))}
                    </SelectNative>
                  </TableCell>
                  <TableCell className="text-right">
                    <Input
                      type="number"
                      step="0.01"
                      value={l.quantity}
                      onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Input
                      type="number"
                      step="0.01"
                      value={l.unitCost}
                      onChange={(e) => updateLine(idx, { unitCost: e.target.value })}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      onClick={() => removeLine(idx)}
                      disabled={isSingleItemMode || lines.length === 1}
                    >
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}


