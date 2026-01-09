'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';

import { useAuth } from '@/contexts/auth-context';
import { createVendorCredit, fetchApi, getAccounts, getVendors, Account, Vendor } from '@/lib/api';
import { todayInTimeZone } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectNative } from '@/components/ui/select-native';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AccountPicker } from '@/components/account-picker';
import { ItemCombobox } from '@/components/item-combobox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type Line = {
  itemId: string;
  itemText: string;
  accountId: string;
  quantity: string;
  unitCost: string;
  discountAmount: string;
  taxRate: string;
  taxLabel: string;
  description: string;
};

type TaxOption = { id: number; name: string; ratePercent: number; type: 'rate' | 'group' };

export default function NewVendorCreditPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const search = useSearchParams();
  const [loading, setLoading] = useState(false);

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [inventoryAccountId, setInventoryAccountId] = useState<number | null>(null);
  const [defaultLocationId, setDefaultLocationId] = useState<number | null>(null);
  const [stockByItemId, setStockByItemId] = useState<Record<number, number>>({});
  const [taxOptions, setTaxOptions] = useState<TaxOption[]>([]);
  const [taxSearchTerm, setTaxSearchTerm] = useState('');
  const [openTaxIdx, setOpenTaxIdx] = useState<number | null>(null);

  const [form, setForm] = useState({
    vendorId: '',
    creditDate: '',
    locationId: '',
  });

  const [lines, setLines] = useState<Line[]>([
    { itemId: '', itemText: '', accountId: '', quantity: '1', unitCost: '', discountAmount: '0', taxRate: '0', taxLabel: '', description: '' },
  ]);

  const [sourceBill, setSourceBill] = useState<any>(null);
  const fromPurchaseBillId = Number(search?.get('purchaseBillId') ?? 0);
  const isFromPurchaseBill = Number.isFinite(fromPurchaseBillId) && fromPurchaseBillId > 0;

  useEffect(() => {
    if (!user?.companyId) return;
    getVendors(user.companyId).then(setVendors).catch(console.error);
    fetchApi(`/companies/${user.companyId}/locations`).then(setLocations).catch(console.error);
    fetchApi(`/companies/${user.companyId}/items`).then(setItems).catch(console.error);
    fetchApi(`/companies/${user.companyId}/taxes`)
      .then((t) => {
        const options: TaxOption[] = [
          ...(((t as any)?.taxRates ?? []) as any[]).map((r) => ({
            id: r.id,
            name: `${r.name} [${Number(r.ratePercent ?? 0).toFixed(0)}%]`,
            ratePercent: Number(r.ratePercent ?? 0),
            type: 'rate' as const,
          })),
          ...(((t as any)?.taxGroups ?? []) as any[]).map((g) => ({
            id: g.id,
            name: `${g.name} [${Number(g.totalRatePercent ?? 0).toFixed(0)}%]`,
            ratePercent: Number(g.totalRatePercent ?? 0),
            type: 'group' as const,
          })),
        ];
        setTaxOptions(options);
      })
      .catch(() => setTaxOptions([]));
    getAccounts(user.companyId).then(setAccounts).catch(console.error);
    fetchApi(`/companies/${user.companyId}/settings`)
      .then((s) => {
        setInventoryAccountId(Number((s as any).inventoryAssetAccountId ?? 0) || null);
        const defId =
          Number(((s as any).defaultLocationId ?? (s as any).defaultWarehouseId ?? 0) || 0) || null;
        setDefaultLocationId(defId);
      })
      .catch(() => {
        setInventoryAccountId(null);
        setDefaultLocationId(null);
      });
  }, [user?.companyId]);

  // If opened from a purchase bill, prefill vendor/location/lines.
  useEffect(() => {
    if (!user?.companyId) return;
    if (!isFromPurchaseBill) return;
    fetchApi(`/companies/${user.companyId}/purchase-bills/${fromPurchaseBillId}`)
      .then((b: any) => {
        setSourceBill(b);
        const vendorId = b?.vendor?.id ? String(b.vendor.id) : '';
        const locationId = b?.warehouse?.id ? String(b.warehouse.id) : b?.location?.id ? String(b.location.id) : '';
        setForm((prev) => ({ ...prev, vendorId: vendorId || prev.vendorId, locationId: locationId || prev.locationId }));

        const billLines = (b?.lines ?? []) as any[];
        if (billLines.length > 0) {
          setLines(
            billLines.map((l: any) => ({
              itemId: String(l.itemId ?? ''),
              itemText: String(l.item?.name ?? ''),
              accountId: l.accountId ? String(l.accountId) : '',
              // Default to the same qty + unit cost as the bill line (user can adjust).
              quantity: String(Number(l.quantity ?? 0) || 0),
              unitCost: String(Number(l.unitCost ?? 0) || 0),
              discountAmount: String(Number(l.discountAmount ?? 0) || 0),
              taxRate: String(Number(l.taxRate ?? 0) || 0),
              taxLabel: '',
              description: String(l.description ?? l.item?.name ?? ''),
            }))
          );
        }
      })
      .catch((e: any) => {
        console.error(e);
        alert(e?.message ?? 'Failed to load purchase bill');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.companyId, isFromPurchaseBill, fromPurchaseBillId]);

  useEffect(() => {
    const tz = companySettings?.timeZone ?? 'Asia/Yangon';
    if (!form.creditDate) {
      setForm((prev) => ({ ...prev, creditDate: todayInTimeZone(tz) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companySettings?.timeZone]);

  const selectableItems = useMemo(() => items.filter((i) => i.isActive !== false), [items]);
  const expenseAccounts = useMemo(() => accounts.filter((a) => a.type === 'EXPENSE'), [accounts]);

  const effectiveLocationId = useMemo(() => {
    const fromForm = Number(form.locationId || 0) || null;
    if (fromForm) return fromForm;
    const fromSettings = defaultLocationId ?? null;
    if (fromSettings) return fromSettings;
    const fromLocs = Number((locations ?? []).find((l: any) => l?.isDefault)?.id ?? 0) || null;
    return fromLocs;
  }, [form.locationId, defaultLocationId, locations]);

  const selectedLocationLabel = useMemo(() => {
    if (!effectiveLocationId) return null;
    const loc = (locations ?? []).find((l: any) => Number(l?.id) === Number(effectiveLocationId));
    return loc ? String(loc.name ?? '').trim() || null : null;
  }, [locations, effectiveLocationId]);

  // Stock on hand map for selected location (UX only).
  useEffect(() => {
    if (!user?.companyId) return;
    if (!effectiveLocationId) {
      setStockByItemId({});
      return;
    }
    let cancelled = false;
    const qs = `?locationId=${encodeURIComponent(String(effectiveLocationId))}`;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.companyId, effectiveLocationId]);

  const subtotalAmount = useMemo(() => {
    return lines.reduce((sum, l) => {
      const gross = Number(l.quantity || 0) * Number(l.unitCost || 0);
      const disc = Number((l as any).discountAmount || 0);
      return sum + Math.max(0, gross - (Number.isFinite(disc) ? disc : 0));
    }, 0);
  }, [lines]);

  const taxAmount = useMemo(() => {
    return lines.reduce((sum, l) => {
      const gross = Number(l.quantity || 0) * Number(l.unitCost || 0);
      const disc = Number((l as any).discountAmount || 0);
      const net = Math.max(0, gross - (Number.isFinite(disc) ? disc : 0));
      const rate = Number((l as any).taxRate ?? 0);
      if (!Number.isFinite(rate) || rate <= 0) return sum;
      return sum + net * rate;
    }, 0);
  }, [lines]);

  const total = useMemo(() => subtotalAmount + taxAmount, [subtotalAmount, taxAmount]);

  function updateLine(idx: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  function applyPickedItem(idx: number, picked: any | null) {
    const itemId = picked?.id ? String(picked.id) : '';
    const pickedTracked = picked?.type === 'GOODS' && !!picked?.trackInventory;
    const nextAccountId = pickedTracked
      ? inventoryAccountId
        ? String(inventoryAccountId)
        : ''
      : picked?.expenseAccountId
        ? String(picked.expenseAccountId)
        : '';
    const baseCost = Number(picked?.costPrice ?? 0);
    updateLine(idx, {
      itemId,
      itemText: picked?.name ? String(picked.name) : '',
      accountId: nextAccountId,
      unitCost:
        String(lines[idx]?.unitCost ?? '').trim() || !Number.isFinite(baseCost) || baseCost <= 0
          ? String(lines[idx]?.unitCost ?? '')
          : String(baseCost),
      description: picked?.name ? String(picked.name) : '',
    });
  }

  function handleItemTextChange(idx: number, text: string) {
    if (sourceBill) return;
    const normalized = String(text ?? '').trim();
    const picked = selectableItems.find((i: any) => String(i.name ?? '').trim().toLowerCase() === normalized.toLowerCase());
    if (picked) {
      applyPickedItem(idx, picked);
      return;
    }
    updateLine(idx, { itemText: text, itemId: '' });
  }
  function addLine() {
    if (isFromPurchaseBill) return;
    setLines((prev) => [
      ...prev,
      { itemId: '', itemText: '', accountId: '', quantity: '1', unitCost: '', discountAmount: '0', taxRate: '0', taxLabel: '', description: '' },
    ]);
  }
  function removeLine(idx: number) {
    if (isFromPurchaseBill) return;
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!user?.companyId) return;

    const payloadLines = lines
      .map((l) => ({
        itemId: Number(l.itemId),
        accountId: l.accountId ? Number(l.accountId) : undefined,
        quantity: Number(l.quantity),
        unitCost: Number(l.unitCost),
        discountAmount: Number((l as any).discountAmount || 0),
        taxRate: Number((l as any).taxRate || 0),
        description: l.description || undefined,
      }))
      .filter((l) => l.itemId && l.quantity > 0 && l.unitCost > 0);

    if (payloadLines.length === 0) {
      alert('Add at least 1 line with item, quantity (>0), and unit cost (>0).');
      return;
    }

    setLoading(true);
    try {
      const vc = await createVendorCredit(user.companyId, {
        vendorId: form.vendorId ? Number(form.vendorId) : null,
        creditDate: form.creditDate,
        locationId: form.locationId ? Number(form.locationId) : undefined,
        lines: payloadLines,
      });
      router.push(`/vendor-credits/${vc.id}`);
    } catch (err: any) {
      alert(err.message || 'Failed to create vendor credit');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href={isFromPurchaseBill ? `/purchase-bills/${fromPurchaseBillId}` : '/vendor-credits'}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">New Vendor Credit</h1>
          <p className="text-sm text-muted-foreground">
            {sourceBill ? `Vendor credit for Purchase Bill #${sourceBill.billNumber}` : 'Create a credit from a supplier and apply it to purchase bills.'}
          </p>
        </div>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="grid gap-2">
                <Label>Vendor</Label>
                <SelectNative
                  value={form.vendorId}
                  onChange={(e) => setForm({ ...form, vendorId: e.target.value })}
                  disabled={!!sourceBill}
                >
                  <option value="">—</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={String(v.id)}>
                      {v.name}
                    </option>
                  ))}
                </SelectNative>
              </div>
              <div className="grid gap-2">
                <Label>Credit Date</Label>
                <Input type="date" value={form.creditDate} onChange={(e) => setForm({ ...form, creditDate: e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label>Branch / Location</Label>
                <SelectNative
                  value={form.locationId}
                  onChange={(e) => setForm({ ...form, locationId: e.target.value })}
                  disabled={!!sourceBill}
                >
                  <option value="">Company default</option>
                  {locations.map((l) => (
                    <option key={l.id} value={String(l.id)}>
                      {l.name}
                      {l.isDefault ? ' (Default)' : ''}
                    </option>
                  ))}
                </SelectNative>
              </div>
            </div>

            <Card className="shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">Item Table</CardTitle>
                <Button type="button" variant="outline" onClick={addLine} className="gap-2" disabled={!!sourceBill}>
                  <Plus className="h-4 w-4" /> Add New Row
                </Button>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40">
                        <TableHead className="w-[420px]">ITEM</TableHead>
                        <TableHead className="w-[220px]">ACCOUNT</TableHead>
                        <TableHead className="w-[110px] text-right">QTY</TableHead>
                        <TableHead className="w-[160px] text-right">RATE</TableHead>
                        <TableHead className="w-[140px] text-right">DISCOUNT</TableHead>
                        <TableHead className="w-[200px]">TAX</TableHead>
                        <TableHead className="w-[160px] text-right">AMOUNT</TableHead>
                        <TableHead className="w-[60px]" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {lines.map((l, idx) => {
                        const it = selectableItems.find((x) => String(x.id) === String(l.itemId));
                        const isTracked = it?.type === 'GOODS' && !!it?.trackInventory;
                        const gross = Number(l.quantity || 0) * Number(l.unitCost || 0);
                        const disc = Number((l as any).discountAmount || 0);
                        const net = Math.max(0, gross - (Number.isFinite(disc) ? disc : 0));
                        const rate = Number((l as any).taxRate ?? 0);
                        const lineTax = Number.isFinite(rate) && rate > 0 ? net * rate : 0;
                        const lineTotal = net + (Number.isFinite(lineTax) ? lineTax : 0);
                        return (
                          <TableRow key={idx}>
                            <TableCell className="align-top">
                              <Input className="hidden" />
                              <ItemCombobox
                                items={(selectableItems ?? []).map((i: any) => ({
                                  id: Number(i.id),
                                  name: String(i.name ?? ''),
                                  sku: i.sku ?? null,
                                  sellingPrice: i.sellingPrice,
                                  costPrice: i.costPrice,
                                  trackInventory: !!i.trackInventory,
                                }))}
                                valueText={(l as any).itemText ?? (l.itemId ? (selectableItems.find((x: any) => String(x.id) === String(l.itemId))?.name ?? '') : '')}
                                placeholder="Type or click to select an item…"
                                onChangeText={(t) => handleItemTextChange(idx, t)}
                                onSelectItem={(it) => applyPickedItem(idx, { ...it, ...selectableItems.find((x: any) => Number(x.id) === Number(it.id)) })}
                                stockByItemId={stockByItemId}
                                selectedLocationLabel={selectedLocationLabel}
                                currencyLabel={null}
                                priceLabel="Cost"
                                getPrice={(it) => Number(it.costPrice ?? 0)}
                                addNewHref="/items/new"
                                disabled={!selectableItems.length || !!sourceBill}
                              />
                              <div className="mt-2">
                                <Input
                                  placeholder="Description (optional)"
                                  value={l.description}
                                  onChange={(e) => updateLine(idx, { description: e.target.value })}
                                  disabled={!!sourceBill}
                                />
                              </div>
                            </TableCell>
                            <TableCell className="align-top">
                              {isTracked ? (
                                <Input disabled value={inventoryAccountId ? `Inventory Asset (#${inventoryAccountId})` : 'Inventory Asset'} />
                              ) : (
                                <AccountPicker
                                  accounts={expenseAccounts}
                                  value={l.accountId}
                                  onChange={(v) => updateLine(idx, { accountId: v ? String(v) : '' })}
                                  placeholder="Select account…"
                                />
                              )}
                            </TableCell>
                            <TableCell className="align-top">
                              <Input
                                type="number"
                                inputMode="numeric"
                                step="1"
                                min="1"
                                className="text-right"
                                value={l.quantity}
                                onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                              />
                            </TableCell>
                            <TableCell className="align-top">
                              <Input
                                type="number"
                                inputMode="decimal"
                                step="0.01"
                                min="0"
                                className="text-right"
                                value={l.unitCost}
                                onChange={(e) => updateLine(idx, { unitCost: e.target.value })}
                                // Allow editing rate even when created from a bill (user requested).
                                disabled={false}
                              />
                            </TableCell>
                            <TableCell className="align-top">
                              <Input
                                type="number"
                                inputMode="decimal"
                                step="0.01"
                                min="0"
                                className="text-right"
                                value={(l as any).discountAmount ?? '0'}
                                onChange={(e) => updateLine(idx, { discountAmount: e.target.value } as any)}
                                disabled={!!sourceBill}
                              />
                            </TableCell>
                            <TableCell className="align-top">
                              <DropdownMenu open={openTaxIdx === idx} onOpenChange={(o) => setOpenTaxIdx(o ? idx : null)}>
                                <DropdownMenuTrigger asChild>
                                  <Button type="button" variant="outline" className="w-full justify-between" disabled={!!sourceBill}>
                                    <span className="truncate">{(l as any).taxLabel ? (l as any).taxLabel : 'No tax'}</span>
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="start" className="w-[280px] p-0">
                                  <div className="border-b p-2">
                                    <Input
                                      placeholder="Search tax…"
                                      value={taxSearchTerm}
                                      onChange={(e) => setTaxSearchTerm(e.target.value)}
                                      disabled={!!sourceBill}
                                    />
                                  </div>
                                  <div className="max-h-64 overflow-auto p-2">
                                    <DropdownMenuItem
                                      onSelect={() => {
                                        updateLine(idx, { taxRate: '0', taxLabel: '' } as any);
                                        setOpenTaxIdx(null);
                                      }}
                                    >
                                      No tax
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    {(taxOptions ?? [])
                                      .filter((t) => String(t.name).toLowerCase().includes(String(taxSearchTerm || '').toLowerCase()))
                                      .slice(0, 50)
                                      .map((t) => (
                                        <DropdownMenuItem
                                          key={`${t.type}-${t.id}`}
                                          onSelect={() => {
                                            updateLine(idx, { taxRate: String((t.ratePercent ?? 0) / 100), taxLabel: t.name } as any);
                                            setOpenTaxIdx(null);
                                          }}
                                        >
                                          {t.name}
                                        </DropdownMenuItem>
                                      ))}
                                  </div>
                                </DropdownMenuContent>
                              </DropdownMenu>
                              <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                                Tax: {Number.isFinite(lineTax) ? lineTax.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '0'}
                              </div>
                            </TableCell>
                            <TableCell className="align-top text-right font-medium tabular-nums">
                              {Number.isFinite(lineTotal) ? lineTotal.toLocaleString() : '0'}
                            </TableCell>
                            <TableCell className="align-top">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => removeLine(idx)}
                                disabled={lines.length <= 1 || !!sourceBill}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            <div className="rounded-xl border bg-muted/20 px-4 py-3 text-sm">
              <div className="flex items-center justify-between text-muted-foreground">
                <span>Subtotal</span>
                <span className="font-medium tabular-nums">{subtotalAmount.toLocaleString()}</span>
              </div>
              <div className="mt-1 flex items-center justify-between text-muted-foreground">
                <span>Tax</span>
                <span className="font-medium tabular-nums">{taxAmount.toLocaleString()}</span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-muted-foreground">Total</span>
                <span className="text-lg font-semibold tabular-nums">{total.toLocaleString()}</span>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Link href="/vendor-credits">
                <Button type="button" variant="outline">Cancel</Button>
              </Link>
              <Button type="submit" loading={loading} loadingText="Saving...">
                Save Vendor Credit
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}


