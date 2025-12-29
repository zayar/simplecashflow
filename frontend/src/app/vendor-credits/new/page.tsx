'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
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

type Line = { itemId: string; accountId: string; quantity: string; unitCost: string; description: string };

export default function NewVendorCreditPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [inventoryAccountId, setInventoryAccountId] = useState<number | null>(null);

  const [form, setForm] = useState({
    vendorId: '',
    creditDate: '',
    locationId: '',
  });

  const [lines, setLines] = useState<Line[]>([
    { itemId: '', accountId: '', quantity: '1', unitCost: '', description: '' },
  ]);

  useEffect(() => {
    if (!user?.companyId) return;
    getVendors(user.companyId).then(setVendors).catch(console.error);
    fetchApi(`/companies/${user.companyId}/locations`).then(setLocations).catch(console.error);
    fetchApi(`/companies/${user.companyId}/items`).then(setItems).catch(console.error);
    getAccounts(user.companyId).then(setAccounts).catch(console.error);
    fetchApi(`/companies/${user.companyId}/settings`)
      .then((s) => setInventoryAccountId(Number(s.inventoryAssetAccountId ?? 0) || null))
      .catch(() => setInventoryAccountId(null));
  }, [user?.companyId]);

  useEffect(() => {
    const tz = companySettings?.timeZone ?? 'Asia/Yangon';
    if (!form.creditDate) {
      setForm((prev) => ({ ...prev, creditDate: todayInTimeZone(tz) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companySettings?.timeZone]);

  const selectableItems = useMemo(() => items.filter((i) => i.isActive !== false), [items]);
  const expenseAccounts = useMemo(() => accounts.filter((a) => a.type === 'EXPENSE'), [accounts]);

  const total = useMemo(
    () => lines.reduce((sum, l) => sum + Number(l.quantity || 0) * Number(l.unitCost || 0), 0),
    [lines]
  );

  function updateLine(idx: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((prev) => [...prev, { itemId: '', accountId: '', quantity: '1', unitCost: '', description: '' }]);
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
        accountId: l.accountId ? Number(l.accountId) : undefined,
        quantity: Number(l.quantity),
        unitCost: Number(l.unitCost),
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
        <Link href="/vendor-credits">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">New Vendor Credit</h1>
          <p className="text-sm text-muted-foreground">Create a credit from a supplier and apply it to purchase bills.</p>
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
                <Label>Credit Date</Label>
                <Input type="date" value={form.creditDate} onChange={(e) => setForm({ ...form, creditDate: e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label>Branch / Location</Label>
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
            </div>

            <Card className="shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">Item Table</CardTitle>
                <Button type="button" variant="outline" onClick={addLine} className="gap-2">
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
                        <TableHead className="w-[160px] text-right">AMOUNT</TableHead>
                        <TableHead className="w-[60px]" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {lines.map((l, idx) => {
                        const it = selectableItems.find((x) => String(x.id) === String(l.itemId));
                        const isTracked = it?.type === 'GOODS' && !!it?.trackInventory;
                        const lineTotal = Number(l.quantity || 0) * Number(l.unitCost || 0);
                        return (
                          <TableRow key={idx}>
                            <TableCell className="align-top">
                              <SelectNative
                                value={l.itemId}
                                onChange={(e) => {
                                  const itemId = e.target.value;
                                  const picked = selectableItems.find((x) => String(x.id) === String(itemId));
                                  const pickedTracked = picked?.type === 'GOODS' && !!picked?.trackInventory;
                                  const nextAccountId = pickedTracked
                                    ? inventoryAccountId
                                      ? String(inventoryAccountId)
                                      : ''
                                    : picked?.expenseAccountId
                                      ? String(picked.expenseAccountId)
                                      : '';
                                  updateLine(idx, { itemId, accountId: nextAccountId });
                                }}
                              >
                                <option value="">Select item…</option>
                                {selectableItems.map((it2) => (
                                  <option key={it2.id} value={String(it2.id)}>
                                    {it2.name}
                                  </option>
                                ))}
                              </SelectNative>
                              <div className="mt-2">
                                <Input
                                  placeholder="Description (optional)"
                                  value={l.description}
                                  onChange={(e) => updateLine(idx, { description: e.target.value })}
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
                                  onChange={(v) => updateLine(idx, { accountId: v })}
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
                              />
                            </TableCell>
                            <TableCell className="align-top text-right font-medium tabular-nums">
                              {Number.isFinite(lineTotal) ? lineTotal.toLocaleString() : '0'}
                            </TableCell>
                            <TableCell className="align-top">
                              <Button type="button" variant="ghost" size="icon" onClick={() => removeLine(idx)} disabled={lines.length <= 1}>
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

            <div className="flex items-center justify-between rounded-xl border bg-muted/20 px-4 py-3">
              <div className="text-sm text-muted-foreground">Total</div>
              <div className="text-lg font-semibold tabular-nums">{total.toLocaleString()}</div>
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


