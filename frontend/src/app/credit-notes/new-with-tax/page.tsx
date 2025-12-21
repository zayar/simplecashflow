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
import { Plus, Trash2, ArrowLeft, ChevronDown, Search } from 'lucide-react';
import { Separator } from '@/components/ui/separator';

type TaxOption = {
  id: number
  name: string
  ratePercent: number
  type: 'rate' | 'group'
}

type CreditNoteLine = {
  itemId: string
  description: string
  quantity: number
  unitPrice: number
  taxRateId: string
  taxType: 'rate' | 'group' | ''
}

export default function NewCreditNoteWithTaxPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const search = useSearchParams();
  const tz = companySettings?.timeZone ?? 'Asia/Yangon';

  const [customers, setCustomers] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [taxOptions, setTaxOptions] = useState<TaxOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTaxDropdown, setShowTaxDropdown] = useState<number | null>(null);
  const [taxSearchTerm, setTaxSearchTerm] = useState('');
  const [taxExclusive, setTaxExclusive] = useState(false);

  const [customerId, setCustomerId] = useState('');
  const [creditNoteDate, setCreditNoteDate] = useState('');
  const [lines, setLines] = useState<CreditNoteLine[]>([
    { itemId: '', description: '', quantity: 1, unitPrice: 0, taxRateId: '', taxType: '' }
  ]);
  const [sourceInvoice, setSourceInvoice] = useState<any>(null);

  useEffect(() => {
    if (!creditNoteDate) setCreditNoteDate(todayInTimeZone(tz));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tz]);

  useEffect(() => {
    if (!user?.companyId) return;
    Promise.all([
      fetchApi(`/companies/${user.companyId}/customers`),
      fetchApi(`/companies/${user.companyId}/items`),
      fetchApi(`/companies/${user.companyId}/taxes`),
    ]).then(([cust, itm, taxes]) => {
      setCustomers(cust);
      setItems(itm);
      
      const options: TaxOption[] = [
        ...(taxes.taxRates || []).map((r: any) => ({
          id: r.id,
          name: `${r.name} [${r.ratePercent.toFixed(0)}%]`,
          ratePercent: r.ratePercent,
          type: 'rate' as const,
        })),
        ...(taxes.taxGroups || []).map((g: any) => ({
          id: g.id,
          name: `${g.name} [${g.totalRatePercent.toFixed(0)}%]`,
          ratePercent: g.totalRatePercent,
          type: 'group' as const,
        })),
      ];
      setTaxOptions(options);
    }).catch(console.error);
  }, [user?.companyId]);

  useEffect(() => {
    if (!user?.companyId) return;
    const invoiceId = search?.get('invoiceId');
    if (!invoiceId) return;
    
    fetchApi(`/companies/${user.companyId}/invoices/${invoiceId}`)
      .then((inv) => {
        setSourceInvoice(inv);
        setCustomerId(String(inv.customerId ?? inv.customer?.id ?? ''));
        const invLines = (inv.lines ?? []) as any[];
        if (invLines.length > 0) {
          setLines(
            invLines.map((l: any) => ({
              itemId: String(l.itemId),
              description: l.description ?? l.item?.name ?? '',
              quantity: 1,
              unitPrice: Number(l.unitPrice ?? 0),
              taxRateId: '',
              taxType: '',
            }))
          );
        }
      })
      .catch((e) => setError(e?.message ?? String(e)));
  }, [user?.companyId, search]);

  function updateLine(idx: number, patch: Partial<CreditNoteLine>) {
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
    setLines(next);
  }

  const selectTax = (index: number, option: TaxOption | null) => {
    const newLines = [...lines];
    if (option) {
      newLines[index].taxRateId = option.id.toString();
      newLines[index].taxType = option.type;
    } else {
      newLines[index].taxRateId = '';
      newLines[index].taxType = '';
    }
    setLines(newLines);
    setShowTaxDropdown(null);
    setTaxSearchTerm('');
  };

  function addLine() {
    setLines((prev) => [...prev, { itemId: '', description: '', quantity: 1, unitPrice: 0, taxRateId: '', taxType: '' }]);
  }

  function removeLine(idx: number) {
    setLines((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
  }

  const getTaxLabel = (line: CreditNoteLine) => {
    if (!line.taxRateId) return 'Select a Tax';
    const option = taxOptions.find(o => o.id.toString() === line.taxRateId && o.type === line.taxType);
    return option?.name || 'Select a Tax';
  };

  const calculateLineSubtotal = (line: CreditNoteLine) => {
    return line.quantity * line.unitPrice;
  };

  const calculateLineTax = (line: CreditNoteLine) => {
    const subtotal = calculateLineSubtotal(line);
    if (!line.taxRateId) return 0;
    const option = taxOptions.find(o => o.id.toString() === line.taxRateId && o.type === line.taxType);
    if (!option) return 0;
    return (subtotal * option.ratePercent) / 100;
  };

  const calculateLineTotal = (line: CreditNoteLine) => {
    return calculateLineSubtotal(line) + calculateLineTax(line);
  };

  const totals = useMemo(() => {
    const subtotal = lines.reduce((sum, l) => sum + calculateLineSubtotal(l), 0);
    const tax = lines.reduce((sum, l) => sum + calculateLineTax(l), 0);
    const total = subtotal + tax;
    return { subtotal, tax, total };
  }, [lines]);

  async function submit() {
    if (!user?.companyId) return;
    setLoading(true);
    setError(null);
    try {
      await fetchApi(`/companies/${user.companyId}/credit-notes`, {
        method: 'POST',
        body: JSON.stringify({
          customerId: Number(customerId),
          creditNoteDate,
          lines: lines.map((l) => ({
            itemId: Number(l.itemId),
            description: l.description,
            quantity: Number(l.quantity),
            unitPrice: Number(l.unitPrice),
            // TODO: After migration, include:
            // taxRate: l.taxRateId ? taxOptions.find(o => o.id.toString() === l.taxRateId)?.ratePercent / 100 : 0,
          })),
        }),
      });
      router.push('/credit-notes');
    } catch (err: any) {
      setError(err?.message ?? 'Failed to create credit note');
    } finally {
      setLoading(false);
    }
  }

  if (!user) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Link href="/credit-notes">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New Credit Note</h1>
          {sourceInvoice && (
            <p className="text-sm text-muted-foreground">
              Credit note for Invoice #{sourceInvoice.invoiceNumber}
            </p>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded">
          {error}
        </div>
      )}

      <div className="grid gap-6">
        {/* Header Info */}
        <Card>
          <CardContent className="pt-6 grid gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="customerId">
                Customer Name
                <span className="text-red-500">*</span>
              </Label>
              <div className="flex gap-2">
                <SelectNative
                  id="customerId"
                  required
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  className="flex-1"
                >
                  <option value="">Select or add a customer</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </SelectNative>
                <Button type="button" variant="outline" size="icon">
                  <Search className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="creditNoteDate">
                Credit Note Date
                <span className="text-red-500">*</span>
              </Label>
              <Input
                id="creditNoteDate"
                type="date"
                required
                value={creditNoteDate}
                onChange={(e) => setCreditNoteDate(e.target.value)}
              />
            </div>
          </CardContent>
        </Card>

        {/* Tax Exclusive Toggle */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTaxExclusive(!taxExclusive)}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            <span>Tax Exclusive</span>
            <ChevronDown className="h-4 w-4" />
          </button>
        </div>

        {/* Item Table */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Item Table</CardTitle>
              <Button type="button" variant="ghost" size="sm">
                Bulk Actions
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-12 gap-2 text-xs font-medium text-muted-foreground border-b pb-2">
              <div className="col-span-3">ITEM DETAILS</div>
              <div className="col-span-1 text-right">QUANTITY</div>
              <div className="col-span-2 text-right">RATE</div>
              <div className="col-span-2">TAX</div>
              <div className="col-span-3 text-right">AMOUNT</div>
              <div className="col-span-1"></div>
            </div>

            {lines.map((line, index) => {
              const lineSubtotal = calculateLineSubtotal(line);
              const lineTax = calculateLineTax(line);
              const lineTotal = calculateLineTotal(line);

              return (
                <div key={index} className="grid grid-cols-12 gap-2 items-start py-2">
                  <div className="col-span-3">
                    <SelectNative
                      required
                      value={line.itemId}
                      onChange={(e) => handleItemChange(index, e.target.value)}
                      className="text-sm"
                    >
                      <option value="">Type or click to select an item.</option>
                      {items.map((i) => (
                        <option key={i.id} value={i.id}>{i.name}</option>
                      ))}
                    </SelectNative>
                  </div>
                  <div className="col-span-1">
                    <Input
                      type="number"
                      min="0.01"
                      step="0.01"
                      className="text-right text-sm tabular-nums"
                      value={line.quantity}
                      onChange={(e) => updateLine(index, { quantity: Number(e.target.value) || 0 })}
                    />
                  </div>
                  <div className="col-span-2">
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      className="text-right text-sm tabular-nums"
                      value={line.unitPrice}
                      onChange={(e) => updateLine(index, { unitPrice: Number(e.target.value) || 0 })}
                    />
                  </div>
                  <div className="col-span-2 relative">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full justify-between text-sm"
                      onClick={() => setShowTaxDropdown(showTaxDropdown === index ? null : index)}
                    >
                      <span className="truncate">{getTaxLabel(line)}</span>
                      <ChevronDown className="h-4 w-4 ml-1 flex-shrink-0" />
                    </Button>
                    
                    {showTaxDropdown === index && (
                      <div className="absolute top-full left-0 mt-1 w-64 bg-white border rounded-md shadow-lg z-50">
                        <div className="p-2 border-b">
                          <div className="relative">
                            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                            <Input
                              placeholder="Search"
                              value={taxSearchTerm}
                              onChange={(e) => setTaxSearchTerm(e.target.value)}
                              className="pl-8 text-sm"
                            />
                          </div>
                        </div>
                        <div className="max-h-64 overflow-y-auto">
                          <div className="p-2">
                            <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                              Taxes
                            </div>
                            {taxOptions
                              .filter((opt) => opt.type === 'rate' && opt.name.toLowerCase().includes(taxSearchTerm.toLowerCase()))
                              .map((opt) => (
                                <button
                                  key={`rate-${opt.id}`}
                                  type="button"
                                  onClick={() => selectTax(index, opt)}
                                  className="w-full text-left px-3 py-2 hover:bg-primary hover:text-primary-foreground rounded text-sm"
                                >
                                  {opt.name}
                                </button>
                              ))}
                          </div>

                          <div className="p-2 border-t">
                            <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                              Tax Group
                            </div>
                            {taxOptions
                              .filter((opt) => opt.type === 'group' && opt.name.toLowerCase().includes(taxSearchTerm.toLowerCase()))
                              .map((opt) => (
                                <button
                                  key={`group-${opt.id}`}
                                  type="button"
                                  onClick={() => selectTax(index, opt)}
                                  className="w-full text-left px-3 py-2 hover:bg-primary hover:text-primary-foreground rounded text-sm"
                                >
                                  {opt.name}
                                </button>
                              ))}
                          </div>

                          <div className="p-2 border-t">
                            <Link
                              href="/taxes/new"
                              className="flex items-center gap-2 px-3 py-2 text-sm text-primary hover:bg-muted rounded"
                            >
                              <Plus className="h-4 w-4" />
                              New Tax
                            </Link>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="col-span-3 text-right text-sm font-medium tabular-nums">
                    {lineTotal.toFixed(2)}
                  </div>
                  <div className="col-span-1 flex justify-end">
                    <Button 
                      type="button" 
                      variant="ghost" 
                      size="icon"
                      onClick={() => removeLine(index)}
                      disabled={lines.length === 1}
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                </div>
              );
            })}

            <div className="flex gap-2 pt-2">
              <Button type="button" variant="outline" size="sm" onClick={addLine}>
                <Plus className="h-4 w-4 mr-1" /> Add New Row
              </Button>
              <Button type="button" variant="ghost" size="sm">
                <Plus className="h-4 w-4 mr-1" /> Add Items in Bulk
              </Button>
            </div>

            <Separator className="my-4" />
            
            {/* Totals */}
            <div className="space-y-2">
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Sub Total</span>
                <span className="tabular-nums font-medium">{totals.subtotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Discount</span>
                <Input type="number" className="w-24 text-right text-sm" defaultValue="0" />
              </div>
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Shipping Charges</span>
                <Input type="number" className="w-24 text-right text-sm" defaultValue="0" />
              </div>
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Adjustment</span>
                <Input type="number" className="w-24 text-right text-sm" defaultValue="0" />
              </div>
              <Separator />
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Round Off</span>
                <span className="tabular-nums">0.00</span>
              </div>
              <div className="flex justify-between items-center text-lg font-semibold pt-2">
                <span>Total ( {companySettings?.baseCurrency || 'MMK'} )</span>
                <span className="tabular-nums">{totals.total.toFixed(2)}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Customer Notes */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Customer Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <textarea
              className="w-full min-h-[60px] p-3 text-sm border rounded-md"
              placeholder="Will be displayed on the credit note"
            />
          </CardContent>
        </Card>

        {/* Terms & Conditions */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Terms & Conditions</CardTitle>
          </CardHeader>
          <CardContent>
            <textarea
              className="w-full min-h-[60px] p-3 text-sm border rounded-md"
              placeholder="Enter the terms and conditions of your business to be displayed in your transaction"
            />
          </CardContent>
        </Card>

        {/* Additional Fields Note */}
        <p className="text-sm text-muted-foreground">
          Additional Fields: Start adding custom fields for your credit notes by going to{' '}
          <span className="font-medium">Settings → Sales → Credit Notes</span>.
        </p>

        {/* Action Buttons */}
        <div className="flex justify-end gap-4">
          <Button type="button" variant="outline" onClick={() => router.back()}>
            Cancel
          </Button>
          <Button type="button" variant="outline" onClick={submit} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Save as Draft
          </Button>
          <Button type="button" onClick={submit} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Save as Open
          </Button>
        </div>
      </div>
    </div>
  );
}

