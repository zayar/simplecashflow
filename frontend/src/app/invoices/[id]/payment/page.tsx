'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { useRouter, useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';

export default function RecordPaymentPage() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useParams();
  const invoiceId = params.id;

  const [loading, setLoading] = useState(false);
  const [bankAccounts, setBankAccounts] = useState<any[]>([]);
  
  const [formData, setFormData] = useState({
    paymentDate: new Date().toISOString().split('T')[0],
    amount: '',
    bankAccountId: '',
  });

  useEffect(() => {
    if (user?.companyId) {
      // Fetch ASSET accounts (Bank/Cash)
      fetchApi(`/companies/${user.companyId}/accounts?type=ASSET`)
        .then(setBankAccounts)
        .catch(console.error);
    }
  }, [user?.companyId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.companyId) return;
    
    setLoading(true);
    try {
      await fetchApi(`/companies/${user.companyId}/invoices/${invoiceId}/payments`, {
        method: 'POST',
        body: JSON.stringify({
          paymentDate: formData.paymentDate,
          amount: Number(formData.amount),
          bankAccountId: Number(formData.bankAccountId),
        }),
      });
      router.push('/invoices');
    } catch (err: any) {
      console.error(err);
      alert(err.message || 'Failed to record payment');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Record Payment</h1>
      
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>Payment Details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="paymentDate">Date</Label>
              <Input
                id="paymentDate"
                type="date"
                required
                value={formData.paymentDate}
                onChange={(e) => setFormData({ ...formData, paymentDate: e.target.value })}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="amount">Amount</Label>
              <Input
                id="amount"
                type="number"
                step="0.01"
                required
                value={formData.amount}
                onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="bankAccount">Deposit To (Bank/Cash)</Label>
              <select
                id="bankAccount"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                required
                value={formData.bankAccountId}
                onChange={(e) => setFormData({ ...formData, bankAccountId: e.target.value })}
              >
                <option value="">Select Account</option>
                {bankAccounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.code} - {acc.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex justify-end gap-4 pt-4">
              <Button type="button" variant="outline" onClick={() => router.back()}>
                Cancel
              </Button>
              <Button type="submit" disabled={loading}>
                {loading ? 'Recording...' : 'Record Payment'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
