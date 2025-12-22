import { Prisma } from '@prisma/client';
import { type PrismaTx } from './posting.service.js';
export type MoneyLine = {
    accountId: number;
    debit: Prisma.Decimal;
    credit: Prisma.Decimal;
};
export declare function computeNetByAccount(lines: Array<{
    accountId: number;
    debit: any;
    credit: any;
}>): Map<number, Prisma.Decimal>;
export declare function buildAdjustmentLinesFromNets(deltaNetByAccount: Map<number, Prisma.Decimal>): MoneyLine[];
export declare function diffNets(original: Map<number, Prisma.Decimal>, desired: Map<number, Prisma.Decimal>): Map<number, Prisma.Decimal>;
export declare function createReversalJournalEntry(tx: PrismaTx, input: {
    companyId: number;
    originalJournalEntryId: number;
    reversalDate: Date;
    reason?: string | null;
    createdByUserId?: number | null;
}): Promise<{
    original: any;
    reversal: any;
}>;
//# sourceMappingURL=reversal.service.d.ts.map