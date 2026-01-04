"use client"

import { formatDateInTimeZone } from "@/lib/utils"
import type { InvoiceTemplate } from "@/lib/api"

function formatMoney(n: any) {
  const num = Number(n ?? 0)
  if (Number.isNaN(num)) return String(n ?? "")
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function formatMoneyWithCurrency(n: any, currency?: string) {
  const num = Number(n ?? 0)
  if (Number.isNaN(num)) return String(n ?? "")
  const cur = (currency ?? "").trim()
  return cur ? `${cur}${formatMoney(num)}` : formatMoney(num)
}

type InvoiceLike = {
  invoiceNumber: string
  status: string
  invoiceDate: string | Date
  dueDate?: string | Date | null
  currency?: string | null
  total?: any
  totalPaid?: any
  remainingBalance?: any
  customer?: { name?: string | null } | null
  location?: { name?: string | null } | null
  warehouse?: { name?: string | null } | null
  customerNotes?: string | null
  termsAndConditions?: string | null
  taxAmount?: any
  lines?: Array<{
    id?: number | string
    quantity?: any
    unitPrice?: any
    discountAmount?: any
    description?: string | null
    item?: { name?: string | null } | null
  }>
}

function statusLabel(status: string) {
  const s = String(status ?? "").toUpperCase()
  if (!s) return "—"
  return s.slice(0, 1) + s.slice(1).toLowerCase()
}

export function InvoicePaper({
  invoice,
  companyName,
  tz,
  template,
  displayCurrency,
  baseCurrency,
  fxRateToBase,
}: {
  invoice: InvoiceLike
  companyName: string
  tz: string
  template: InvoiceTemplate | null
  // Optional: display invoice in a different currency (UI-only).
  // When provided with fxRateToBase, amounts are converted from baseCurrency to displayCurrency.
  displayCurrency?: string | null
  baseCurrency?: string | null
  fxRateToBase?: number | null
}) {
  const t: InvoiceTemplate = template ?? {
    version: 1,
    logoUrl: null,
    accentColor: "#2F81B7",
    fontFamily: "Inter",
    headerText: null,
    footerText: null,
    tableHeaderBg: "#2F81B7",
    tableHeaderText: "#FFFFFF",
  }

  const invoiceLines = (invoice.lines ?? []) as any[]
  const baseCur = (baseCurrency ?? invoice.currency ?? "").trim() || null
  const dispCur = (displayCurrency ?? baseCur ?? invoice.currency ?? "").trim() || null
  const fx = typeof fxRateToBase === "number" ? fxRateToBase : Number(fxRateToBase ?? 0)
  const showFx = !!(baseCur && dispCur && baseCur !== dispCur && Number.isFinite(fx) && fx > 0)

  const toDisp = (n: any) => {
    const num = Number(n ?? 0)
    if (!showFx) return num
    return num / fx
  }

  const grossSubtotal = invoiceLines.reduce((sum: number, l: any) => {
    const qty = Number(l.quantity ?? 0)
    const rate = Number(l.unitPrice ?? 0)
    return sum + qty * rate
  }, 0)
  const discountTotal = invoiceLines.reduce((sum: number, l: any) => {
    return sum + Math.max(0, Number(l.discountAmount ?? 0))
  }, 0)
  const taxAmount = Number((invoice as any).taxAmount ?? 0)

  const rootStyle: React.CSSProperties = {
    fontFamily: t.fontFamily,
  }

  const headStyle: React.CSSProperties = {
    backgroundColor: t.tableHeaderBg,
    color: t.tableHeaderText,
  }

  return (
    <div className="p-6 sm:p-10" style={rootStyle}>
      {/* Header */}
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          {t.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={t.logoUrl}
              alt="Company logo"
              className="mb-3 h-16 w-auto max-w-[220px] object-contain sm:h-20 sm:max-w-[280px]"
            />
          ) : null}
          <div className="text-xl font-semibold tracking-tight" style={{ color: t.accentColor }}>
            {companyName}
          </div>
          {(t.headerText ?? "").trim() ? (
            <div className="text-sm text-muted-foreground whitespace-pre-wrap">{t.headerText}</div>
          ) : (
            <div className="text-sm text-muted-foreground">
              <div>Address line (optional)</div>
              <div>City, Country</div>
            </div>
          )}
        </div>

        <div className="space-y-2 text-left sm:text-right">
          <div className="text-3xl font-semibold tracking-tight" style={{ color: t.accentColor }}>
            Invoice
          </div>
          <div className="text-sm text-muted-foreground">
            <div>
              <span className="font-medium text-foreground">#{invoice.invoiceNumber}</span>
            </div>
            <div className="mt-1 inline-flex rounded-full border px-2 py-0.5 text-xs">
              {statusLabel(invoice.status)}
            </div>
          </div>
          <div className="mt-3 rounded-md bg-slate-50 p-3 text-sm">
            <div className="text-xs font-medium text-muted-foreground">Balance Due</div>
            <div className="text-lg font-semibold tabular-nums">
              {formatMoneyWithCurrency(toDisp((invoice as any).remainingBalance), dispCur ?? undefined)}
            </div>
            {showFx ? (
              <div className="mt-1 text-[11px] text-muted-foreground">
                Exchange rate: 1 {dispCur} = {baseCur}
                {formatMoney(fx)}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="my-8 border-t" />

      {/* Bill to + meta */}
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Bill To
          </div>
          <div className="text-base font-semibold">{invoice.customer?.name ?? "—"}</div>
          <div className="text-sm text-muted-foreground">Customer address (optional)</div>
        </div>

        <div className="space-y-2 sm:justify-self-end sm:text-right">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <div className="text-muted-foreground">Invoice Date</div>
            <div className="font-medium">{formatDateInTimeZone(invoice.invoiceDate as any, tz)}</div>
            <div className="text-muted-foreground">Due Date</div>
            <div className="font-medium">
              {invoice.dueDate ? formatDateInTimeZone(invoice.dueDate as any, tz) : "—"}
            </div>
            <div className="text-muted-foreground">Location</div>
            <div className="font-medium">{invoice.location?.name ?? invoice.warehouse?.name ?? "—"}</div>
            <div className="text-muted-foreground">Terms</div>
            <div className="font-medium">{invoice.dueDate ? "Net" : "—"}</div>
          </div>
        </div>
      </div>

      <div className="my-8 border-t" />

      {/* Lines */}
      <div className="overflow-hidden rounded-md border">
        <table className="w-full text-sm">
          <thead style={headStyle}>
            <tr>
              <th className="px-4 py-3 text-left font-medium">#</th>
              <th className="px-4 py-3 text-left font-medium">Item</th>
              <th className="px-4 py-3 text-right font-medium">Qty</th>
              <th className="px-4 py-3 text-right font-medium">Rate</th>
              <th className="px-4 py-3 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {invoiceLines.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                  No invoice lines.
                </td>
              </tr>
            ) : (
              invoiceLines.map((l: any, idx: number) => {
                const qty = Number(l.quantity ?? 0)
                const rate = Number(l.unitPrice ?? 0)
                const discount = Math.max(0, Number(l.discountAmount ?? 0))
                const amount = Math.max(0, qty * rate - discount)
                const itemName = l.item?.name ?? (l.description ?? "—")
                const desc = String(l.description ?? "").trim()
                const showDesc = Boolean(desc && l.item?.name && desc !== l.item.name)
                return (
                  <tr key={l.id ?? idx} className={idx % 2 === 0 ? "bg-white" : "bg-slate-50/30"}>
                    <td className="px-4 py-3 text-muted-foreground">{idx + 1}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{itemName}</div>
                      {showDesc ? <div className="mt-1 text-xs text-muted-foreground">{desc}</div> : null}
                      {discount > 0 ? (
                        <div className="mt-1 text-xs text-muted-foreground">
                          Discount: {formatMoneyWithCurrency(toDisp(discount), dispCur ?? undefined)}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums">{formatMoney(qty)}</td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums">
                      {formatMoneyWithCurrency(toDisp(rate), dispCur ?? undefined)}
                    </td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums">
                      {formatMoneyWithCurrency(toDisp(amount), dispCur ?? undefined)}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Totals */}
      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <div className="space-y-4 text-sm text-muted-foreground">
          {(invoice.customerNotes ?? "").trim() ? (
            <div>
              <div className="font-medium text-slate-900">Customer Notes</div>
              <div className="mt-1 whitespace-pre-wrap">{invoice.customerNotes}</div>
            </div>
          ) : null}

          {(invoice.termsAndConditions ?? "").trim() ? (
            <div>
              <div className="font-medium text-slate-900">Terms &amp; Conditions</div>
              <div className="mt-1 whitespace-pre-wrap">{invoice.termsAndConditions}</div>
            </div>
          ) : null}

          {!(invoice.customerNotes ?? "").trim() && !(invoice.termsAndConditions ?? "").trim() ? (
            <div>
              <div className="font-medium text-slate-900">Notes</div>
              <div className="mt-1">—</div>
            </div>
          ) : null}
        </div>

        <div className="sm:justify-self-end sm:text-right">
          <div className="ml-auto w-full max-w-sm space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Sub Total</span>
              <span className="font-medium tabular-nums">
                {formatMoneyWithCurrency(toDisp(grossSubtotal), dispCur ?? undefined)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Discount</span>
              <span className="font-medium tabular-nums">
                {formatMoneyWithCurrency(toDisp(discountTotal), dispCur ?? undefined)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Tax</span>
              <span className="font-medium tabular-nums">
                {formatMoneyWithCurrency(toDisp(taxAmount), dispCur ?? undefined)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Total</span>
              <span className="font-semibold tabular-nums">
                {formatMoneyWithCurrency(toDisp((invoice as any).total), dispCur ?? undefined)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Payment Made</span>
              <span className="font-medium tabular-nums">
                {formatMoneyWithCurrency(toDisp((invoice as any).totalPaid), dispCur ?? undefined)}
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between border-t pt-2">
              <span className="font-semibold">Balance Due</span>
              <span className="font-semibold tabular-nums">
                {formatMoneyWithCurrency(toDisp((invoice as any).remainingBalance), dispCur ?? undefined)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {(t.footerText ?? "").trim() ? (
        <div className="mt-10 border-t pt-4 text-sm text-muted-foreground whitespace-pre-wrap">
          {t.footerText}
        </div>
      ) : null}
    </div>
  )
}


