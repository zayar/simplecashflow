'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, Plus, Trash2 } from 'lucide-react';

import { useAuth } from '@/contexts/auth-context';
import { fetchApi, getAccounts, getVendors, Account, Vendor } from '@/lib/api';
import { todayInTimeZone } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectNative } from '@/components/ui/select-native';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { AccountPicker } from '@/components/account-picker';

type Line = { itemId: string; accountId: string; quantity: string; unitCost: string; description: string };

export default function EditPurchaseBillPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [loadingDoc, setLoadingDoc] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [inventoryAccountId, setInventoryAccountId] = useState<number | null>(null);

  const [bill, setBill] = useState<any>(null);
  const [form, setForm] = useState({
    vendorId: '',
    billDate: '',
    dueDate: '',
    warehouseId: '',
  });
  const [lines, setLines] = useState<Line[]>([{ itemId: '', accountId: '', quantity: '1', unitCost: '', description: '' }]);

  useEffect(() => {
    if (!user?.companyId) return;
    getVendors(user.companyId).then(setVendors).catch(console.error);
    fetchApi(`/companies/${user.companyId}/warehouses`).then(setWarehouses).catch(console.error);
    fetchApi(`/companies/${user.companyId}/items`).then(setItems).catch(console.error);
    getAccounts(user.companyId).then(setAccounts).catch(console.error);
    fetchApi(`/companies/${user.companyId}/settings`)
      .then((s) => setInventoryAccountId(Number(s.inventoryAssetAccountId ?? 0) || null))
      .catch(() => setInventoryAccountId(null));
  }, [user?.companyId]);

  useEffect(() => {
    const tz = companySettings?.timeZone ?? 'Asia/Yangon';
    if (!form.billDate) {
      setForm((prev) => ({ ...prev, billDate: todayInTimeZone(tz) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companySettings?.timeZone]);

  useEffect(() => {
    if (!user?.companyId || !id) return;
    setLoadingDoc(true);
    setError(null);
    fetchApi(`/companies/${user.companyId}/purchase-bills/${id}`)
      .then((data) => {
        setBill(data);
        if (data?.status !== 'DRAFT') {
          setError('Only DRAFT purchase bills can be edited.');
          return;
        }
        setForm({
          vendorId: data?.vendor?.id ? String(data.vendor.id) : '',
          billDate: data?.billDate ? String(data.billDate).slice(0, 10) : '',
          dueDate: data?.dueDate ? String(data.dueDate).slice(0, 10) : '',
          warehouseId: data?.warehouse?.id ? String(data.warehouse.id) : '',
        });
        const docLines = (data?.lines ?? []) as any[];
        if (docLines.length > 0) {
          setLines(
            docLines.map((l: any) => ({
              itemId: String(l.itemId ?? ''),
              accountId: l.accountId ? String(l.accountId) : '',
              quantity: String(Number(l.quantity ?? 0)),
              unitCost: String(Number(l.unitCost ?? 0)),
              description: l.description ?? '',
            }))
          );
        }
      })
      .catch((e) => setError(e?.message ?? String(e)))
      .finally(() => setLoadingDoc(false));
  }, [user?.companyId, id]);

  const selectableItems = useMemo(() => items.filter((i) => i.isActive !== false), [items]);
  const expenseAccounts = useMemo(() => accounts.filter((a) => a.type === 'EXPENSE'), [accounts]);
  const inventoryAccount = useMemo(
    () => (inventoryAccountId ? accounts.find((a) => a.id === inventoryAccountId) ?? null : null),
    [accounts, inventoryAccountId]
  );
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
    if (!user?.companyId || !id) return;
    if (saving) return;
    // Draft-friendly: allow saving even if some lines are missing account mapping.
    // Posting (on the detail page) will enforce required account mappings.

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
      setError('Add at least 1 line with item, quantity (>0), and unit cost (>0).');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await fetchApi(`/companies/${user.companyId}/purchase-bills/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          vendorId: form.vendorId ? Number(form.vendorId) : null,
          billDate: form.billDate,
          dueDate: form.dueDate || null,
          warehouseId: form.warehouseId ? Number(form.warehouseId) : undefined,
          lines: payloadLines,
        }),
      });
      router.push(`/purchase-bills/${id}`);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to update purchase bill');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href={`/purchase-bills/${id ?? ''}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Edit Purchase Bill</h1>
          <p className="text-sm text-muted-foreground">Edit a draft purchase bill before posting.</p>
        </div>
      </div>

      {error ? <div className="text-sm text-red-600">{error}</div> : null}

      {loadingDoc ? (
        <Card className="shadow-sm">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
            Loading…
          </CardContent>
        </Card>
      ) : (
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Details</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-3">
                <div className="grid gap-2">
                  <Label>Vendor (optional)</Label>
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
                  <Label>Due Date (optional)</Label>
                  <Input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
                </div>
              </div>

              <div className="grid gap-2 md:max-w-sm">
                <Label>Warehouse</Label>
                <SelectNative value={form.warehouseId} onChange={(e) => setForm({ ...form, warehouseId: e.target.value })}>
                  <option value="">Company default</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={String(w.id)}>
                      {w.name}
                      {w.isDefault ? ' (Default)' : ''}
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
                          <TableHead className="w-[420px]">ITEM / DESCRIPTION</TableHead>
                          <TableHead className="w-[90px] text-right">QTY</TableHead>
                          <TableHead className="w-[160px]">UNIT</TableHead>
                          <TableHead className="w-[160px] text-right">PRICE</TableHead>
                          <TableHead className="w-[160px] text-right">DISCOUNT</TableHead>
                          <TableHead className="w-[160px] text-right">ITEM AMOUNT</TableHead>
                          <TableHead className="w-[60px]" />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {lines.map((l, idx) => {
                          const it = selectableItems.find((x) => String(x.id) === String(l.itemId));
                          const isTracked = it?.type === 'GOODS' && !!it?.trackInventory;
                          const lineTotal = Number(l.quantity || 0) * Number(l.unitCost || 0);
                          return (
                            <>
                            <TableRow key={`main-${idx}`} className="border-b-0">
                              <TableCell className="align-top">
                                <div className="space-y-2">
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

                                  <Textarea
                                    value={l.description}
                                    onChange={(e) => updateLine(idx, { description: e.target.value })}
                                    placeholder="Enter name or description"
                                    className="min-h-[44px]"
                                  />
                                </div>
                              </TableCell>
                              <TableCell className="align-top">
                                <Input
                                  type="number"
                                  inputMode="decimal"
                                  className="text-right"
                                  value={l.quantity}
                                  onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                                />
                              </TableCell>
                              <TableCell className="align-top">
                                <Input disabled placeholder="Enter a Unit" />
                              </TableCell>
                              <TableCell className="align-top">
                                <Input
                                  type="number"
                                  inputMode="decimal"
                                  className="text-right"
                                  value={l.unitCost}
                                  onChange={(e) => updateLine(idx, { unitCost: e.target.value })}
                                />
                              </TableCell>
                              <TableCell className="align-top">
                                <Input disabled className="text-right" value="0.00" />
                              </TableCell>
                              <TableCell className="align-top text-right font-semibold tabular-nums">
                                {lineTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </TableCell>
                              <TableCell className="align-top text-right">
                                <Button type="button" variant="ghost" size="icon" onClick={() => removeLine(idx)} disabled={lines.length <= 1}>
                                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                                </Button>
                              </TableCell>
                            </TableRow>
                            <TableRow key={`acct-${idx}`} className="bg-muted/10 border-t-0">
                              <TableCell className="py-3">
                                <Textarea
                                  value={l.description}
                                  onChange={(e) => updateLine(idx, { description: e.target.value })}
                                  placeholder="Enter name or description"
                                  className="min-h-[44px]"
                                />
                              </TableCell>
                              <TableCell colSpan={2} className="py-3">
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
                                  <div className="mt-1 text-xs text-orange-600">Missing account → you can save Draft, but you can’t Post until set.</div>
                                ) : null}
                              </TableCell>
                              <TableCell colSpan={4} />
                            </TableRow>
                            </>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>

              <div className="flex justify-end text-sm">
                <div className="w-64 space-y-1">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Total</span>
                    <span className="font-semibold tabular-nums">{total.toLocaleString()}</span>
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <Link href={`/purchase-bills/${id}`}>
                  <Button type="button" variant="outline">
                    Cancel
                  </Button>
                </Link>
                <Button type="submit" disabled={saving}>
                  {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {saving ? 'Saving...' : 'Save changes'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}


