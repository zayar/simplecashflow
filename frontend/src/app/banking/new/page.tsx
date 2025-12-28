'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { ArrowLeft } from 'lucide-react';
import { SelectNative } from '@/components/ui/select-native';
import { Separator } from '@/components/ui/separator';

type Kind = 'CASH' | 'BANK' | 'E_WALLET' | 'CREDIT_CARD';

export default function NewBankingAccountPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const [form, setForm] = useState({
    kind: 'BANK' as Kind,
    accountName: '',
    accountCode: '',
    bankName: '',
    accountNumber: '',
    identifierCode: '',
    branch: '',
    description: '',
    isPrimary: false,
  });

  const showBankFields = useMemo(() => form.kind === 'BANK' || form.kind === 'E_WALLET', [form.kind]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.companyId) return;
    setLoading(true);
    try {
      await fetchApi(`/companies/${user.companyId}/banking-accounts`, {
        method: 'POST',
        body: JSON.stringify({
          kind: form.kind,
          accountName: form.accountName,
          accountCode: form.accountCode,
          bankName: form.bankName || undefined,
          accountNumber: form.accountNumber || undefined,
          identifierCode: form.identifierCode || undefined,
          branch: form.branch || undefined,
          description: form.description || undefined,
          isPrimary: form.isPrimary,
        }),
      });
      router.push('/banking');
    } catch (err: any) {
      console.error(err);
      alert(err.message || 'Failed to create banking account');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/banking">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">New Banking Account</h1>
          <p className="text-sm text-muted-foreground">
            Creates a deposit account + an ASSET account in your chart of accounts.
          </p>
        </div>
      </div>

      <Card className="max-w-xl shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="kind">Account Kind</Label>
              <SelectNative
                id="kind"
                value={form.kind}
                onChange={(e) => setForm({ ...form, kind: e.target.value as Kind })}
              >
                <option value="BANK">Bank</option>
                <option value="CASH">Cash</option>
                <option value="E_WALLET">E‑wallet</option>
                <option value="CREDIT_CARD">Credit Card (future)</option>
              </SelectNative>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="accountName">Account Name</Label>
              <Input
                id="accountName"
                required
                value={form.accountName}
                onChange={(e) => setForm({ ...form, accountName: e.target.value })}
                placeholder="e.g. KBZ Bank - Main"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="accountCode">Account Code</Label>
              <Input
                id="accountCode"
                required
                value={form.accountCode}
                onChange={(e) => setForm({ ...form, accountCode: e.target.value })}
                placeholder="e.g. 1010"
              />
              <p className="text-xs text-muted-foreground">
                Must be unique inside your company (Chart of Accounts rule).
              </p>
            </div>

            {showBankFields && <Separator />}
            {showBankFields && (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="bankName">Bank / Provider Name</Label>
                  <Input
                    id="bankName"
                    value={form.bankName}
                    onChange={(e) => setForm({ ...form, bankName: e.target.value })}
                    placeholder="e.g. KBZ / KPay / WavePay"
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="accountNumber">Account Number</Label>
                  <Input
                    id="accountNumber"
                    value={form.accountNumber}
                    onChange={(e) => setForm({ ...form, accountNumber: e.target.value })}
                    placeholder="Optional"
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="identifierCode">Identifier Code</Label>
                  <Input
                    id="identifierCode"
                    value={form.identifierCode}
                    onChange={(e) => setForm({ ...form, identifierCode: e.target.value })}
                    placeholder="Optional"
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="branch">Location</Label>
                  <Input
                    id="branch"
                    value={form.branch}
                    onChange={(e) => setForm({ ...form, branch: e.target.value })}
                    placeholder="Optional"
                  />
                </div>
              </>
            )}

            <div className="grid gap-2">
              <Label htmlFor="description">Notes</Label>
              <Input
                id="description"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Optional"
              />
            </div>

            <label className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={form.isPrimary}
                onChange={(e) => setForm({ ...form, isPrimary: e.target.checked })}
              />
              Make this primary
            </label>

            <div className="flex justify-end gap-4 pt-4">
              <Button type="button" variant="outline" onClick={() => router.back()}>
                Cancel
              </Button>
              <Button type="submit" disabled={loading}>
                {loading ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}


