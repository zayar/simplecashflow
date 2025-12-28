'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, ChevronDown, Loader2, Plus, Search, Trash2 } from 'lucide-react';

import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { todayInTimeZone } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SelectNative } from '@/components/ui/select-native';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AccountPicker } from '@/components/account-picker';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type TaxOption = { id: number; name: string; ratePercent: number; type: 'rate' | 'group' };
type Line = {
  itemId: string;
  invoiceLineId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  taxLabel: string;
  discount?: number;
  incomeAccountId?: string;
};

export default function EditCreditNotePage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const tz = companySettings?.timeZone ?? 'Asia/Yangon';

  const [customers, setCustomers] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [defaultIncomeAccountId, setDefaultIncomeAccountId] = useState<number | null>(null);
  const [taxOptions, setTaxOptions] = useState<TaxOption[]>([]);
  const [taxSearchTerm, setTaxSearchTerm] = useState('');
  const [openTaxIdx, setOpenTaxIdx] = useState<number | null>(null);
  // Accounting is always visible on the line items table (per reference UI).

  const [loadingDoc, setLoadingDoc] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cn, setCn] = useState<any>(null);

  const [customerId, setCustomerId] = useState('');
  const [creditNoteDate, setCreditNoteDate] = useState('');
  const [customerNotes, setCustomerNotes] = useState('');
  const [termsAndConditions, setTermsAndConditions] = useState('');
  const [lines, setLines] = useState<Line[]>([
    { itemId: '', description: '', quantity: 1, unitPrice: 0, taxRate: 0, taxLabel: '', discount: 0 },
  ]);

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

  useEffect(() => {
    if (!user?.companyId || !id) return;
    setLoadingDoc(true);
    setError(null);
    fetchApi(`/companies/${user.companyId}/credit-notes/${id}`)
      .then((data) => {
        setCn(data);
        if (data?.status !== 'DRAFT') {
          setError('Only DRAFT credit notes can be edited.');
          return;
        }
        setCustomerId(String(data.customerId ?? data.customer?.id ?? ''));
        setCreditNoteDate(data.creditNoteDate ? String(data.creditNoteDate).slice(0, 10) : todayInTimeZone(tz));
        setCustomerNotes(data.customerNotes ?? '');
        setTermsAndConditions(data.termsAndConditions ?? '');
        const docLines = (data.lines ?? []) as any[];
        if (docLines.length > 0) {
          setLines(
            docLines.map((l: any) => ({
              itemId: String(l.itemId ?? ''),
              invoiceLineId: l.invoiceLineId ? String(l.invoiceLineId) : undefined,
              description: l.description ?? l.item?.name ?? '',
              quantity: Number(l.quantity ?? 1),
              unitPrice: Number(l.unitPrice ?? 0),
              taxRate: Number(l.taxRate ?? 0),
              taxLabel: '',
              discount: Number(l.discountAmount ?? 0),
              incomeAccountId: l.incomeAccountId ? String(l.incomeAccountId) : '',
            }))
          );
        }
      })
      .catch((e) => setError(e?.message ?? String(e)))
      .finally(() => setLoadingDoc(false));
  }, [user?.companyId, id, tz]);

  const totals = useMemo(() => {
    const subtotal = lines.reduce((sum, l) => {
      const raw = Number(l.quantity || 0) * Number(l.unitPrice || 0);
      const discount = Math.max(0, Number((l as any).discount || 0));
      return sum + Math.max(0, raw - discount);
    }, 0);
    const tax = lines.reduce((sum, l) => {
      const raw = Number(l.quantity || 0) * Number(l.unitPrice || 0);
      const discount = Math.max(0, Number((l as any).discount || 0));
      const net = Math.max(0, raw - discount);
      return sum + net * Number(l.taxRate || 0);
    }, 0);
    return { subtotal, tax, total: subtotal + tax };
  }, [lines]);

  function updateLine(idx: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
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
        discount: 0,
        incomeAccountId: defaultIncomeAccountId ? String(defaultIncomeAccountId) : '',
      },
    ]);
  }

  function removeLine(idx: number) {
    setLines((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
  }

  async function submit() {
    if (!user?.companyId || !id) return;
    if (saving) return;
    setError(null);
    if (!customerId) {
      setError('Customer is required.');
      return;
    }
    if (lines.length === 0 || lines.some((l) => !l.itemId)) {
      setError('Please select items for all lines.');
      return;
    }
    setSaving(true);
    try {
      await fetchApi(`/companies/${user.companyId}/credit-notes/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          customerId: Number(customerId),
          creditNoteDate,
          invoiceId: cn?.invoiceId ?? null,
          customerNotes: customerNotes || null,
          termsAndConditions: termsAndConditions || null,
          lines: lines.map((l) => ({
            itemId: Number(l.itemId),
            invoiceLineId: l.invoiceLineId ? Number(l.invoiceLineId) : null,
            description: l.description,
            quantity: Number(l.quantity),
            unitPrice: Number(l.unitPrice),
            taxRate: Number(l.taxRate || 0),
            discountAmount: Number((l as any).discount || 0),
            incomeAccountId:
              Number((l as any).incomeAccountId || defaultIncomeAccountId || 0) > 0
                ? Number((l as any).incomeAccountId || defaultIncomeAccountId || 0)
                : undefined,
          })),
        }),
      });
      router.push(`/credit-notes/${id}`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  async function deleteDraft() {
    if (!user?.companyId || !id) return;
    if (deleting) return;
    if (!confirm('Delete this credit note? This is only allowed for DRAFT/APPROVED credit notes.')) return;
    try {
      setError(null);
      setDeleting(true);
      await fetchApi(`/companies/${user.companyId}/credit-notes/${id}`, { method: 'DELETE' });
      router.push('/credit-notes');
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href={`/credit-notes/${id ?? ''}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Edit Credit Note</h1>
          <p className="text-sm text-muted-foreground">Edit a draft credit note before posting.</p>
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
        <>
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
                      const rawSubtotal = Number(l.quantity || 0) * Number(l.unitPrice || 0);
                      const discount = Math.max(0, Number((l as any).discount || 0));
                      const netSubtotal = Math.max(0, rawSubtotal - discount);
                      const lineTax = netSubtotal * Number(l.taxRate || 0);
                      const itemAmount = netSubtotal + lineTax;
                      return (
                        <>
                        <TableRow key={`main-${idx}`} className="border-b-0">
                          <TableCell className="align-top">
                            <div className="space-y-2">
                              <SelectNative value={l.itemId} disabled={!!l.invoiceLineId} onChange={(e) => updateLine(idx, { itemId: e.target.value })}>
                                <option value="">Select item…</option>
                                {items.map((it) => (
                                  <option key={it.id} value={String(it.id)}>
                                    {it.name}
                                  </option>
                                ))}
                              </SelectNative>
                              {l.invoiceLineId ? (
                                <div className="text-xs text-muted-foreground">Linked to invoice line #{l.invoiceLineId}</div>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell className="align-top">
                            <Input
                              type="number"
                              inputMode="numeric"
                              step="1"
                              min="0"
                              className="text-right"
                              value={l.quantity}
                              onChange={(e) => updateLine(idx, { quantity: Number(e.target.value) })}
                            />
                          </TableCell>
                          <TableCell className="align-top">
                            <Input disabled placeholder="Enter a Unit" />
                          </TableCell>
                          <TableCell className="align-top">
                            <Input
                              type="number"
                              inputMode="numeric"
                              step="1"
                              min="0"
                              className="text-right"
                              value={l.unitPrice}
                              onChange={(e) => updateLine(idx, { unitPrice: Number(e.target.value) })}
                            />
                          </TableCell>
                          <TableCell className="align-top">
                        <DropdownMenu
                          open={openTaxIdx === idx}
                          onOpenChange={(open) => {
                            setOpenTaxIdx(open ? idx : null);
                            if (!open) setTaxSearchTerm('');
                          }}
                        >
                          <DropdownMenuTrigger asChild>
                            <Button type="button" variant="outline" className="w-full justify-between px-2">
                                <span className="truncate text-xs">{l.taxLabel || 'Tax'}</span>
                                <ChevronDown className="h-4 w-4" />
                              </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-[280px] p-0">
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
                                    {taxOptions
                                      .filter((t) => t.name.toLowerCase().includes(taxSearchTerm.toLowerCase()))
                                      .map((t) => (
                                  <DropdownMenuItem
                                          key={`${t.type}-${t.id}`}
                                    onSelect={(e) => {
                                      e.preventDefault();
                                            updateLine(idx, { taxRate: t.ratePercent / 100, taxLabel: t.name });
                                            setOpenTaxIdx(null);
                                            setTaxSearchTerm('');
                                          }}
                                        >
                                          {t.name}
                                  </DropdownMenuItem>
                                      ))}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem asChild>
                                <Link href="/taxes" className="text-sm text-primary">
                                        + New Tax
                                      </Link>
                              </DropdownMenuItem>
                            </div>
                          </DropdownMenuContent>
                        </DropdownMenu>
                          </TableCell>
                          <TableCell className="align-top">
                            <Input
                              inputMode="decimal"
                              type="number"
                              step="0.01"
                              min="0"
                              className="text-right"
                              value={Number((l as any).discount || 0)}
                              onChange={(e) => updateLine(idx, { discount: Number(e.target.value || 0) } as any)}
                            />
                          </TableCell>
                          <TableCell className="align-top text-right font-semibold tabular-nums">
                            {itemAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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
                          </TableCell>
                          <TableCell colSpan={5} />
                        </TableRow>
                        </>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              <div className="flex justify-end">
                <div className="w-full max-w-sm space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Sub Total</span>
                    <span className="tabular-nums">
                      {totals.subtotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Tax</span>
                    <span className="tabular-nums">
                      {totals.tax.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                  <div className="flex justify-between font-semibold">
                    <span>Total</span>
                    <span className="tabular-nums">
                      {totals.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Notes &amp; Terms</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <Label>Customer Notes</Label>
                <Textarea value={customerNotes} onChange={(e) => setCustomerNotes(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label>Terms &amp; Conditions</Label>
                <Textarea value={termsAndConditions} onChange={(e) => setTermsAndConditions(e.target.value)} />
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end gap-2">
            <Button variant="destructive" type="button" onClick={deleteDraft} disabled={saving || deleting}>
              {deleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
            <Link href={`/credit-notes/${id}`}>
              <Button variant="outline" type="button">
                Cancel
              </Button>
            </Link>
            <Button onClick={submit} disabled={saving}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {saving ? 'Saving...' : 'Save changes'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}


