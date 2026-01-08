import type { PrismaTx } from '../ledger/posting.service.js';
/**
 * Ensures the company has a GRNI (Goods Received Not Invoiced) liability account configured.
 * This is used to recognize inventory at receipt time without posting AP until the bill arrives.
 */
export declare function ensureGrniAccount(tx: PrismaTx, companyId: number): Promise<number>;
//# sourceMappingURL=grni.service.d.ts.map