import Cookies from 'js-cookie';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

async function readResponseBody(res: Response): Promise<any> {
  // 204 No Content is valid for many write endpoints.
  if (res.status === 204) return null;

  const contentType = res.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');

  if (isJson) {
    try {
      return await res.json();
    } catch {
      // Empty/invalid JSON payload
      return null;
    }
  }

  // Fallback for non-JSON (rare in this app, but safer than throwing).
  try {
    const text = await res.text();
    return text || null;
  } catch {
    return null;
  }
}

export async function fetchApi(endpoint: string, options: RequestInit = {}) {
  const token = Cookies.get('token');
  
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  // Fintech safety rail: idempotency for all non-GET writes.
  // This prevents duplicate posting under retries / double-click / flaky networks.
  const method = (options.method ?? 'GET').toUpperCase();
  const isWrite = method !== 'GET' && method !== 'HEAD';
  if (isWrite && !headers['Idempotency-Key'] && !headers['idempotency-key']) {
    const key =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    headers['Idempotency-Key'] = key;
  }

  // Only set JSON content type for string bodies (we use JSON.stringify in this app).
  // Avoid clobbering FormData or explicit caller-provided content types.
  if (options.body && typeof options.body === 'string' && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });

  // If the token is expired/invalid, force a clean logout and redirect.
  // This prevents the UI from getting stuck in a loop of failing requests.
  if (res.status === 401) {
    const payload = await readResponseBody(res);
    const message =
      (payload && typeof payload === 'object' && ('message' in payload || 'error' in payload)
        ? ((payload as any).message || (payload as any).error)
        : null) ??
      (typeof payload === 'string' ? payload : null) ??
      'Unauthorized';

    try {
      Cookies.remove('token');
      Cookies.remove('user');
    } catch {
      // best-effort
    }

    if (typeof window !== 'undefined') {
      // Include reason for nicer UX on login page (optional).
      const qp = new URLSearchParams({ reason: 'expired' }).toString();
      // Avoid infinite redirect loops if we're already on /login.
      if (!window.location.pathname.startsWith('/login')) {
        window.location.assign(`/login?${qp}`);
      }
    }

    throw new Error(message);
  }

  if (!res.ok) {
    const payload = await readResponseBody(res);
    const message =
      (payload && typeof payload === 'object' && ('message' in payload || 'error' in payload)
        ? ((payload as any).message || (payload as any).error)
        : null) ??
      (typeof payload === 'string' ? payload : null) ??
      `Request failed with status ${res.status}`;
    throw new Error(message);
  }

  return await readResponseBody(res);
}

// --- Invoice Template (print/design settings) ---
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

export async function getInvoiceTemplate(companyId: number): Promise<InvoiceTemplate> {
  return fetchApi(`/companies/${companyId}/invoice-template`);
}

export async function updateInvoiceTemplate(companyId: number, template: Partial<InvoiceTemplate>): Promise<InvoiceTemplate> {
  return fetchApi(`/companies/${companyId}/invoice-template`, {
    method: 'PUT',
    body: JSON.stringify(template),
  });
}

export async function clearInvoiceTemplate(companyId: number): Promise<InvoiceTemplate> {
  return fetchApi(`/companies/${companyId}/invoice-template`, {
    method: 'PUT',
    body: JSON.stringify({ clear: true }),
  });
}

// --- Public Invoice Share Link (customer view, no login) ---
export type PublicInvoiceResponse = {
  company: {
    id: number;
    name: string;
    timeZone: string | null;
    template: InvoiceTemplate;
    paymentQrCodes?: {
      kbz?: string | null;
      ayaPay?: string | null;
      uabPay?: string | null;
      aPlus?: string | null;
    };
  };
  invoice: {
    id: number;
    invoiceNumber: string;
    status: string;
    invoiceDate: string;
    dueDate: string | null;
    currency: string | null;
    subtotal: any;
    taxAmount: any;
    total: any;
    totalPaid: number;
    remainingBalance: number;
    customerName: string | null;
    locationName: string | null;
    customerNotes: string | null;
    termsAndConditions: string | null;
    lines: Array<{
      id: number;
      quantity: any;
      unitPrice: any;
      discountAmount: any;
      description: string | null;
      itemName: string | null;
    }>;
  };
};

export async function createPublicInvoiceLink(companyId: number, invoiceId: number): Promise<{ token: string }> {
  return fetchApi(`/companies/${companyId}/invoices/${invoiceId}/public-link`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function getPublicInvoice(token: string): Promise<PublicInvoiceResponse> {
  const safe = encodeURIComponent(token);
  return fetchApi(`/public/invoices/${safe}`);
}

// Upload payment proof (public, no auth) - customer uploads after making payment
export async function uploadPaymentProof(token: string, file: File, note?: string): Promise<{
  success: boolean;
  message: string;
  proof: { url: string; submittedAt: string; note: string | null };
}> {
  const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';
  const safe = encodeURIComponent(token);
  const formData = new FormData();
  formData.append('file', file);
  if (note) formData.append('note', note);

  const res = await fetch(`${API_BASE_URL}/public/invoices/${safe}/payment-proof`, {
    method: 'POST',
    body: formData,
    headers: {
      'Idempotency-Key': `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    },
  });

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload?.error || payload?.message || 'Failed to upload payment proof');
  }

  return res.json();
}

// Delete payment proof(s) (public, no auth). If no opts provided, deletes all proofs.
export async function deletePaymentProof(
  token: string,
  opts?: { id?: string; url?: string }
): Promise<{ success: true; pendingPaymentProofs: any[] }> {
  const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';
  const safe = encodeURIComponent(token);
  const qs =
    opts?.id ? `?id=${encodeURIComponent(opts.id)}` : opts?.url ? `?url=${encodeURIComponent(opts.url)}` : '';

  const res = await fetch(`${API_BASE_URL}/public/invoices/${safe}/payment-proof${qs}`, {
    method: 'DELETE',
    headers: {
      'Idempotency-Key': `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    },
  });

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload?.error || payload?.message || 'Failed to delete payment proof');
  }

  return res.json();
}

// Report types based on our backend response
export interface TrialBalanceReport {
  companyId: number;
  from: string;
  to: string;
  totalDebit: string;
  totalCredit: string;
  balanced: boolean;
  accounts: {
    accountId: number;
    code: string | null;
    name: string | null;
    type: string | null;
    normalBalance: string | null;
    reportGroup: string | null;
    debit: string;
    credit: string;
  }[];
}

export interface ProfitLossReport {
  companyId: number;
  from: string;
  to: string;
  totalIncome: string;
  totalExpense: string;
  netProfit: string;
  incomeAccounts: {
    accountId: number;
    code: string;
    name: string;
    reportGroup: string | null;
    amount: string;
  }[];
  expenseAccounts: {
    accountId: number;
    code: string;
    name: string;
    reportGroup: string | null;
    amount: string;
  }[];
}

export interface BalanceSheetReport {
  companyId: number;
  asOf: string;
  columns?: Array<{ asOf: string; label: string }>;
  totalsByColumn?: Array<{
    assets: string;
    liabilities: string;
    equity: string;
    balanced: boolean;
  }>;
  totals: {
    assets: string;
    liabilities: string;
    equity: string;
    balanced: boolean;
  };
  assets: BalanceSheetRow[];
  liabilities: BalanceSheetRow[];
  equity: BalanceSheetRow[];
}

interface BalanceSheetRow {
  accountId: number;
  code: string;
  name: string;
  type: string;
  debit: string;
  credit: string;
  balance: string;
  balances?: string[];
}

export async function getTrialBalance(companyId: number, from: string, to: string): Promise<TrialBalanceReport> {
  return fetchApi(`/companies/${companyId}/reports/trial-balance?from=${from}&to=${to}`);
}

export async function getProfitLoss(companyId: number, from: string, to: string): Promise<ProfitLossReport> {
  return fetchApi(`/companies/${companyId}/reports/profit-and-loss?from=${from}&to=${to}`);
}

// --- Account Transactions (drill-down) ---
export type AccountTransactionsReport = {
  companyId: number;
  from: string;
  to: string;
  account: { id: number; code: string; name: string; type: string };
  openingBalance: { amount: string; side: 'Dr' | 'Cr' };
  rows: Array<{
    date: string; // YYYY-MM-DD
    journalEntryId: number;
    entryNumber: string;
    description: string;
    transactionType: string;
    transactionNo: string;
    referenceNo: string | null;
    debit: string;
    credit: string;
    amount: string;
    side: 'Dr' | 'Cr';
    runningBalance: string;
    runningSide: 'Dr' | 'Cr';
  }>;
};

export async function getAccountTransactions(
  companyId: number,
  accountId: number,
  from: string,
  to: string,
  take: number = 200
): Promise<AccountTransactionsReport> {
  const qs = new URLSearchParams({
    accountId: String(accountId),
    from,
    to,
    take: String(take),
  }).toString();
  return fetchApi(`/companies/${companyId}/reports/account-transactions?${qs}`);
}

export interface Account {
  id: number;
  code: string;
  name: string;
  type: string;
  normalBalance: string;
  reportGroup: string | null;
  cashflowActivity: string | null;
  isActive: boolean;
}

export async function getAccounts(companyId: number): Promise<Account[]> {
  return fetchApi(`/companies/${companyId}/accounts`);
}

export async function createAccount(companyId: number, data: {
  code: string;
  name: string;
  type: string;
  reportGroup?: string;
  cashflowActivity?: string;
}): Promise<Account> {
  return fetchApi(`/companies/${companyId}/accounts`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getBalanceSheet(companyId: number, asOf: string): Promise<BalanceSheetReport> {
  return fetchApi(`/companies/${companyId}/reports/balance-sheet?asOf=${asOf}`);
}

export async function getBalanceSheetWithCompare(companyId: number, asOf: string, compareYears: number = 0): Promise<BalanceSheetReport> {
  const cy = Math.min(Math.max(Number(compareYears || 0), 0), 2);
  return fetchApi(`/companies/${companyId}/reports/balance-sheet?asOf=${encodeURIComponent(asOf)}&compareYears=${cy}`);
}

// --- Accounts Payable (AP) / Bills ---
export interface Vendor {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  currency?: string | null;
  openingBalance?: string | null;
  createdAt: string;
}

export async function getVendors(companyId: number): Promise<Vendor[]> {
  return fetchApi(`/companies/${companyId}/vendors`);
}

export async function getVendor(companyId: number, vendorId: number): Promise<Vendor> {
  return fetchApi(`/companies/${companyId}/vendors/${vendorId}`);
}

export async function updateVendor(
  companyId: number,
  vendorId: number,
  data: { name: string; email?: string; phone?: string; currency?: string; openingBalance?: number }
): Promise<Vendor> {
  return fetchApi(`/companies/${companyId}/vendors/${vendorId}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: data.name,
      email: data.email ?? null,
      phone: data.phone ?? null,
      currency: data.currency ?? null,
      openingBalance: data.openingBalance === undefined ? undefined : data.openingBalance,
    }),
  });
}

// --- Credit Notes (AR Credits) ---
export type CreditNoteListRow = {
  id: number;
  creditNoteNumber: string;
  creditNoteDate: string;
  total: string;
  invoiceId: number | null;
};

export async function getCustomerCreditNotes(companyId: number, customerId: number, onlyOpen: boolean = true): Promise<CreditNoteListRow[]> {
  const qs = new URLSearchParams({ onlyOpen: onlyOpen ? '1' : '0' }).toString();
  return fetchApi(`/companies/${companyId}/customers/${customerId}/credit-notes?${qs}`);
}

export async function applyCreditNoteToInvoice(
  companyId: number,
  invoiceId: number,
  creditNoteId: number
): Promise<{ invoiceId: number; creditNoteId: number; status: string }> {
  return fetchApi(`/companies/${companyId}/invoices/${invoiceId}/apply-credit-note`, {
    method: 'POST',
    headers: { 'Idempotency-Key': `${Date.now()}-${Math.random().toString(16).slice(2)}` },
    body: JSON.stringify({ creditNoteId }),
  });
}

export async function unapplyCreditNote(companyId: number, creditNoteId: number): Promise<{ creditNoteId: number; invoiceId: number; status: string }> {
  return fetchApi(`/companies/${companyId}/credit-notes/${creditNoteId}/unapply`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function refundCreditNote(companyId: number, creditNoteId: number, data: {
  amount: number;
  refundDate?: string;
  bankAccountId: number;
  reference?: string | null;
  description?: string | null;
}): Promise<{ creditNoteRefundId: number; journalEntryId: number }> {
  return fetchApi(`/companies/${companyId}/credit-notes/${creditNoteId}/refunds`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// --- Vendor Credits (AP Credits) ---
export interface VendorCreditListRow {
  id: number;
  creditNumber: string;
  status: 'DRAFT' | 'APPROVED' | 'POSTED' | 'VOID';
  creditDate: string;
  vendorId: number | null;
  vendorName: string | null;
  locationName: string | null;
  total: string;
  amountApplied: string;
  remaining: string;
}

export interface VendorCreditLineInput {
  itemId: number;
  quantity: number;
  unitCost: number;
  description?: string;
  accountId?: number;
}

export interface VendorCreditDetail {
  id: number;
  creditNumber: string;
  status: 'DRAFT' | 'APPROVED' | 'POSTED' | 'VOID';
  creditDate: string;
  currency: string | null;
  vendor: Vendor | null;
  location: any | null;
  total: string;
  amountApplied: string;
  remaining: string;
  journalEntryId: number | null;
  lines: Array<{
    id: number;
    itemId: number;
    item: any;
    accountId: number | null;
    account: { id: number; code: string; name: string; type: string } | null;
    description: string | null;
    quantity: string;
    unitCost: string;
    lineTotal: string;
  }>;
  applications: Array<{
    id: number;
    appliedDate: string;
    amount: string;
    purchaseBill: { id: number; billNumber: string; billDate: string; vendorName: string | null; locationName: string | null; total: string } | null;
  }>;
}

export async function getVendorCredits(
  companyId: number,
  opts?: { vendorId?: number; eligibleOnly?: boolean; status?: string }
): Promise<VendorCreditListRow[]> {
  const qs = new URLSearchParams();
  if (opts?.vendorId) qs.set('vendorId', String(opts.vendorId));
  if (opts?.eligibleOnly) qs.set('eligibleOnly', 'true');
  if (opts?.status) qs.set('status', String(opts.status));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return fetchApi(`/companies/${companyId}/vendor-credits${suffix}`);
}

// --- Vendor Advances (Supplier Prepayments) ---
export type VendorAdvanceListRow = {
  id: number;
  advanceDate: string;
  amount: string;
  amountApplied: string;
  remaining: string;
  receivedVia: 'CASH' | 'BANK' | 'E_WALLET' | 'CREDIT_CARD' | null;
  reference: string | null;
  description: string | null;
  journalEntryId: number | null;
};

export async function getVendorAdvances(companyId: number, vendorId: number, onlyOpen: boolean = true): Promise<VendorAdvanceListRow[]> {
  const qp = new URLSearchParams({ onlyOpen: onlyOpen ? '1' : '0' }).toString();
  return fetchApi(`/companies/${companyId}/vendors/${vendorId}/vendor-advances?${qp}`);
}

export async function createVendorAdvance(companyId: number, data: {
  vendorId: number;
  locationId: number;
  advanceDate?: string;
  currency?: string | null;
  amount: number;
  bankAccountId: number;
  receivedVia?: 'CASH' | 'BANK' | 'E_WALLET' | 'CREDIT_CARD' | null;
  reference?: string | null;
  description?: string | null;
}): Promise<{ vendorAdvanceId: number; journalEntryId: number }> {
  return fetchApi(`/companies/${companyId}/vendor-advances`, { method: 'POST', body: JSON.stringify(data) });
}

export async function applyVendorAdvanceToBill(
  companyId: number,
  purchaseBillId: number,
  data: { vendorAdvanceId: number; amount: number; appliedDate?: string }
): Promise<any> {
  return fetchApi(`/companies/${companyId}/purchase-bills/${purchaseBillId}/apply-vendor-advance`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function createVendorCredit(
  companyId: number,
  data: { vendorId?: number | null; creditDate?: string; locationId?: number; lines: VendorCreditLineInput[] }
): Promise<any> {
  return fetchApi(`/companies/${companyId}/vendor-credits`, { method: 'POST', body: JSON.stringify(data) });
}

export async function getVendorCredit(companyId: number, vendorCreditId: number): Promise<VendorCreditDetail> {
  return fetchApi(`/companies/${companyId}/vendor-credits/${vendorCreditId}`);
}

export async function postVendorCredit(companyId: number, vendorCreditId: number): Promise<any> {
  return fetchApi(`/companies/${companyId}/vendor-credits/${vendorCreditId}/post`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function voidVendorCredit(companyId: number, vendorCreditId: number, reason: string): Promise<any> {
  return fetchApi(`/companies/${companyId}/vendor-credits/${vendorCreditId}/void`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function applyVendorCreditToBill(
  companyId: number,
  purchaseBillId: number,
  data: { vendorCreditId: number; amount: number; appliedDate?: string }
): Promise<any> {
  return fetchApi(`/companies/${companyId}/purchase-bills/${purchaseBillId}/apply-credits`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// --- Customer Advances (AR Credits) ---
export interface CustomerAdvanceListRow {
  id: number;
  advanceDate: string;
  currency: string | null;
  amount: string;
  amountApplied: string;
  remaining: string;
  receivedVia: 'CASH' | 'BANK' | 'E_WALLET' | 'CREDIT_CARD' | null;
  reference: string | null;
  description: string | null;
  location: { id: number; name: string } | null;
  journalEntryId: number | null;
}

export async function getCustomerAdvances(companyId: number, customerId: number, onlyOpen = true): Promise<CustomerAdvanceListRow[]> {
  const qp = new URLSearchParams({ onlyOpen: onlyOpen ? '1' : '0' }).toString();
  return fetchApi(`/companies/${companyId}/customers/${customerId}/customer-advances?${qp}`);
}

export async function applyCustomerAdvanceToInvoice(
  companyId: number,
  invoiceId: number,
  data: { customerAdvanceId: number; amount: number; appliedDate?: string }
): Promise<any> {
  return fetchApi(`/companies/${companyId}/invoices/${invoiceId}/apply-credits`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function createVendor(
  companyId: number,
  data: { name: string; email?: string; phone?: string; currency?: string; openingBalance?: number }
): Promise<Vendor> {
  return fetchApi(`/companies/${companyId}/vendors`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export interface Customer {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  currency: string | null;
  openingBalance: string | null;
  createdAt: string;
}

export async function getCustomers(companyId: number): Promise<Customer[]> {
  return fetchApi(`/companies/${companyId}/customers`);
}

export async function getCustomer(companyId: number, customerId: number): Promise<Customer> {
  return fetchApi(`/companies/${companyId}/customers/${customerId}`);
}

export async function createCustomer(
  companyId: number,
  data: { name: string; email?: string; phone?: string; currency?: string; openingBalance?: number }
): Promise<Customer> {
  return fetchApi(`/companies/${companyId}/customers`, {
    method: 'POST',
    body: JSON.stringify({
      name: data.name,
      email: data.email ?? null,
      phone: data.phone ?? null,
      currency: data.currency ?? null,
      openingBalance: data.openingBalance === undefined ? undefined : data.openingBalance,
    }),
  });
}

export async function updateCustomer(
  companyId: number,
  customerId: number,
  data: { name: string; email?: string; phone?: string; currency?: string; openingBalance?: number }
): Promise<Customer> {
  return fetchApi(`/companies/${companyId}/customers/${customerId}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: data.name,
      email: data.email ?? null,
      phone: data.phone ?? null,
      currency: data.currency ?? null,
      openingBalance: data.openingBalance === undefined ? undefined : data.openingBalance,
    }),
  });
}

export type BillStatus = 'DRAFT' | 'POSTED' | 'PARTIAL' | 'PAID';

export interface BillListRow {
  id: number;
  expenseNumber: string;
  vendorName: string | null;
  status: BillStatus;
  amount: string;
  amountPaid: string;
  expenseDate: string;
  dueDate: string | null;
}

export interface BillDetail {
  id: number;
  expenseNumber: string;
  vendor: Vendor | null;
  status: BillStatus;
  expenseDate: string;
  dueDate: string | null;
  amount: string;
  currency: string | null;
  description: string;
  expenseAccount: { id: number; code: string; name: string; type: string } | null;
  totalPaid: number;
  remainingBalance: number;
  payments: {
    id: number;
    paymentDate: string;
    amount: string;
    bankAccount: { id: number; code: string; name: string };
    journalEntryId: number | null;
    reversedAt: string | null;
    reversalReason: string | null;
    reversalJournalEntryId: number | null;
  }[];
  journalEntries: {
    kind: string;
    journalEntryId: number;
    date: string;
    description: string;
    lines: {
      account: { id: number; code: string; name: string; type: string };
      debit: string;
      credit: string;
    }[];
  }[];
}

export async function getBills(companyId: number): Promise<BillListRow[]> {
  return fetchApi(`/companies/${companyId}/expenses`);
}

export async function getBill(companyId: number, billId: number): Promise<BillDetail> {
  return fetchApi(`/companies/${companyId}/expenses/${billId}`);
}

export async function createBill(
  companyId: number,
  data: {
    vendorId?: number | null;
    expenseDate?: string;
    dueDate?: string;
    description: string;
    amount: number;
    currency?: string;
    expenseAccountId?: number | null;
  }
): Promise<any> {
  return fetchApi(`/companies/${companyId}/expenses`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function postBill(
  companyId: number,
  billId: number,
  data: { bankAccountId?: number } = {}
): Promise<any> {
  return fetchApi(`/companies/${companyId}/expenses/${billId}/post`, {
    method: 'POST',
    body: JSON.stringify(data ?? {}),
  });
}

export async function payBill(
  companyId: number,
  billId: number,
  data: { paymentDate?: string; amount: number; bankAccountId: number }
): Promise<any> {
  return fetchApi(`/companies/${companyId}/expenses/${billId}/payments`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateBill(
  companyId: number,
  billId: number,
  data: {
    vendorId?: number | null;
    expenseDate?: string;
    dueDate?: string | null;
    description: string;
    amount: number;
    currency?: string | null;
    expenseAccountId?: number | null;
  }
): Promise<any> {
  return fetchApi(`/companies/${companyId}/expenses/${billId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

// --- Cashflow Statement ---
export interface CashflowStatement {
  companyId: number;
  from: string;
  to: string;
  operating: { total: string; lines: { label: string; amount: string }[] };
  investing: { total: string; lines: { label: string; amount: string }[] };
  financing: { total: string; lines: { label: string; amount: string }[] };
  reconciliation: {
    cashBegin: string;
    cashEnd: string;
    netChangeInCash: string;
    computedNetChangeInCash: string;
    reconciled: boolean;
  };
  notes: string[];
}

export async function getCashflowStatement(companyId: number, from: string, to: string): Promise<CashflowStatement> {
  return fetchApi(`/companies/${companyId}/reports/cashflow?from=${from}&to=${to}`);
}

// --- Period Close ---
export interface PeriodCloseResult {
  companyId: number;
  from: string;
  to: string;
  periodCloseId: number;
  journalEntryId: number;
  alreadyClosed: boolean;
  netProfit: string | null;
}

export async function closePeriod(companyId: number, from: string, to: string): Promise<PeriodCloseResult> {
  return fetchApi(`/companies/${companyId}/period-close?from=${from}&to=${to}`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

// --- Currencies (Option 1: reference-only exchange rates) ---
export type CurrencyOverviewRow = {
  id: number;
  code: string;
  name: string | null;
  symbol: string | null;
  isBase: boolean;
  latestRateToBase: string | null;
  latestAsOfDate: string | null;
};

export type CurrenciesOverview = {
  baseCurrency: string | null;
  currencies: CurrencyOverviewRow[];
};

export async function getCurrenciesOverview(companyId: number): Promise<CurrenciesOverview> {
  return fetchApi(`/companies/${companyId}/currencies/overview`);
}

export async function createCurrency(
  companyId: number,
  data: { code: string; name?: string | null; symbol?: string | null }
): Promise<any> {
  return fetchApi(`/companies/${companyId}/currencies`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateCurrency(
  companyId: number,
  currencyId: number,
  data: { name?: string | null; symbol?: string | null; isActive?: boolean }
): Promise<any> {
  return fetchApi(`/companies/${companyId}/currencies/${currencyId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteCurrency(companyId: number, currencyId: number): Promise<{ ok: boolean }> {
  return fetchApi(`/companies/${companyId}/currencies/${currencyId}`, { method: 'DELETE' });
}

export type ExchangeRateRow = {
  id: number;
  currencyCode: string;
  baseCurrency: string;
  rateToBase: string;
  asOfDate: string;
  createdAt: string;
};

export async function getExchangeRates(companyId: number, code: string): Promise<ExchangeRateRow[]> {
  return fetchApi(`/companies/${companyId}/currencies/${code}/rates`);
}

export async function createExchangeRate(
  companyId: number,
  code: string,
  data: { rateToBase: number; asOfDate: string }
): Promise<ExchangeRateRow> {
  return fetchApi(`/companies/${companyId}/currencies/${code}/rates`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// --- Payment QR Codes Management ---
export type PaymentQrCodes = {
  kbz?: string | null;
  ayaPay?: string | null;
  uabPay?: string | null;
  aPlus?: string | null;
};

export async function getPaymentQrCodes(companyId: number): Promise<PaymentQrCodes> {
  return fetchApi(`/companies/${companyId}/payment-qr-codes`);
}

export async function updatePaymentQrCodes(
  companyId: number,
  data: Partial<PaymentQrCodes>
): Promise<PaymentQrCodes> {
  return fetchApi(`/companies/${companyId}/payment-qr-codes`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function uploadPaymentQrCode(
  companyId: number,
  method: 'kbz' | 'ayaPay' | 'uabPay' | 'aPlus',
  file: File
): Promise<{ method: string; url: string; allQrCodes: PaymentQrCodes }> {
  const formData = new FormData();
  formData.append('file', file);

  const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';
  const token = (await import('js-cookie')).default.get('token');
  
  const res = await fetch(`${API_BASE_URL}/companies/${companyId}/payment-qr-codes/${method}`, {
    method: 'POST',
    body: formData,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Idempotency-Key': `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    },
  });

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload?.error || payload?.message || 'Failed to upload QR code');
  }

  return res.json();
}

export async function deletePaymentQrCode(
  companyId: number,
  method: 'kbz' | 'ayaPay' | 'uabPay' | 'aPlus'
): Promise<PaymentQrCodes> {
  return fetchApi(`/companies/${companyId}/payment-qr-codes/${method}`, {
    method: 'DELETE',
  });
}
