import { fetchApi } from './api';

export type ExpenseStatus = 'DRAFT' | 'APPROVED' | 'POSTED' | 'PARTIAL' | 'PAID' | 'VOID';

export type ExpenseListRow = {
  id: number;
  expenseNumber: string;
  vendorId: number | null;
  vendorName: string | null;
  status: ExpenseStatus;
  amount: string | number;
  amountPaid?: string | number;
  expenseDate: string;
  dueDate: string | null;
  attachmentUrl?: string | null;
};

export type ExpenseDetail = ExpenseListRow & {
  description?: string | null;
  currency?: string | null;
  expenseAccount?: { id: number; code: string; name: string; type: string } | null;
  totalPaid?: string | number;
  remainingBalance?: string | number;
  payments?: {
    id: number;
    paymentDate: string;
    amount: string | number;
    bankAccount?: { id: number; code?: string; name: string } | null;
    reversedAt?: string | null;
  }[];
};

export type Vendor = {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  createdAt?: string;
};

export type Account = {
  id: number;
  code: string;
  name: string;
  type: string;
  isActive?: boolean;
};

export async function getExpenses(companyId: number): Promise<ExpenseListRow[]> {
  return (await fetchApi(`/companies/${companyId}/expenses`)) as ExpenseListRow[];
}

export async function getExpense(companyId: number, expenseId: number): Promise<ExpenseDetail> {
  return (await fetchApi(`/companies/${companyId}/expenses/${expenseId}`)) as ExpenseDetail;
}

export async function getVendors(companyId: number): Promise<Vendor[]> {
  return (await fetchApi(`/companies/${companyId}/vendors`)) as Vendor[];
}

export async function getVendor(companyId: number, vendorId: number): Promise<Vendor> {
  return (await fetchApi(`/companies/${companyId}/vendors/${vendorId}`)) as Vendor;
}

export async function createVendor(
  companyId: number,
  payload: { name: string; email?: string | null; phone?: string | null }
): Promise<Vendor> {
  return (await fetchApi(`/companies/${companyId}/vendors`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })) as Vendor;
}

export async function updateVendor(
  companyId: number,
  vendorId: number,
  payload: { name?: string; email?: string | null; phone?: string | null }
): Promise<Vendor> {
  return (await fetchApi(`/companies/${companyId}/vendors/${vendorId}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  })) as Vendor;
}

export async function getAccounts(companyId: number): Promise<Account[]> {
  return (await fetchApi(`/companies/${companyId}/accounts`)) as Account[];
}

export async function createExpense(
  companyId: number,
  payload: {
    vendorId?: number | null;
    expenseDate?: string;
    dueDate?: string;
    description: string;
    amount: number;
    currency?: string;
    expenseAccountId?: number | null;
    attachmentUrl?: string | null;
  }
) {
  return await fetchApi(`/companies/${companyId}/expenses`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function updateExpense(
  companyId: number,
  expenseId: number,
  payload: {
    vendorId?: number | null;
    expenseDate?: string;
    dueDate?: string | null;
    description?: string;
    amount?: number;
    expenseAccountId?: number | null;
    attachmentUrl?: string | null;
  }
) {
  return await fetchApi(`/companies/${companyId}/expenses/${expenseId}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
}

export async function postExpense(companyId: number, expenseId: number, payload: { bankAccountId?: number } = {}) {
  return await fetchApi(`/companies/${companyId}/expenses/${expenseId}/post`, {
    method: 'POST',
    body: JSON.stringify(payload ?? {})
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Expense Attachment Upload
// ──────────────────────────────────────────────────────────────────────────────

export async function uploadExpenseAttachment(
  companyId: number,
  file: File
): Promise<{ url: string }> {
  const formData = new FormData();
  formData.append('file', file);
  return (await fetchApi(`/companies/${companyId}/uploads/expense-attachment`, {
    method: 'POST',
    body: formData
  })) as { url: string };
}


