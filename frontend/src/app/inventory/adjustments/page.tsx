'use client';

import { useEffect, useMemo, useState } from 'react';
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

type Line = { itemId: string; quantityDelta: string; unitCost: string };

export default function AdjustmentsPage() {
  const { user } = useAuth();
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [locationId, setLocationId] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [referenceNumber, setReferenceNumber] = useState('');
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<Line[]>([{ itemId: '', quantityDelta: '', unitCost: '' }]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!user?.companyId) return;
    fetchApi(`/companies/${user.companyId}/locations`).then(setWarehouses).catch(console.error);
    fetchApi(`/companies/${user.companyId}/items`).then(setItems).catch(console.error);
  }, [user?.companyId]);

  const goodsItems = useMemo(() => items.filter((i) => i.type === 'GOODS'), [items]);

  function updateLine(idx: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((prev) => [...prev, { itemId: '', quantityDelta: '', unitCost: '' }]);
  }

  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  async function submit() {
    if (!user?.companyId) return;
    setLoading(true);
    try {
      await fetchApi(`/companies/${user.companyId}/inventory/adjustments`, {
        method: 'POST',
        body: JSON.stringify({
          date,
          locationId: locationId ? Number(locationId) : undefined,
          referenceNumber: referenceNumber || undefined,
          reason: reason || undefined,
          lines: lines
            .filter((l) => l.itemId && l.quantityDelta)
            .map((l) => ({
              itemId: Number(l.itemId),
              quantityDelta: Number(l.quantityDelta),
              unitCost: l.unitCost ? Number(l.unitCost) : undefined,
            })),
        }),
      });
      alert('Adjustment posted');
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
        <h1 className="text-2xl font-semibold tracking-tight">Adjust Stock</h1>
        <p className="text-sm text-muted-foreground">Quantity adjustments only (V1). Positive requires unit cost.</p>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div className="grid gap-2">
            <Label>Date</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>Location</Label>
            <SelectNative value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Company default</option>
              {warehouses.map((w) => (
                <option key={w.id} value={String(w.id)}>
                  {w.name}
                  {w.isDefault ? ' (Default)' : ''}
                </option>
              ))}
            </SelectNative>
          </div>
          <div className="grid gap-2">
            <Label>Reference #</Label>
            <Input value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} />
          </div>
          <div className="grid gap-2 md:col-span-3">
            <Label>Reason</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="md:col-span-3 flex justify-end">
            <Button onClick={submit} disabled={loading}>
              {loading ? 'Posting...' : 'Post Adjustment'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">Lines</CardTitle>
          <Button variant="outline" onClick={addLine}>
            Add line
          </Button>
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="w-[180px] text-right">Qty Delta</TableHead>
                <TableHead className="w-[200px] text-right">Unit Cost (if +)</TableHead>
                <TableHead className="w-[110px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l, idx) => (
                <TableRow key={idx}>
                  <TableCell>
                    <SelectNative value={l.itemId} onChange={(e) => updateLine(idx, { itemId: e.target.value })}>
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
                      inputMode="numeric"
                      step="1"
                      placeholder="e.g. 10 or -2"
                      value={l.quantityDelta}
                      onChange={(e) => updateLine(idx, { quantityDelta: e.target.value })}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Input
                      type="number"
                      inputMode="numeric"
                      step="1"
                      min="0"
                      value={l.unitCost}
                      onChange={(e) => updateLine(idx, { unitCost: e.target.value })}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" onClick={() => removeLine(idx)} disabled={lines.length === 1}>
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


