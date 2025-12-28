import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { getInvoice, postInvoice } from '../lib/ar';
import { AppBar, BackIcon, IconButton } from '../components/AppBar';
import { formatMMDDYYYY, formatMoneyK, toNumber } from '../lib/format';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';

export default function InvoiceDetail() {
  const { user } = useAuth();
  const companyId = user?.companyId ?? 0;
  const navigate = useNavigate();
  const params = useParams();
  const invoiceId = Number(params.id ?? 0);

  const invoiceQuery = useQuery({
    queryKey: ['invoice', companyId, invoiceId],
    queryFn: async () => await getInvoice(companyId, invoiceId),
    enabled: companyId > 0 && invoiceId > 0
  });

  const inv = invoiceQuery.data ?? null;
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

  return (
    <div className="min-h-dvh bg-background">
      <AppBar
        title="Invoice"
        left={
          <IconButton ariaLabel="Back" onClick={() => navigate(-1)}>
            <BackIcon />
          </IconButton>
        }
        right={<div className="h-10 w-10" />}
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
            <Card className="overflow-hidden rounded-2xl shadow-sm">
            <div className="flex items-start justify-between px-4 py-3">
              <div>
                <div className="text-2xl font-semibold tracking-tight">{inv.invoiceNumber}</div>
                <div className="mt-1 text-sm text-muted-foreground">{inv.customerName ?? 'No Client'}</div>
              </div>
              <div className="text-right">
                <div className="text-sm text-muted-foreground">{inv.status}</div>
                <div className="mt-1 text-sm text-muted-foreground">{formatMMDDYYYY(inv.invoiceDate)}</div>
              </div>
            </div>
            <div className="border-t border-border px-4 py-3">
              <div className="flex justify-between text-sm">
                <div className="text-muted-foreground">Sub Total</div>
                <div className="text-foreground">{formatMoneyK(grossSubtotal)}</div>
              </div>
              <div className="mt-2 flex justify-between text-sm">
                <div className="text-muted-foreground">Discount</div>
                <div className="text-foreground">{formatMoneyK(discountTotal)}</div>
              </div>
              <div className="mt-2 flex justify-between text-sm">
                <div className="text-muted-foreground">Tax</div>
                <div className="text-foreground">{formatMoneyK(taxAmount)}</div>
              </div>
              <div className="mt-2 flex justify-between text-sm font-semibold">
                <div className="text-foreground">Total</div>
                <div className="text-foreground">{formatMoneyK(inv.total)}</div>
              </div>
              <div className="mt-2 flex justify-between text-sm">
                <div className="text-muted-foreground">Payment Made</div>
                <div className="text-foreground">{formatMoneyK(paid)}</div>
              </div>
              <div className="mt-2 flex justify-between text-sm font-semibold">
                <div className="text-foreground">Balance Due</div>
                <div className="text-foreground">{formatMoneyK(balance)}</div>
              </div>
              {/* netSubtotal is shown implicitly; keep for debugging parity if needed */}
              <div className="mt-2 hidden text-xs text-muted-foreground">Net subtotal: {netSubtotal}</div>
            </div>

            {inv.lines?.length ? (
              <div className="border-t border-border">
                {inv.lines.map((l) => (
                  <div key={l.id} className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">{l.description ?? 'Line'}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {toNumber(l.quantity)} × {formatMoneyK(l.unitPrice)}
                        {toNumber((l as any).discountAmount ?? 0) > 0 ? `  •  Disc ${formatMoneyK((l as any).discountAmount)}` : ''}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-sm font-semibold text-foreground">
                      {formatMoneyK(
                        Math.max(
                          0,
                          toNumber(l.quantity) * toNumber(l.unitPrice) - toNumber((l as any).discountAmount ?? 0)
                        )
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            </Card>

            {/* Actions */}
            <Card className="rounded-2xl p-4 shadow-sm">
              {inv.status === 'DRAFT' ? (
                <Button
                  className="w-full"
                  onClick={async () => {
                    await postInvoice(companyId, invoiceId);
                    window.location.reload();
                  }}
                >
                  Post Invoice
                </Button>
              ) : null}

              <Button
                className={`${inv.status === 'DRAFT' ? 'mt-3' : ''} w-full`}
                variant={inv.status === 'DRAFT' ? 'outline' : 'default'}
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


