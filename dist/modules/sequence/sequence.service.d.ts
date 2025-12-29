import { Prisma } from '@prisma/client';
type PrismaTx = Prisma.TransactionClient;
/**
 * Atomically allocates a sequence number for a given (companyId, key).
 * Stores nextNumber as the next value to allocate.
 */
export declare function nextCompanySequenceNumber(tx: PrismaTx, companyId: number, key: string): Promise<number>;
export declare function nextPurchaseBillNumber(tx: PrismaTx, companyId: number): Promise<string>;
export declare function nextCreditNoteNumber(tx: PrismaTx, companyId: number): Promise<string>;
export declare function nextVendorCreditNumber(tx: PrismaTx, companyId: number): Promise<string>;
export declare function nextJournalEntryNumber(tx: PrismaTx, companyId: number, date: Date): Promise<string>;
export {};
//# sourceMappingURL=sequence.service.d.ts.map