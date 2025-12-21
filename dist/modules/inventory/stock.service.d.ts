import { Prisma } from '@prisma/client';
import type { PrismaTx } from '../ledger/posting.service.js';
export type StockMoveInput = {
    companyId: number;
    warehouseId: number;
    itemId: number;
    date: Date;
    type: 'OPENING' | 'ADJUSTMENT' | 'SALE_ISSUE' | 'SALE_RETURN' | 'PURCHASE_RECEIPT' | 'TRANSFER_OUT' | 'TRANSFER_IN';
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
export declare function getCompanyInventoryConfig(tx: PrismaTx, companyId: number): Promise<{
    id: number;
    inventoryAssetAccountId: number | null;
    cogsAccountId: number | null;
    openingBalanceEquityAccountId: number | null;
    defaultWarehouseId: number | null;
}>;
/**
 * Bootstrap inventory defaults for older tenants (created before inventory features existed).
 * - Ensures Inventory/COGS/Opening Equity accounts exist and are linked on Company
 * - Ensures a default Warehouse exists and is linked on Company
 */
export declare function ensureInventoryCompanyDefaults(tx: PrismaTx, companyId: number): Promise<{
    id: number;
    defaultWarehouseId: number | null;
    inventoryAssetAccountId: number | null;
    cogsAccountId: number | null;
    openingBalanceEquityAccountId: number | null;
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
}>;
export declare function getStockBalanceForUpdate(tx: PrismaTx, input: {
    companyId: number;
    warehouseId: number;
    itemId: number;
}): Promise<{
    qtyOnHand: Prisma.Decimal;
    avgUnitCost: Prisma.Decimal;
    inventoryValue: Prisma.Decimal;
} | null>;
//# sourceMappingURL=stock.service.d.ts.map