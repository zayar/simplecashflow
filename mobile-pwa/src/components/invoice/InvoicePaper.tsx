import React from 'react';

export type InvoiceTemplate = {
  version: 1;
  logoUrl: string | null;
  accentColor: string;
  fontFamily: string;
  headerText: string | null;
  footerText: string | null;
  tableHeaderBg: string;
  tableHeaderText: string;
};

type InvoiceLike = {
  invoiceNumber: string;
  status: string;
  invoiceDate: string | Date;
  dueDate?: string | Date | null;
  currency?: string | null;
  total?: any;
  totalPaid?: any;
  remainingBalance?: any;
  customer?: { name?: string | null } | null;
  location?: { name?: string | null } | null;
  warehouse?: { name?: string | null } | null;
  customerNotes?: string | null;
  termsAndConditions?: string | null;
  taxAmount?: any;
  lines?: Array<{
    id?: number | string;
    quantity?: any;
    unitPrice?: any;
    discountAmount?: any;
    description?: string | null;
    item?: { name?: string | null } | null;
  }>;
};

const DEFAULT_TEMPLATE: InvoiceTemplate = {
  version: 1,
  logoUrl: null,
  accentColor: '#2F81B7',
  fontFamily: 'Inter',
  headerText: null,
  footerText: null,
  tableHeaderBg: '#2F81B7',
  tableHeaderText: '#FFFFFF',
};

function formatMoney(n: any) {
  const num = Number(n ?? 0);
  if (Number.isNaN(num)) return String(n ?? '');
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatMoneyWithCurrency(n: any, currency?: string | null) {
  const cur = String(currency ?? '').trim();
  return cur ? `${cur}${formatMoney(n)}` : formatMoney(n);
}

function formatDateInTimeZone(isoLike: any, tz?: string | null) {
  const d = new Date(isoLike);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz && String(tz).trim() ? String(tz) : undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }
}

function statusLabel(status: string) {
  const s = String(status ?? '').toUpperCase();
  if (!s) return '—';
  return s.slice(0, 1) + s.slice(1).toLowerCase();
}

export function InvoicePaper({
  invoice,
  companyName,
  tz,
  template,
}: {
  invoice: InvoiceLike;
  companyName: string;
  tz: string | null;
  template: InvoiceTemplate | null;
}) {
  const t: InvoiceTemplate = template ?? DEFAULT_TEMPLATE;

  const invoiceLines = (invoice.lines ?? []) as any[];
  const grossSubtotal = invoiceLines.reduce((sum: number, l: any) => {
    const qty = Number(l.quantity ?? 0);
    const rate = Number(l.unitPrice ?? 0);
    return sum + qty * rate;
  }, 0);
  const discountTotal = invoiceLines.reduce((sum: number, l: any) => {
    return sum + Math.max(0, Number(l.discountAmount ?? 0));
  }, 0);
  const taxAmount = Number((invoice as any).taxAmount ?? 0);

  const rootStyle: React.CSSProperties = { fontFamily: t.fontFamily };
  const headStyle: React.CSSProperties = { backgroundColor: t.tableHeaderBg, color: t.tableHeaderText };

  return (
    <div className="bg-white" style={rootStyle}>
      <div className="p-5">
        {/* Header */}
        <div className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              {t.logoUrl ? (
                // eslint-disable-next-line jsx-a11y/alt-text
                <img src={t.logoUrl} className="mb-3 h-12 w-auto max-w-[180px] object-contain" />
              ) : null}
              <div className="text-lg font-semibold tracking-tight" style={{ color: t.accentColor }}>
                {companyName}
              </div>
              {(t.headerText ?? '').trim() ? (
                <div className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{t.headerText}</div>
              ) : (
                <div className="mt-1 text-xs text-muted-foreground">
                  <div>Address line (optional)</div>
                  <div>City, Country</div>
                </div>
              )}
            </div>

            <div className="shrink-0 text-right">
              <div className="text-2xl font-semibold tracking-tight" style={{ color: t.accentColor }}>
                Invoice
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                <div className="font-medium text-foreground">#{invoice.invoiceNumber}</div>
                <div className="mt-1 inline-flex rounded-full border px-2 py-0.5 text-[11px]">
                  {statusLabel(invoice.status)}
                </div>
              </div>
              <div className="mt-3 rounded-md bg-slate-50 p-3 text-xs">
                <div className="text-[11px] font-medium text-muted-foreground">Balance Due</div>
                <div className="mt-1 text-base font-semibold tabular-nums">
                  {formatMoneyWithCurrency((invoice as any).remainingBalance, invoice.currency ?? undefined)}
                </div>
              </div>
            </div>
          </div>

          <div className="border-t" />

          {/* Bill to + meta */}
          <div className="grid gap-4">
            <div className="space-y-1">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Bill To</div>
              <div className="text-sm font-semibold">{invoice.customer?.name ?? '—'}</div>
              <div className="text-xs text-muted-foreground">Customer address (optional)</div>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <div className="text-muted-foreground">Invoice Date</div>
              <div className="font-medium">{formatDateInTimeZone(invoice.invoiceDate as any, tz)}</div>
              <div className="text-muted-foreground">Due Date</div>
              <div className="font-medium">{invoice.dueDate ? formatDateInTimeZone(invoice.dueDate as any, tz) : '—'}</div>
              <div className="text-muted-foreground">Location</div>
              <div className="font-medium">{invoice.location?.name ?? invoice.warehouse?.name ?? '—'}</div>
              <div className="text-muted-foreground">Terms</div>
              <div className="font-medium">{invoice.dueDate ? 'Net' : '—'}</div>
            </div>
          </div>

          <div className="border-t" />

          {/* Lines */}
          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-xs">
              <thead style={headStyle}>
                <tr>
                  <th className="px-3 py-2 text-left font-medium">#</th>
                  <th className="px-3 py-2 text-left font-medium">Item</th>
                  <th className="px-3 py-2 text-right font-medium">Qty</th>
                  <th className="px-3 py-2 text-right font-medium">Rate</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {invoiceLines.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-10 text-center text-muted-foreground">
                      No invoice lines.
                    </td>
                  </tr>
                ) : (
                  invoiceLines.map((l: any, idx: number) => {
                    const qty = Number(l.quantity ?? 0);
                    const rate = Number(l.unitPrice ?? 0);
                    const discount = Math.max(0, Number(l.discountAmount ?? 0));
                    const amount = Math.max(0, qty * rate - discount);
                    const itemName = l.item?.name ?? (l.description ?? '—');
                    const desc = String(l.description ?? '').trim();
                    const showDesc = Boolean(desc && l.item?.name && desc !== l.item.name);
                    return (
                      <tr key={l.id ?? idx} className={idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'}>
                        <td className="px-3 py-2 text-muted-foreground">{idx + 1}</td>
                        <td className="px-3 py-2">
                          <div className="font-medium text-slate-900">{itemName}</div>
                          {showDesc ? <div className="mt-0.5 text-[11px] text-muted-foreground">{desc}</div> : null}
                          {discount > 0 ? (
                            <div className="mt-0.5 text-[11px] text-muted-foreground">
                              Discount: {formatMoneyWithCurrency(discount, invoice.currency ?? undefined)}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums">{formatMoney(qty)}</td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums">
                          {formatMoneyWithCurrency(rate, invoice.currency ?? undefined)}
                        </td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums">
                          {formatMoneyWithCurrency(amount, invoice.currency ?? undefined)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="grid gap-4">
            <div className="space-y-3 text-xs text-muted-foreground">
              {(invoice.customerNotes ?? '').trim() ? (
                <div>
                  <div className="font-medium text-slate-900">Customer Notes</div>
                  <div className="mt-1 whitespace-pre-wrap">{invoice.customerNotes}</div>
                </div>
              ) : null}

              {(invoice.termsAndConditions ?? '').trim() ? (
                <div>
                  <div className="font-medium text-slate-900">Terms &amp; Conditions</div>
                  <div className="mt-1 whitespace-pre-wrap">{invoice.termsAndConditions}</div>
                </div>
              ) : null}
            </div>

            <div className="ml-auto w-full max-w-sm space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Sub Total</span>
                <span className="font-medium tabular-nums">
                  {formatMoneyWithCurrency(grossSubtotal, invoice.currency ?? undefined)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Discount</span>
                <span className="font-medium tabular-nums">
                  {formatMoneyWithCurrency(discountTotal, invoice.currency ?? undefined)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Tax</span>
                <span className="font-medium tabular-nums">{formatMoneyWithCurrency(taxAmount, invoice.currency ?? undefined)}</span>
              </div>
              <div className="flex items-center justify-between text-sm font-semibold">
                <span className="text-foreground">Total</span>
                <span className="tabular-nums">{formatMoneyWithCurrency((invoice as any).total, invoice.currency ?? undefined)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Payment Made</span>
                <span className="font-medium tabular-nums">
                  {formatMoneyWithCurrency((invoice as any).totalPaid ?? 0, invoice.currency ?? undefined)}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm font-semibold">
                <span className="text-foreground">Balance Due</span>
                <span className="tabular-nums">
                  {formatMoneyWithCurrency((invoice as any).remainingBalance, invoice.currency ?? undefined)}
                </span>
              </div>
            </div>
          </div>

          {(t.footerText ?? '').trim() ? (
            <>
              <div className="border-t" />
              <div className="whitespace-pre-wrap text-xs text-muted-foreground">{t.footerText}</div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}


