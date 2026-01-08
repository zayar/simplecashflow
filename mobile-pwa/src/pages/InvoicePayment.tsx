import React, { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { getBankingAccounts, getInvoice, recordInvoicePayment, type BankingAccountRow } from '../lib/ar';
import { AppBar, BackIcon, IconButton } from '../components/AppBar';
import { Card } from '../components/ui/card';
import { Label } from '../components/ui/label';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { formatMMDDYYYY, toNumber, yyyyMmDd } from '../lib/format';

type Mode = 'CASH' | 'BANK' | 'E_WALLET';

function SelectNative(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
        props.className ?? ''
      }`}
    />
  );
}

export default function InvoicePayment() {
  const { user } = useAuth();
  const companyId = user?.companyId ?? 0;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams();
  const invoiceId = Number(params.id ?? 0);

  const invoiceQuery = useQuery({
    queryKey: ['invoice', companyId, invoiceId],
    queryFn: async () => await getInvoice(companyId, invoiceId),
    enabled: companyId > 0 && invoiceId > 0
  });

  const bankingQuery = useQuery({
    queryKey: ['banking-accounts', companyId],
    queryFn: async () => await getBankingAccounts(companyId),
    enabled: companyId > 0
  });

  const inv = invoiceQuery.data ?? null;
  const [paymentMode, setPaymentMode] = useState<Mode>('CASH');
  const [paymentDate, setPaymentDate] = useState<string>(yyyyMmDd(new Date()));
  const [amount, setAmount] = useState<string>('');
  const [bankAccountId, setBankAccountId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedProof, setSelectedProof] = useState<{ id?: string | null; url: string } | null>(null);

  React.useEffect(() => {
    if (!inv) return;
    const remaining =
      inv.remainingBalance !== undefined
        ? Number(inv.remainingBalance)
        : Math.max(0, toNumber(inv.total) - toNumber(inv.totalPaid ?? 0));
    if (!amount && remaining > 0) setAmount(String(remaining.toFixed(2)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inv]);

  const canPay = inv ? inv.status === 'POSTED' || inv.status === 'PARTIAL' : false;

  const filteredDepositAccounts = useMemo(() => {
    const rows = (bankingQuery.data ?? []) as BankingAccountRow[];
    return rows.filter((a) => {
      if (paymentMode === 'CASH') return a.kind === 'CASH';
      if (paymentMode === 'BANK') return a.kind === 'BANK';
      return a.kind === 'E_WALLET';
    });
  }, [bankingQuery.data, paymentMode]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!companyId || !invoiceId) return;
    setError(null);

    const amt = Number(amount);
    if (!amt || amt <= 0) return setError('Payment amount must be greater than 0');
    if (!bankAccountId) return setError('Please select Deposit To account');

    setIsSubmitting(true);
    try {
      await recordInvoicePayment(companyId, invoiceId, {
        paymentMode,
        paymentDate,
        amount: amt,
        bankAccountId: Number(bankAccountId),
        pendingProofId: selectedProof?.id ? String(selectedProof.id) : undefined,
        attachmentUrl: selectedProof?.id ? undefined : selectedProof?.url || undefined,
      });
      
      // Invalidate queries so the invoice detail page shows updated data
      await queryClient.invalidateQueries({ queryKey: ['invoice', companyId, invoiceId] });
      await queryClient.invalidateQueries({ queryKey: ['invoices', companyId] });
      
      // Reset state and navigate back to invoice detail
      setIsSubmitting(false);
      navigate(`/invoices/${invoiceId}`, { replace: true });
    } catch (err: any) {
      setError(err?.message ?? 'Failed to record payment');
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-dvh bg-background pb-24">
      <AppBar
        title="Record payment"
        left={
          <IconButton ariaLabel="Back" onClick={() => navigate(-1)}>
            <BackIcon />
          </IconButton>
        }
        right={<div className="h-10 w-10" />}
      />

      <div className="mx-auto max-w-xl px-3 pt-3">
        <Card className="rounded-2xl p-4 shadow-sm">
          {invoiceQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading invoice…</div>
          ) : invoiceQuery.isError || !inv ? (
            <div className="text-sm text-destructive">Failed to load invoice.</div>
          ) : (
            <div className="flex items-start justify-between">
              <div>
                <div className="text-lg font-semibold">{inv.invoiceNumber}</div>
                <div className="text-sm text-muted-foreground">{inv.customerName ?? 'No Client'}</div>
              </div>
              <div className="text-right">
                <div className="text-sm text-muted-foreground">Balance</div>
                <div className="text-base font-semibold">
                  {toNumber(inv.remainingBalance ?? Math.max(0, toNumber(inv.total) - toNumber(inv.totalPaid ?? 0))).toLocaleString()}
                </div>
              </div>
            </div>
          )}
        </Card>

        <Card className="mt-3 rounded-2xl p-4 shadow-sm">
          {!inv ? null : !canPay ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              {inv.status === 'DRAFT'
                ? 'Invoice must be posted before recording payments.'
                : 'Payments allowed only for POSTED or PARTIAL invoices.'}
            </div>
          ) : null}

          {/* Customer Payment Proofs */}
          {inv && Array.isArray((inv as any)?.pendingPaymentProofs) && (inv as any).pendingPaymentProofs.length > 0 && (
            <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-800">
                <span>📷</span> Customer Proofs
                <span className="rounded-full bg-amber-200 px-1.5 py-0.5 text-xs">
                  {(inv as any).pendingPaymentProofs.length}
                </span>
              </div>
              <p className="mb-2 text-xs text-amber-700">Select a proof to attach:</p>
              <div className="grid grid-cols-4 gap-2">
                {(inv as any).pendingPaymentProofs.map((proof: any, idx: number) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() =>
                      setSelectedProof((prev) => {
                        const same = prev && prev.url === proof.url && String(prev.id ?? '') === String(proof?.id ?? '');
                        return same ? null : { id: proof?.id ?? null, url: proof.url };
                      })
                    }
                    className={`relative aspect-square overflow-hidden rounded-lg border-2 ${
                      selectedProof?.url === proof.url && String(selectedProof?.id ?? '') === String(proof?.id ?? '')
                        ? 'border-blue-500 ring-2 ring-blue-200'
                        : 'border-gray-200'
                    }`}
                  >
                    <img
                      src={proof.url}
                      alt={`Proof ${idx + 1}`}
                      className="h-full w-full object-cover"
                    />
                    {selectedProof?.url === proof.url && String(selectedProof?.id ?? '') === String(proof?.id ?? '') && (
                      <div className="absolute inset-0 flex items-center justify-center bg-blue-500/20">
                        <span className="rounded-full bg-blue-500 p-0.5 text-white text-xs">✓</span>
                      </div>
                    )}
                  </button>
                ))}
              </div>
              {selectedProof && (
                <div className="mt-2 flex items-center justify-between text-xs text-green-700">
                  <span>✓ Proof selected</span>
                  <button type="button" onClick={() => setSelectedProof(null)} className="text-gray-500">
                    Clear
                  </button>
                </div>
              )}
            </div>
          )}

          <form onSubmit={onSubmit} className="mt-3 space-y-4">
            <div className="grid gap-2">
              <Label>Payment Mode</Label>
              <SelectNative
                disabled={!canPay || isSubmitting}
                value={paymentMode}
                onChange={(e) => {
                  setPaymentMode(e.target.value as Mode);
                  setBankAccountId('');
                }}
              >
                <option value="CASH">Cash</option>
                <option value="BANK">Bank</option>
                <option value="E_WALLET">E‑wallet</option>
              </SelectNative>
            </div>

            <div className="grid gap-2">
              <Label>Payment Date</Label>
              <Input
                type="date"
                required
                disabled={!canPay || isSubmitting}
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
              />
              <div className="text-xs text-muted-foreground">Selected: {formatMMDDYYYY(paymentDate)}</div>
            </div>

            <div className="grid gap-2">
              <Label>Amount</Label>
              <Input
                type="number"
                step="0.01"
                min="0.01"
                required
                disabled={!canPay || isSubmitting}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <Label>Deposit To</Label>
              <SelectNative
                required
                disabled={!canPay || isSubmitting}
                value={bankAccountId}
                onChange={(e) => setBankAccountId(e.target.value)}
              >
                <option value="">Select Account</option>
                {filteredDepositAccounts.map((row) => (
                  <option key={row.id} value={row.account.id}>
                    {row.account.code} - {row.account.name}
                  </option>
                ))}
              </SelectNative>
              <div className="text-xs text-muted-foreground">
                Uses the same “Deposit To” list as the web app (Banking accounts only).
              </div>
            </div>

            {error ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            <div className="flex gap-3 pt-2">
              <Button type="button" variant="outline" className="w-full" onClick={() => navigate(-1)} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button type="submit" className="w-full" disabled={!canPay || isSubmitting || !bankAccountId}>
                {isSubmitting ? 'Recording…' : 'Record Payment'}
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}


