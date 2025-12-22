'use client';

import { useState, useEffect } from 'react';
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
import Link from 'next/link';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type TaxOption = {
  id: number
  name: string
  ratePercent: number
  type: 'rate' | 'group'
}

type InvoiceLine = {
  itemId: string
  description: string
  quantity: number
  unitPrice: number
  taxRateId: string // can be tax rate ID or group ID
  taxType: 'rate' | 'group' | ''
}

export default function NewInvoiceWithTaxPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [customers, setCustomers] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [taxOptions, setTaxOptions] = useState<TaxOption[]>([]);
  const [showTaxDropdown, setShowTaxDropdown] = useState<number | null>(null);
  const [taxSearchTerm, setTaxSearchTerm] = useState('');
  const [taxExclusive, setTaxExclusive] = useState(false);
  const timeZone = companySettings?.timeZone ?? 'Asia/Yangon';
  
  const [formData, setFormData] = useState({
    customerId: '',
    invoiceDate: '',
    dueDate: '',
  });

  const [lines, setLines] = useState<InvoiceLine[]>([
    { itemId: '', description: '', quantity: 1, unitPrice: 0, taxRateId: '', taxType: '' }
  ]);

  useEffect(() => {
    if (user?.companyId) {
      Promise.all([
        fetchApi(`/companies/${user.companyId}/customers`),
        fetchApi(`/companies/${user.companyId}/items`),
        fetchApi(`/companies/${user.companyId}/taxes`),
      ]).then(([cust, itm, taxes]) => {
        setCustomers(cust);
        setItems(itm);
        
        // Combine tax rates and groups into a single dropdown list
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
    }
  }, [user?.companyId]);

  useEffect(() => {
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
    setLines(newLines);
  };

  const updateLine = (index: number, field: keyof InvoiceLine, value: any) => {
    const newLines = [...lines];
    (newLines[index] as any)[field] = value;
    setLines(newLines);
  };

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

  const addLine = () => {
    setLines([...lines, { itemId: '', description: '', quantity: 1, unitPrice: 0, taxRateId: '', taxType: '' }]);
  };

  const removeLine = (index: number) => {
    if (lines.length > 1) {
      setLines(lines.filter((_, i) => i !== index));
    }
  };

  const getTaxLabel = (line: InvoiceLine) => {
    if (!line.taxRateId) return 'Select a Tax';
    const option = taxOptions.find(o => o.id.toString() === line.taxRateId && o.type === line.taxType);
    return option?.name || 'Select a Tax';
  };

  const calculateLineSubtotal = (line: InvoiceLine) => {
    return line.quantity * line.unitPrice;
  };

  const calculateLineTax = (line: InvoiceLine) => {
    const subtotal = calculateLineSubtotal(line);
    if (!line.taxRateId) return 0;
    const option = taxOptions.find(o => o.id.toString() === line.taxRateId && o.type === line.taxType);
    if (!option) return 0;
    return (subtotal * option.ratePercent) / 100;
  };

  const calculateLineTotal = (line: InvoiceLine) => {
    return calculateLineSubtotal(line) + calculateLineTax(line);
  };

  const calculateTotals = () => {
    const subtotal = lines.reduce((sum, line) => sum + calculateLineSubtotal(line), 0);
    const tax = lines.reduce((sum, line) => sum + calculateLineTax(line), 0);
    const total = subtotal + tax;
    return { subtotal, tax, total };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.companyId) return;
    
    setLoading(true);
    try {
      // For now, submit without tax (backend needs migration first)
      // Once migrated, add taxRateId and taxType to each line
      await fetchApi(`/companies/${user.companyId}/invoices`, {
        method: 'POST',
        body: JSON.stringify({
          customerId: Number(formData.customerId),
          invoiceDate: formData.invoiceDate,
          dueDate: formData.dueDate || undefined,
          lines: lines.map(l => ({
            itemId: Number(l.itemId),
            description: l.description,
            quantity: Number(l.quantity),
            unitPrice: Number(l.unitPrice),
            // TODO: After migration, include:
            // taxRate: l.taxRateId ? taxOptions.find(o => o.id.toString() === l.taxRateId)?.ratePercent / 100 : 0,
          }))
        }),
      });
      router.push('/invoices');
    } catch (err) {
      console.error(err);
      alert('Failed to create invoice');
    } finally {
      setLoading(false);
    }
  };

  const totals = calculateTotals();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">New Invoice</h1>
        <p className="text-sm text-muted-foreground">Create a draft invoice with tax.</p>
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
                <Label htmlFor="customer">
                  Customer Name
                  <span className="text-red-500">*</span>
                </Label>
                <SelectNative
                  id="customer"
                  required
                  value={formData.customerId}
                  onChange={(e) => setFormData({ ...formData, customerId: e.target.value })}
                >
                  <option value="">Select or add a customer</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </SelectNative>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="invoiceDate">
                  Invoice Date
                  <span className="text-red-500">*</span>
                </Label>
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

          {/* Tax Configuration */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setTaxExclusive(!taxExclusive)}
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
            >
              <div className="flex items-center gap-2">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                <span>Tax Exclusive</span>
                <ChevronDown className="h-4 w-4" />
              </div>
            </button>
          </div>

          {/* Lines Table */}
          <Card>
            <CardHeader>
              <CardTitle>Item Table</CardTitle>
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
                  <div key={index} className="grid grid-cols-12 gap-2 items-center py-2">
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
                        onChange={(e) => updateLine(index, 'quantity', Number(e.target.value) || 0)}
                      />
                    </div>
                    <div className="col-span-2">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        className="text-right text-sm tabular-nums"
                        value={line.unitPrice}
                        onChange={(e) => updateLine(index, 'unitPrice', Number(e.target.value) || 0)}
                      />
                    </div>
                    <div className="col-span-2">
                      <DropdownMenu
                        open={showTaxDropdown === index}
                        onOpenChange={(open) => {
                          setShowTaxDropdown(open ? index : null);
                          if (!open) setTaxSearchTerm('');
                        }}
                      >
                        <DropdownMenuTrigger asChild>
                          <Button type="button" variant="outline" size="sm" className="w-full justify-between text-sm">
                        <span className="truncate">{getTaxLabel(line)}</span>
                        <ChevronDown className="h-4 w-4 ml-1 flex-shrink-0" />
                      </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-64 p-0">
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
                          <div className="max-h-64 overflow-y-auto p-2">
                            <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Taxes</div>
                              {taxOptions
                                .filter((opt) => opt.type === 'rate' && opt.name.toLowerCase().includes(taxSearchTerm.toLowerCase()))
                                .map((opt) => (
                                <DropdownMenuItem
                                    key={`rate-${opt.id}`}
                                  onSelect={(e) => {
                                    e.preventDefault();
                                    selectTax(index, opt);
                                  }}
                                  >
                                    {opt.name}
                                </DropdownMenuItem>
                                ))}

                            <DropdownMenuSeparator />
                            <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Tax Group</div>
                              {taxOptions
                                .filter((opt) => opt.type === 'group' && opt.name.toLowerCase().includes(taxSearchTerm.toLowerCase()))
                                .map((opt) => (
                                <DropdownMenuItem
                                    key={`group-${opt.id}`}
                                  onSelect={(e) => {
                                    e.preventDefault();
                                    selectTax(index, opt);
                                  }}
                                  >
                                    {opt.name}
                                </DropdownMenuItem>
                                ))}

                            <DropdownMenuSeparator />
                            <DropdownMenuItem asChild>
                              <Link href="/taxes/new" className="text-sm text-primary">
                                <span className="inline-flex items-center gap-2">
                                <Plus className="h-4 w-4" />
                                New Tax
                                </span>
                              </Link>
                            </DropdownMenuItem>
                          </div>
                        </DropdownMenuContent>
                      </DropdownMenu>
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
              
              {/* Totals Section */}
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
                className="w-full min-h-[80px] p-3 text-sm border rounded-md"
                placeholder="Will be displayed on the invoice"
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
                className="w-full min-h-[80px] p-3 text-sm border rounded-md"
                placeholder="Enter the terms and conditions of your business to be displayed in your transaction"
              />
            </CardContent>
          </Card>

          {/* Action Buttons */}
          <div className="flex justify-end gap-4">
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="button" variant="outline" disabled={loading}>
              Save as Draft
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? 'Saving...' : 'Save and Send'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

