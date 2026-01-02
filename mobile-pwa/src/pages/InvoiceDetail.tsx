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
      await queryClient.invalidateQueries({ queryKey: ['invoice', companyId, invoiceId] });
      await invoiceQuery.refetch();
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
          // User canceled share sheet — do not show as an error; fall back to copy.
          const name = String(e?.name ?? '');
          const msg = String(e?.message ?? '');
          if (name !== 'AbortError' && !msg.toLowerCase().includes('canceled')) throw e;
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

            {/* Actions */}
            <Card className="rounded-2xl p-4 shadow-sm">
              {inv.status === 'DRAFT' ? (
                <Button
                  className="w-full"
                  type="button"
                  disabled={postInvoiceMutation.isPending}
                  onClick={() => postInvoiceMutation.mutate()}
                >
                  {postInvoiceMutation.isPending ? 'Posting…' : 'Post Invoice'}
                </Button>
              ) : null}

              {actionError ? <div className="mt-3 text-sm text-destructive">{actionError}</div> : null}
              {shareError ? <div className="mt-3 text-sm text-destructive">{shareError}</div> : null}

              <Button
                className={`${inv.status === 'DRAFT' ? 'mt-3' : ''} w-full`}
                variant={inv.status === 'DRAFT' ? 'outline' : 'default'}
                type="button"
                onClick={() => navigate(`/invoices/${invoiceId}/payment`)}
              >
                Record Payment
              </Button>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}


