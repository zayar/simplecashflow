import type { PrismaTx } from '../modules/ledger/posting.service.js';
export declare function dayAfter(d: Date): Date;
export declare function getClosedThroughDate(tx: PrismaTx, companyId: number): Promise<Date | null>;
/**
 * Business rule:
 * - Backdating is allowed only if transactionDate is within an OPEN period.
 * - If transactionDate falls on/before the latest closed PeriodClose.toDate, block.
 *
 * We treat PeriodClose.toDate as inclusive at the day granularity (normalized to day).
 */
export declare function assertOpenPeriodOrThrow(tx: PrismaTx, args: {
    companyId: number;
    transactionDate: Date;
    action: string;
}): Promise<{
    closedThroughDate: Date | null;
}>;
//# sourceMappingURL=periodClosePolicy.d.ts.map