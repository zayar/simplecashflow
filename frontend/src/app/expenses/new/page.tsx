'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { createBill, getAccounts, getVendors, postBill, fetchApi, Vendor, Account } from '@/lib/api';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { ArrowLeft, Search } from 'lucide-react';
import { SelectNative } from '@/components/ui/select-native';
import { Textarea } from '@/components/ui/textarea';
import { todayInTimeZone } from '@/lib/utils';

export default function NewBillPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [expenseAccounts, setExpenseAccounts] = useState<Account[]>([]);
  const [depositAccounts, setDepositAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const [form, setForm] = useState({
    vendorId: '',
    expenseDate: '',
    dueDate: '',
    description: '', // Maps to Notes
    amount: '',
    expenseAccountId: '',
    // IMPORTANT: backend expects bankAccountId = Chart of Accounts Account.id (ASSET),
    // not BankingAccount.id. We store the COA account id here.
    paidThroughAccountId: '',
    reference: '', // Will be prepended to description if present
    isTaxExclusive: true, // Placeholder for UI match
  });

  useEffect(() => {
    if (!user?.companyId) return;
    
    // Load vendors
    getVendors(user.companyId).then(setVendors).catch(console.error);
    
    // Load Expense accounts
    getAccounts(user.companyId).then((all) => {
      setExpenseAccounts(all.filter((a) => a.type === 'EXPENSE'));
    }).catch(console.error);

    // Load Banking accounts for "Paid Through"
    fetchApi(`/companies/${user.companyId}/banking-accounts`)
      .then(setDepositAccounts)
      .catch(console.error);
  }, [user?.companyId]);

  useEffect(() => {
    const tz = companySettings?.timeZone ?? 'Asia/Yangon';
    if (!form.expenseDate) {
      setForm((prev) => ({ ...prev, expenseDate: todayInTimeZone(tz) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companySettings?.timeZone]);

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
      // 1. Prepare description
      let fullDescription = form.description;
      if (form.reference) {
        fullDescription = `Ref: ${form.reference} - ${fullDescription}`;
      }
      if (!fullDescription.trim()) {
        fullDescription = 'Expense'; // Fallback
      }

      // 2. Create Bill (Draft)
      const bill = await createBill(user.companyId, {
        vendorId: form.vendorId ? Number(form.vendorId) : null,
        expenseDate: form.expenseDate,
        dueDate: form.dueDate || undefined, // If paying immediately, dueDate doesn't matter much but good to have
        description: fullDescription,
        amount,
        expenseAccountId: Number(form.expenseAccountId),
      });

      // 3. If Paid Through is selected, chain Post + Pay
      if (form.paidThroughAccountId) {
        // Validate selected account is a banking account (cash/bank/e-wallet) in this company
        const selected = depositAccounts.find((d: any) => d.account?.id?.toString() === form.paidThroughAccountId);
        if (!selected) throw new Error('Pay Through must be a banking account (create it under Banking first)');

        // Post as "paid immediately": Dr Expense / Cr Bank (no Accounts Payable)
        await postBill(user.companyId, bill.id, { bankAccountId: Number(form.paidThroughAccountId) });

        // Redirect to list (or stay on page if "Save and New", but currently just redirecting)
        router.push('/expenses');
      } else {
        // Just Draft
        router.push(`/expenses/${bill.id}`);
      }
    } catch (err: any) {
      console.error(err);
      alert(err.message || 'Failed to record expense');
    } finally {
      setLoading(false);
    }
  }

  // Filter deposit accounts based on simplistic assumptions or just show all
  // The backend supports CASH, BANK, E_WALLET. All are valid for "Paid Through".
  
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/expenses">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Record Expense</h1>
          <p className="text-sm text-muted-foreground">
            Record a new expense. Select &quot;Paid Through&quot; to pay immediately.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Expense Details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6 max-w-4xl">
            
            <div className="grid gap-6 md:grid-cols-2">
              {/* Left Column */}
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label>Date*</Label>
                  <Input 
                    type="date" 
                    required
                    value={form.expenseDate} 
                    onChange={(e) => setForm({ ...form, expenseDate: e.target.value })} 
                  />
                </div>

                <div className="grid gap-2">
                  <Label>Expense Account*</Label>
                  <SelectNative
                    value={form.expenseAccountId}
                    onChange={(e) => setForm({ ...form, expenseAccountId: e.target.value })}
                    required
                  >
                    <option value="">Select an account</option>
                    {expenseAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} - {a.name}
                      </option>
                    ))}
                  </SelectNative>
                </div>

                <div className="grid gap-2">
                  <Label>Amount*</Label>
                  <div className="flex gap-2">
                    <SelectNative className="w-[100px]" disabled>
                      <option>MMK</option>
                    </SelectNative>
                    <Input 
                      type="number" 
                      inputMode="numeric"
                      step="1" 
                      min="1" 
                      required 
                      value={form.amount} 
                      onChange={(e) => setForm({ ...form, amount: e.target.value })} 
                    />
                  </div>
                </div>

                <div className="flex items-center gap-4 text-sm">
                  <Label className="font-normal">Amount Is</Label>
                  <div className="flex items-center gap-2">
                    <input 
                      type="radio" 
                      id="tax_inc" 
                      name="tax_pref" 
                      checked={!form.isTaxExclusive} 
                      onChange={() => setForm({ ...form, isTaxExclusive: false })} 
                      disabled 
                    />
                    <label htmlFor="tax_inc" className="text-muted-foreground">Tax Inclusive</label>
                  </div>
                  <div className="flex items-center gap-2">
                    <input 
                      type="radio" 
                      id="tax_exc" 
                      name="tax_pref" 
                      checked={form.isTaxExclusive} 
                      onChange={() => setForm({ ...form, isTaxExclusive: true })} 
                      disabled 
                    />
                    <label htmlFor="tax_exc" className="text-muted-foreground">Tax Exclusive</label>
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label className="text-red-500">Paid Through* (Select to Pay Now)</Label>
                  <SelectNative
                    value={form.paidThroughAccountId}
                    onChange={(e) => setForm({ ...form, paidThroughAccountId: e.target.value })}
                  >
                    <option value="">(None - Create Draft Expense)</option>
                    {depositAccounts.map((acc: any) => (
                      <option key={acc.id} value={acc.account?.id}>
                        {acc.kind} - {acc.account.name} ({acc.account.code})
                      </option>
                    ))}
                  </SelectNative>
                  <p className="text-xs text-muted-foreground">
                    If selected, this will create a posted expense and record payment immediately.
                  </p>
                </div>
              </div>

              {/* Right Column */}
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label>Vendor</Label>
                  <div className="flex gap-2">
                    <SelectNative
                      value={form.vendorId}
                      onChange={(e) => setForm({ ...form, vendorId: e.target.value })}
                      className="flex-1"
                    >
                      <option value="">Select Vendor</option>
                      {vendors.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </SelectNative>
                    <Button type="button" size="icon" variant="outline">
                      <Search className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label>Reference#</Label>
                  <Input 
                    value={form.reference}
                    onChange={(e) => setForm({ ...form, reference: e.target.value })}
                    placeholder="e.g. INV-001"
                  />
                </div>

                <div className="grid gap-2">
                  <Label>Notes</Label>
                  <Textarea 
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    placeholder="Max. 500 characters"
                    className="min-h-[100px]"
                    required
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-6 border-t mt-6">
              <Button type="button" variant="outline" onClick={() => router.back()}>
                Cancel
              </Button>
              <Button type="submit" disabled={loading}>
                {loading 
                  ? 'Saving...' 
                  : (form.paidThroughAccountId ? 'Save (Record Expense)' : 'Save (Draft Expense)')
                }
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
