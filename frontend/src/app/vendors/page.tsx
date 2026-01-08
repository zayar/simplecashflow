'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { createVendor, getCurrenciesOverview, getExchangeRates, getVendors, type CurrenciesOverview, Vendor } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { SelectNative } from '@/components/ui/select-native';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export default function VendorsPage() {
  const { user, companySettings } = useAuth();
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  const [currencies, setCurrencies] = useState<CurrenciesOverview | null>(null);

  const baseCurrency = useMemo(() => {
    const cur = String(currencies?.baseCurrency ?? companySettings?.baseCurrency ?? '')
      .trim()
      .toUpperCase();
    return cur || null;
  }, [currencies?.baseCurrency, companySettings?.baseCurrency]);

  const currencyOptions = useMemo(() => {
    const codes = (currencies?.currencies ?? []).map((c) => String(c.code).trim().toUpperCase()).filter(Boolean);
    const all = new Set<string>();
    if (baseCurrency) all.add(baseCurrency);
    for (const c of codes) all.add(c);
    return Array.from(all).sort();
  }, [currencies?.currencies, baseCurrency]);

  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    currency: '',
    openingBalanceInput: '',
    fxRateInput: '',
  });

  const isFx = useMemo(() => {
    if (!baseCurrency) return false;
    const cur = String(form.currency ?? '').trim().toUpperCase();
    return !!cur && cur !== baseCurrency;
  }, [form.currency, baseCurrency]);

  const openingBalanceBase = useMemo(() => {
    const ob = form.openingBalanceInput.trim();
    if (!ob) return null;
    const obNum = Number(ob);
    if (!Number.isFinite(obNum)) return null;
    if (!isFx) return obNum;
    const r = Number(form.fxRateInput);
    if (!Number.isFinite(r) || r <= 0) return null;
    return obNum * r;
  }, [form.openingBalanceInput, form.fxRateInput, isFx]);

  async function load() {
    if (!user?.companyId) return;
    const v = await getVendors(user.companyId);
    setVendors(v);
  }

  useEffect(() => {
    load().catch(console.error);
  }, [user?.companyId]);

  useEffect(() => {
    if (!user?.companyId) return;
    getCurrenciesOverview(user.companyId)
      .then(setCurrencies)
      .catch((e) => {
        console.error(e);
        setCurrencies(null);
      });
  }, [user?.companyId]);

  useEffect(() => {
    setForm((prev) => {
      if (prev.currency) return prev;
      const fallback = baseCurrency ?? currencyOptions[0] ?? 'MMK';
      return { ...prev, currency: fallback };
    });
  }, [baseCurrency, currencyOptions]);

  useEffect(() => {
    if (!user?.companyId) return;
    if (!isFx) {
      setForm((prev) => ({ ...prev, fxRateInput: '' }));
      return;
    }
    const code = String(form.currency ?? '').trim().toUpperCase();
    if (!code) return;
    getExchangeRates(user.companyId, code)
      .then((rows) => {
        const latest = (rows ?? [])[0];
        const rate = latest?.rateToBase ? String(latest.rateToBase) : '';
        setForm((prev) => {
          if (prev.fxRateInput?.trim()) return prev;
          return { ...prev, fxRateInput: rate };
        });
      })
      .catch(console.error);
  }, [user?.companyId, isFx, form.currency]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!user?.companyId) return;
    setLoading(true);
    try {
      const openingBalance =
        form.openingBalanceInput.trim() === ''
          ? undefined
          : openingBalanceBase === null
            ? NaN
            : openingBalanceBase;
      if (Number.isNaN(openingBalance as any)) {
        alert(isFx ? 'Please enter a valid opening balance and exchange rate.' : 'Please enter a valid opening balance.');
        return;
      }
      await createVendor(user.companyId, {
        name: form.name,
        email: form.email || undefined,
        phone: form.phone || undefined,
        currency: form.currency || undefined,
        openingBalance,
      });
      setForm({ name: '', email: '', phone: '', currency: '', openingBalanceInput: '', fxRateInput: '' });
      setFormOpen(false);
      await load();
    } catch (err: any) {
      alert(err.message || 'Failed to create vendor');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Vendors</h1>
          <p className="text-sm text-muted-foreground">
            People and businesses you pay.
          </p>
        </div>
        <Button className="gap-2" onClick={() => setFormOpen((v) => !v)}>
          <Plus className="h-4 w-4" /> New Vendor
        </Button>
      </div>

      {formOpen && (
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Create vendor</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="grid gap-4 md:grid-cols-3">
              <div className="grid gap-2">
                <Label>Name</Label>
                <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label>Email</Label>
                <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label>Phone</Label>
                <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>

              <div className="grid gap-2">
                <Label>Currency</Label>
                <SelectNative value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                  {currencyOptions.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </SelectNative>
                <div className="text-xs text-muted-foreground">
                  Missing a currency?{' '}
                  <Link href="/currencies" className="text-primary underline underline-offset-4">
                    Add new currency
                  </Link>
                  .
                </div>
              </div>

              <div className="grid gap-2">
                <Label>Opening Balance</Label>
                <div className="flex gap-2">
                  <SelectNative className="w-[100px]" disabled>
                    <option>{form.currency || baseCurrency || '—'}</option>
                  </SelectNative>
                  <Input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    value={form.openingBalanceInput}
                    onChange={(e) => setForm({ ...form, openingBalanceInput: e.target.value })}
                    placeholder="0.00"
                  />
                </div>
              </div>

              {isFx ? (
                <div className="grid gap-2">
                  <Label>Exchange Rate</Label>
                  <div className="flex gap-2">
                    <div className="flex items-center text-sm text-muted-foreground w-[100px]">1 {form.currency} =</div>
                    <Input
                      type="number"
                      inputMode="decimal"
                      step="0.000001"
                      value={form.fxRateInput}
                      onChange={(e) => setForm({ ...form, fxRateInput: e.target.value })}
                      placeholder="0.00"
                    />
                    <div className="flex items-center text-sm text-muted-foreground w-[80px]">{baseCurrency}</div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Stored in base currency ({baseCurrency}) as{' '}
                    <span className="font-medium tabular-nums">
                      {openingBalanceBase === null ? '—' : openingBalanceBase.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </span>
                    .
                  </div>
                </div>
              ) : null}

              <div className="md:col-span-3 flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={loading}>
                  {loading ? 'Creating...' : 'Create'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">All vendors</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead className="w-[110px]">Currency</TableHead>
                <TableHead className="w-[120px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vendors.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="font-medium">{v.name}</TableCell>
                  <TableCell className="text-muted-foreground">{v.email ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{v.phone ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{(v as any).currency ?? '—'}</TableCell>
                  <TableCell className="text-right">
                    <Link href={`/vendors/${v.id}/edit`}>
                      <Button variant="outline" size="sm">
                        Edit
                      </Button>
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
              {vendors.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    No vendors yet.
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
