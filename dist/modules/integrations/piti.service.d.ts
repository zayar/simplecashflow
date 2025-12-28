export type PitiSaleUpsertRequest = {
    saleId: string;
    saleNumber?: string;
    saleDate?: string;
    currency?: string | null;
    customer?: {
        externalCustomerId?: string;
        name: string;
        phone?: string | null;
        email?: string | null;
    } | null;
    lines: Array<{
        externalProductId?: string;
        sku?: string | null;
        name: string;
        quantity: number;
        unitPrice: number;
        discountAmount?: number | null;
        taxRate?: number | null;
    }>;
    payments?: Array<{
        cashflowAccountId?: number;
        cashflowAccountCode?: string;
        amount: number;
        paidAt?: string;
    }> | null;
    options?: {
        autoCreateCustomer?: boolean;
        autoCreateItems?: boolean;
        postInvoice?: boolean;
        recordPayment?: boolean;
    };
};
export type PitiSaleUpsertResult = {
    saleId: string;
    invoiceId: number;
    invoiceNumber: string;
    invoiceStatus: string;
    journalEntryId: number | null;
    paymentIds: number[];
};
export type PitiRefundUpsertRequest = {
    refundId: string;
    saleId?: string | null;
    refundNumber?: string;
    refundDate?: string;
    currency?: string | null;
    customer?: {
        externalCustomerId?: string;
        name: string;
        phone?: string | null;
        email?: string | null;
    } | null;
    lines: Array<{
        externalProductId?: string;
        sku?: string | null;
        name: string;
        quantity: number;
        unitPrice: number;
        discountAmount?: number | null;
        taxRate?: number | null;
    }>;
};
export type PitiRefundUpsertResult = {
    refundId: string;
    creditNoteId: number;
    creditNoteNumber: string;
    status: string;
    journalEntryId: number | null;
};
/**
 * Creates (or replays) a posted Cashflow Invoice from a Piti COMPLETED sale.
 *
 * Inventory policy:
 * - We DO create/reuse `Item` records for reporting.
 * - We ALWAYS force `trackInventory=false` for integration-created items to avoid Cashflow stock moves
 *   (Piti remains SoT for operational inventory).
 */
export declare function upsertPostedInvoiceFromPitiSale(args: {
    prisma: any;
    companyId: number;
    idempotencyKey: string;
    payload: PitiSaleUpsertRequest;
    userId?: number | null;
}): Promise<PitiSaleUpsertResult>;
/**
 * Creates (or replays) a posted Cashflow CreditNote from a Piti refund/return.
 *
 * Inventory policy:
 * - No stock moves (items are non-tracked).
 * - Finance only: reverse revenue + tax and reduce AR.
 */
export declare function upsertPostedCreditNoteFromPitiRefund(args: {
    prisma: any;
    companyId: number;
    idempotencyKey: string;
    payload: PitiRefundUpsertRequest;
    userId?: number | null;
}): Promise<PitiRefundUpsertResult>;
//# sourceMappingURL=piti.service.d.ts.map