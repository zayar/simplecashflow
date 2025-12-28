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
    navigate(`${returnTo}?picked=1`, { replace: true });
  }

  const errors = useMemo(() => {
    const desc = String(line.itemName ?? '').trim();
    const hasDesc = desc.length > 0;
    return { description: hasDesc ? null : 'Description is required' };
  }, [line.itemName]);

  const total = useMemo(() => {
    const qty = clampQty(toNumber(line.quantity));
    const unit = clampMoney(toNumber(line.unitPrice));
    const discount = clampMoney(toNumber(line.discountAmount ?? 0));
    const taxRate = clampMoney(toNumber(line.taxRate ?? 0));
    const net = Math.max(0, qty * unit - discount);
    return net + net * taxRate;
  }, [line.quantity, line.unitPrice, line.discountAmount, line.taxRate]);

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
          <div className="px-4 py-4">
            <Label className="text-muted-foreground">Description</Label>
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
              placeholder="Description"
              className="mt-2"
              list="invoice-items-datalist"
            />
            <datalist id="invoice-items-datalist">
              {items.map((it) => (
                <option key={it.id} value={it.name} />
              ))}
            </datalist>
            {touched && errors.description ? (
              <div className="mt-1 text-sm text-destructive">{errors.description}</div>
            ) : null}
            <div className="mt-2 text-xs text-muted-foreground">
              Type a free item, or pick from your items list (tap search icon).
            </div>
          </div>

          <div className="border-t border-border px-4 py-4">
            <div className="flex items-center justify-between">
              <div className="text-xl font-semibold">Unit Cost</div>
              <div className="flex items-center gap-2">
                <div className="text-lg text-muted-foreground">K</div>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  value={clampMoney(toNumber(line.unitPrice))}
                  onChange={(e) => updateLine({ unitPrice: clampMoney(Number(e.target.value)) })}
                  className="w-28 text-right"
                />
              </div>
            </div>
          </div>

          <div className="border-t border-border px-4 py-4">
            <div className="flex items-center justify-between">
              <div className="text-xl font-semibold">Quantity</div>
              <Input
                type="number"
                min={1}
                inputMode="numeric"
                value={clampQty(toNumber(line.quantity))}
                onChange={(e) => updateLine({ quantity: clampQty(Number(e.target.value)) })}
                className="w-28 text-right"
              />
            </div>
          </div>

          <div className="border-t border-border px-4 py-4">
            <div className="flex items-center justify-between">
              <div className="text-xl font-semibold">Discount Amount</div>
              <div className="flex items-center gap-2">
                <div className="text-lg text-muted-foreground">K</div>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  value={clampMoney(toNumber(line.discountAmount ?? 0))}
                  onChange={(e) => updateLine({ discountAmount: clampMoney(Number(e.target.value)) })}
                  className="w-28 text-right"
                />
              </div>
            </div>
          </div>

          {/* We only implement tax using existing API field (taxRate). */}
          <div className="border-t border-border px-4 py-4">
            <div className="flex items-center justify-between">
              <div className="text-xl font-semibold">Tax rate</div>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  value={clampMoney(toNumber(line.taxRate ?? 0)) * 100}
                  onChange={(e) => updateLine({ taxRate: clampMoney(Number(e.target.value)) / 100 })}
                  className="w-28 text-right"
                />
                <div className="text-lg text-muted-foreground">%</div>
              </div>
            </div>
          </div>

          <div className="border-t border-border px-4 py-4">
            <div className="flex items-center justify-between">
              <div className="text-2xl font-semibold">Total</div>
              <div className="text-2xl font-semibold">{formatMoneyK(total)}</div>
            </div>
          </div>
        </Card>

        <Card className="mt-3 rounded-2xl shadow-sm">
          <div className="px-4 py-4">
            <Label className="text-muted-foreground">Additional Details</Label>
            <Textarea
              value={String(line.description ?? '')}
              onChange={(e) => updateLine({ description: e.target.value })}
              placeholder="Additional details"
              className="mt-2 min-h-24"
            />
          </div>
        </Card>

        <div className="mt-4 flex gap-3">
          <Button
            onClick={() => {
              setTouched(true);
              if (errors.description) return;
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


