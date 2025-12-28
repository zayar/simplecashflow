import React, { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { createInvoice, getCompanySettings, getWarehouses } from '../lib/ar';
import { AppBar, BackIcon, IconButton } from '../components/AppBar';
import { Fab, SaveIcon } from '../components/Fab';
import { clearInvoiceDraft, getInvoiceDraft, setInvoiceDraft, type DraftLine } from '../lib/invoiceDraft';
import { formatMMDDYYYY, formatMoneyK, toNumber, yyyyMmDd } from '../lib/format';
import { Card } from '../components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Button } from '../components/ui/button';

function clampQty(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.floor(n);
}

function clampMoney(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export default function InvoiceNew() {
  const { user } = useAuth();
  const companyId = user?.companyId ?? 0;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();

  const [draft, setDraftState] = useState(() => getInvoiceDraft());
  const [error, setError] = useState<string | null>(null);

  const settingsQuery = useQuery({
    queryKey: ['company-settings', companyId],
    queryFn: async () => await getCompanySettings(companyId),
    enabled: companyId > 0
  });

  const warehousesQuery = useQuery({
    queryKey: ['warehouses', companyId],
    queryFn: async () => await getWarehouses(companyId),
    enabled: companyId > 0
  });

  const branchName = useMemo(() => {
    const lid = (settingsQuery.data as any)?.defaultLocationId ?? (settingsQuery.data as any)?.defaultWarehouseId ?? null;
    const loc = (warehousesQuery.data ?? []).find((w) => w.id === lid) ?? null;
    return (loc as any)?.name ?? 'Head Office';
  }, [(settingsQuery.data as any)?.defaultLocationId, (settingsQuery.data as any)?.defaultWarehouseId, warehousesQuery.data]);

  // If we returned from pickers, ensure draft is fresh.
  React.useEffect(() => {
    const next = getInvoiceDraft();
    // Always default to today if missing.
    if (!next.invoiceDate) next.invoiceDate = yyyyMmDd(new Date());
    setDraftState(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('picked')]);

  function updateDraft(next: typeof draft) {
    setDraftState(next);
    setInvoiceDraft(next);
  }

  const totals = useMemo(() => {
    const subtotal = draft.lines.reduce((sum, l) => sum + toNumber(l.quantity) * toNumber(l.unitPrice), 0);
    const discount = draft.lines.reduce((sum, l) => sum + toNumber(l.discountAmount ?? 0), 0);
    const tax = draft.lines.reduce((sum, l) => {
      const net = Math.max(0, toNumber(l.quantity) * toNumber(l.unitPrice) - toNumber(l.discountAmount ?? 0));
      return sum + net * toNumber(l.taxRate ?? 0);
    }, 0);
    const total = Math.max(0, subtotal - discount) + tax;
    return { subtotal, discount, tax, total };
  }, [draft.lines]);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!companyId) throw new Error('Missing companyId');
      if (!draft.customerId) throw new Error('Please select a client');
      if (!draft.invoiceDate) throw new Error('Please select invoice date');
      if (!draft.lines.length) throw new Error('Please add at least 1 item');

      const lines = draft.lines
        .filter((l) => clampQty(toNumber(l.quantity)) > 0)
        .map((l) => {
          const itemId = l.itemId ? Number(l.itemId) : 0;
          const payloadLine: any = {
            quantity: clampQty(toNumber(l.quantity)),
            unitPrice: clampMoney(toNumber(l.unitPrice)),
            taxRate: clampMoney(toNumber(l.taxRate ?? 0)),
            discountAmount: clampMoney(toNumber(l.discountAmount ?? 0))
          };

          // For tracked inventory items, send itemId; otherwise custom description.
          if (itemId > 0) payloadLine.itemId = itemId;
          const title = String(l.itemName ?? '').trim();
          const details = String(l.description ?? '').trim();
          const desc = title && details ? `${title}\n${details}` : details || title;
          if (desc) payloadLine.description = desc;
          return payloadLine;
        });

      return await createInvoice(companyId, {
        customerId: Number(draft.customerId),
        invoiceDate: draft.invoiceDate,
        dueDate: draft.dueDate ? draft.dueDate : undefined,
        lines
      });
    },
    onSuccess: async (res: any) => {
      clearInvoiceDraft();
      await queryClient.invalidateQueries({ queryKey: ['invoices', companyId] });
      const id = res && typeof res === 'object' && 'id' in res ? Number((res as any).id) : 0;
      if (id > 0) navigate(`/invoices/${id}`, { replace: true });
      else navigate('/invoices', { replace: true });
    },
    onError: (err: any) => {
      setError(err?.message ?? 'Failed to create invoice');
    }
  });

  function addLine() {
    updateDraft({ ...draft, lines: [...draft.lines, { quantity: 1, unitPrice: 0 }] });
  }

  function removeLine(index: number) {
    if (draft.lines.length <= 1) return;
    const next = draft.lines.filter((_, i) => i !== index);
    updateDraft({ ...draft, lines: next });
  }

  function updateLine(index: number, patch: Partial<DraftLine>) {
    const next = draft.lines.map((l, i) => (i === index ? { ...l, ...patch } : l));
    updateDraft({ ...draft, lines: next });
  }

  return (
    <div className="min-h-dvh bg-background pb-24">
      <AppBar
        title="Invoice"
        left={
          <IconButton ariaLabel="Back" onClick={() => navigate(-1)}>
            <BackIcon />
          </IconButton>
        }
        right={<div className="h-10 w-10" />}
      />

      <div className="mx-auto max-w-xl px-3 pt-3">
        <Card className="rounded-2xl shadow-sm">
          <div className="p-3">
            <Tabs defaultValue="edit" className="w-full">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="edit">Edit</TabsTrigger>
                <TabsTrigger value="preview" disabled>
                  Preview
                </TabsTrigger>
                <TabsTrigger value="history" disabled>
                  History
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </Card>

        <Card className="mt-3 overflow-hidden rounded-2xl shadow-sm">
          <div className="flex items-start justify-between px-4 py-3">
            <div>
              {/* Only show invoice number if we actually have one; otherwise keep clean */}
              <div className="text-3xl font-extrabold tracking-tight">New</div>
            </div>
            <div className="text-right">
              <div className="text-sm text-muted-foreground">Due on receipt</div>
              <div className="mt-1">
                <button
                  type="button"
                  onClick={() => {
                    // Focus the hidden date input by clicking it programmatically (simple + mobile-friendly).
                    const el = document.getElementById('invoice-date-input') as HTMLInputElement | null;
                    el?.showPicker?.();
                    el?.focus();
                  }}
                  className="rounded-md px-2 py-1 text-sm font-medium text-foreground active:bg-muted/50"
                >
                  {formatMMDDYYYY(draft.invoiceDate) || formatMMDDYYYY(yyyyMmDd(new Date()))}
                </button>
                <input
                  id="invoice-date-input"
                  type="date"
                  value={draft.invoiceDate}
                  onChange={(e) => updateDraft({ ...draft, invoiceDate: e.target.value })}
                  className="absolute h-0 w-0 opacity-0"
                />
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              updateDraft({ ...draft, activeLineIndex: null, returnTo: '/invoices/new' });
              navigate('/customers?mode=pick');
            }}
            className="flex w-full items-center justify-between border-t border-border px-4 py-3 text-left active:bg-muted/50"
          >
            <div className="flex items-center gap-2">
              <div className="text-foreground">
                <span className="font-semibold">To</span> <span className="text-muted-foreground">Client</span>
              </div>
              <div className="text-sm text-foreground">{draft.customerName ?? ''}</div>
            </div>
            <div className="text-muted-foreground">›</div>
          </button>

          <button
            type="button"
            onClick={() => {
              navigate(`/warehouses?mode=pick&returnTo=${encodeURIComponent('/invoices/new')}`);
            }}
            className="flex w-full items-center justify-between border-t border-border px-4 py-3 text-left active:bg-muted/50"
          >
            <div className="flex items-center gap-2">
              <div className="text-foreground">
                <span className="font-semibold">Location</span>
              </div>
              <div className="text-sm text-foreground">{branchName}</div>
            </div>
            <div className="text-muted-foreground">›</div>
          </button>
        </Card>

        <Card className="mt-3 overflow-hidden rounded-2xl shadow-sm">
          <button
            type="button"
            onClick={() => {
              // Create a new line and open its detail.
              const next = getInvoiceDraft();
              const idx = next.lines.length;
              next.lines = [...(next.lines ?? []), { quantity: 1, unitPrice: 0 }];
              next.activeLineIndex = idx;
              next.returnTo = '/invoices/new';
              setInvoiceDraft(next);
              setDraftState(next);
              navigate(`/invoices/new/line?idx=${idx}`);
            }}
            className="flex w-full items-start justify-between gap-3 px-4 py-4 text-left active:bg-muted/50"
          >
            <div className="text-base text-muted-foreground">Add Item</div>
            <div className="text-right">
              <div className="text-sm text-muted-foreground">
                {draft.lines.length} × {formatMoneyK(0)}
              </div>
              <div className="text-base font-medium text-foreground">{formatMoneyK(totals.total)}</div>
            </div>
          </button>

          {draft.lines.length ? (
            <div className="border-t border-border">
              {draft.lines.map((l, idx) => {
                const title = String(l.itemName ?? '').trim() || 'Item';
                const qty = toNumber(l.quantity);
                const unit = toNumber(l.unitPrice);
                const discount = toNumber(l.discountAmount ?? 0);
                const net = Math.max(0, qty * unit - discount);
                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => {
                      const next = getInvoiceDraft();
                      next.activeLineIndex = idx;
                      next.returnTo = '/invoices/new';
                      setInvoiceDraft(next);
                      setDraftState(next);
                      navigate(`/invoices/new/line?idx=${idx}`);
                    }}
                    className="flex w-full items-start justify-between gap-3 border-t border-border px-4 py-3 text-left active:bg-muted/50"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-base text-foreground">{title}</div>
                      <div className="text-sm text-muted-foreground">
                        {qty || 0} × {formatMoneyK(unit)}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-base font-medium text-foreground">{formatMoneyK(net)}</div>
                      <div className="mt-2 flex items-center justify-end gap-2">
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            removeLine(idx);
                          }}
                        >
                          Remove
                        </Button>
                        <div className="text-sm text-muted-foreground">›</div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : null}

          <div className="border-t border-border px-4 py-4">
            <div className="flex items-center justify-between">
              <div className="text-xl font-semibold text-foreground">Subtotal</div>
              <div className="text-xl font-semibold text-foreground">{formatMoneyK(totals.subtotal)}</div>
            </div>
          </div>
        </Card>

        <Card className="mt-3 overflow-hidden rounded-2xl shadow-sm">
          <div className="px-4 py-4">
            <div className="flex justify-between py-2 text-base">
              <div className="text-foreground">Discount</div>
              <div className="text-foreground">{formatMoneyK(totals.discount)}</div>
            </div>
            <div className="flex justify-between py-2 text-base">
              <div className="text-foreground">Tax</div>
              <div className="text-foreground">{formatMoneyK(totals.tax)}</div>
            </div>
            <div className="flex justify-between py-2 text-base">
              <div className="text-foreground">Total</div>
              <div className="text-foreground">{formatMoneyK(totals.total)}</div>
            </div>
            <div className="flex justify-between py-2 text-base">
              <div className="text-foreground">Payments</div>
              <div className="text-foreground">{formatMoneyK(0)}</div>
            </div>
            <div className="mt-2 flex justify-between py-2 text-xl font-semibold">
              <div className="text-foreground">Balance Due</div>
              <div className="text-foreground">{formatMoneyK(totals.total)}</div>
            </div>
          </div>
        </Card>

        {error ? (
          <div className="mt-3 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}
      </div>

      <Fab
        onClick={() => {
          setError(null);
          createMutation.mutate();
        }}
        ariaLabel="Save invoice"
        icon={<SaveIcon />}
        label="Save"
        disabled={createMutation.isPending}
      />
    </div>
  );
}


