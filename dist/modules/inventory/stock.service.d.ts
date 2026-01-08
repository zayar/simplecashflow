import { Prisma } from '@prisma/client';
import type { PrismaTx } from '../ledger/posting.service.js';
export type StockMoveInput = {
    companyId: number;
    locationId: number;
    itemId: number;
    date: Date;
    /**
     * Inventory engine v1 stores only the current StockBalance (not a dated ledger of balances).
     * To keep WAC and "no oversell" correct, we must apply stock moves in chronological order.
     *
     * If allowBackdated is false (default), we reject moves dated earlier than the latest StockMove
     * for the same (companyId, locationId, itemId).
     */
    allowBackdated?: boolean;
    type: 'OPENING' | 'ADJUSTMENT' | 'SALE_ISSUE' | 'SALE_RETURN' | 'PURCHASE_RECEIPT' | 'PURCHASE_RETURN' | 'TRANSFER_OUT' | 'TRANSFER_IN';
    direction: 'IN' | 'OUT';
    quantity: Prisma.Decimal;
    unitCostApplied: Prisma.Decimal;
    totalCostApplied: Prisma.Decimal;
    referenceType?: string | null;
    referenceId?: string | null;
    correlationId?: string | null;
    createdByUserId?: number | null;
    journalEntryId?: number | null;
};
type StockMoveRowForReplay = {
    id: number;
    date: Date;
    type: StockMoveInput['type'];
    direction: StockMoveInput['direction'];
    quantity: Prisma.Decimal;
    unitCostApplied: Prisma.Decimal;
    totalCostApplied: Prisma.Decimal;
    referenceType: string | null;
    referenceId: string | null;
};
type ReplayBalance = {
    qtyOnHand: Prisma.Decimal;
    avgUnitCost: Prisma.Decimal;
    inventoryValue: Prisma.Decimal;
};
/**
 * Pure replay helper used by `applyStockMoveWac` for safe backdated inserts.
 *
 * Key invariant:
 * - We DO NOT rewrite existing StockMove costs (immutability/audit).
 * - For a backdated insert, we compute the inserted move's cost at its position in the move timeline,
 *   then validate that NO move in the resulting timeline causes negative stock.
 * - The caller can then rebuild the StockBalance "current snapshot" from the replay result.
 */
export declare function _test_replayStockMovesWithBackdatedInsert(args: {
    existingMoves: StockMoveRowForReplay[];
    insert: Omit<StockMoveInput, 'totalCostApplied'> & {
        totalCostApplied?: Prisma.Decimal;
    };
}): {
    computedInsert: {
        unitCostApplied: Prisma.Decimal;
        totalCostApplied: Prisma.Decimal;
    };
    finalBalance: ReplayBalance;
};
type StockMoveRowForValueReplay = {
    id: number;
    date: Date;
    type: StockMoveInput['type'] | 'VALUE_ADJUSTMENT';
    direction: StockMoveInput['direction'];
    quantity: Prisma.Decimal;
    unitCostApplied: Prisma.Decimal;
    totalCostApplied: Prisma.Decimal;
    referenceType: string | null;
    referenceId: string | null;
};
/**
 * Replay helper for value-only inserts (e.g., landed cost capitalization).
 * Inserts an IN move with quantity = 0 and totalCostApplied = valueDelta.
 *
 * Invariant: stock on hand at insert point must be > 0 (otherwise avg cost is undefined).
 */
export declare function _test_replayStockMovesWithBackdatedValueInsert(args: {
    existingMoves: StockMoveRowForValueReplay[];
    insert: {
        date: Date;
        valueDelta: Prisma.Decimal;
        referenceType?: string | null;
        referenceId?: string | null;
    };
}): {
    finalBalance: ReplayBalance;
};
export declare function applyStockValueAdjustmentWac(tx: PrismaTx, input: {
    companyId: number;
    locationId: number;
    itemId: number;
    date: Date;
    valueDelta: Prisma.Decimal;
    allowBackdated?: boolean;
    referenceType?: string | null;
    referenceId?: string | null;
    correlationId?: string | null;
    createdByUserId?: number | null;
    journalEntryId?: number | null;
}): Promise<{
    balance: any;
    move: any;
    requiresInventoryRecalcFromDate: Date | null;
}>;
export declare function getCompanyInventoryConfig(tx: PrismaTx, companyId: number): Promise<{
    id: number;
    inventoryAssetAccountId: number | null;
    cogsAccountId: number | null;
    openingBalanceEquityAccountId: number | null;
    defaultLocationId: number | null;
}>;
/**
 * Bootstrap inventory defaults for older tenants (created before inventory features existed).
 * - Ensures Inventory/COGS/Opening Equity accounts exist and are linked on Company
 * - Ensures a default Warehouse exists and is linked on Company
 */
export declare function ensureInventoryCompanyDefaults(tx: PrismaTx, companyId: number): Promise<{
    id: number;
    defaultLocationId: number | null;
    inventoryAssetAccountId: number | null;
    cogsAccountId: number | null;
    openingBalanceEquityAccountId: number | null;
}>;
export declare function ensureLocation(tx: PrismaTx, companyId: number, locationId: number): Promise<{
    id: number;
    name: string;
    isDefault: boolean;
}>;
export declare function ensureWarehouse(tx: PrismaTx, companyId: number, warehouseId: number): Promise<{
    id: number;
    name: string;
    isDefault: boolean;
}>;
export declare function ensureInventoryItem(tx: PrismaTx, companyId: number, itemId: number): Promise<{
    id: number;
    type: "GOODS";
    trackInventory: boolean;
}>;
/**
 * Apply a single stock movement under weighted average costing (WAC).
 * Updates StockBalance and writes StockMove (immutable audit).
 *
 * NOTE: Caller must ensure concurrency safety (e.g., Redis lock per company+warehouse+item).
 */
export declare function applyStockMoveWac(tx: PrismaTx, input: Omit<StockMoveInput, 'totalCostApplied'> & {
    totalCostApplied?: Prisma.Decimal;
}): Promise<{
    balance: any;
    move: any;
    unitCostApplied: Prisma.Decimal;
    totalCostApplied: Prisma.Decimal;
    requiresInventoryRecalcFromDate: Date;
} | {
    balance: any;
    move: any;
    unitCostApplied: Prisma.Decimal;
    totalCostApplied: Prisma.Decimal;
    requiresInventoryRecalcFromDate: null;
}>;
export declare function getStockBalanceForUpdate(tx: PrismaTx, input: {
    companyId: number;
    locationId: number;
    itemId: number;
}): Promise<{
    qtyOnHand: Prisma.Decimal;
    avgUnitCost: Prisma.Decimal;
    inventoryValue: Prisma.Decimal;
} | null>;
export {};
//# sourceMappingURL=stock.service.d.ts.map