import { Prisma } from '@prisma/client';
export type PrismaTx = any;
export type PostingLineInput = {
    accountId: number;
    debit?: Prisma.Decimal;
    credit?: Prisma.Decimal;
};
export type PostJournalEntryInput = {
    companyId: number;
    date: Date;
    description: string;
    createdByUserId?: number | null;
    reversalOfJournalEntryId?: number | null;
    reversalReason?: string | null;
    /**
     * If true, skips re-checking that accountIds belong to the company.
     * Use ONLY when the caller already validated all accounts in a tenant-safe way.
     */
    skipAccountValidation?: boolean;
    lines: PostingLineInput[];
};
/**
 * Posting Engine: creates a balanced JournalEntry + JournalLines.
 * - Enforces debit == credit using Prisma.Decimal
 * - Enforces no line has both debit and credit > 0
 * - Enforces all accounts belong to the company (multi-tenant safety)
 */
export declare function postJournalEntry(tx: PrismaTx, input: PostJournalEntryInput): Promise<any>;
//# sourceMappingURL=posting.service.d.ts.map