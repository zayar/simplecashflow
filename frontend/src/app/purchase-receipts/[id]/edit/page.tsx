'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
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

type Line = {
  itemId: string;
  itemText: string;
  quantity: string;
  unitCost: string;
  discountAmount: string;
  description: string;
};

export default function EditPurchaseReceiptPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = Number(params?.id);
  const tz = companySettings?.timeZone ?? 'Asia/Yangon';

  const [loading, setLoading] = useState(false);
  const [loadingDoc, setLoadingDoc] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);

  const [doc, setDoc] = useState<any>(null);
  const [form, setForm] = useState({
    vendorId: '',
    purchaseOrderId: '',
    locationId: '',
    receiptDate: '',
    expectedDate: '',
    currency: '',
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
    if (!form.receiptDate) setForm((p) => ({ ...p, receiptDate: todayInTimeZone(tz) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tz]);

  useEffect(() => {
    if (!user?.companyId || !id || Number.isNaN(id)) return;
    setLoadingDoc(true);
    setError(null);
    fetchApi(`/companies/${user.companyId}/purchase-receipts/${id}`)
      .then((data) => {
        setDoc(data);
        if (data?.status !== 'DRAFT') {
          setError('Only DRAFT purchase receipts can be edited.');
          return;
        }
        setForm({
          vendorId: data?.vendor?.id ? String(data.vendor.id) : '',
          purchaseOrderId: data?.purchaseOrderId ? String(data.purchaseOrderId) : '',
          locationId: data?.location?.id ? String(data.location.id) : data?.warehouse?.id ? String(data.warehouse.id) : '',
          receiptDate: data?.receiptDate ? String(data.receiptDate).slice(0, 10) : '',
          expectedDate: data?.expectedDate ? String(data.expectedDate).slice(0, 10) : '',
          currency: data?.currency ? String(data.currency) : '',
        });
        const docLines = (data?.lines ?? []) as any[];
        if (docLines.length > 0) {
          setLines(
            docLines.map((l: any) => ({
              itemId: String(l.itemId ?? ''),
              itemText: String(l.item?.name ?? ''),
              quantity: String(Number(l.quantity ?? 0)),
              unitCost: String(Number(l.unitCost ?? 0)),
              discountAmount: String(Number(l.discountAmount ?? 0)),
              description: l.description ?? '',
            }))
          );
        }
      })
      .catch((e) => setError(e?.message ?? String(e)))
      .finally(() => setLoadingDoc(false));
  }, [user?.companyId, id]);

  const selectableItems = useMemo(() => {
    // Backend currently enforces receipts are tracked GOODS only.
    return items.filter((i) => i.isActive !== false && i.type === 'GOODS' && !!i.trackInventory);
  }, [items]);

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
    const picked = selectableItems.find((i: any) => String(i.name ?? '').trim().toLowerCase() === normalized.toLowerCase());
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
    if (!user?.companyId || !id || Number.isNaN(id)) return;
    if (error) return;

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
      await fetchApi(`/companies/${user.companyId}/purchase-receipts/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          vendorId: form.vendorId ? Number(form.vendorId) : null,
          purchaseOrderId: form.purchaseOrderId ? Number(form.purchaseOrderId) : null,
          locationId: Number(form.locationId),
          receiptDate: form.receiptDate || undefined,
          expectedDate: form.expectedDate || null,
          currency: form.currency || null,
          lines: payloadLines,
        }),
      });
      router.push(`/purchase-receipts/${id}`);
    } catch (err: any) {
      alert(err?.message ?? 'Failed to update purchase receipt');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href={`/purchase-receipts/${id}`}>
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Edit Purchase Receipt</h1>
            <p className="text-sm text-muted-foreground">Only DRAFT receipts can be edited. Posted receipts must be voided.</p>
          </div>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          <div className="font-medium">Cannot edit</div>
          <div className="text-red-800">{error}</div>
        </div>
      ) : null}

      <form className="space-y-6" onSubmit={submit}>
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Header</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Vendor</Label>
              <SelectNative value={form.vendorId} onChange={(e) => setForm((p) => ({ ...p, vendorId: e.target.value }))} disabled={!!error}>
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
              <SelectNative value={form.locationId} onChange={(e) => setForm((p) => ({ ...p, locationId: e.target.value }))} disabled={!!error}>
                <option value="">Select location…</option>
                {locations.map((l) => (
                  <option key={l.id} value={String(l.id)}>
                    {l.name}
                  </option>
                ))}
              </SelectNative>
            </div>

            <div className="space-y-2">
              <Label>Receipt date</Label>
              <Input type="date" value={form.receiptDate} onChange={(e) => setForm((p) => ({ ...p, receiptDate: e.target.value }))} disabled={!!error} />
            </div>

            <div className="space-y-2">
              <Label>Expected date</Label>
              <Input type="date" value={form.expectedDate} onChange={(e) => setForm((p) => ({ ...p, expectedDate: e.target.value }))} disabled={!!error} />
            </div>

            <div className="space-y-2">
              <Label>Currency (optional)</Label>
              <Input value={form.currency} onChange={(e) => setForm((p) => ({ ...p, currency: e.target.value }))} placeholder="e.g. MMK" disabled={!!error} />
            </div>

            <div className="space-y-2">
              <Label>PO ID (optional)</Label>
              <Input value={form.purchaseOrderId} onChange={(e) => setForm((p) => ({ ...p, purchaseOrderId: e.target.value }))} placeholder="e.g. 123" disabled={!!error} />
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-lg">Lines</CardTitle>
            <Button type="button" variant="outline" className="gap-2" onClick={addLine} disabled={!!error}>
              <Plus className="h-4 w-4" /> Add line
            </Button>
          </CardHeader>
          <CardContent className="pt-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="w-[110px] text-right">Qty</TableHead>
                  <TableHead className="w-[130px] text-right">Unit cost</TableHead>
                  <TableHead className="w-[140px] text-right">Discount</TableHead>
                  <TableHead className="w-[70px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l, idx) => (
                  <TableRow key={idx}>
                    <TableCell>
                      <div className="space-y-2">
                        <ItemCombobox
                          items={selectableItems}
                          value={l.itemText}
                          placeholder="Select tracked goods item…"
                          onChange={(text) => handleItemTextChange(idx, text)}
                          onPick={(picked) => applyPickedItem(idx, picked)}
                          disabled={!!error}
                        />
                        <Input value={l.description} onChange={(e) => updateLine(idx, { description: e.target.value })} placeholder="Description (optional)" disabled={!!error} />
                      </div>
                    </TableCell>
                    <TableCell>
                      <Input className="text-right" value={l.quantity} onChange={(e) => updateLine(idx, { quantity: e.target.value })} disabled={!!error} />
                    </TableCell>
                    <TableCell>
                      <Input className="text-right" value={l.unitCost} onChange={(e) => updateLine(idx, { unitCost: e.target.value })} disabled={!!error} />
                    </TableCell>
                    <TableCell>
                      <Input className="text-right" value={l.discountAmount} onChange={(e) => updateLine(idx, { discountAmount: e.target.value })} disabled={!!error} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button type="button" variant="ghost" size="icon" onClick={() => removeLine(idx)} disabled={!!error || lines.length <= 1}>
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
          <Link href={`/purchase-receipts/${id}`}>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </Link>
          <Button type="submit" disabled={loadingDoc || loading || !!error}>
            {loading ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </div>
  );
}

