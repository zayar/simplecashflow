'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { createBill, getAccounts, getVendors, Vendor, Account } from '@/lib/api';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { ArrowLeft } from 'lucide-react';
import { SelectNative } from '@/components/ui/select-native';

export default function NewBillPage() {
  const { user } = useAuth();
  const router = useRouter();

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [expenseAccounts, setExpenseAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);

  const [form, setForm] = useState({
    vendorId: '',
    expenseDate: new Date().toISOString().split('T')[0],
    dueDate: '',
    description: '',
    amount: '',
    expenseAccountId: '',
  });

  useEffect(() => {
    if (!user?.companyId) return;
    getVendors(user.companyId).then(setVendors).catch(console.error);
    getAccounts(user.companyId).then((all) => setExpenseAccounts(all.filter((a) => a.type === 'EXPENSE'))).catch(console.error);
  }, [user?.companyId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user?.companyId) return;

    const amount = Number(form.amount);
    if (!amount || amount <= 0) {
      alert('Amount must be > 0');
      return;
    }

    if (!form.expenseAccountId) {
      alert('Please select an expense account');
      return;
    }

    setLoading(true);
    try {
      const bill = await createBill(user.companyId, {
        vendorId: form.vendorId ? Number(form.vendorId) : null,
        expenseDate: form.expenseDate,
        dueDate: form.dueDate || undefined,
        description: form.description,
        amount,
        expenseAccountId: Number(form.expenseAccountId),
      });
      router.push(`/expenses/${bill.id}`);
    } catch (err: any) {
      alert(err.message || 'Failed to create bill');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/expenses">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">New Bill</h1>
          <p className="text-sm text-muted-foreground">
            Capture a bill, then post it to create AP.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Bill Details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4 max-w-2xl">
            <div className="grid gap-2">
              <Label>Vendor (optional)</Label>
              <SelectNative
                value={form.vendorId}
                onChange={(e) => setForm({ ...form, vendorId: e.target.value })}
              >
                <option value="">—</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </SelectNative>
              <p className="text-xs text-muted-foreground">
                Tip: create vendors under <b>Vendors</b>.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <Label>Bill Date</Label>
                <Input type="date" value={form.expenseDate} onChange={(e) => setForm({ ...form, expenseDate: e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label>Due Date (optional)</Label>
                <Input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
              </div>
            </div>

            <div className="grid gap-2">
              <Label>Description</Label>
              <Input required value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <Label>Expense Account</Label>
                <SelectNative
                  value={form.expenseAccountId}
                  onChange={(e) => setForm({ ...form, expenseAccountId: e.target.value })}
                  required
                >
                  <option value="">Select account</option>
                  {expenseAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} - {a.name}
                    </option>
                  ))}
                </SelectNative>
              </div>
              <div className="grid gap-2">
                <Label>Amount</Label>
                <Input type="number" step="0.01" min="0.01" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-4">
              <Button type="button" variant="outline" onClick={() => router.back()}>
                Cancel
              </Button>
              <Button type="submit" disabled={loading}>
                {loading ? 'Creating...' : 'Create Bill'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
