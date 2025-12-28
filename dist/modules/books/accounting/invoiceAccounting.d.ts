import { Decimal } from '@prisma/client/runtime/library';
export type InvoiceLineInput = {
    quantity: Decimal | number | string;
    unitPrice: Decimal | number | string;
    discountAmount?: Decimal | number | string | null;
    taxRate?: Decimal | number | string | null;
    incomeAccountId: number;
};
export type JournalLine = {
    accountId: number;
    debit: Decimal;
    credit: Decimal;
};
export declare function computeInvoiceTotalsAndIncomeBuckets(lines: InvoiceLineInput[]): {
    subtotal: Decimal;
    taxAmount: Decimal;
    total: Decimal;
    incomeBuckets: Map<number, Decimal>;
};
export declare function assertTotalsMatchStored(total: Decimal, storedTotal: Decimal): void;
export declare function buildInvoicePostingJournalLines(args: {
    arAccountId: number;
    total: Decimal;
    incomeBuckets: Map<number, Decimal>;
    taxPayableAccountId?: number | null;
    taxAmount?: Decimal;
    cogsAccountId?: number | null;
    inventoryAssetAccountId?: number | null;
    totalCogs?: Decimal;
}): JournalLine[];
export declare function sumDebitsCredits(lines: JournalLine[]): {
    debit: Decimal;
    credit: Decimal;
};
//# sourceMappingURL=invoiceAccounting.d.ts.map