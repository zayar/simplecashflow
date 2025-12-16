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
}

export async function getTrialBalance(companyId: number, from: string, to: string): Promise<TrialBalanceReport> {
  return fetchApi(`/companies/${companyId}/reports/trial-balance?from=${from}&to=${to}`);
}

export async function getProfitLoss(companyId: number, from: string, to: string): Promise<ProfitLossReport> {
  return fetchApi(`/companies/${companyId}/reports/profit-and-loss?from=${from}&to=${to}`);
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

// --- Accounts Payable (AP) / Bills ---
export interface Vendor {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  createdAt: string;
}

export async function getVendors(companyId: number): Promise<Vendor[]> {
  return fetchApi(`/companies/${companyId}/vendors`);
}

export async function createVendor(
  companyId: number,
  data: { name: string; email?: string; phone?: string }
): Promise<Vendor> {
  return fetchApi(`/companies/${companyId}/vendors`, {
    method: 'POST',
    body: JSON.stringify(data),
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

export async function postBill(companyId: number, billId: number): Promise<any> {
  return fetchApi(`/companies/${companyId}/expenses/${billId}/post`, {
    method: 'POST',
    body: JSON.stringify({}),
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
