'use client';

import { useMemo, useState, useEffect } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi, getExchangeRates } from '@/lib/api';
import { useRouter, useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { ArrowLeft, DollarSign, Calendar, User, FileText } from 'lucide-react';
import Link from 'next/link';
import { SelectNative } from '@/components/ui/select-native';
import { Badge } from '@/components/ui/badge';
import { todayInTimeZone } from '@/lib/utils';
import { formatDateInTimeZone } from '@/lib/utils';

export default function RecordPaymentPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const params = useParams();
  const invoiceId = params.id;
  const tz = companySettings?.timeZone ?? 'Asia/Yangon';
  const baseCurrency = useMemo(() => {
    const cur = String(companySettings?.baseCurrency ?? '').trim().toUpperCase();
    return cur || null;
  }, [companySettings?.baseCurrency]);

  const [loading, setLoading] = useState(false);
  const [invoice, setInvoice] = useState<any>(null);
  const [depositAccounts, setDepositAccounts] = useState<any[]>([]);

  const customerCurrency = useMemo(() => {
    const cur = String(invoice?.customer?.currency ?? '').trim().toUpperCase();
    return cur || null;
  }, [invoice?.customer?.currency]);

  const isFxCustomer = useMemo(() => {
    return !!(baseCurrency && customerCurrency && baseCurrency !== customerCurrency);
  }, [baseCurrency, customerCurrency]);

  const [fxRateToBase, setFxRateToBase] = useState<number | null>(null);
  const [fxAsOfDate, setFxAsOfDate] = useState<string | null>(null);
  const [enterInCustomerCurrency, setEnterInCustomerCurrency] = useState(true);
  
  const [formData, setFormData] = useState({
    paymentMode: 'CASH' as 'CASH' | 'BANK' | 'E_WALLET',
    paymentDate: '',
    amount: '',
    bankAccountId: '',
  });

  // Selected payment proof attachment
  const [selectedPendingProofId, setSelectedPendingProofId] = useState<string | null>(null);
  const [selectedAttachmentUrl, setSelectedAttachmentUrl] = useState<string | null>(null); // legacy fallback

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

  // FX (display + entry helper): load latest rate for customer currency.
  useEffect(() => {
    if (!user?.companyId) return;
    if (!isFxCustomer || !customerCurrency) {
      setFxRateToBase(null);
      setFxAsOfDate(null);
      return;
    }
    let cancelled = false;
    getExchangeRates(user.companyId, customerCurrency)
      .then((rows) => {
        if (cancelled) return;
        const invoiceDateStr = String(invoice?.invoiceDate ?? '').slice(0, 10);
        const invoiceDate = invoiceDateStr ? new Date(invoiceDateStr) : null;
        const pick =
          (rows ?? []).find((r: any) => {
            if (!invoiceDate) return true;
            const d = new Date(String(r.asOfDate ?? ''));
            if (Number.isNaN(d.getTime())) return false;
            return d.getTime() <= invoiceDate.getTime();
          }) ?? (rows ?? [])[0];
        const rate = pick ? Number((pick as any).rateToBase) : 0;
        if (!pick || !Number.isFinite(rate) || rate <= 0) {
          setFxRateToBase(null);
          setFxAsOfDate(null);
          return;
        }
        setFxRateToBase(rate);
        setFxAsOfDate((pick as any).asOfDate ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setFxRateToBase(null);
        setFxAsOfDate(null);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.companyId, isFxCustomer, customerCurrency, invoice?.invoiceDate]);

  useEffect(() => {
    const tz = companySettings?.timeZone ?? 'Asia/Yangon';
    if (!formData.paymentDate) {
      setFormData((prev) => ({ ...prev, paymentDate: todayInTimeZone(tz) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companySettings?.timeZone]);

  // Auto-fill remaining balance when invoice loads
  useEffect(() => {
    if (invoice && invoice.remainingBalance > 0 && !formData.amount) {
      // If user wants to enter in customer currency, prefill converted amount.
      if (isFxCustomer && enterInCustomerCurrency && fxRateToBase && fxRateToBase > 0) {
        setFormData((prev) => ({ ...prev, amount: (invoice.remainingBalance / fxRateToBase).toFixed(2) }));
      } else {
        setFormData(prev => ({ ...prev, amount: invoice.remainingBalance.toFixed(2) }));
      }
    }
  }, [invoice, isFxCustomer, enterInCustomerCurrency, fxRateToBase]);

  const handleAmountChange = (value: string) => {
    const numValue = Number(value);
    const maxAmount = invoice ? invoice.remainingBalance : Infinity;

    // Always validate against remaining balance in BASE currency (backend posts in base).
    const baseAmt =
      isFxCustomer && enterInCustomerCurrency && fxRateToBase && fxRateToBase > 0 ? numValue * fxRateToBase : numValue;

    if (baseAmt > maxAmount) {
      alert(`Payment amount cannot exceed remaining balance of ${maxAmount.toLocaleString()} ${baseCurrency ?? ''}`.trim());
      const capped = isFxCustomer && enterInCustomerCurrency && fxRateToBase && fxRateToBase > 0 ? maxAmount / fxRateToBase : maxAmount;
      setFormData((prev) => ({ ...prev, amount: capped.toFixed(2) }));
    } else {
      setFormData((prev) => ({ ...prev, amount: value }));
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

    const baseAmount =
      isFxCustomer && enterInCustomerCurrency && fxRateToBase && fxRateToBase > 0 ? amount * fxRateToBase : amount;
    if (baseAmount > invoice.remainingBalance) {
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
          // Always send BASE currency amount to backend (ledger-safe).
          amount: baseAmount,
          bankAccountId: Number(formData.bankAccountId),
          // Optional attachment from customer-uploaded proofs:
          // Prefer stable proof id (server stores gs:// reference); fallback to legacy URL.
          pendingProofId: selectedPendingProofId || undefined,
          attachmentUrl: !selectedPendingProofId ? (selectedAttachmentUrl || undefined) : undefined,
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
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Record payment</h1>
            <p className="text-sm text-muted-foreground">Loading invoice details…</p>
          </div>
        </div>
        <Card className="shadow-sm">
          <CardContent className="pt-6">
            <p className="text-center text-muted-foreground">Loading invoice details...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const canPay = invoice.status === 'POSTED' || invoice.status === 'PARTIAL';
  const isFullyPaid = invoice.remainingBalance <= 0;
  const showFx = isFxCustomer && fxRateToBase && fxRateToBase > 0;
  const enteredNum = Number(formData.amount || 0);
  const baseEntered = showFx && enterInCustomerCurrency ? enteredNum * (fxRateToBase as number) : enteredNum;
  const maxDisplay = showFx && enterInCustomerCurrency ? invoice.remainingBalance / (fxRateToBase as number) : invoice.remainingBalance;

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
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Record payment</h1>
          <p className="text-sm text-muted-foreground">{invoice.invoiceNumber}</p>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Invoice Details */}
        <Card className="shadow-sm">
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
              <p>{formatDateInTimeZone(invoice.invoiceDate, tz)}</p>
            </div>

            {invoice.dueDate && (
              <div className="grid gap-2">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Calendar className="h-4 w-4" />
                  Due Date
                </div>
                <p>{formatDateInTimeZone(invoice.dueDate, tz)}</p>
              </div>
            )}

            <div className="pt-4 border-t space-y-2">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Invoice Total:</span>
                <span className="font-bold text-lg">
                  {Number(invoice.total).toLocaleString()}
                  {baseCurrency ? ` ${baseCurrency}` : ''}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total Paid:</span>
                <span className="font-medium text-green-600">{invoice.totalPaid.toLocaleString()}</span>
              </div>
              <div className="flex justify-between pt-2 border-t">
                <span className="font-semibold">Remaining Balance:</span>
                <span className={`font-bold text-lg ${invoice.remainingBalance > 0 ? 'text-orange-600' : 'text-green-600'}`}>
                  {invoice.remainingBalance.toLocaleString()}
                  {baseCurrency ? ` ${baseCurrency}` : ''}
                </span>
              </div>
            </div>

              {showFx ? (
                <div className="mt-2 rounded-md border bg-muted/30 p-3 text-sm">
                  <div>
                    <span className="text-muted-foreground">Customer currency:</span> <b>{customerCurrency}</b>
                    &nbsp;·&nbsp;
                    <span className="text-muted-foreground">Base currency:</span> <b>{baseCurrency}</b>
                  </div>
                  <div className="text-muted-foreground">
                    Exchange rate: <b>1 {customerCurrency} = {baseCurrency}{Number(fxRateToBase).toLocaleString()}</b>
                    {fxAsOfDate ? ` (as of ${String(fxAsOfDate).slice(0, 10)})` : ''}
                  </div>
                </div>
              ) : null}

            <div className="pt-2">
              <Badge variant="outline">{invoice.status}</Badge>
            </div>
          </CardContent>
        </Card>

        {/* Payment Form */}
        <Card className="shadow-sm">
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
                        {formatDateInTimeZone(payment.paymentDate, tz)} - {payment.bankAccount?.name}
                        {payment.attachmentUrl && <span className="ml-1">📎</span>}
                      </span>
                      <span className="font-medium">{Number(payment.amount).toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Customer-submitted payment proofs */}
            {Array.isArray(invoice?.pendingPaymentProofs) && invoice.pendingPaymentProofs.length > 0 && (
              <div className="mb-4 p-4 bg-amber-50 border border-amber-200 rounded-md">
                <p className="text-sm font-semibold mb-2 text-amber-800">
                  📷 Customer Payment Proofs ({invoice.pendingPaymentProofs.length})
                </p>
                <p className="text-xs text-amber-700 mb-3">
                  Select a proof to attach to this payment record:
                </p>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {invoice.pendingPaymentProofs.map((proof: any, idx: number) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => {
                        const pid = typeof proof?.id === 'string' ? proof.id : null;
                        if (pid) {
                          setSelectedPendingProofId((prev) => (prev === pid ? null : pid));
                          setSelectedAttachmentUrl(null);
                        } else {
                          const url = typeof proof?.url === 'string' ? proof.url : null;
                          setSelectedAttachmentUrl((prev) => (prev === url ? null : url));
                          setSelectedPendingProofId(null);
                        }
                      }}
                      className={`relative aspect-square overflow-hidden rounded-lg border-2 transition-all ${
                        (selectedPendingProofId && proof?.id === selectedPendingProofId) ||
                        (!selectedPendingProofId && selectedAttachmentUrl === proof.url)
                          ? 'border-blue-500 ring-2 ring-blue-200'
                          : 'border-gray-200 hover:border-amber-300'
                      }`}
                    >
                      <img
                        src={proof.url}
                        alt={`Proof ${idx + 1}`}
                        className="h-full w-full object-cover"
                      />
                      {((selectedPendingProofId && proof?.id === selectedPendingProofId) ||
                        (!selectedPendingProofId && selectedAttachmentUrl === proof.url)) && (
                        <div className="absolute inset-0 flex items-center justify-center bg-blue-500/20">
                          <div className="rounded-full bg-blue-500 p-1 text-white text-xs">✓</div>
                        </div>
                      )}
                    </button>
                  ))}
                </div>
                {(selectedPendingProofId || selectedAttachmentUrl) && (
                  <div className="mt-2 flex items-center justify-between text-xs">
                    <span className="text-green-700">✓ Proof selected</span>
                    <button
                      type="button"
                      onClick={() => { setSelectedAttachmentUrl(null); setSelectedPendingProofId(null); }}
                      className="text-gray-500 hover:text-gray-700"
                    >
                      Clear selection
                    </button>
                  </div>
                )}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="paymentMode">Payment Mode</Label>
                <SelectNative
                  id="paymentMode"
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
                </SelectNative>
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
                      (Max: {Number(maxDisplay).toLocaleString()}
                      {showFx && enterInCustomerCurrency ? ` ${customerCurrency}` : baseCurrency ? ` ${baseCurrency}` : ''})
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
                {showFx ? (
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <input
                        id="enterInCustomerCurrency"
                        type="checkbox"
                        checked={enterInCustomerCurrency}
                        onChange={() => setEnterInCustomerCurrency((p) => !p)}
                      />
                      <label htmlFor="enterInCustomerCurrency">
                        Enter amount in <b>{customerCurrency}</b>
                      </label>
                    </div>
                    <div>
                      Will record: <b>{Number(baseEntered || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</b>
                      {baseCurrency ? ` ${baseCurrency}` : ''}
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="grid gap-2">
                <Label htmlFor="bankAccount">Deposit To*</Label>
                <SelectNative
                  id="bankAccount"
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
                </SelectNative>
                <p className="text-xs text-muted-foreground">
                  Only accounts created under <b>Banking</b> can be used here (fintech safety).
                </p>
              </div>

              <div className="flex justify-end gap-4 pt-4">
                <Button type="button" variant="outline" onClick={() => router.back()} disabled={loading}>
                  Cancel
                </Button>
                <Button 
                  type="submit" 
                  loading={loading}
                  loadingText="Recording Payment..."
                  disabled={!canPay || isFullyPaid || !formData.bankAccountId}
                >
                  Record Payment
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
