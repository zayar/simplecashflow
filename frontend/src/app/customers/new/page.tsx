'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { createCustomer, getCurrenciesOverview, getExchangeRates, type CurrenciesOverview } from '@/lib/api';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { SelectNative } from '@/components/ui/select-native';
import Link from 'next/link';

export default function NewCustomerPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const [currencies, setCurrencies] = useState<CurrenciesOverview | null>(null);

  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    currency: '',
    openingBalanceInput: '',
    fxRateInput: '',
  });

  const baseCurrency = useMemo(() => {
    const cur = String(currencies?.baseCurrency ?? companySettings?.baseCurrency ?? '')
      .trim()
      .toUpperCase();
    return cur || null;
  }, [currencies?.baseCurrency, companySettings?.baseCurrency]);

  const currencyOptions = useMemo(() => {
    const codes = (currencies?.currencies ?? []).map((c) => String(c.code).trim().toUpperCase()).filter(Boolean);
    // Ensure base currency is always present (even if overview is empty).
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

  // Default currency
  useEffect(() => {
    setFormData((prev) => {
      if (prev.currency) return prev;
      const fallback = baseCurrency ?? currencyOptions[0] ?? 'MMK';
      return { ...prev, currency: fallback };
    });
  }, [baseCurrency, currencyOptions]);

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
          // Don't overwrite manual edits
          if (prev.fxRateInput?.trim()) return prev;
          return { ...prev, fxRateInput: rate };
        });
      })
      .catch(console.error);
  }, [user?.companyId, isFx, formData.currency]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.companyId) return;

    const openingBalance =
      formData.openingBalanceInput.trim() === ''
        ? undefined
        : openingBalanceBase === null
          ? NaN
          : openingBalanceBase;

    if (Number.isNaN(openingBalance as any)) {
      alert(isFx ? 'Please enter a valid opening balance and exchange rate.' : 'Please enter a valid opening balance.');
      return;
    }

    setLoading(true);
    try {
      await createCustomer(user.companyId, {
        name: formData.name,
        email: formData.email,
        phone: formData.phone,
        currency: formData.currency,
        openingBalance,
      });
      router.push('/customers');
    } catch (err) {
      console.error(err);
      alert('Failed to create customer');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">New Customer</h1>
        <p className="text-sm text-muted-foreground">
          Add a customer so you can invoice them.
        </p>
      </div>
      
      <Card className="max-w-2xl shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Customer details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                required
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="currency">Currency</Label>
              <SelectNative
                id="currency"
                value={formData.currency}
                onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
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
                  onChange={(e) => setFormData((p) => ({ ...p, openingBalanceInput: e.target.value }))}
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
                      onChange={(e) => setFormData((p) => ({ ...p, fxRateInput: e.target.value }))}
                      placeholder="0.00"
                    />
                    <div className="flex items-center text-sm text-muted-foreground w-[80px]">
                      {baseCurrency}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Opening balance will be stored in base currency ({baseCurrency}) as{' '}
                    <span className="font-medium tabular-nums">
                      {openingBalanceBase === null ? '—' : openingBalanceBase.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </span>
                    .
                  </div>
                </div>
              ) : baseCurrency ? (
                <div className="text-xs text-muted-foreground">
                  Stored in base currency ({baseCurrency}).
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">
                  Tip: Set a company base currency in{' '}
                  <Link href="/settings" className="text-primary underline underline-offset-4">
                    Settings
                  </Link>{' '}
                  to enable exchange-rate conversions.
                </div>
              )}
            </div>

            <div className="flex justify-end gap-4 pt-4">
              <Button type="button" variant="outline" onClick={() => router.back()}>
                Cancel
              </Button>
              <Button type="submit" disabled={loading}>
                {loading ? 'Creating...' : 'Create Customer'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
