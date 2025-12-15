'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { SelectNative } from '@/components/ui/select-native';

export default function NewItemPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [incomeAccounts, setIncomeAccounts] = useState<any[]>([]);
  
  const [formData, setFormData] = useState({
    name: '',
    sku: '',
    type: 'GOODS',
    sellingPrice: '',
    incomeAccountId: '',
  });

  useEffect(() => {
    if (user?.companyId) {
      // Fetch INCOME accounts for dropdown
      fetchApi(`/companies/${user.companyId}/accounts?type=INCOME`)
        .then(setIncomeAccounts)
        .catch(console.error);
    }
  }, [user?.companyId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.companyId) return;
    
    setLoading(true);
    try {
      await fetchApi(`/companies/${user.companyId}/items`, {
        method: 'POST',
        body: JSON.stringify({
          ...formData,
          sellingPrice: Number(formData.sellingPrice),
          incomeAccountId: Number(formData.incomeAccountId),
        }),
      });
      router.push('/items');
    } catch (err) {
      console.error(err);
      alert('Failed to create item');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">New Item</h1>
        <p className="text-sm text-muted-foreground">
          Create a product or service for invoicing.
        </p>
      </div>
      
      <Card className="max-w-2xl shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Item details</CardTitle>
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
                <Label htmlFor="sku">SKU</Label>
                <Input
                  id="sku"
                  value={formData.sku}
                  onChange={(e) => setFormData({ ...formData, sku: e.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="type">Type</Label>
                <SelectNative
                  id="type"
                  value={formData.type}
                  onChange={(e) => setFormData({ ...formData, type: e.target.value })}
                >
                  <option value="GOODS">Goods</option>
                  <option value="SERVICE">Service</option>
                </SelectNative>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="sellingPrice">Selling Price *</Label>
                <Input
                  id="sellingPrice"
                  type="number"
                  step="0.01"
                  required
                  value={formData.sellingPrice}
                  onChange={(e) => setFormData({ ...formData, sellingPrice: e.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="incomeAccount">Income Account *</Label>
                <SelectNative
                  id="incomeAccount"
                  required
                  value={formData.incomeAccountId}
                  onChange={(e) => setFormData({ ...formData, incomeAccountId: e.target.value })}
                >
                  <option value="">Select Account</option>
                  {incomeAccounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.code} - {acc.name}
                    </option>
                  ))}
                </SelectNative>
              </div>
            </div>

            <div className="flex justify-end gap-4 pt-4">
              <Button type="button" variant="outline" onClick={() => router.back()}>
                Cancel
              </Button>
              <Button type="submit" disabled={loading}>
                {loading ? 'Creating...' : 'Create Item'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
