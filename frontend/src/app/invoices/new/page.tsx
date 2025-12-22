'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Trash2, Plus, ChevronDown, Search } from 'lucide-react';
import { SelectNative } from '@/components/ui/select-native';
import { Separator } from '@/components/ui/separator';
import { todayInTimeZone } from '@/lib/utils';
import { Textarea } from '@/components/ui/textarea';
import Link from 'next/link';
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

export default function NewInvoicePage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [customers, setCustomers] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [defaultIncomeAccountId, setDefaultIncomeAccountId] = useState<number | null>(null);
  const [taxOptions, setTaxOptions] = useState<TaxOption[]>([]);
  const [taxSearchTerm, setTaxSearchTerm] = useState('');
  const [openTaxIdx, setOpenTaxIdx] = useState<number | null>(null);
  const timeZone = companySettings?.timeZone ?? 'Asia/Yangon';

  const incomeAccounts = useMemo(
    () => (accounts ?? []).filter((a: any) => a.type === 'INCOME' && a.isActive !== false),
    [accounts]
  );
  
  const [formData, setFormData] = useState({
    customerId: '',
    invoiceDate: '',
    dueDate: '',
    customerNotes: '',
    termsAndConditions: '',
  });

  const [lines, setLines] = useState([
    { itemId: '', description: '', quantity: 1, unitPrice: 0, taxRate: 0, taxLabel: '', incomeAccountId: '' }
  ]);

  useEffect(() => {
    if (user?.companyId) {
      Promise.all([
        fetchApi(`/companies/${user.companyId}/customers`),
        fetchApi(`/companies/${user.companyId}/items`),
        fetchApi(`/companies/${user.companyId}/taxes`),
        fetchApi(`/companies/${user.companyId}/accounts`),
      ])
        .then(([cust, itm, taxes, accounts]) => {
          setCustomers(cust);
          setItems(itm);
          const activeAccounts = (accounts ?? []).filter((a: any) => a.isActive !== false);
          setAccounts(activeAccounts);
          const income = activeAccounts.filter((a: any) => a.type === 'INCOME');
          const sales = income.find(
            (a: any) => String(a.code) === '4000' || String(a.name).trim().toLowerCase() === 'sales income'
          );
          const fallback = sales ?? income[0] ?? null;
          setDefaultIncomeAccountId(fallback ? Number(fallback.id) : null);
          const options: TaxOption[] = [
            ...((taxes?.taxRates ?? []) as any[]).map((r) => ({
              id: r.id,
              name: `${r.name} [${Number(r.ratePercent ?? 0).toFixed(0)}%]`,
              ratePercent: Number(r.ratePercent ?? 0),
              type: 'rate' as const,
            })),
            ...((taxes?.taxGroups ?? []) as any[]).map((g) => ({
              id: g.id,
              name: `${g.name} [${Number(g.totalRatePercent ?? 0).toFixed(0)}%]`,
              ratePercent: Number(g.totalRatePercent ?? 0),
              type: 'group' as const,
            })),
          ];
          setTaxOptions(options);
        })
        .catch(console.error);
    }
  }, [user?.companyId]);

  useEffect(() => {
    // Default date should follow company time zone (not UTC).
    if (!formData.invoiceDate) {
      setFormData((prev) => ({ ...prev, invoiceDate: todayInTimeZone(timeZone) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeZone]);

  const handleItemChange = (index: number, itemId: string) => {
    const item = items.find(i => i.id.toString() === itemId);
    const newLines = [...lines];
    newLines[index].itemId = itemId;
    if (item) {
      newLines[index].unitPrice = Number(item.sellingPrice);
      newLines[index].description = item.name;
    }
    // Default income account is always Sales Income (business-owner friendly).
    if (!(newLines[index] as any).incomeAccountId && defaultIncomeAccountId) {
      (newLines[index] as any).incomeAccountId = String(defaultIncomeAccountId);
    }
    setLines(newLines);
  };

  const updateLine = (index: number, field: string, value: any) => {
    const newLines = [...lines];
    (newLines[index] as any)[field] = value;
    setLines(newLines);
  };

  const addLine = () => {
    setLines([
      ...lines,
      {
        itemId: '',
        description: '',
        quantity: 1,
        unitPrice: 0,
        taxRate: 0,
        taxLabel: '',
        incomeAccountId: defaultIncomeAccountId ? String(defaultIncomeAccountId) : '',
      } as any,
    ]);
  };

  const removeLine = (index: number) => {
    if (lines.length > 1) {
      setLines(lines.filter((_, i) => i !== index));
    }
  };

  const totals = useMemo(() => {
    const subtotal = lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0), 0);
    const tax = lines.reduce((sum, line) => {
      const lineSubtotal = Number(line.quantity || 0) * Number(line.unitPrice || 0);
      return sum + lineSubtotal * Number((line as any).taxRate || 0);
    }, 0);
    return { subtotal, tax, total: subtotal + tax };
  }, [lines]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.companyId) return;
    
    setLoading(true);
    try {
      await fetchApi(`/companies/${user.companyId}/invoices`, {
        method: 'POST',
        body: JSON.stringify({
          customerId: Number(formData.customerId),
          invoiceDate: formData.invoiceDate,
          dueDate: formData.dueDate || undefined,
          customerNotes: formData.customerNotes || undefined,
          termsAndConditions: formData.termsAndConditions || undefined,
          lines: lines.map(l => ({
            itemId: Number(l.itemId),
            description: l.description,
            quantity: Number(l.quantity),
            unitPrice: Number(l.unitPrice),
            taxRate: Number((l as any).taxRate || 0),
            incomeAccountId:
              Number((l as any).incomeAccountId || defaultIncomeAccountId || 0) > 0
                ? Number((l as any).incomeAccountId || defaultIncomeAccountId || 0)
                : undefined,
          }))
        }),
      });
      router.push('/invoices');
    } catch (err: any) {
      console.error(err);
      alert(err?.message || 'Failed to create invoice');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">New Invoice</h1>
        <p className="text-sm text-muted-foreground">Create a draft invoice.</p>
      </div>
      
      <form onSubmit={handleSubmit}>
        <div className="grid gap-6">
          {/* Basic Info */}
          <Card>
            <CardHeader>
              <CardTitle>Customer & Dates</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-3">
              <div className="grid gap-2">
                <Label htmlFor="customer">Customer *</Label>
                <SelectNative
                  id="customer"
                  required
                  value={formData.customerId}
                  onChange={(e) => setFormData({ ...formData, customerId: e.target.value })}
                >
                  <option value="">Select Customer</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </SelectNative>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="invoiceDate">Invoice Date</Label>
                <Input
                  id="invoiceDate"
                  type="date"
                  required
                  value={formData.invoiceDate}
                  onChange={(e) => setFormData({ ...formData, invoiceDate: e.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="dueDate">Due Date</Label>
                <Input
                  id="dueDate"
                  type="date"
                  value={formData.dueDate}
                  onChange={(e) => setFormData({ ...formData, dueDate: e.target.value })}
                />
              </div>
            </CardContent>
          </Card>

          {/* Lines */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle>Items</CardTitle>
              <Button type="button" variant="outline" size="sm" onClick={addLine}>
                <Plus className="mr-2 h-4 w-4" /> Add Item
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
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
                    {lines.map((line, index) => {
                      const lineSubtotal = Number(line.quantity || 0) * Number(line.unitPrice || 0)
                      return (
                    <>
                    <TableRow key={`main-${index}`} className="border-b-0">
                      <TableCell className="align-top">
                            <div className="space-y-2">
                              <SelectNative required value={line.itemId} onChange={(e) => handleItemChange(index, e.target.value)}>
                                <option value="">Select item…</option>
                      {items.map((i) => (
                        <option key={i.id} value={i.id}>{i.name}</option>
                      ))}
                    </SelectNative>
                  </div>
                          </TableCell>
                          <TableCell className="align-top">
                    <Input
                      type="number"
                      min="1"
                              inputMode="numeric"
                      className="text-right"
                      value={line.quantity}
                      onChange={(e) => updateLine(index, 'quantity', Number(e.target.value))}
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
                      value={line.unitPrice}
                      onChange={(e) => updateLine(index, 'unitPrice', Number(e.target.value))}
                    />
                          </TableCell>
                      <TableCell className="align-top">
                              <DropdownMenu
                                open={openTaxIdx === index}
                                onOpenChange={(open) => {
                                  setOpenTaxIdx(open ? index : null);
                                  if (!open) setTaxSearchTerm('');
                                }}
                              >
                                <DropdownMenuTrigger asChild>
                                  <Button type="button" variant="outline" className="w-full justify-between px-2">
                        <span className="truncate text-xs">{(line as any).taxLabel || 'Tax'}</span>
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
                            <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Tax</div>
                            {taxOptions
                              .filter((t) => t.type === 'rate')
                              .filter((t) => t.name.toLowerCase().includes(taxSearchTerm.toLowerCase()))
                              .map((t) => (
                                        <DropdownMenuItem
                                  key={`rate-${t.id}`}
                                          onSelect={(e) => {
                                            e.preventDefault();
                                    updateLine(index, 'taxRate', t.ratePercent / 100);
                                    updateLine(index, 'taxLabel', t.name);
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
                            <Input disabled className="text-right" value="0.00" />
                          </TableCell>
                          <TableCell className="align-top text-right font-semibold tabular-nums">
                            {lineSubtotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </TableCell>
                          <TableCell className="align-top text-right">
                            <Button type="button" variant="ghost" size="icon" onClick={() => removeLine(index)} disabled={lines.length === 1}>
                              <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                          </TableCell>
                        </TableRow>
                    <TableRow key={`acct-${index}`} className="bg-muted/10 border-t-0">
                      <TableCell className="py-3">
                        <Textarea
                          value={line.description}
                          onChange={(e) => updateLine(index, 'description', e.target.value)}
                          placeholder="Enter name or description"
                          className="min-h-[44px]"
                        />
                      </TableCell>
                      <TableCell colSpan={2} className="py-3">
                        <AccountPicker
                          accounts={accounts}
                          value={(line as any).incomeAccountId || defaultIncomeAccountId}
                          onChange={(nextId) => updateLine(index, 'incomeAccountId', nextId ? String(nextId) : '')}
                          placeholder="Select an account"
                          disabled={!accounts.length}
                          createHref="/accounts/new"
                          isOptionDisabled={(a) => a.type !== 'INCOME'}
                          getOptionDisabledReason={(a) => (a.type !== 'INCOME' ? 'Invoice lines must use an INCOME account' : undefined)}
                        />
                      </TableCell>
                      <TableCell colSpan={4} />
                    </TableRow>
                    </>
                      )
                    })}
                  </TableBody>
                </Table>
                </div>

              <Button type="button" variant="outline" size="sm" onClick={addLine} className="mt-2">
                <Plus className="h-4 w-4 mr-2" /> Add Line
              </Button>

              {!defaultIncomeAccountId ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                  <div className="font-medium text-destructive">Missing “Sales Income” account</div>
                  <div className="mt-1 text-muted-foreground">
                    Please create an INCOME account with code <b>4000</b> (Sales Income) in Chart of Accounts.
                  </div>
                </div>
              ) : null}

              <Separator />
              <div className="flex justify-end">
                <div className="w-64 space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Sub Total</span>
                    <span className="tabular-nums">{totals.subtotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Tax</span>
                    <span className="tabular-nums">{totals.tax.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex justify-between font-semibold">
                    <span>Total</span>
                    <span className="tabular-nums">{totals.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Text blocks (printed on invoice) */}
          <Card>
            <CardHeader>
              <CardTitle>Customer Notes</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Textarea
                value={formData.customerNotes}
                onChange={(e) => setFormData({ ...formData, customerNotes: e.target.value })}
                placeholder="Will be displayed on the invoice"
                className="min-h-[90px]"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Terms &amp; Conditions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Textarea
                value={formData.termsAndConditions}
                onChange={(e) => setFormData({ ...formData, termsAndConditions: e.target.value })}
                placeholder="Enter the terms and conditions of your business to be displayed in your transaction"
                className="min-h-[110px]"
              />
            </CardContent>
          </Card>

          <div className="flex justify-end gap-4">
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? 'Saving...' : 'Save as Draft'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
