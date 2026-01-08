'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { useAuth } from '@/contexts/auth-context';
import { getCurrenciesOverview, getCustomer, getExchangeRates, updateCustomer, type CurrenciesOverview } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectNative } from '@/components/ui/select-native';

export default function EditCustomerPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const customerId = Number(params?.id);

  const [loadingDoc, setLoadingDoc] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [currencies, setCurrencies] = useState<CurrenciesOverview | null>(null);

  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    currency: 'USD',
    openingBalanceInput: '',
    fxRateInput: '',
    _openingBalanceBaseExisting: '',
  });

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

  const isFx = useMemo(() => {
    if (!baseCurrency) return false;
    const cur = String(formData.currency ?? '').trim().toUpperCase();
    return !!cur && cur !== baseCurrency;
  }, [formData.currency, baseCurrency]);

  const openingBalanceBase = useMemo(() => {
    const ob = formData.openingBalanceInput.trim();
    if (!ob) return null;
    const obNum = Number(ob);
    if (!Number.isFinite(obNum)) return null;
    if (!isFx) return obNum;
    const r = Number(formData.fxRateInput);
    if (!Number.isFinite(r) || r <= 0) return null;
    return obNum * r;
  }, [formData.openingBalanceInput, formData.fxRateInput, isFx]);

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
    if (!user?.companyId || !customerId || Number.isNaN(customerId)) return;
    setLoadingDoc(true);
    setError(null);
    getCustomer(user.companyId, customerId)
      .then((c) => {
        const obBase = c?.openingBalance ? String(c.openingBalance) : '';
        setFormData({
          name: c?.name ?? '',
          email: c?.email ?? '',
          phone: c?.phone ?? '',
          currency: c?.currency ?? baseCurrency ?? 'USD',
          openingBalanceInput: '',
          fxRateInput: '',
          _openingBalanceBaseExisting: obBase,
        });
      })
      .catch((e) => setError(e?.message ?? String(e)))
      .finally(() => setLoadingDoc(false));
  }, [user?.companyId, customerId, baseCurrency]);

  // Auto-fill FX rate when currency != base
  useEffect(() => {
    if (!user?.companyId) return;
    if (!isFx) {
      setFormData((prev) => ({ ...prev, fxRateInput: '' }));
      return;
    }
    const code = String(formData.currency ?? '').trim().toUpperCase();
    if (!code) return;
    getExchangeRates(user.companyId, code)
      .then((rows) => {
        const latest = (rows ?? [])[0];
        const rate = latest?.rateToBase ? String(latest.rateToBase) : '';
        setFormData((prev) => {
          if (prev.fxRateInput?.trim()) return prev;
          return { ...prev, fxRateInput: rate };
        });
      })
      .catch(console.error);
  }, [user?.companyId, isFx, formData.currency]);

  // Back-calculate display opening balance (best-effort) from stored base amount.
  useEffect(() => {
    setFormData((prev) => {
      if (prev.openingBalanceInput.trim()) return prev;
      const base = Number(prev._openingBalanceBaseExisting);
      if (!Number.isFinite(base) || base === 0) return prev;
      if (!isFx) return { ...prev, openingBalanceInput: base.toFixed(2) };
      const r = Number(prev.fxRateInput);
      if (!Number.isFinite(r) || r <= 0) return prev;
      const est = base / r;
      return { ...prev, openingBalanceInput: est.toFixed(2) };
    });
  }, [isFx, formData.fxRateInput]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!user?.companyId || !customerId || Number.isNaN(customerId)) return;
    if (saving) return;

    setSaving(true);
    setError(null);
    try {
      const openingBalance =
        formData.openingBalanceInput.trim() === ''
          ? undefined
          : openingBalanceBase === null
            ? NaN
            : openingBalanceBase;
      if (Number.isNaN(openingBalance as any)) {
        setError(isFx ? 'Please enter a valid opening balance and exchange rate.' : 'Please enter a valid opening balance.');
        return;
      }
      await updateCustomer(user.companyId, customerId, {
        name: formData.name,
        email: formData.email || undefined,
        phone: formData.phone || undefined,
        currency: formData.currency || undefined,
        openingBalance,
      });
      router.push('/customers');
    } catch (err: any) {
      setError(err?.message ?? 'Failed to update customer');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/customers">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Edit Customer</h1>
          <p className="text-sm text-muted-foreground">Update customer contact info.</p>
        </div>
      </div>

      {error ? <div className="text-sm text-red-600">{error}</div> : null}

      <Card className="max-w-2xl shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Customer details</CardTitle>
        </CardHeader>
        <CardContent>
          {loadingDoc ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="name">Name *</Label>
                <Input
                  id="name"
                  required
                  value={formData.name}
                  onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData((prev) => ({ ...prev, email: e.target.value }))}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="phone">Phone</Label>
                  <Input
                    id="phone"
                    value={formData.phone}
                    onChange={(e) => setFormData((prev) => ({ ...prev, phone: e.target.value }))}
                  />
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="currency">Currency</Label>
                <SelectNative
                  id="currency"
                  value={formData.currency}
                  onChange={(e) => setFormData((prev) => ({ ...prev, currency: e.target.value }))}
                >
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
                <Label htmlFor="openingBalance">Opening Balance</Label>
                <div className="flex gap-2">
                  <SelectNative className="w-[120px]" disabled>
                    <option>{formData.currency || baseCurrency || '—'}</option>
                  </SelectNative>
                  <Input
                    id="openingBalance"
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    value={formData.openingBalanceInput}
                    onChange={(e) => setFormData((prev) => ({ ...prev, openingBalanceInput: e.target.value }))}
                    placeholder="0.00"
                  />
                </div>
                {isFx ? (
                  <div className="grid gap-2 pt-2">
                    <Label htmlFor="fxRate">Exchange Rate</Label>
                    <div className="flex gap-2">
                      <div className="flex items-center text-sm text-muted-foreground w-[120px]">
                        1 {formData.currency} =
                      </div>
                      <Input
                        id="fxRate"
                        type="number"
                        inputMode="decimal"
                        step="0.000001"
                        value={formData.fxRateInput}
                        onChange={(e) => setFormData((prev) => ({ ...prev, fxRateInput: e.target.value }))}
                        placeholder="0.00"
                      />
                      <div className="flex items-center text-sm text-muted-foreground w-[80px]">
                        {baseCurrency}
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Will be posted to ledger in base currency ({baseCurrency}) as{' '}
                      <span className="font-medium tabular-nums">
                        {openingBalanceBase === null ? '—' : openingBalanceBase.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </span>
                      .
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="flex justify-end gap-4 pt-4">
                <Button type="button" variant="outline" onClick={() => router.back()}>
                  Cancel
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}


