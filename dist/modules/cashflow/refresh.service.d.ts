import type { PrismaTx } from '../ledger/posting.service.js';
export type Scenario = 'base' | 'conservative' | 'optimistic';
export declare function refreshCashflowSnapshotsForCompany(tx: PrismaTx, args: {
    companyId: number;
    asOfDate?: Date;
    scenarios?: Scenario[];
}): Promise<void>;
//# sourceMappingURL=refresh.service.d.ts.map