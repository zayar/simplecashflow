import type { PrismaTx } from '../ledger/posting.service.js';
/**
 * Ensures the company has a Purchase Price Variance (PPV) account configured.
 * Used when clearing GRNI and the vendor bill total differs from receipt total.
 */
export declare function ensurePurchasePriceVarianceAccount(tx: PrismaTx, companyId: number): Promise<number>;
//# sourceMappingURL=ppv.service.d.ts.map