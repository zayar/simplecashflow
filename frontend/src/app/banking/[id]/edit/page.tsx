'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { useAuth } from '@/contexts/auth-context';
import { fetchApi, getCurrenciesOverview, getExchangeRates, type CurrenciesOverview } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectNative } from '@/components/ui/select-native';
import { Separator } from '@/components/ui/separator';

type Kind = 'CASH' | 'BANK' | 'E_WALLET' | 'CREDIT_CARD';

export default function EditBankingAccountPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const bankingAccountId = Number(params?.id);

  const [loadingDoc, setLoadingDoc] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [data, setData] = useState<any>(null);
  const [currencies, setCurrencies] = useState<CurrenciesOverview | null>(null);

  const [form, setForm] = useState({
    kind: 'BANK' as Kind,
    accountName: '',
    accountCode: '',
    currency: '',
    bankName: '',
    accountNumber: '',
    identifierCode: '',
    branch: '',
    description: '',
    isPrimary: false,
    openingBalanceAdjInput: '',
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
    const all = new Set<string>();
    if (baseCurrency) all.add(baseCurrency);
    for (const c of codes) all.add(c);
    return Array.from(all).sort();
  }, [currencies?.currencies, baseCurrency]);

  const isFx = useMemo(() => {
    if (!baseCurrency) return false;
    const cur = String(form.currency ?? '').trim().toUpperCase();
    return !!cur && cur !== baseCurrency;
  }, [form.currency, baseCurrency]);

  const openingAdjBase = useMemo(() => {
    const ob = form.openingBalanceAdjInput.trim();
    if (!ob) return null;
    const obNum = Number(ob);
    if (!Number.isFinite(obNum)) return null;
    if (!isFx) return obNum;
    const r = Number(form.fxRateInput);
    if (!Number.isFinite(r) || r <= 0) return null;
    return obNum * r;
  }, [form.openingBalanceAdjInput, form.fxRateInput, isFx]);

  const showBankFields = useMemo(() => form.kind === 'BANK' || form.kind === 'E_WALLET', [form.kind]);

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
    if (!user?.companyId || !bankingAccountId || Number.isNaN(bankingAccountId)) return;
    setLoadingDoc(true);
    setError(null);
    fetchApi(`/companies/${user.companyId}/banking-accounts/${bankingAccountId}`)
      .then((res) => {
        setData(res);
        setForm((prev) => ({
          ...prev,
          kind: (res?.kind ?? 'BANK') as Kind,
          accountName: res?.account?.name ?? '',
          accountCode: res?.account?.code ?? '',
          currency: String(res?.currency ?? '').trim().toUpperCase() || baseCurrency || prev.currency || 'MMK',
          bankName: res?.bankName ?? '',
          accountNumber: res?.accountNumber ?? '',
          identifierCode: res?.identifierCode ?? '',
          branch: res?.branch ?? '',
          description: res?.description ?? '',
          isPrimary: !!res?.isPrimary,
          openingBalanceAdjInput: '',
          fxRateInput: '',
        }));
      })
      .catch((e) => setError(e?.message ?? String(e)))
      .finally(() => setLoadingDoc(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.companyId, bankingAccountId, baseCurrency]);

  // Default currency when creating form state
  useEffect(() => {
    setForm((prev) => {
      if (prev.currency) return prev;
      const fallback = baseCurrency ?? currencyOptions[0] ?? 'MMK';
      return { ...prev, currency: fallback };
    });
  }, [baseCurrency, currencyOptions]);

  // Auto-fill FX rate (best-effort) when adjustment currency != base
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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!user?.companyId || !bankingAccountId || Number.isNaN(bankingAccountId)) return;
    if (saving) return;

    const openingBalanceDelta =
      form.openingBalanceAdjInput.trim() === ''
        ? undefined
        : openingAdjBase === null
          ? NaN
          : openingAdjBase;

    if (Number.isNaN(openingBalanceDelta as any)) {
      setError(isFx ? 'Please enter a valid opening balance adjustment and exchange rate.' : 'Please enter a valid opening balance adjustment.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await fetchApi(`/companies/${user.companyId}/banking-accounts/${bankingAccountId}`, {
        method: 'PUT',
        body: JSON.stringify({
          accountName: form.accountName,
          accountCode: form.accountCode,
          currency: form.currency || null,
          bankName: form.bankName || null,
          accountNumber: form.accountNumber || null,
          identifierCode: form.identifierCode || null,
          branch: form.branch || null,
          description: form.description || null,
          isPrimary: form.isPrimary,
          openingBalanceDelta,
        }),
      });
      router.push(`/banking/${bankingAccountId}`);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to update banking account');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href={`/banking/${bankingAccountId || ''}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Edit Banking Account</h1>
          <p className="text-sm text-muted-foreground">Update account details and post an opening balance adjustment.</p>
        </div>
      </div>

      {error ? <div className="text-sm text-red-600">{error}</div> : null}

      <Card className="max-w-2xl shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Details</CardTitle>
        </CardHeader>
        <CardContent>
          {loadingDoc ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
          ) : !data ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Account not found.</div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="kind">Account Kind</Label>
                <SelectNative id="kind" value={form.kind} disabled>
                  <option value="BANK">Bank</option>
                  <option value="CASH">Cash</option>
                  <option value="E_WALLET">E‑wallet</option>
                  <option value="CREDIT_CARD">Credit Card (future)</option>
                </SelectNative>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="accountName">Account Name</Label>
                <Input
                  id="accountName"
                  required
                  value={form.accountName}
                  onChange={(e) => setForm((p) => ({ ...p, accountName: e.target.value }))}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="accountCode">Account Code</Label>
                <Input
                  id="accountCode"
                  required
                  value={form.accountCode}
                  onChange={(e) => setForm((p) => ({ ...p, accountCode: e.target.value }))}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="currency">Currency</Label>
                <SelectNative id="currency" value={form.currency} onChange={(e) => setForm((p) => ({ ...p, currency: e.target.value }))}>
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

              {showBankFields ? <Separator /> : null}
              {showBankFields ? (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="bankName">Bank / Provider Name</Label>
                    <Input id="bankName" value={form.bankName} onChange={(e) => setForm((p) => ({ ...p, bankName: e.target.value }))} />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="accountNumber">Account Number</Label>
                    <Input
                      id="accountNumber"
                      value={form.accountNumber}
                      onChange={(e) => setForm((p) => ({ ...p, accountNumber: e.target.value }))}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="identifierCode">Identifier Code</Label>
                    <Input
                      id="identifierCode"
                      value={form.identifierCode}
                      onChange={(e) => setForm((p) => ({ ...p, identifierCode: e.target.value }))}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="branch">Location</Label>
                    <Input id="branch" value={form.branch} onChange={(e) => setForm((p) => ({ ...p, branch: e.target.value }))} />
                  </div>
                </>
              ) : null}

              <div className="grid gap-2">
                <Label htmlFor="description">Notes</Label>
                <Input id="description" value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} />
              </div>

              <label className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.isPrimary}
                  onChange={(e) => setForm((p) => ({ ...p, isPrimary: e.target.checked }))}
                />
                Make this primary
              </label>

              <Separator />

              <div className="grid gap-2">
                <Label htmlFor="openingAdj">Opening Balance Adjustment</Label>
                <div className="flex gap-2">
                  <SelectNative className="w-[120px]" disabled>
                    <option>{form.currency || baseCurrency || '—'}</option>
                  </SelectNative>
                  <Input
                    id="openingAdj"
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    value={form.openingBalanceAdjInput}
                    onChange={(e) => setForm((p) => ({ ...p, openingBalanceAdjInput: e.target.value }))}
                    placeholder="0.00"
                  />
                </div>
                <div className="text-xs text-muted-foreground">
                  This will post a journal entry between the bank account and Opening Balance Equity (delta only).
                </div>
                {isFx ? (
                  <div className="grid gap-2 pt-2">
                    <Label htmlFor="fxRate">Exchange Rate</Label>
                    <div className="flex gap-2">
                      <div className="flex items-center text-sm text-muted-foreground w-[120px]">
                        1 {form.currency} =
                      </div>
                      <Input
                        id="fxRate"
                        type="number"
                        inputMode="decimal"
                        step="0.000001"
                        value={form.fxRateInput}
                        onChange={(e) => setForm((p) => ({ ...p, fxRateInput: e.target.value }))}
                        placeholder="0.00"
                      />
                      <div className="flex items-center text-sm text-muted-foreground w-[80px]">{baseCurrency}</div>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Will be posted in base currency ({baseCurrency}) as{' '}
                      <span className="font-medium tabular-nums">
                        {openingAdjBase === null ? '—' : openingAdjBase.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </span>
                      .
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="flex justify-end gap-4 pt-4">
                <Button type="button" variant="outline" onClick={() => router.back()} disabled={saving}>
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

