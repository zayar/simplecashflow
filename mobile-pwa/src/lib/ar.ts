import { fetchApi } from './api';

export type InvoiceStatus = 'DRAFT' | 'POSTED' | 'PARTIAL' | 'PAID';

export type InvoiceListRow = {
  id: number;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  status: InvoiceStatus;
  customerId: number | null;
  customerName: string | null;
  total: string | number;
  amountPaid?: string | number;
};

export type InvoiceDetail = InvoiceListRow & {
  subtotal?: string | number | null;
  taxAmount?: string | number | null;
  totalPaid?: number;
  remainingBalance?: number;
  payments?: {
    id: number;
    paymentDate: string;
    amount: string | number;
    bankAccount?: { id: number; code: string; name: string } | null;
    reversedAt?: string | null;
  }[];
  lines?: {
    id: number;
    itemId: number | null;
    description: string | null;
    quantity: string | number;
    unitPrice: string | number;
    taxRate?: string | number;
    discountAmount?: string | number;
  }[];
};

export type Customer = {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  currency: string | null;
};

export type Item = {
  id: number;
  name: string;
  sku: string | null;
  type: string;
  sellingPrice: string | number | null;
};

export type BankingAccountKind = 'CASH' | 'BANK' | 'E_WALLET' | 'CREDIT_CARD';

export type BankingAccountRow = {
  id: number;
  kind: BankingAccountKind;
  isPrimary: boolean;
  bankName: string | null;
  accountNumber: string | null;
  identifierCode: string | null;
  branch: string | null;
  description: string | null;
  account: { id: number; code: string; name: string; type: string };
};

export type Location = {
  id: number;
  name: string;
  isDefault: boolean;
};

export type CompanySettings = {
  companyId: number;
  name: string;
  timeZone: string | null;
  defaultLocationId: number | null;
  // Backward compatibility (older API responses)
  defaultWarehouseId?: number | null;
};

export async function getInvoices(companyId: number): Promise<InvoiceListRow[]> {
  return (await fetchApi(`/companies/${companyId}/invoices`)) as InvoiceListRow[];
}

export async function getInvoice(companyId: number, invoiceId: number): Promise<InvoiceDetail> {
  return (await fetchApi(`/companies/${companyId}/invoices/${invoiceId}`)) as InvoiceDetail;
}

export async function getCustomers(companyId: number): Promise<Customer[]> {
  return (await fetchApi(`/companies/${companyId}/customers`)) as Customer[];
}

export async function getItems(companyId: number): Promise<Item[]> {
  return (await fetchApi(`/companies/${companyId}/items`)) as Item[];
}

export async function getBankingAccounts(companyId: number): Promise<BankingAccountRow[]> {
  return (await fetchApi(`/companies/${companyId}/banking-accounts`)) as BankingAccountRow[];
}

export async function getLocations(companyId: number): Promise<Location[]> {
  return (await fetchApi(`/companies/${companyId}/locations`)) as Location[];
}

// Backward-compatible alias (deprecated)
export async function getWarehouses(companyId: number) {
  return await getLocations(companyId);
}

export async function getCompanySettings(companyId: number): Promise<CompanySettings> {
  const s = (await fetchApi(`/companies/${companyId}/settings`)) as any;
  return {
    companyId: s.companyId,
    name: s.name,
    timeZone: s.timeZone ?? null,
    defaultLocationId: s.defaultLocationId ?? s.defaultWarehouseId ?? null,
    defaultWarehouseId: s.defaultWarehouseId ?? null,
  };
}

export async function updateCompanySettings(companyId: number, payload: { defaultLocationId?: number | null; defaultWarehouseId?: number | null }) {
  return await fetchApi(`/companies/${companyId}/settings`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
}

export async function postInvoice(companyId: number, invoiceId: number) {
  return await fetchApi(`/companies/${companyId}/invoices/${invoiceId}/post`, {
    method: 'POST',
    body: JSON.stringify({})
  });
}

export async function recordInvoicePayment(
  companyId: number,
  invoiceId: number,
  payload: {
    paymentMode?: 'CASH' | 'BANK' | 'E_WALLET';
    paymentDate?: string;
    amount: number;
    bankAccountId: number;
  }
) {
  return await fetchApi(`/companies/${companyId}/invoices/${invoiceId}/payments`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function createInvoice(
  companyId: number,
  payload: {
    customerId: number;
    invoiceDate: string;
    dueDate?: string;
    customerNotes?: string;
    termsAndConditions?: string;
    lines: {
      itemId?: number;
      description?: string;
      quantity: number;
      unitPrice: number;
      taxRate?: number;
      discountAmount?: number;
    }[];
  }
) {
  return await fetchApi(`/companies/${companyId}/invoices`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}


