import React, { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AppBar, BackIcon, IconButton, SearchIcon } from '../components/AppBar';
import { formatMoneyK, toNumber } from '../lib/format';
import { getInvoiceDraft, setInvoiceDraft, type DraftLine } from '../lib/invoiceDraft';
import { useAuth } from '../lib/auth';
import { useQuery } from '@tanstack/react-query';
import { getItems, type Item } from '../lib/ar';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Label } from '../components/ui/label';
import { Button } from '../components/ui/button';

function clampQty(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.floor(n);
}

function clampMoney(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export default function InvoiceLine() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const idx = Number(params.get('idx') ?? 0);
  const safeIdx = Number.isFinite(idx) && idx >= 0 ? idx : 0;

  const { user } = useAuth();
  const companyId = user?.companyId ?? 0;

  const [draft, setDraftState] = useState(() => getInvoiceDraft());
  const [touched, setTouched] = useState(false);

  const line = draft.lines[safeIdx] ?? { quantity: 1, unitPrice: 0 };
  const [unitPriceText, setUnitPriceText] = useState<string>(String(clampMoney(toNumber((line as any).unitPrice ?? 0))));
  const [qtyText, setQtyText] = useState<string>(String(clampQty(toNumber((line as any).quantity ?? 1))));
  const [discountText, setDiscountText] = useState<string>(String(clampMoney(toNumber((line as any).discountAmount ?? 0))));
  const [taxPctText, setTaxPctText] = useState<string>(String(clampMoney(toNumber((line as any).taxRate ?? 0)) * 100));

  // When changing line index (or after draft refresh), sync text fields from numeric values.
  React.useEffect(() => {
    setUnitPriceText(String(clampMoney(toNumber((line as any).unitPrice ?? 0))));
    setQtyText(String(clampQty(toNumber((line as any).quantity ?? 1))));
    setDiscountText(String(clampMoney(toNumber((line as any).discountAmount ?? 0))));
    setTaxPctText(String(clampMoney(toNumber((line as any).taxRate ?? 0)) * 100));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeIdx, params.get('picked')]);

  // When returning from picker screens, refresh draft from storage.
  React.useEffect(() => {
    if (!params.get('picked')) return;
    setDraftState(getInvoiceDraft());
    // keep touched state as-is
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('picked')]);

  const itemsQuery = useQuery({
    queryKey: ['items', companyId],
    queryFn: async () => await getItems(companyId),
    enabled: companyId > 0
  });
  const items = (itemsQuery.data ?? []) as Item[];

  function updateDraft(next: typeof draft) {
    setDraftState(next);
    setInvoiceDraft(next);
  }

  function updateLine(patch: Partial<DraftLine>) {
    const lines = draft.lines.slice();
    while (lines.length <= safeIdx) lines.push({ quantity: 1, unitPrice: 0 });
    lines[safeIdx] = { ...lines[safeIdx], ...patch };
    updateDraft({ ...draft, lines, activeLineIndex: safeIdx });
  }

  function goBack() {
    const returnTo = draft.returnTo ?? '/invoices/new';
    const sep = returnTo.includes('?') ? '&' : '?';
    navigate(`${returnTo}${sep}picked=1`, { replace: true });
  }

  const errors = useMemo(() => {
    const name = String(line.itemName ?? '').trim();
    const hasName = name.length > 0;
    const isCustom = !Number(line.itemId ?? 0);
    const unit = clampMoney(toNumber(line.unitPrice));
    const unitErr = isCustom && unit <= 0 ? 'Unit cost is required for custom items' : null;
    return { itemName: hasName ? null : 'Item name is required', unitPrice: unitErr };
  }, [line.itemId, line.itemName, line.unitPrice]);

  const total = useMemo(() => {
    const qty = clampQty(toNumber(line.quantity));
    const unit = clampMoney(toNumber(line.unitPrice));
    const discount = clampMoney(toNumber(line.discountAmount ?? 0));
    const taxRate = clampMoney(toNumber(line.taxRate ?? 0));
    const net = Math.max(0, qty * unit - discount);
    return net + net * taxRate;
  }, [line.quantity, line.unitPrice, line.discountAmount, line.taxRate]);

  const rowInputClass =
    'h-9 w-28 rounded-xl border border-transparent bg-muted/40 px-2 py-1 text-right tabular-nums shadow-none focus-visible:border-input focus-visible:bg-background focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0';
  const rowPrefixClass = 'pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground';
  const rowSuffixClass = 'pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground';

  return (
    <div className="min-h-dvh bg-background pb-24">
      <AppBar
        title="Item"
        left={
          <IconButton ariaLabel="Back" onClick={goBack}>
            <BackIcon />
          </IconButton>
        }
        right={
          <IconButton
            ariaLabel="Search"
            onClick={() => {
              const next = getInvoiceDraft();
              next.activeLineIndex = safeIdx;
              next.returnTo = `/invoices/new/line?idx=${safeIdx}`;
              setInvoiceDraft(next);
              navigate('/items?mode=pick');
            }}
          >
            <SearchIcon />
          </IconButton>
        }
      />

      <div className="mx-auto max-w-xl px-3 pt-3">
        <Card className="rounded-2xl shadow-sm">
          <div className="px-4 py-3">
            <Label className="text-sm text-muted-foreground">Item Name</Label>
            <Input
              value={String(line.itemName ?? '')}
              onChange={(e) => {
                setTouched(true);
                const typed = e.target.value;
                // Type or select from DB (autocomplete via datalist).
                const match = items.find((it) => String(it.name ?? '').trim().toLowerCase() === typed.trim().toLowerCase());
                if (match) {
                  updateLine({
                    itemId: match.id,
                    itemName: match.name,
                    unitPrice: Math.max(0, toNumber(match.sellingPrice))
                  });
                } else {
                  // Free item/custom line
                  updateLine({ itemName: typed, itemId: null });
                }
              }}
              placeholder="e.g. Calculator"
              className="mt-2 h-10 rounded-xl border border-transparent bg-muted/40 shadow-none focus-visible:border-input focus-visible:bg-background focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0"
              list="invoice-items-datalist"
              autoComplete="off"
            />
            <datalist id="invoice-items-datalist">
              {items.map((it) => (
                <option key={it.id} value={it.name} />
              ))}
            </datalist>
            {touched && errors.itemName ? <div className="mt-1 text-sm text-destructive">{errors.itemName}</div> : null}
            <div className="mt-1 text-xs text-muted-foreground">Type a custom item, or tap search to pick from your items list.</div>

            <div className="mt-4">
              <Label className="text-sm text-muted-foreground">Description</Label>
              <Textarea
                value={String(line.description ?? '')}
                onChange={(e) => updateLine({ description: e.target.value })}
                placeholder="Optional details…"
                className="mt-2 min-h-20 rounded-xl border border-transparent bg-muted/40 shadow-none focus-visible:border-input focus-visible:bg-background focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0"
              />
            </div>
          </div>

          <div className="border-t border-border/70 px-4 py-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-foreground">Unit Cost</div>
              <div className="relative">
                <div className={rowPrefixClass}>K</div>
                <Input
                  inputMode="decimal"
                  value={unitPriceText}
                  onChange={(e) => setUnitPriceText(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={() => {
                    setTouched(true);
                    const raw = unitPriceText.trim();
                    const n = raw === '' ? 0 : clampMoney(Number(raw));
                    updateLine({ unitPrice: n });
                    setUnitPriceText(String(n));
                  }}
                  className={`${rowInputClass} pl-6`}
                />
              </div>
            </div>
            {touched && errors.unitPrice ? <div className="mt-2 text-sm text-destructive">{errors.unitPrice}</div> : null}
          </div>

          <div className="border-t border-border/70 px-4 py-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-foreground">Quantity</div>
              <Input
                inputMode="numeric"
                value={qtyText}
                onChange={(e) => setQtyText(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={() => {
                  const raw = qtyText.trim();
                  const n = raw === '' ? 1 : clampQty(Number(raw));
                  updateLine({ quantity: n });
                  setQtyText(String(n));
                }}
                className={rowInputClass}
              />
            </div>
          </div>

          <div className="border-t border-border/70 px-4 py-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-foreground">Discount</div>
              <div className="relative">
                <div className={rowPrefixClass}>K</div>
                <Input
                  inputMode="decimal"
                  value={discountText}
                  onChange={(e) => setDiscountText(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={() => {
                    const raw = discountText.trim();
                    const n = raw === '' ? 0 : clampMoney(Number(raw));
                    updateLine({ discountAmount: n });
                    setDiscountText(String(n));
                  }}
                  className={`${rowInputClass} pl-6`}
                />
              </div>
            </div>
          </div>

          {/* We only implement tax using existing API field (taxRate). */}
          <div className="border-t border-border/70 px-4 py-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-foreground">Tax</div>
              <div className="relative">
                <Input
                  inputMode="decimal"
                  value={taxPctText}
                  onChange={(e) => setTaxPctText(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={() => {
                    const raw = taxPctText.trim();
                    const pct = raw === '' ? 0 : clampMoney(Number(raw));
                    const rate = pct / 100;
                    updateLine({ taxRate: rate });
                    setTaxPctText(String(pct));
                  }}
                  className={`${rowInputClass} pr-6`}
                />
                <div className={rowSuffixClass}>%</div>
              </div>
            </div>
          </div>

          <div className="border-t border-border/70 px-4 py-3">
            <div className="flex items-center justify-between">
              <div className="text-base font-semibold">Total</div>
              <div className="text-base font-semibold">{formatMoneyK(total)}</div>
            </div>
          </div>
        </Card>

        <div className="mt-4 flex gap-3">
          <Button
            onClick={() => {
              setTouched(true);
              if (errors.itemName || errors.unitPrice) return;
              goBack();
            }}
            className="w-full rounded-xl"
          >
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}


