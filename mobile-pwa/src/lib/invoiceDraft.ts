import { yyyyMmDd } from './format';

const DRAFT_KEY = 'cf_invoice_draft_v1';

export type DraftLine = {
  itemId?: number | null;
  itemName?: string | null;
  description?: string | null;
  quantity: number;
  unitPrice: number;
  discountAmount?: number;
  taxRate?: number;
};

export type InvoiceDraft = {
  // If the user went to a picker screen, where should we return after selecting?
  returnTo?: string | null;
  // When set, InvoiceNew should UPDATE the existing invoice (PUT) instead of creating a new one (POST).
  editingInvoiceId?: number | null;
  customerId?: number | null;
  customerName?: string | null;
  invoiceDate: string; // YYYY-MM-DD
  dueDate?: string | null; // YYYY-MM-DD
  lines: DraftLine[];
  activeLineIndex?: number | null;
};

export function defaultDraft(): InvoiceDraft {
  return {
    returnTo: null,
    editingInvoiceId: null,
    customerId: null,
    customerName: null,
    invoiceDate: yyyyMmDd(new Date()),
    dueDate: null,
    lines: [{ quantity: 1, unitPrice: 0 }]
  };
}

export function getInvoiceDraft(): InvoiceDraft {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return defaultDraft();
    const parsed = JSON.parse(raw) as Partial<InvoiceDraft>;
    const safe: InvoiceDraft = {
      ...defaultDraft(),
      ...parsed,
      lines:
        Array.isArray(parsed.lines) && parsed.lines.length > 0
          ? parsed.lines.map((l: any) => ({
              itemId: l?.itemId ?? null,
              itemName: l?.itemName ?? null,
              description: l?.description ?? null,
              quantity: Number(l?.quantity ?? 1) || 1,
              unitPrice: Number(l?.unitPrice ?? 0) || 0,
              discountAmount: Number(l?.discountAmount ?? 0) || 0,
              taxRate: Number(l?.taxRate ?? 0) || 0
            }))
          : defaultDraft().lines
    };
    return safe;
  } catch {
    return defaultDraft();
  }
}

export function setInvoiceDraft(next: InvoiceDraft) {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(next));
  } catch {
    // best-effort
  }
}

export function clearInvoiceDraft() {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // best-effort
  }
}


