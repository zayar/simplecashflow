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
  hasPendingPaymentProof?: boolean;
  pendingPaymentProofCount?: number;
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

export async function createCustomer(
  companyId: number,
  payload: { name: string; email?: string | null; phone?: string | null; currency?: string | null }
): Promise<Customer> {
  return (await fetchApi(`/companies/${companyId}/customers`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })) as Customer;
}

export async function updateCustomer(
  companyId: number,
  customerId: number,
  payload: { name: string; email?: string | null; phone?: string | null; currency?: string | null }
): Promise<Customer> {
  return (await fetchApi(`/companies/${companyId}/customers/${customerId}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  })) as Customer;
}

export async function getCustomer(companyId: number, customerId: number): Promise<Customer> {
  return (await fetchApi(`/companies/${companyId}/customers/${customerId}`)) as Customer;
}

export async function createItem(
  companyId: number,
  payload: { name: string; sellingPrice?: number; sku?: string | null; type?: 'GOODS' | 'SERVICE' }
): Promise<Item> {
  return (await fetchApi(`/companies/${companyId}/items`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })) as Item;
}

export async function updateItem(
  companyId: number,
  itemId: number,
  payload: { name?: string; sellingPrice?: number; sku?: string | null; type?: 'GOODS' | 'SERVICE' }
): Promise<Item> {
  return (await fetchApi(`/companies/${companyId}/items/${itemId}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  })) as Item;
}

export async function getItem(companyId: number, itemId: number): Promise<Item> {
  return (await fetchApi(`/companies/${companyId}/items/${itemId}`)) as Item;
}

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

export type PaymentQrCodes = {
  kbz?: string | null;
  ayaPay?: string | null;
  uabPay?: string | null;
  aPlus?: string | null;
};

export type PublicInvoiceResponse = {
  company: {
    id: number;
    name: string;
    timeZone: string | null;
    template: InvoiceTemplate;
    paymentQrCodes?: PaymentQrCodes | null;
  };
  invoice: {
    id: number;
    invoiceNumber: string;
    status: string;
    invoiceDate: string;
    dueDate: string | null;
    currency: string | null;
    subtotal: string | number;
    taxAmount: string | number;
    total: string | number;
    totalPaid: number;
    remainingBalance: number;
    customerName: string | null;
    locationName: string | null;
    customerNotes: string | null;
    termsAndConditions: string | null;
    pendingPaymentProofs?: { url: string; submittedAt: string; note?: string | null }[] | null;
    lines: {
      id: number;
      quantity: string | number;
      unitPrice: string | number;
      discountAmount: string | number;
      description: string | null;
      itemName: string | null;
    }[];
  };
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

export async function getInvoiceTemplate(companyId: number): Promise<InvoiceTemplate> {
  return (await fetchApi(`/companies/${companyId}/invoice-template`)) as InvoiceTemplate;
}

export async function createPublicInvoiceLink(companyId: number, invoiceId: number): Promise<{ token: string }> {
  return (await fetchApi(`/companies/${companyId}/invoices/${invoiceId}/public-link`, {
    method: 'POST',
    body: JSON.stringify({})
  })) as { token: string };
}

export async function getPublicInvoice(token: string): Promise<PublicInvoiceResponse> {
  const safe = encodeURIComponent(token);
  return (await fetchApi(`/public/invoices/${safe}`)) as PublicInvoiceResponse;
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
    attachmentUrl?: string; // Payment proof image URL
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

// ──────────────────────────────────────────────────────────────────────────────
// Payment QR Codes
// ──────────────────────────────────────────────────────────────────────────────

export async function getPaymentQrCodes(companyId: number): Promise<PaymentQrCodes> {
  return (await fetchApi(`/companies/${companyId}/payment-qr-codes`)) as PaymentQrCodes;
}

export async function uploadPaymentQrCode(
  companyId: number,
  method: 'kbz' | 'ayaPay' | 'uabPay' | 'aPlus',
  file: File
): Promise<{ url: string }> {
  const formData = new FormData();
  formData.append('file', file);
  return (await fetchApi(`/companies/${companyId}/payment-qr-codes/${method}`, {
    method: 'POST',
    body: formData
  })) as { url: string };
}

export async function deletePaymentQrCode(
  companyId: number,
  method: 'kbz' | 'ayaPay' | 'uabPay' | 'aPlus'
): Promise<PaymentQrCodes> {
  return (await fetchApi(`/companies/${companyId}/payment-qr-codes/${method}`, {
    method: 'DELETE',
  })) as PaymentQrCodes;
}

// ──────────────────────────────────────────────────────────────────────────────
// Public Payment Proof Upload
// ──────────────────────────────────────────────────────────────────────────────

export async function uploadPublicPaymentProof(
  token: string,
  file: File
): Promise<{ url: string }> {
  const formData = new FormData();
  formData.append('file', file);
  const safeToken = encodeURIComponent(token);
  return (await fetchApi(`/public/invoices/${safeToken}/payment-proof`, {
    method: 'POST',
    body: formData
  })) as { url: string };
}

export async function deletePublicPaymentProof(token: string, url?: string): Promise<{ success: true; pendingPaymentProofs: any[] }> {
  const safeToken = encodeURIComponent(token);
  const qs = url ? `?url=${encodeURIComponent(url)}` : '';
  return (await fetchApi(`/public/invoices/${safeToken}/payment-proof${qs}`, {
    method: 'DELETE',
  })) as { success: true; pendingPaymentProofs: any[] };
}


