import { Prisma } from '@prisma/client';
import type { PrismaTx } from '../ledger/posting.service.js';
type Key = string;
type State = {
    qty: Prisma.Decimal;
    value: Prisma.Decimal;
    avg: Prisma.Decimal;
};
export declare function _test_applyWacReplay(args: {
    baselineByKey: Map<Key, {
        qty: Prisma.Decimal;
        value: Prisma.Decimal;
    }>;
    moves: Array<{
        id: number;
        date: Date;
        locationId: number;
        itemId: number;
        direction: 'IN' | 'OUT';
        quantity: Prisma.Decimal;
        unitCostApplied: Prisma.Decimal;
        totalCostApplied: Prisma.Decimal;
        referenceType: string | null;
        journalEntryId: number | null;
    }>;
}): {
    updatedOutMoves: Array<{
        id: number;
        unitCostApplied: Prisma.Decimal;
        totalCostApplied: Prisma.Decimal;
    }>;
    deltaByJournalEntryId: Map<number, Prisma.Decimal>;
    endingByKey: Map<Key, State>;
};
export declare function runInventoryRecalcForward(tx: PrismaTx, args: {
    companyId: number;
    fromDate: Date;
    now?: Date;
}): Promise<{
    companyId: number;
    closedThroughDate: string | null;
    effectiveStartDate: string;
    toDate: string;
    revaluedOutMoves: number;
    adjustedJournalEntries: number;
}>;
export declare function rebuildProjectionsFromLedger(tx: PrismaTx, args: {
    companyId: number;
    fromDate: Date;
    toDate: Date;
}): Promise<{
    companyId: number;
    fromDate: string;
    toDate: string;
    rebuilt: boolean;
}>;
export {};
//# sourceMappingURL=recalc.service.d.ts.map