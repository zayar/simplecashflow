'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Plus, Trash2, Pencil } from 'lucide-react';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi, getAccounts, getVendors, getCurrenciesOverview, getExchangeRates, Account, Vendor } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectNative } from '@/components/ui/select-native';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { todayInTimeZone } from '@/lib/utils';
import { Textarea } from '@/components/ui/textarea';
import { AccountPicker } from '@/components/account-picker';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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

export default function NewPurchaseBillPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const baseCurrency = useMemo(() => {
    const cur = String(companySettings?.baseCurrency ?? '').trim().toUpperCase();
    return cur || null;
  }, [companySettings?.baseCurrency]);

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

  const [currencyOptions, setCurrencyOptions] = useState<string[]>([]);
  const [entryCurrency, setEntryCurrency] = useState<string>('');
  const [enterInEntryCurrency, setEnterInEntryCurrency] = useState(true);
  const isFx = useMemo(() => !!(baseCurrency && entryCurrency && entryCurrency !== baseCurrency), [baseCurrency, entryCurrency]);
  const [fxRateToBase, setFxRateToBase] = useState<number | null>(null);
  const [fxAsOfDate, setFxAsOfDate] = useState<string | null>(null);
  const [fxRateManual, setFxRateManual] = useState(false);
  const [fxEditOpen, setFxEditOpen] = useState(false);
  const [fxEditRate, setFxEditRate] = useState('');
  const [fxEditRecalc, setFxEditRecalc] = useState(false);

  const [form, setForm] = useState({
    vendorId: '',
    billDate: '',
    dueDate: '',
    locationId: '',
  });

  const [lines, setLines] = useState<Line[]>([
    { itemId: '', itemText: '', accountId: '', quantity: '1', unitCost: '', discountAmount: '0', taxRate: '0', taxLabel: '', description: '' },
  ]);

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

    // Load available currencies for the exchange-rate picker (reference-only).
    getCurrenciesOverview(user.companyId)
      .then((ov) => {
        const base = String((ov as any)?.baseCurrency ?? baseCurrency ?? '').trim().toUpperCase();
        const codes = Array.from(
          new Set<string>([
            ...(base ? [base] : []),
            ...(((ov as any)?.currencies ?? []) as any[]).map((c: any) => String(c.code ?? '').trim().toUpperCase()).filter(Boolean),
          ])
        );
        setCurrencyOptions(codes);
        if (!entryCurrency && base) setEntryCurrency(base);
      })
      .catch(() => {
        if (!entryCurrency && baseCurrency) setEntryCurrency(baseCurrency);
      });
  }, [user?.companyId]);

  useEffect(() => {
    const tz = companySettings?.timeZone ?? 'Asia/Yangon';
    if (!form.billDate) {
      setForm((prev) => ({ ...prev, billDate: todayInTimeZone(tz) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companySettings?.timeZone]);

  // If entry currency changes, reset manual override.
  useEffect(() => {
    setFxRateManual(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryCurrency]);

  // Fetch suggested exchange rate (does not write to company settings)
  useEffect(() => {
    if (!user?.companyId) return;
    if (!isFx) {
      setFxRateToBase(null);
      setFxAsOfDate(null);
      setFxRateManual(false);
      return;
    }
    if (fxRateManual) return;
    let cancelled = false;
    getExchangeRates(user.companyId, entryCurrency)
      .then((rows) => {
        if (cancelled) return;
        const billDateStr = String(form.billDate ?? '').slice(0, 10);
        const billDate = billDateStr ? new Date(billDateStr) : null;
        const pick =
          (rows ?? []).find((r: any) => {
            if (!billDate) return true;
            const d = new Date(String(r.asOfDate ?? ''));
            if (Number.isNaN(d.getTime())) return false;
            return d.getTime() <= billDate.getTime();
          }) ?? (rows ?? [])[0];
        const rate = pick ? Number((pick as any).rateToBase) : 0;
        if (!pick || !Number.isFinite(rate) || rate <= 0) {
          setFxRateToBase(null);
          setFxAsOfDate(null);
          return;
        }
        setFxRateToBase(rate);
        setFxAsOfDate((pick as any).asOfDate ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setFxRateToBase(null);
        setFxAsOfDate(null);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.companyId, isFx, entryCurrency, form.billDate, fxRateManual]);

  function openFxEditor() {
    setFxEditRate(fxRateToBase && fxRateToBase > 0 ? String(fxRateToBase) : '');
    setFxEditRecalc(false);
    setFxEditOpen(true);
  }

  function applyFxRateOverride() {
    const next = Number(fxEditRate);
    if (!Number.isFinite(next) || next <= 0) {
      alert('Exchange rate must be a positive number.');
      return;
    }
    const prev = fxRateToBase && fxRateToBase > 0 ? fxRateToBase : null;
    setFxRateToBase(next);
    setFxAsOfDate(form.billDate || null);
    setFxRateManual(true);

    // Optional: recalc entry-currency costs so base amounts remain unchanged.
    if (fxEditRecalc && enterInEntryCurrency && prev && prev > 0) {
      const factor = prev / next;
      setLines((old) =>
        old.map((l) => ({
          ...l,
          unitCost: String(Number(l.unitCost || 0) * factor),
          discountAmount: String(Number(l.discountAmount || 0) * factor),
        }))
      );
    }
    setFxEditOpen(false);
  }

  const selectableItems = useMemo(() => items.filter((i) => i.isActive !== false), [items]);
  const expenseAccounts = useMemo(() => accounts.filter((a) => a.type === 'EXPENSE'), [accounts]);
  const inventoryAccount = useMemo(
    () => (inventoryAccountId ? accounts.find((a) => a.id === inventoryAccountId) ?? null : null),
    [accounts, inventoryAccountId]
  );
  const subtotalAmount = useMemo(() => {
    return lines.reduce((sum, l) => {
      const gross = Number(l.quantity || 0) * Number(l.unitCost || 0);
      const disc = Number(l.discountAmount || 0);
      return sum + Math.max(0, gross - (Number.isFinite(disc) ? disc : 0));
    }, 0);
  }, [lines]);

  const taxAmount = useMemo(() => {
    return lines.reduce((sum, l) => {
      const gross = Number(l.quantity || 0) * Number(l.unitCost || 0);
      const disc = Number(l.discountAmount || 0);
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

    const showFx = !!(isFx && enterInEntryCurrency && fxRateToBase && fxRateToBase > 0);
    const baseCost = Number(picked?.costPrice ?? 0);
    const nextCost = showFx ? baseCost / Number(fxRateToBase || 1) : baseCost;

    updateLine(idx, {
      itemId,
      itemText: picked?.name ? String(picked.name) : '',
      accountId: nextAccountId,
      unitCost:
        String(lines[idx]?.unitCost ?? '').trim() || !Number.isFinite(nextCost) || nextCost <= 0
          ? String(lines[idx]?.unitCost ?? '')
          : String(nextCost),
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
    // allow typing/searching without selecting yet
    updateLine(idx, { itemText: text, itemId: '' });
  }

  function addLine() {
    setLines((prev) => [
      ...prev,
      { itemId: '', itemText: '', accountId: '', quantity: '1', unitCost: '', discountAmount: '0', taxRate: '0', taxLabel: '', description: '' },
    ]);
  }

  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!user?.companyId) return;
    // Draft-friendly: allow saving even if some lines are missing account mapping.
    // Posting (on the detail page) will enforce required account mappings.

    const payloadLines = lines
      .map((l) => ({
        itemId: Number(l.itemId),
        accountId: l.accountId ? Number(l.accountId) : undefined,
        quantity: Number(l.quantity),
        unitCost: Number(l.unitCost),
        discountAmount: Number(l.discountAmount || 0),
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
      const showFx = !!(isFx && enterInEntryCurrency && fxRateToBase && fxRateToBase > 0);
      const factor = showFx ? fxRateToBase! : 1;
      const bill = await fetchApi(`/companies/${user.companyId}/purchase-bills`, {
        method: 'POST',
        body: JSON.stringify({
          vendorId: form.vendorId ? Number(form.vendorId) : null,
          billDate: form.billDate,
          dueDate: form.dueDate || undefined,
          locationId: form.locationId ? Number(form.locationId) : undefined,
          // We always save in base currency in this app today; FX is just a per-document entry helper.
          // (Does NOT change company exchange rates.)
          lines: payloadLines.map((l) => ({
            ...l,
            unitCost: Number(l.unitCost) * factor,
            discountAmount: Number(l.discountAmount ?? 0) * factor,
          })),
        }),
      });
      router.push(`/purchase-bills/${bill.id}`);
    } catch (err: any) {
      alert(err.message || 'Failed to create purchase bill');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/purchase-bills">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">New Purchase Bill</h1>
          <p className="text-sm text-muted-foreground">
            Add inventory items and post to increase Inventory and Accounts Payable.
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
                <Label>Supplier</Label>
                <SelectNative value={form.vendorId} onChange={(e) => setForm({ ...form, vendorId: e.target.value })}>
                  <option value="">—</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={String(v.id)}>
                      {v.name}
                    </option>
                  ))}
                </SelectNative>
              </div>
              <div className="grid gap-2">
                <Label>Bill Date</Label>
                <Input type="date" value={form.billDate} onChange={(e) => setForm({ ...form, billDate: e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label>Due Date</Label>
                <Input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
              </div>
            </div>

            {baseCurrency ? (
              <Card className="shadow-sm">
                <CardHeader>
                  <CardTitle className="text-base">Exchange Rate (optional)</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="grid gap-2 md:max-w-sm">
                    <Label>Entry Currency</Label>
                    <SelectNative
                      value={entryCurrency}
                      onChange={(e) => setEntryCurrency(String(e.target.value).trim().toUpperCase())}
                    >
                      {(currencyOptions.length ? currencyOptions : [baseCurrency]).map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </SelectNative>
                    <div className="text-xs text-muted-foreground">
                      Base currency is <b>{baseCurrency}</b>. If you select a different currency, costs/discounts will be converted to base when saved.
                    </div>
                  </div>

                  {isFx ? (
                    <>
                      {fxRateToBase ? (
                        <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
                          <div>
                            Exchange rate: <b>1 {entryCurrency} = {baseCurrency}{fxRateToBase}</b>
                            {fxAsOfDate ? ` (as of ${String(fxAsOfDate).slice(0, 10)})` : ''}
                            {fxRateManual ? <span className="ml-2 text-xs text-orange-600">(custom)</span> : null}
                          </div>
                          <Button type="button" variant="outline" size="sm" onClick={openFxEditor}>
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit rate
                          </Button>
                        </div>
                      ) : (
                        <div className="text-orange-600">
                          No exchange rate found for {entryCurrency}. Add it in Currencies, or enter a custom rate here.
                        </div>
                      )}

                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={enterInEntryCurrency}
                          onChange={(e) => setEnterInEntryCurrency(e.target.checked)}
                        />
                        <span>
                          Enter costs/discounts in <b>{entryCurrency}</b> (will be saved in {baseCurrency})
                        </span>
                      </label>
                    </>
                  ) : (
                    <div className="text-muted-foreground">Entry currency is the same as base. No conversion will be applied.</div>
                  )}
                </CardContent>
              </Card>
            ) : null}

            <div className="grid gap-2 md:max-w-sm">
              <Label>Location</Label>
              <SelectNative value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })}>
                <option value="">Company default</option>
                {locations.map((l) => (
                  <option key={l.id} value={String(l.id)}>
                    {l.name}
                    {l.isDefault ? ' (Default)' : ''}
                  </option>
                ))}
              </SelectNative>
            </div>

            <Card className="shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">Lines</CardTitle>
                <Button type="button" variant="outline" onClick={addLine} className="gap-2">
                  <Plus className="h-4 w-4" /> Add Item
                </Button>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                      <TableRow className="bg-muted/40">
                        <TableHead className="w-[420px]">ITEM</TableHead>
                        <TableHead className="w-[140px] text-right">QTY</TableHead>
                        <TableHead className="w-[160px]">UNIT</TableHead>
                        <TableHead className="w-[160px] text-right">PRICE</TableHead>
                        <TableHead className="w-[220px]">ACCOUNT</TableHead>
                        <TableHead className="w-[160px] text-right">DISCOUNT</TableHead>
                        <TableHead className="w-[200px]">TAX</TableHead>
                        <TableHead className="w-[160px] text-right">ITEM AMOUNT</TableHead>
                        <TableHead className="w-[60px]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                      {lines.map((l, idx) => {
                        const it = selectableItems.find((x) => String(x.id) === String(l.itemId));
                        const isTracked = it?.type === 'GOODS' && !!it?.trackInventory;
                        const gross = Number(l.quantity || 0) * Number(l.unitCost || 0);
                        const disc = Number(l.discountAmount || 0);
                        const net = Math.max(0, gross - (Number.isFinite(disc) ? disc : 0));
                        const rate = Number((l as any).taxRate ?? 0);
                        const lineTax = Number.isFinite(rate) && rate > 0 ? net * rate : 0;
                        const lineTotal = net + (Number.isFinite(lineTax) ? lineTax : 0);
                        return (
                          <>
                          <TableRow key={`main-${idx}`} className="border-b-0">
                            <TableCell className="align-top">
                              <div className="space-y-2">
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
                                  currencyLabel={enterInEntryCurrency && entryCurrency ? entryCurrency : baseCurrency}
                                  priceLabel="Cost"
                                  getPrice={(it) => Number(it.costPrice ?? 0)}
                                  addNewHref="/items/new"
                                  disabled={!selectableItems.length}
                                />

                              </div>
                        </TableCell>
                            <TableCell className="align-top">
                          <Input
                            type="number"
                            inputMode="numeric"
                            step="1"
                            min="1"
                            className="w-[120px] text-right text-base tabular-nums"
                            value={l.quantity}
                            onChange={(e) => {
                              const next = e.target.value;
                              updateLine(idx, { quantity: next.includes('.') ? String(Math.trunc(Number(next))) : next });
                            }}
                          />
                        </TableCell>
                            <TableCell className="align-top">
                              <Input disabled placeholder="Enter a Unit" />
                            </TableCell>
                            <TableCell className="align-top">
                          <Input
                            type="number"
                            inputMode="decimal"
                            step="1"
                            min="0"
                                className="text-right"
                            value={l.unitCost}
                            onChange={(e) => updateLine(idx, { unitCost: e.target.value })}
                          />
                        </TableCell>
                            <TableCell className="align-top">
                              {isTracked ? (
                                <AccountPicker
                                  accounts={inventoryAccount ? [inventoryAccount as any] : []}
                                  value={inventoryAccount ? inventoryAccount.id : null}
                                  onChange={() => {}}
                                  placeholder={inventoryAccount ? inventoryAccount.name : 'Inventory (not set)'}
                                  disabled
                                  createHref="/accounts/new"
                                />
                              ) : (
                                <AccountPicker
                                  accounts={accounts}
                                  value={l.accountId ? Number(l.accountId) : null}
                                  onChange={(nextId) => updateLine(idx, { accountId: nextId ? String(nextId) : '' })}
                                  placeholder="Select an account"
                                  disabled={!accounts.length}
                                  createHref="/accounts/new"
                                />
                              )}
                              {!isTracked && l.itemId && !l.accountId ? (
                                <div className="mt-1 text-xs text-orange-600">
                                  Missing account → you can save Draft, but you can’t Post until set.
                                </div>
                              ) : null}
                            </TableCell>
                            <TableCell className="align-top">
                              <Input
                                type="number"
                                inputMode="numeric"
                                step="1"
                                min="0"
                                className="text-right"
                                value={l.discountAmount}
                                onChange={(e) => updateLine(idx, { discountAmount: e.target.value })}
                              />
                            </TableCell>
                            <TableCell className="align-top">
                              <DropdownMenu open={openTaxIdx === idx} onOpenChange={(o) => setOpenTaxIdx(o ? idx : null)}>
                                <DropdownMenuTrigger asChild>
                                  <Button type="button" variant="outline" className="w-full justify-between">
                                    <span className="truncate">{(l as any).taxLabel ? (l as any).taxLabel : 'No tax'}</span>
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="start" className="w-[280px] p-0">
                                  <div className="border-b p-2">
                                    <Input
                                      placeholder="Search tax…"
                                      value={taxSearchTerm}
                                      onChange={(e) => setTaxSearchTerm(e.target.value)}
                                    />
                                  </div>
                                  <div className="max-h-64 overflow-auto p-2">
                                    <DropdownMenuItem
                                      onSelect={() => {
                                        updateLine(idx, { taxRate: '0', taxLabel: '' });
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
                                            updateLine(idx, { taxRate: String((t.ratePercent ?? 0) / 100), taxLabel: t.name });
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
                            <TableCell className="align-top text-right font-semibold tabular-nums">
                              {lineTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </TableCell>
                            <TableCell className="align-top text-right">
                              <Button type="button" variant="ghost" size="icon" onClick={() => removeLine(idx)} disabled={lines.length === 1}>
                                <Trash2 className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        </TableCell>
                      </TableRow>
                          </>
                        );
                      })}
                  </TableBody>
                </Table>
                </div>
                <div className="flex justify-end pt-4 text-sm">
                  <div className="space-y-1 text-right text-muted-foreground">
                    <div>
                      Subtotal:{' '}
                      <span className="font-medium tabular-nums">
                        {subtotalAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </div>
                    <div>
                      Tax:{' '}
                      <span className="font-medium tabular-nums">
                        {taxAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </div>
                    <div>
                      Total:{' '}
                      <span className="font-semibold tabular-nums">
                        {total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="flex justify-end gap-3 pt-4">
              <Button type="button" variant="outline" onClick={() => router.back()}>
                Cancel
              </Button>
              <Button type="submit" disabled={loading}>
                {loading ? 'Saving...' : 'Save as Draft'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Exchange rate editor (per-bill override; does not change company settings) */}
      <Dialog open={fxEditOpen} onOpenChange={setFxEditOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Exchange Rate</DialogTitle>
            <DialogDescription>
              Set a custom exchange rate for this purchase bill only. This will not change company exchange rates.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="grid gap-2">
              <Label htmlFor="fxRateInput">
                Exchange Rate (in {baseCurrency ?? 'base currency'})
              </Label>
              <Input
                id="fxRateInput"
                type="number"
                inputMode="decimal"
                step="0.000001"
                value={fxEditRate}
                onChange={(e) => setFxEditRate(e.target.value)}
                placeholder={fxRateToBase ? String(fxRateToBase) : '0'}
              />
            </div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={fxEditRecalc}
                onChange={(e) => setFxEditRecalc(e.target.checked)}
                disabled={!enterInEntryCurrency || !fxRateToBase}
              />
              <span>Re-calculate item prices based on this rate</span>
            </label>
          </div>
          <DialogFooter>
            <Button type="button" onClick={applyFxRateOverride}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}


