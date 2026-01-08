import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { createPublicInvoiceLink, getCompanySettings, getInvoice, getInvoiceTemplate, postInvoice } from '../lib/ar';
import { AppBar, BackIcon, IconButton } from '../components/AppBar';
import { formatMMDDYYYY, formatMoneyK, toNumber } from '../lib/format';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { InvoicePaper } from '../components/invoice/InvoicePaper';
import { setInvoiceDraft } from '../lib/invoiceDraft';

export default function InvoiceDetail() {
  const { user } = useAuth();
  const companyId = user?.companyId ?? 0;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams();
  const invoiceId = Number(params.id ?? 0);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [shareError, setShareError] = React.useState<string | null>(null);

  const invoiceQuery = useQuery({
    queryKey: ['invoice', companyId, invoiceId],
    queryFn: async () => await getInvoice(companyId, invoiceId),
    enabled: companyId > 0 && invoiceId > 0
  });

  const settingsQuery = useQuery({
    queryKey: ['company-settings', companyId],
    queryFn: async () => await getCompanySettings(companyId),
    enabled: companyId > 0,
  });

  const templateQuery = useQuery({
    queryKey: ['invoice-template', companyId],
    queryFn: async () => await getInvoiceTemplate(companyId),
    enabled: companyId > 0,
  });

  const postInvoiceMutation = useMutation({
    mutationFn: async () => {
      if (companyId <= 0 || invoiceId <= 0) throw new Error('Missing company or invoice id.');
      return await postInvoice(companyId, invoiceId);
    },
    onMutate: () => {
      setActionError(null);
    },
    onSuccess: async () => {
      // Invalidate and refetch the invoice data to update the UI
      try {
        await queryClient.invalidateQueries({ queryKey: ['invoice', companyId, invoiceId] });
        await queryClient.invalidateQueries({ queryKey: ['invoices', companyId] });
        await invoiceQuery.refetch();
      } catch (e) {
        // If refetch fails, at least the mutation succeeded - user can refresh
        console.warn('Refetch after post failed:', e);
      }
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : 'Failed to post invoice.';
      setActionError(msg);
      // Minimal UX for mobile: ensure user sees something even if the card is off-screen.
      if (typeof window !== 'undefined') window.alert(msg);
    }
  });

  const inv = invoiceQuery.data ?? null;
  const companyName = settingsQuery.data?.name ?? 'Company';
  const tz = settingsQuery.data?.timeZone ?? null;
  const template = templateQuery.data ?? null;

  const discountTotal = React.useMemo(() => {
    if (!inv?.lines?.length) return 0;
    return inv.lines.reduce((sum, l: any) => sum + toNumber(l.discountAmount ?? 0), 0);
  }, [inv?.lines]);

  const grossSubtotal = React.useMemo(() => {
    if (!inv?.lines?.length) return 0;
    return inv.lines.reduce((sum, l: any) => sum + toNumber(l.quantity) * toNumber(l.unitPrice), 0);
  }, [inv?.lines]);

  const netSubtotal = React.useMemo(() => {
    // Prefer backend subtotal when present (source of truth), otherwise compute.
    const s = inv ? toNumber((inv as any).subtotal ?? 0) : 0;
    return s > 0 ? s : Math.max(0, grossSubtotal - discountTotal);
  }, [inv, grossSubtotal, discountTotal]);

  const taxAmount = React.useMemo(() => {
    return inv ? toNumber((inv as any).taxAmount ?? 0) : 0;
  }, [inv]);

  const paid = React.useMemo(() => {
    return inv ? toNumber((inv as any).totalPaid ?? (inv as any).amountPaid ?? 0) : 0;
  }, [inv]);

  const balance = React.useMemo(() => {
    if (!inv) return 0;
    const b = (inv as any).remainingBalance;
    if (b !== undefined && b !== null) return Math.max(0, Number(b));
    return Math.max(0, toNumber(inv.total) - paid);
  }, [inv, paid]);

  async function shareInvoiceLink() {
    setShareError(null);
    try {
      if (typeof window === 'undefined') return;
      const title = inv?.invoiceNumber ? `Invoice ${inv.invoiceNumber}` : 'Invoice';
      const text = inv?.customerName ? `Invoice for ${inv.customerName}` : 'Invoice link';

      // Preferred: public customer link (no login).
      let url = `${window.location.origin}/invoices/${invoiceId}`;
      if (companyId > 0 && invoiceId > 0) {
        const { token } = await createPublicInvoiceLink(companyId, invoiceId);
        url = `${window.location.origin}/public/invoices/${encodeURIComponent(token)}`;
      }

      if (navigator.share) {
        try {
          await navigator.share({ title, text, url });
          return;
        } catch (e: any) {
          // Some browsers (notably iOS Safari / in-app browsers) expose Web Share but block it
          // in certain contexts, throwing e.g. "The request is not allowed by the user agent...".
          // Treat these as "share not available" and fall back to copy/prompt silently.
          const name = String(e?.name ?? '');
          const msg = String(e?.message ?? '').toLowerCase();
          const isUserCancel = name === 'AbortError' || msg.includes('canceled') || msg.includes('cancelled');
          const isBlocked =
            name === 'NotAllowedError' ||
            name === 'SecurityError' ||
            msg.includes('not allowed') ||
            msg.includes('user agent') ||
            msg.includes('denied permission');
          if (!isUserCancel && !isBlocked) throw e;
        }
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        window.alert('Invoice link copied.');
        return;
      }
      window.prompt('Copy invoice link:', url);
    } catch (e) {
      setShareError(e instanceof Error ? e.message : 'Failed to share link.');
    }
  }

  return (
    <div className="min-h-dvh bg-background">
      <AppBar
        title="Invoice"
        left={
          <IconButton ariaLabel="Back" onClick={() => navigate(-1)}>
            <BackIcon />
          </IconButton>
        }
        right={
          <IconButton ariaLabel="Share" onClick={shareInvoiceLink}>
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M16 6l-4-4-4 4" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 2v14" />
            </svg>
          </IconButton>
        }
      />

      <div className="mx-auto max-w-xl px-3 py-3">
        {invoiceQuery.isLoading ? (
          <Card className="rounded-2xl p-4 text-sm text-muted-foreground shadow-sm">Loading…</Card>
        ) : invoiceQuery.isError ? (
          <Card className="rounded-2xl p-4 text-sm text-destructive shadow-sm">Failed to load invoice.</Card>
        ) : !inv ? (
          <Card className="rounded-2xl p-4 text-sm text-muted-foreground shadow-sm">Not found.</Card>
        ) : (
          <div className="space-y-3">
            {/* Real invoice preview (same idea as web "InvoicePaper") */}
            <Card className="overflow-hidden rounded-2xl shadow-sm">
              <InvoicePaper
                invoice={{
                  invoiceNumber: inv.invoiceNumber,
                  status: inv.status,
                  invoiceDate: inv.invoiceDate,
                  dueDate: inv.dueDate,
                  currency: (inv as any).currency ?? null,
                  total: inv.total,
                  totalPaid: (inv as any).totalPaid ?? (inv as any).amountPaid ?? 0,
                  remainingBalance: (inv as any).remainingBalance ?? balance,
                  customer: { name: inv.customerName ?? null },
                  location: null,
                  warehouse: null,
                  customerNotes: (inv as any).customerNotes ?? null,
                  termsAndConditions: (inv as any).termsAndConditions ?? null,
                  taxAmount: (inv as any).taxAmount ?? 0,
                  lines: (inv.lines ?? []).map((l: any) => ({
                    id: l.id,
                    quantity: l.quantity,
                    unitPrice: l.unitPrice,
                    discountAmount: (l as any).discountAmount ?? 0,
                    description: l.description ?? null,
                    item: null,
                  })),
                }}
                companyName={companyName}
                tz={tz}
                template={template as any}
              />
            </Card>

            {/* Customer Payment Proofs */}
            {Array.isArray((inv as any)?.pendingPaymentProofs) && (inv as any).pendingPaymentProofs.length > 0 && (
              <Card className="rounded-2xl border-amber-200 bg-amber-50/50 p-4 shadow-sm">
                <div className="mb-3 flex items-center gap-2">
                  <span className="text-lg">📷</span>
                  <span className="font-medium text-amber-800">Customer Payment Proofs</span>
                  <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-medium text-amber-800">
                    {(inv as any).pendingPaymentProofs.length}
                  </span>
                </div>
                <p className="mb-3 text-xs text-amber-700">
                  Your customer has uploaded payment screenshots. Tap to view, then record the payment.
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {(inv as any).pendingPaymentProofs.map((proof: any, idx: number) => (
                    <a
                      key={idx}
                      href={proof.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="aspect-square overflow-hidden rounded-lg border-2 border-amber-200 bg-white"
                    >
                      <img
                        src={proof.url}
                        alt={`Proof ${idx + 1}`}
                        className="h-full w-full object-cover"
                      />
                    </a>
                  ))}
                </div>
              </Card>
            )}

            {/* Actions */}
            <Card className="rounded-2xl p-4 shadow-sm">
              {inv.status === 'DRAFT' ? (
                <Button
                  className="w-full"
                  type="button"
                  variant="outline"
                  onClick={() => {
                    if (!inv) return;

                    const toYyyyMmDd = (s: any): string => {
                      const str = String(s ?? '');
                      if (!str) return '';
                      return str.length >= 10 ? str.slice(0, 10) : str;
                    };

                    const lines = (inv.lines ?? []).map((l: any) => {
                      const rawDesc = String(l.description ?? '').trim();
                      const [first, ...rest] = rawDesc.split('\n');
                      const title = first?.trim() || null;
                      const details = rest.join('\n').trim() || null;
                      return {
                        itemId: l.itemId ?? null,
                        itemName: title,
                        description: details,
                        quantity: Math.max(1, Math.floor(toNumber(l.quantity))),
                        unitPrice: Math.max(0, toNumber(l.unitPrice)),
                        discountAmount: Math.max(0, toNumber(l.discountAmount ?? 0)),
                        taxRate: Math.max(0, toNumber(l.taxRate ?? 0)),
                      };
                    });

                    setInvoiceDraft({
                      returnTo: null,
                      editingInvoiceId: invoiceId,
                      customerId: inv.customerId ?? null,
                      customerName: inv.customerName ?? null,
                      invoiceDate: toYyyyMmDd(inv.invoiceDate),
                      dueDate: inv.dueDate ? toYyyyMmDd(inv.dueDate) : null,
                      lines: lines.length ? lines : [{ quantity: 1, unitPrice: 0 }],
                      activeLineIndex: null,
                    });

                    navigate('/invoices/new?edit=1');
                  }}
                >
                  Edit Draft
                </Button>
              ) : null}

              {inv.status === 'DRAFT' ? (
                <Button
                  className="mt-3 w-full"
                  type="button"
                  disabled={postInvoiceMutation.isPending}
                  onClick={() => postInvoiceMutation.mutate()}
                >
                  {postInvoiceMutation.isPending ? 'Posting…' : 'Post Invoice'}
                </Button>
              ) : null}

              {actionError ? <div className="mt-3 text-sm text-destructive">{actionError}</div> : null}
              {shareError ? <div className="mt-3 text-sm text-destructive">{shareError}</div> : null}

              {/* Only show Record Payment for invoices that can still receive payments */}
              {inv.status !== 'PAID' && inv.status !== 'VOID' ? (
                <Button
                  className={`${inv.status === 'DRAFT' ? 'mt-3' : ''} w-full`}
                  variant={inv.status === 'DRAFT' ? 'outline' : 'default'}
                  type="button"
                  onClick={() => navigate(`/invoices/${invoiceId}/payment`)}
                >
                  Record Payment
                </Button>
              ) : null}

              {/* Show paid status indicator when fully paid */}
              {inv.status === 'PAID' ? (
                <div className="flex items-center justify-center gap-2 rounded-xl bg-green-50 p-3 text-green-700">
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="font-medium">Fully Paid</span>
                </div>
              ) : null}
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}


