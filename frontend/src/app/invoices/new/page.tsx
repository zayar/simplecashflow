'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Trash2, Plus } from 'lucide-react';
import { SelectNative } from '@/components/ui/select-native';
import { Separator } from '@/components/ui/separator';

export default function NewInvoicePage() {
  const { user } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [customers, setCustomers] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  
  const [formData, setFormData] = useState({
    customerId: '',
    invoiceDate: new Date().toISOString().split('T')[0],
    dueDate: '',
  });

  const [lines, setLines] = useState([
    { itemId: '', description: '', quantity: 1, unitPrice: 0 }
  ]);

  useEffect(() => {
    if (user?.companyId) {
      fetchApi(`/companies/${user.companyId}/customers`).then(setCustomers).catch(console.error);
      fetchApi(`/companies/${user.companyId}/items`).then(setItems).catch(console.error);
    }
  }, [user?.companyId]);

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

  const updateLine = (index: number, field: string, value: any) => {
    const newLines = [...lines];
    (newLines[index] as any)[field] = value;
    setLines(newLines);
  };

  const addLine = () => {
    setLines([...lines, { itemId: '', description: '', quantity: 1, unitPrice: 0 }]);
  };

  const removeLine = (index: number) => {
    if (lines.length > 1) {
      setLines(lines.filter((_, i) => i !== index));
    }
  };

  const calculateTotal = () => {
    return lines.reduce((sum, line) => sum + (line.quantity * line.unitPrice), 0);
  };

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
          lines: lines.map(l => ({
            itemId: Number(l.itemId),
            description: l.description,
            quantity: Number(l.quantity),
            unitPrice: Number(l.unitPrice)
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
            <CardHeader>
              <CardTitle>Items</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-12 gap-4 font-medium text-sm text-muted-foreground mb-2">
                <div className="col-span-4">Item</div>
                <div className="col-span-4">Description</div>
                <div className="col-span-1 text-right">Qty</div>
                <div className="col-span-2 text-right">Price</div>
                <div className="col-span-1"></div>
              </div>
              
              {lines.map((line, index) => (
                <div key={index} className="grid grid-cols-12 gap-4 items-center">
                  <div className="col-span-4">
                    <SelectNative
                      required
                      value={line.itemId}
                      onChange={(e) => handleItemChange(index, e.target.value)}
                    >
                      <option value="">Select Item</option>
                      {items.map((i) => (
                        <option key={i.id} value={i.id}>{i.name}</option>
                      ))}
                    </SelectNative>
                  </div>
                  <div className="col-span-4">
                    <Input
                      value={line.description}
                      onChange={(e) => updateLine(index, 'description', e.target.value)}
                      placeholder="Description"
                    />
                  </div>
                  <div className="col-span-1">
                    <Input
                      type="number"
                      min="1"
                      className="text-right"
                      value={line.quantity}
                      onChange={(e) => updateLine(index, 'quantity', Number(e.target.value))}
                    />
                  </div>
                  <div className="col-span-2">
                    <Input
                      type="number"
                      step="0.01"
                      className="text-right"
                      value={line.unitPrice}
                      onChange={(e) => updateLine(index, 'unitPrice', Number(e.target.value))}
                    />
                  </div>
                  <div className="col-span-1 text-right">
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
              ))}

              <Button type="button" variant="outline" size="sm" onClick={addLine} className="mt-2">
                <Plus className="h-4 w-4 mr-2" /> Add Line
              </Button>

              <Separator />
              <div className="flex justify-end">
                <div className="text-lg font-semibold tabular-nums">
                  Total: {calculateTotal().toLocaleString()}
                </div>
              </div>
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
