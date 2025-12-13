'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { useRouter, useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { ArrowLeft, DollarSign, Calendar, User, FileText } from 'lucide-react';
import Link from 'next/link';

export default function RecordPaymentPage() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useParams();
  const invoiceId = params.id;

  const [loading, setLoading] = useState(false);
  const [invoice, setInvoice] = useState<any>(null);
  const [depositAccounts, setDepositAccounts] = useState<any[]>([]);
  
  const [formData, setFormData] = useState({
    paymentMode: 'CASH' as 'CASH' | 'BANK' | 'E_WALLET',
    paymentDate: new Date().toISOString().split('T')[0],
    amount: '',
    bankAccountId: '',
  });

  const makeIdempotencyKey = () => {
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? (crypto as any).randomUUID()
      : `idem_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  };

  useEffect(() => {
    if (user?.companyId && invoiceId) {
      // Fetch invoice details
      fetchApi(`/companies/${user.companyId}/invoices/${invoiceId}`)
        .then(setInvoice)
        .catch((err) => {
          console.error(err);
          alert('Failed to load invoice details');
          router.push('/invoices');
        });

      // Fetch Banking deposit accounts (Cash/Bank/E-wallet) only
      fetchApi(`/companies/${user.companyId}/banking-accounts`)
        .then(setDepositAccounts)
        .catch(console.error);
    }
  }, [user?.companyId, invoiceId, router]);

  // Auto-fill remaining balance when invoice loads
  useEffect(() => {
    if (invoice && invoice.remainingBalance > 0 && !formData.amount) {
      setFormData(prev => ({ ...prev, amount: invoice.remainingBalance.toFixed(2) }));
    }
  }, [invoice]);

  const handleAmountChange = (value: string) => {
    const numValue = Number(value);
    const maxAmount = invoice ? invoice.remainingBalance : Infinity;
    
    if (numValue > maxAmount) {
      alert(`Payment amount cannot exceed remaining balance of ${maxAmount.toLocaleString()}`);
      setFormData(prev => ({ ...prev, amount: maxAmount.toFixed(2) }));
    } else {
      setFormData(prev => ({ ...prev, amount: value }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.companyId || !invoice) return;
    
    const amount = Number(formData.amount);
    if (amount <= 0) {
      alert('Payment amount must be greater than 0');
      return;
    }
    
    if (amount > invoice.remainingBalance) {
      alert(`Payment amount cannot exceed remaining balance of ${invoice.remainingBalance.toLocaleString()}`);
      return;
    }

    if (!formData.bankAccountId) {
      alert('Please select a bank/cash account');
      return;
    }
    
    setLoading(true);
    try {
      await fetchApi(`/companies/${user.companyId}/invoices/${invoiceId}/payments`, {
        method: 'POST',
        headers: {
          'Idempotency-Key': makeIdempotencyKey(),
        },
        body: JSON.stringify({
          paymentMode: formData.paymentMode,
          paymentDate: formData.paymentDate,
          amount: amount,
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

  if (!invoice) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/invoices">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Record Payment</h1>
        </div>
        <Card>
          <CardContent className="pt-6">
            <p className="text-center text-muted-foreground">Loading invoice details...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const canPay = invoice.status === 'POSTED' || invoice.status === 'PARTIAL';
  const isFullyPaid = invoice.remainingBalance <= 0;

  const filteredDepositAccounts = depositAccounts.filter((a: any) => {
    if (formData.paymentMode === 'CASH') return a.kind === 'CASH';
    if (formData.paymentMode === 'BANK') return a.kind === 'BANK';
    return a.kind === 'E_WALLET';
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/invoices">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">Record Payment</h1>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Invoice Details */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Invoice Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FileText className="h-4 w-4" />
                Invoice Number
              </div>
              <p className="font-semibold">{invoice.invoiceNumber}</p>
            </div>

            <div className="grid gap-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <User className="h-4 w-4" />
                Customer
              </div>
              <p className="font-medium">{invoice.customer?.name || 'N/A'}</p>
            </div>

            <div className="grid gap-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Calendar className="h-4 w-4" />
                Invoice Date
              </div>
              <p>{new Date(invoice.invoiceDate).toLocaleDateString()}</p>
            </div>

            {invoice.dueDate && (
              <div className="grid gap-2">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Calendar className="h-4 w-4" />
                  Due Date
                </div>
                <p>{new Date(invoice.dueDate).toLocaleDateString()}</p>
              </div>
            )}

            <div className="pt-4 border-t space-y-2">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Invoice Total:</span>
                <span className="font-bold text-lg">{Number(invoice.total).toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total Paid:</span>
                <span className="font-medium text-green-600">{invoice.totalPaid.toLocaleString()}</span>
              </div>
              <div className="flex justify-between pt-2 border-t">
                <span className="font-semibold">Remaining Balance:</span>
                <span className={`font-bold text-lg ${invoice.remainingBalance > 0 ? 'text-orange-600' : 'text-green-600'}`}>
                  {invoice.remainingBalance.toLocaleString()}
                </span>
              </div>
            </div>

            <div className="pt-2">
              <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                invoice.status === 'POSTED' ? 'bg-green-100 text-green-800' :
                invoice.status === 'PAID' ? 'bg-blue-100 text-blue-800' :
                invoice.status === 'PARTIAL' ? 'bg-yellow-100 text-yellow-800' :
                'bg-gray-100 text-gray-800'
              }`}>
                {invoice.status}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Payment Form */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <DollarSign className="h-5 w-5" />
              Payment Details
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!canPay && (
              <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-md">
                <p className="text-sm text-yellow-800">
                  {invoice.status === 'DRAFT' 
                    ? 'Invoice must be posted before recording payments.'
                    : 'This invoice cannot receive payments.'}
                </p>
              </div>
            )}

            {isFullyPaid && (
              <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-md">
                <p className="text-sm text-green-800 font-medium">
                  ✓ This invoice is fully paid.
                </p>
              </div>
            )}

            {invoice.payments && invoice.payments.length > 0 && (
              <div className="mb-4 p-4 bg-gray-50 rounded-md">
                <p className="text-sm font-semibold mb-2">Payment History:</p>
                <div className="space-y-2">
                  {invoice.payments.map((payment: any) => (
                    <div key={payment.id} className="flex justify-between text-sm">
                      <span className="text-muted-foreground">
                        {new Date(payment.paymentDate).toLocaleDateString()} - {payment.bankAccount?.name}
                      </span>
                      <span className="font-medium">{Number(payment.amount).toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="paymentMode">Payment Mode</Label>
                <select
                  id="paymentMode"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!canPay || isFullyPaid}
                  value={formData.paymentMode}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      paymentMode: e.target.value as any,
                      bankAccountId: '',
                    }))
                  }
                >
                  <option value="CASH">Cash</option>
                  <option value="BANK">Bank</option>
                  <option value="E_WALLET">E‑wallet</option>
                </select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="paymentDate">Payment Date</Label>
                <Input
                  id="paymentDate"
                  type="date"
                  required
                  value={formData.paymentDate}
                  onChange={(e) => setFormData({ ...formData, paymentDate: e.target.value })}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="amount">
                  Amount
                  {invoice.remainingBalance > 0 && (
                    <span className="text-xs text-muted-foreground ml-2">
                      (Max: {invoice.remainingBalance.toLocaleString()})
                    </span>
                  )}
                </Label>
                <Input
                  id="amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  max={invoice.remainingBalance}
                  required
                  disabled={!canPay || isFullyPaid}
                  value={formData.amount}
                  onChange={(e) => handleAmountChange(e.target.value)}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="bankAccount">Deposit To*</Label>
                <select
                  id="bankAccount"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  required
                  disabled={!canPay || isFullyPaid}
                  value={formData.bankAccountId}
                  onChange={(e) => setFormData({ ...formData, bankAccountId: e.target.value })}
                >
                  <option value="">Select Account</option>
                  {filteredDepositAccounts.map((row: any) => (
                    <option key={`${row.id}-${row.account?.id ?? ''}`} value={row.account.id}>
                      {row.account.code} - {row.account.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Only accounts created under <b>Banking</b> can be used here (fintech safety).
                </p>
              </div>

              <div className="flex justify-end gap-4 pt-4">
                <Button type="button" variant="outline" onClick={() => router.back()}>
                  Cancel
                </Button>
                <Button 
                  type="submit" 
                  disabled={loading || !canPay || isFullyPaid || !formData.bankAccountId}
                >
                  {loading ? 'Recording Payment...' : 'Record Payment'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
