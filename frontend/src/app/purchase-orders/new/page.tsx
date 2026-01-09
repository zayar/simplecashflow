'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';

import { useAuth } from '@/contexts/auth-context';
import { fetchApi, type Vendor } from '@/lib/api';
import { todayInTimeZone } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectNative } from '@/components/ui/select-native';
import { ItemCombobox } from '@/components/item-combobox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

type Line = {
  itemId: string;
  itemText: string;
  quantity: string;
  unitCost: string;
  discountAmount: string;
  description: string;
};

export default function NewPurchaseOrderPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const tz = companySettings?.timeZone ?? 'Asia/Yangon';

  const [loading, setLoading] = useState(false);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [stockByItemId, setStockByItemId] = useState<Record<number, number>>({});

  const [form, setForm] = useState({
    vendorId: '',
    locationId: '',
    orderDate: '',
    expectedDate: '',
    currency: '',
    notes: '',
  });

  const [lines, setLines] = useState<Line[]>([
    { itemId: '', itemText: '', quantity: '1', unitCost: '', discountAmount: '0', description: '' },
  ]);

  useEffect(() => {
    if (!user?.companyId) return;
    fetchApi(`/companies/${user.companyId}/vendors`).then(setVendors).catch(console.error);
    fetchApi(`/companies/${user.companyId}/locations`).then(setLocations).catch(console.error);
    fetchApi(`/companies/${user.companyId}/items`).then(setItems).catch(console.error);
  }, [user?.companyId]);

  useEffect(() => {
    if (!form.orderDate) setForm((p) => ({ ...p, orderDate: todayInTimeZone(tz) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tz]);

  const activeItems = useMemo(() => items.filter((i) => i.isActive !== false), [items]);

  const selectedLocationLabel = useMemo(() => {
    const id = Number(form.locationId || 0) || null;
    if (!id) return null;
    const loc = (locations ?? []).find((l: any) => Number(l?.id) === Number(id));
    return loc ? String(loc.name ?? '').trim() || null : null;
  }, [locations, form.locationId]);

  useEffect(() => {
    if (!user?.companyId) return;
    const id = Number(form.locationId || 0) || null;
    if (!id) {
      setStockByItemId({});
      return;
    }
    let cancelled = false;
    const qs = `?locationId=${encodeURIComponent(String(id))}`;
    fetchApi(`/companies/${user.companyId}/reports/inventory-summary${qs}`)
      .then((rows) => {
        if (cancelled) return;
        const map: Record<number, number> = {};
        (Array.isArray(rows) ? rows : []).forEach((r: any) => {
          const itemId = Number(r?.item?.id ?? r?.itemId ?? 0);
          const qty = Number(r?.qtyOnHand ?? r?.qty ?? 0);
          if (Number.isFinite(itemId) && itemId > 0 && Number.isFinite(qty)) {
            map[itemId] = qty;
          }
        });
        setStockByItemId(map);
      })
      .catch(() => {
        if (cancelled) return;
        setStockByItemId({});
      });
    return () => {
      cancelled = true;
    };
  }, [user?.companyId, form.locationId]);

  function updateLine(idx: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  function applyPickedItem(idx: number, picked: any | null) {
    const itemId = picked?.id ? String(picked.id) : '';
    const baseCost = Number(picked?.costPrice ?? 0);
    updateLine(idx, {
      itemId,
      itemText: picked?.name ? String(picked.name) : '',
      unitCost:
        String(lines[idx]?.unitCost ?? '').trim() || !Number.isFinite(baseCost) || baseCost <= 0
          ? String(lines[idx]?.unitCost ?? '')
          : String(baseCost),
      description: picked?.name ? String(picked.name) : '',
    });
  }

  function handleItemTextChange(idx: number, text: string) {
    const normalized = String(text ?? '').trim();
    const picked = activeItems.find((i: any) => String(i.name ?? '').trim().toLowerCase() === normalized.toLowerCase());
    if (picked) {
      applyPickedItem(idx, picked);
      return;
    }
    updateLine(idx, { itemText: text, itemId: '' });
  }

  function addLine() {
    setLines((prev) => [...prev, { itemId: '', itemText: '', quantity: '1', unitCost: '', discountAmount: '0', description: '' }]);
  }

  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!user?.companyId) return;

    const payloadLines = lines
      .map((l) => ({
        itemId: Number(l.itemId),
        quantity: Number(l.quantity),
        unitCost: Number(l.unitCost),
        discountAmount: Number(l.discountAmount || 0),
        description: l.description || undefined,
      }))
      .filter((l) => l.itemId && l.quantity > 0 && l.unitCost > 0);

    if (!form.locationId) {
      alert('Location is required.');
      return;
    }
    if (payloadLines.length === 0) {
      alert('Add at least 1 line with item, quantity (>0), and unit cost (>0).');
      return;
    }

    setLoading(true);
    try {
      const created = await fetchApi(`/companies/${user.companyId}/purchase-orders`, {
        method: 'POST',
        body: JSON.stringify({
          vendorId: form.vendorId ? Number(form.vendorId) : null,
          locationId: Number(form.locationId),
          orderDate: form.orderDate || undefined,
          expectedDate: form.expectedDate || null,
          currency: form.currency || null,
          notes: form.notes || null,
          lines: payloadLines,
        }),
      });
      const id = Number((created as any)?.id);
      if (id) router.push(`/purchase-orders/${id}`);
      else router.push('/purchase-orders');
    } catch (err: any) {
      alert(err?.message ?? 'Failed to create purchase order');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/purchase-orders">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">New Purchase Order</h1>
            <p className="text-sm text-muted-foreground">Create a DRAFT PO. You can approve it later.</p>
          </div>
        </div>
      </div>

      <form className="space-y-6" onSubmit={submit}>
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Header</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Vendor</Label>
              <SelectNative value={form.vendorId} onChange={(e) => setForm((p) => ({ ...p, vendorId: e.target.value }))}>
                <option value="">—</option>
                {vendors.map((v) => (
                  <option key={v.id} value={String(v.id)}>
                    {v.name}
                  </option>
                ))}
              </SelectNative>
            </div>

            <div className="space-y-2">
              <Label>Location</Label>
              <SelectNative value={form.locationId} onChange={(e) => setForm((p) => ({ ...p, locationId: e.target.value }))}>
                <option value="">Select location…</option>
                {locations.map((l) => (
                  <option key={l.id} value={String(l.id)}>
                    {l.name}
                  </option>
                ))}
              </SelectNative>
            </div>

            <div className="space-y-2">
              <Label>Order date</Label>
              <Input type="date" value={form.orderDate} onChange={(e) => setForm((p) => ({ ...p, orderDate: e.target.value }))} />
            </div>

            <div className="space-y-2">
              <Label>Expected date</Label>
              <Input type="date" value={form.expectedDate} onChange={(e) => setForm((p) => ({ ...p, expectedDate: e.target.value }))} />
            </div>

            <div className="space-y-2">
              <Label>Currency (optional)</Label>
              <Input value={form.currency} onChange={(e) => setForm((p) => ({ ...p, currency: e.target.value }))} placeholder="e.g. MMK" />
            </div>

            <div className="space-y-2 md:col-span-2">
              <Label>Notes</Label>
              <Textarea value={form.notes} onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))} placeholder="Optional notes…" />
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-lg">Lines</CardTitle>
            <Button type="button" variant="outline" className="gap-2" onClick={addLine}>
              <Plus className="h-4 w-4" /> Add line
            </Button>
          </CardHeader>
          <CardContent className="pt-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead style={{ width: 280 }}>Item</TableHead>
                  <TableHead style={{ width: 120 }}>Qty</TableHead>
                  <TableHead style={{ width: 140 }}>Unit cost</TableHead>
                  <TableHead style={{ width: 140 }}>Discount</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead style={{ width: 60 }} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l, idx) => (
                  <TableRow key={idx}>
                    <TableCell>
                      <Input className="hidden" />
                      <ItemCombobox
                        items={(activeItems ?? []).map((i: any) => ({
                          id: Number(i.id),
                          name: String(i.name ?? ''),
                          sku: i.sku ?? null,
                          sellingPrice: i.sellingPrice,
                          costPrice: i.costPrice,
                          trackInventory: !!i.trackInventory,
                        }))}
                        valueText={(l as any).itemText ?? (l.itemId ? (activeItems.find((x: any) => String(x.id) === String(l.itemId))?.name ?? '') : '')}
                        placeholder="Type or click to select an item…"
                        onChangeText={(t) => handleItemTextChange(idx, t)}
                        onSelectItem={(it) => applyPickedItem(idx, { ...it, ...activeItems.find((x: any) => Number(x.id) === Number(it.id)) })}
                        stockByItemId={stockByItemId}
                        selectedLocationLabel={selectedLocationLabel}
                        currencyLabel={form.currency || null}
                        priceLabel="Cost"
                        getPrice={(it) => Number(it.costPrice ?? 0)}
                        addNewHref="/items/new"
                        disabled={!activeItems.length}
                      />
                    </TableCell>
                    <TableCell>
                      <Input value={l.quantity} onChange={(e) => updateLine(idx, { quantity: e.target.value })} inputMode="decimal" />
                    </TableCell>
                    <TableCell>
                      <Input value={l.unitCost} onChange={(e) => updateLine(idx, { unitCost: e.target.value })} inputMode="decimal" />
                    </TableCell>
                    <TableCell>
                      <Input value={l.discountAmount} onChange={(e) => updateLine(idx, { discountAmount: e.target.value })} inputMode="decimal" />
                    </TableCell>
                    <TableCell>
                      <Input value={l.description} onChange={(e) => updateLine(idx, { description: e.target.value })} placeholder="Optional…" />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button type="button" variant="ghost" size="icon" onClick={() => removeLine(idx)} disabled={lines.length === 1}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <div className="flex items-center justify-end gap-2">
          <Link href="/purchase-orders">
            <Button variant="outline" type="button">
              Cancel
            </Button>
          </Link>
          <Button type="submit" disabled={loading}>
            {loading ? 'Saving…' : 'Save Purchase Order'}
          </Button>
        </div>
      </form>
    </div>
  );
}

