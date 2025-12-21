'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { todayInTimeZone } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SelectNative } from '@/components/ui/select-native';
import { Plus, Trash2, ArrowLeft, Loader2, ChevronDown, Search } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AccountPicker } from '@/components/account-picker';

type TaxOption = { id: number; name: string; ratePercent: number; type: 'rate' | 'group' };
type Line = {
  itemId: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number; // decimal, e.g. 0.07
  taxLabel: string;
  incomeAccountId?: string;
};

export default function NewCreditNotePage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const search = useSearchParams();
  const tz = companySettings?.timeZone ?? 'Asia/Yangon';

  const [customers, setCustomers] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [defaultIncomeAccountId, setDefaultIncomeAccountId] = useState<number | null>(null);
  const [taxOptions, setTaxOptions] = useState<TaxOption[]>([]);
  const [taxSearchTerm, setTaxSearchTerm] = useState('');
  const [openTaxIdx, setOpenTaxIdx] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [customerId, setCustomerId] = useState('');
  const [creditNoteDate, setCreditNoteDate] = useState('');
  const [customerNotes, setCustomerNotes] = useState('');
  const [termsAndConditions, setTermsAndConditions] = useState('');
  const [lines, setLines] = useState<Line[]>([
    { itemId: '', description: '', quantity: 1, unitPrice: 0, taxRate: 0, taxLabel: '' },
  ]);
  const [sourceInvoice, setSourceInvoice] = useState<any>(null);

  useEffect(() => {
    if (!creditNoteDate) setCreditNoteDate(todayInTimeZone(tz));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tz]);

  useEffect(() => {
    if (!user?.companyId) return;
    fetchApi(`/companies/${user.companyId}/customers`).then(setCustomers).catch(console.error);
    fetchApi(`/companies/${user.companyId}/items`).then(setItems).catch(console.error);
    fetchApi(`/companies/${user.companyId}/accounts`)
      .then((accounts) => {
        const activeAccounts = (accounts ?? []).filter((a: any) => a.isActive !== false);
        setAccounts(activeAccounts);
        const income = activeAccounts.filter((a: any) => a.type === 'INCOME');
        const sales = income.find(
          (a: any) => String(a.code) === '4000' || String(a.name).trim().toLowerCase() === 'sales income'
        );
        const fallback = sales ?? income[0] ?? null;
        setDefaultIncomeAccountId(fallback ? Number(fallback.id) : null);
      })
      .catch(() => {
        setAccounts([]);
        setDefaultIncomeAccountId(null);
      });
    fetchApi(`/companies/${user.companyId}/taxes`)
      .then((t) => {
        const opts: TaxOption[] = [
          ...((t?.taxRates ?? []) as any[]).map((r) => ({
            id: r.id,
            name: `${r.name} [${Number(r.ratePercent ?? 0).toFixed(0)}%]`,
            ratePercent: Number(r.ratePercent ?? 0),
            type: 'rate' as const,
          })),
          ...((t?.taxGroups ?? []) as any[]).map((g) => ({
            id: g.id,
            name: `${g.name} [${Number(g.totalRatePercent ?? 0).toFixed(0)}%]`,
            ratePercent: Number(g.totalRatePercent ?? 0),
            type: 'group' as const,
          })),
        ];
        setTaxOptions(opts);
      })
      .catch(console.error);
  }, [user?.companyId]);

  // If opened from an invoice, prefill customer + lines from invoice lines.
  useEffect(() => {
    if (!user?.companyId) return;
    const invoiceId = search?.get('invoiceId');
    if (!invoiceId) return;
    fetchApi(`/companies/${user.companyId}/invoices/${invoiceId}`)
      .then((inv) => {
        setSourceInvoice(inv);
        setCustomerId(String(inv.customerId ?? inv.customer?.id ?? ''));
        // Prefill lines with invoice lines (qty defaults to 1; user can adjust)
        const invLines = (inv.lines ?? []) as any[];
        if (invLines.length > 0) {
          setLines(
            invLines.map((l: any) => ({
              itemId: String(l.itemId),
              description: l.description ?? l.item?.name ?? '',
              quantity: 1,
              unitPrice: Number(l.unitPrice ?? 0),
              taxRate: 0,
              taxLabel: '',
              incomeAccountId: l.incomeAccountId ? String(l.incomeAccountId) : '',
            }))
          );
        }
      })
      .catch((e) => setError(e?.message ?? String(e)));
  }, [user?.companyId, search]);

  const totals = useMemo(() => {
    const subtotal = lines.reduce(
      (sum, l) => sum + Number(l.quantity || 0) * Number(l.unitPrice || 0),
      0
    );
    const tax = lines.reduce((sum, l) => {
      const lineSubtotal = Number(l.quantity || 0) * Number(l.unitPrice || 0);
      return sum + lineSubtotal * Number(l.taxRate || 0);
    }, 0);
    return { subtotal, tax, total: subtotal + tax };
  }, [lines]);

  function updateLine(idx: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  function handleItemChange(index: number, itemId: string) {
    const item = items.find((i) => i.id.toString() === itemId);
    const next = [...lines];
    next[index].itemId = itemId;
    if (item) {
      next[index].unitPrice = Number(item.sellingPrice);
      next[index].description = item.name;
    }
    if (!(next[index] as any).incomeAccountId && defaultIncomeAccountId) {
      (next[index] as any).incomeAccountId = String(defaultIncomeAccountId);
    }
    setLines(next);
  }

  function addLine() {
    setLines((prev) => [
      ...prev,
      {
        itemId: '',
        description: '',
        quantity: 1,
        unitPrice: 0,
        taxRate: 0,
        taxLabel: '',
        incomeAccountId: defaultIncomeAccountId ? String(defaultIncomeAccountId) : '',
      },
    ]);
  }

  function removeLine(idx: number) {
    setLines((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
  }

  async function submit() {
    if (!user?.companyId) return;
    setError(null);
    if (!customerId) {
      setError('Customer is required.');
      return;
    }
    if (lines.length === 0 || lines.some((l) => !l.itemId)) {
      setError('Please select items for all lines.');
      return;
    }
    setLoading(true);
    try {
      const invoiceId = search?.get('invoiceId');
      if (invoiceId) {
        // Clean returns: create credit note from invoice lines (prevents over-return and uses original cost).
        const invLines = (sourceInvoice?.lines ?? []) as any[];
        const byItem = new Map(invLines.map((l: any) => [String(l.itemId), l]));
        const payloadLines = lines
          .filter((l) => l.itemId)
          .map((l) => ({
            invoiceLineId: Number(byItem.get(String(l.itemId))?.id),
            quantity: Number(l.quantity),
          }))
          .filter((l) => l.invoiceLineId && l.quantity > 0);

        const created = await fetchApi(`/companies/${user.companyId}/invoices/${invoiceId}/credit-notes`, {
          method: 'POST',
          body: JSON.stringify({
            creditNoteDate,
            lines: payloadLines,
          }),
        });
        router.push(`/credit-notes/${created.id}`);
        return;
      }

      const created = await fetchApi(`/companies/${user.companyId}/credit-notes`, {
        method: 'POST',
        body: JSON.stringify({
          customerId: Number(customerId),
          creditNoteDate,
            customerNotes: customerNotes || undefined,
            termsAndConditions: termsAndConditions || undefined,
          lines: lines.map((l) => ({
            itemId: Number(l.itemId),
            description: l.description,
            quantity: Number(l.quantity),
            unitPrice: Number(l.unitPrice),
              taxRate: Number(l.taxRate || 0),
            incomeAccountId:
              Number((l as any).incomeAccountId || defaultIncomeAccountId || 0) > 0
                ? Number((l as any).incomeAccountId || defaultIncomeAccountId || 0)
                : undefined,
          })),
        }),
      });
      router.push(`/credit-notes/${created.id}`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/credit-notes">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">New Credit Note</h1>
          <p className="text-sm text-muted-foreground">Create a draft credit note (sales return).</p>
        </div>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Header</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-1.5">
            <Label>Customer</Label>
            <SelectNative value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">Select customer…</option>
              {customers.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
            </SelectNative>
          </div>
          <div className="grid gap-1.5">
            <Label>Date</Label>
            <Input type="date" value={creditNoteDate} onChange={(e) => setCreditNoteDate(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">Lines</CardTitle>
          <Button variant="secondary" onClick={addLine} className="gap-2" type="button">
            <Plus className="h-4 w-4" /> Add Item
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead className="w-[420px]">ITEM / DESCRIPTION</TableHead>
                  <TableHead className="w-[90px] text-right">QTY</TableHead>
                  <TableHead className="w-[160px]">UNIT</TableHead>
                  <TableHead className="w-[160px] text-right">PRICE</TableHead>
                  <TableHead className="w-[140px]">TAX</TableHead>
                  <TableHead className="w-[160px] text-right">DISCOUNT</TableHead>
                  <TableHead className="w-[160px] text-right">ITEM AMOUNT</TableHead>
                  <TableHead className="w-[60px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l, idx) => {
                  const lineSubtotal = Number(l.quantity || 0) * Number(l.unitPrice || 0);
                  return (
                    <>
                    <TableRow key={`main-${idx}`} className="border-b-0">
                      <TableCell className="align-top">
                        <div className="space-y-2">
                <SelectNative value={l.itemId} onChange={(e) => handleItemChange(idx, e.target.value)}>
                  <option value="">Select item…</option>
                  {items.map((it) => (
                    <option key={it.id} value={String(it.id)}>
                      {it.name}
                    </option>
                  ))}
                </SelectNative>
              </div>
                      </TableCell>
                      <TableCell className="align-top">
                <Input
                  inputMode="decimal"
                          className="text-right"
                  value={String(l.quantity)}
                  onChange={(e) => updateLine(idx, { quantity: Number(e.target.value || 0) })}
                />
                      </TableCell>
                      <TableCell className="align-top">
                        <Input disabled placeholder="Enter a Unit" />
                      </TableCell>
                      <TableCell className="align-top">
                <Input
                  inputMode="decimal"
                          className="text-right"
                  value={String(l.unitPrice)}
                  onChange={(e) => updateLine(idx, { unitPrice: Number(e.target.value || 0) })}
                />
                      </TableCell>
                      <TableCell className="align-top">
                <div className="relative">
                  <Button
                    type="button"
                    variant="outline"
                            className="w-full justify-between px-2"
                    onClick={() => setOpenTaxIdx(openTaxIdx === idx ? null : idx)}
                  >
                            <span className="truncate text-xs">{l.taxLabel || 'Tax'}</span>
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                  {openTaxIdx === idx ? (
                            <div className="absolute right-0 z-50 mt-1 w-[280px] rounded-md border bg-background shadow">
                      <div className="p-2 border-b">
                        <div className="relative">
                          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                          <Input
                            className="pl-8"
                            placeholder="Search"
                            value={taxSearchTerm}
                            onChange={(e) => setTaxSearchTerm(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="max-h-64 overflow-auto p-2">
                        <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Tax</div>
                        {taxOptions
                          .filter((t) => t.type === 'rate')
                          .filter((t) => t.name.toLowerCase().includes(taxSearchTerm.toLowerCase()))
                          .map((t) => (
                            <button
                              key={`rate-${t.id}`}
                              type="button"
                              className="w-full rounded px-3 py-2 text-left text-sm hover:bg-muted"
                              onClick={() => {
                                updateLine(idx, { taxRate: t.ratePercent / 100, taxLabel: t.name });
                                setOpenTaxIdx(null);
                                setTaxSearchTerm('');
                              }}
                            >
                              {t.name}
                            </button>
                          ))}
                        <div className="mt-2 border-t pt-2">
                          <Link href="/taxes" className="text-sm text-primary hover:underline">
                            + New Tax
                          </Link>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <Input disabled className="text-right" value="0.00" />
                      </TableCell>
                      <TableCell className="align-top text-right font-semibold tabular-nums">
                        {lineSubtotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </TableCell>
                      <TableCell className="align-top text-right">
                        <Button variant="ghost" size="icon" onClick={() => removeLine(idx)} type="button" disabled={lines.length <= 1}>
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
                        <AccountPicker
                          accounts={accounts}
                          value={(l as any).incomeAccountId || defaultIncomeAccountId}
                          onChange={(nextId) => updateLine(idx, { incomeAccountId: nextId ? String(nextId) : '' } as any)}
                          placeholder="Select an account"
                          disabled={!accounts.length}
                          createHref="/accounts/new"
                          isOptionDisabled={(a) => a.type !== 'INCOME'}
                          getOptionDisabledReason={(a) => (a.type !== 'INCOME' ? 'Credit note lines must use an INCOME account' : undefined)}
                        />
                        {l.itemId && !(l as any).incomeAccountId && !defaultIncomeAccountId ? (
                          <div className="mt-1 text-xs text-orange-600">Missing account → you can save Draft, but you can’t Post until set.</div>
                        ) : null}
                      </TableCell>
                      <TableCell colSpan={5} />
                    </TableRow>
                    </>
                  );
                })}
              </TableBody>
            </Table>
            </div>

          <div className="rounded-lg border p-4 flex justify-between">
            <div className="text-sm text-muted-foreground">Total</div>
            <div className="text-sm font-semibold tabular-nums">
              {totals.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>

          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle className="text-base">Customer Notes</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                value={customerNotes}
                onChange={(e) => setCustomerNotes(e.target.value)}
                placeholder="Will be displayed on the credit note"
                className="min-h-[80px]"
              />
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle className="text-base">Terms &amp; Conditions</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                value={termsAndConditions}
                onChange={(e) => setTermsAndConditions(e.target.value)}
                placeholder="Enter the terms and conditions of your business to be displayed in your transaction"
                className="min-h-[100px]"
              />
            </CardContent>
          </Card>

          {error && <div className="text-sm text-red-600">{error}</div>}

          <div className="flex justify-end gap-2">
            <Link href="/credit-notes">
              <Button variant="ghost">Cancel</Button>
            </Link>
            <Button onClick={submit} disabled={loading}>
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save as Draft
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}


