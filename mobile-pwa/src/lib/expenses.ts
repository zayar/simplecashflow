import { fetchApi } from './api';

export type ExpenseStatus = 'DRAFT' | 'POSTED' | 'PARTIAL' | 'PAID';

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

export async function getVendors(companyId: number): Promise<Vendor[]> {
  return (await fetchApi(`/companies/${companyId}/vendors`)) as Vendor[];
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
  }
) {
  return await fetchApi(`/companies/${companyId}/expenses`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function postExpense(companyId: number, expenseId: number, payload: { bankAccountId?: number } = {}) {
  return await fetchApi(`/companies/${companyId}/expenses/${expenseId}/post`, {
    method: 'POST',
    body: JSON.stringify(payload ?? {})
  });
}


