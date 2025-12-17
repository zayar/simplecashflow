'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Plus } from 'lucide-react';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi, getAccounts, getVendors, Account, Vendor } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectNative } from '@/components/ui/select-native';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { todayInTimeZone } from '@/lib/utils';

type Line = { itemId: string; accountId: string; quantity: string; unitCost: string; description: string };

export default function NewPurchaseBillPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [inventoryAccountId, setInventoryAccountId] = useState<number | null>(null);

  const [form, setForm] = useState({
    vendorId: '',
    billDate: '',
    dueDate: '',
    warehouseId: '',
  });

  const [lines, setLines] = useState<Line[]>([
    { itemId: '', accountId: '', quantity: '1', unitCost: '', description: '' },
  ]);

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
    if (!user?.companyId) return;
    // Enforce account rules:
    // - tracked inventory -> account must be Inventory Asset (locked)
    // - non-inventory/service -> account must be EXPENSE (required)
    for (const [idx, l] of lines.entries()) {
      if (!l.itemId) continue;
      const it = selectableItems.find((x) => String(x.id) === String(l.itemId));
      if (!it) continue;
      const isTracked = it.type === 'GOODS' && !!it.trackInventory;

      if (isTracked) {
        if (!inventoryAccountId) {
          alert('Your company Inventory Asset account is not set. Please set it in Company Settings.');
          return;
        }
        if (String(l.accountId || '') !== String(inventoryAccountId)) {
          alert(`Line ${idx + 1}: tracked inventory must use Inventory Asset account.`);
          return;
        }
      } else {
        if (!l.accountId) {
          alert(`Line ${idx + 1}: please select an Expense account.`);
          return;
        }
      }
    }

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
      const bill = await fetchApi(`/companies/${user.companyId}/purchase-bills`, {
        method: 'POST',
        body: JSON.stringify({
          vendorId: form.vendorId ? Number(form.vendorId) : null,
          billDate: form.billDate,
          dueDate: form.dueDate || undefined,
          warehouseId: form.warehouseId ? Number(form.warehouseId) : undefined,
          lines: payloadLines,
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
                  <Plus className="h-4 w-4" /> Add line
                </Button>
              </CardHeader>
              <CardContent className="pt-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item</TableHead>
                      <TableHead>Account</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="w-[140px] text-right">Qty</TableHead>
                      <TableHead className="w-[180px] text-right">Unit Cost</TableHead>
                      <TableHead className="w-[140px] text-right">Line Total</TableHead>
                      <TableHead className="w-[110px]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lines.map((l, idx) => (
                      <TableRow key={idx}>
                        <TableCell>
                          <SelectNative
                            value={l.itemId}
                            onChange={(e) => {
                              const itemId = e.target.value;
                              const it = selectableItems.find((x) => String(x.id) === String(itemId));
                              const isTracked = it?.type === 'GOODS' && !!it?.trackInventory;
                              const nextAccountId = isTracked
                                ? inventoryAccountId
                                  ? String(inventoryAccountId)
                                  : ''
                                : it?.expenseAccountId
                                  ? String(it.expenseAccountId)
                                  : '';
                              updateLine(idx, { itemId, accountId: nextAccountId });
                            }}
                          >
                            <option value="">Select item</option>
                            {selectableItems.map((it) => (
                              <option key={it.id} value={String(it.id)}>
                                {it.name}
                              </option>
                            ))}
                          </SelectNative>
                        </TableCell>
                        <TableCell>
                          {(() => {
                            const it = selectableItems.find((x) => String(x.id) === String(l.itemId));
                            const isTracked = it?.type === 'GOODS' && !!it?.trackInventory;
                            if (isTracked) {
                              return (
                                <SelectNative value={l.accountId} disabled>
                                  <option value={inventoryAccount ? String(inventoryAccount.id) : ''}>
                                    {inventoryAccount ? `${inventoryAccount.code} - ${inventoryAccount.name}` : 'Inventory (not set)'}
                                  </option>
                                </SelectNative>
                              );
                            }
                            return (
                              <SelectNative
                                value={l.accountId}
                                onChange={(e) => updateLine(idx, { accountId: e.target.value })}
                                required={!!l.itemId}
                              >
                                <option value="">Select expense account</option>
                                {expenseAccounts.map((a) => (
                                  <option key={a.id} value={String(a.id)}>
                                    {a.code} - {a.name}
                                  </option>
                                ))}
                              </SelectNative>
                            );
                          })()}
                        </TableCell>
                        <TableCell>
                          <Input value={l.description} onChange={(e) => updateLine(idx, { description: e.target.value })} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Input type="number" step="0.01" value={l.quantity} onChange={(e) => updateLine(idx, { quantity: e.target.value })} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Input type="number" step="0.01" value={l.unitCost} onChange={(e) => updateLine(idx, { unitCost: e.target.value })} />
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {(Number(l.quantity || 0) * Number(l.unitCost || 0)).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button type="button" variant="ghost" onClick={() => removeLine(idx)} disabled={lines.length === 1}>
                            Remove
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="flex justify-end pt-4 text-sm">
                  <div className="text-muted-foreground">
                    Total:{' '}
                    <span className="font-medium tabular-nums">
                      {total.toLocaleString()}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="flex justify-end gap-3 pt-4">
              <Button type="button" variant="outline" onClick={() => router.back()}>
                Cancel
              </Button>
              <Button type="submit" disabled={loading}>
                {loading ? 'Creating...' : 'Create Purchase Bill'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}


