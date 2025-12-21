import { Prisma } from '@prisma/client';
import type { PrismaTx } from '../ledger/posting.service.js';

export type StockMoveInput = {
  companyId: number;
  warehouseId: number;
  itemId: number;
  date: Date;
  type:
    | 'OPENING'
    | 'ADJUSTMENT'
    | 'SALE_ISSUE'
    | 'SALE_RETURN'
    | 'PURCHASE_RECEIPT'
    | 'TRANSFER_OUT'
    | 'TRANSFER_IN';
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

function d0() {
  return new Prisma.Decimal(0);
}

function d2(x: Prisma.Decimal) {
  return x.toDecimalPlaces(2);
}

export async function getCompanyInventoryConfig(tx: PrismaTx, companyId: number) {
  const company = await (tx as any).company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      inventoryAssetAccountId: true,
      cogsAccountId: true,
      openingBalanceEquityAccountId: true,
      defaultWarehouseId: true,
    },
  });
  if (!company) {
    throw Object.assign(new Error('company not found'), { statusCode: 404 });
  }
  return company as {
    id: number;
    inventoryAssetAccountId: number | null;
    cogsAccountId: number | null;
    openingBalanceEquityAccountId: number | null;
    defaultWarehouseId: number | null;
  };
}

/**
 * Bootstrap inventory defaults for older tenants (created before inventory features existed).
 * - Ensures Inventory/COGS/Opening Equity accounts exist and are linked on Company
 * - Ensures a default Warehouse exists and is linked on Company
 */
export async function ensureInventoryCompanyDefaults(tx: PrismaTx, companyId: number) {
  const company = await (tx as any).company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      inventoryAssetAccountId: true,
      cogsAccountId: true,
      openingBalanceEquityAccountId: true,
      defaultWarehouseId: true,
    },
  });
  if (!company) throw Object.assign(new Error('company not found'), { statusCode: 404 });

  // 1) Default warehouse
  let defaultWarehouseId: number | null = company.defaultWarehouseId ?? null;
  if (!defaultWarehouseId) {
    const wh = await (tx as any).warehouse.findFirst({
      where: { companyId, isDefault: true },
      select: { id: true },
    });
    if (wh?.id) {
      defaultWarehouseId = wh.id;
    } else {
      // Create a default warehouse
      const created = await (tx as any).warehouse.create({
        data: { companyId, name: 'Main Warehouse', isDefault: true },
        select: { id: true },
      });
      defaultWarehouseId = created.id;
    }
  }

  // 2) Accounts
  let inventoryAssetAccountId: number | null = company.inventoryAssetAccountId ?? null;
  let cogsAccountId: number | null = company.cogsAccountId ?? null;
  let openingBalanceEquityAccountId: number | null = company.openingBalanceEquityAccountId ?? null;

  if (!inventoryAssetAccountId) {
    const acc = await (tx as any).account.findFirst({
      where: { companyId, type: 'ASSET', code: '1300' },
      select: { id: true },
    });
    inventoryAssetAccountId =
      acc?.id ??
      (
        await (tx as any).account.create({
          data: {
            companyId,
            code: '1300',
            name: 'Inventory',
            type: 'ASSET',
            normalBalance: 'DEBIT',
            reportGroup: 'INVENTORY',
            cashflowActivity: 'OPERATING',
          },
          select: { id: true },
        })
      ).id;
  }

  if (!cogsAccountId) {
    const acc = await (tx as any).account.findFirst({
      where: { companyId, type: 'EXPENSE', code: '5001' },
      select: { id: true },
    });
    cogsAccountId =
      acc?.id ??
      (
        await (tx as any).account.create({
          data: {
            companyId,
            code: '5001',
            name: 'Cost of Goods Sold',
            type: 'EXPENSE',
            normalBalance: 'DEBIT',
            reportGroup: 'COGS',
            cashflowActivity: 'OPERATING',
          },
          select: { id: true },
        })
      ).id;
  }

  if (!openingBalanceEquityAccountId) {
    const acc = await (tx as any).account.findFirst({
      where: { companyId, type: 'EQUITY', code: '3050' },
      select: { id: true },
    });
    openingBalanceEquityAccountId =
      acc?.id ??
      (
        await (tx as any).account.create({
          data: {
            companyId,
            code: '3050',
            name: 'Opening Balance Equity',
            type: 'EQUITY',
            normalBalance: 'CREDIT',
            reportGroup: 'EQUITY',
            cashflowActivity: 'FINANCING',
          },
          select: { id: true },
        })
      ).id;
  }

  // Persist links (idempotent update)
  await (tx as any).company.update({
    where: { id: companyId },
    data: {
      defaultWarehouseId,
      inventoryAssetAccountId,
      cogsAccountId,
      openingBalanceEquityAccountId,
    },
  });

  return {
    id: companyId,
    defaultWarehouseId,
    inventoryAssetAccountId,
    cogsAccountId,
    openingBalanceEquityAccountId,
  };
}

export async function ensureWarehouse(tx: PrismaTx, companyId: number, warehouseId: number) {
  const wh = await (tx as any).warehouse.findFirst({
    where: { id: warehouseId, companyId },
    select: { id: true, name: true, isDefault: true },
  });
  if (!wh) {
    throw Object.assign(new Error('warehouse not found'), { statusCode: 400 });
  }
  return wh as { id: number; name: string; isDefault: boolean };
}

export async function ensureInventoryItem(tx: PrismaTx, companyId: number, itemId: number) {
  const item = await (tx as any).item.findFirst({
    where: { id: itemId, companyId },
    select: { id: true, type: true, trackInventory: true },
  });
  if (!item) throw Object.assign(new Error('item not found'), { statusCode: 400 });
  if (item.type !== 'GOODS') throw Object.assign(new Error('only GOODS can be inventoried'), { statusCode: 400 });
  if (!item.trackInventory) {
    throw Object.assign(new Error('item.trackInventory must be enabled'), { statusCode: 400 });
  }
  return item as { id: number; type: 'GOODS'; trackInventory: boolean };
}

/**
 * Apply a single stock movement under weighted average costing (WAC).
 * Updates StockBalance and writes StockMove (immutable audit).
 *
 * NOTE: Caller must ensure concurrency safety (e.g., Redis lock per company+warehouse+item).
 */
export async function applyStockMoveWac(tx: PrismaTx, input: Omit<StockMoveInput, 'totalCostApplied'> & {
  totalCostApplied?: Prisma.Decimal;
}) {
  const qty = d2(input.quantity);
  if (qty.lessThanOrEqualTo(0)) {
    throw Object.assign(new Error('quantity must be > 0'), { statusCode: 400 });
  }

  // DB-level safety: lock the StockBalance row inside the current transaction so concurrent writes
  // cannot oversell or compute WAC based on stale balances. This makes negative inventory prevention
  // independent of Redis availability.
  const existing = await lockAndGetStockBalanceRowForUpdate(tx, {
    companyId: input.companyId,
    warehouseId: input.warehouseId,
    itemId: input.itemId,
  });

  const Q = existing ? new Prisma.Decimal(existing.qtyOnHand) : d0();
  const A = existing ? new Prisma.Decimal(existing.avgUnitCost) : d0();
  const V = existing ? new Prisma.Decimal(existing.inventoryValue) : d0();

  if (input.direction === 'OUT') {
    if (Q.lessThan(qty)) {
      throw Object.assign(new Error('insufficient stock'), {
        statusCode: 400,
        itemId: input.itemId,
        warehouseId: input.warehouseId,
        qtyOnHand: Q.toString(),
        qtyRequested: qty.toString(),
      });
    }

    const unitCost = d2(A);
    const outValue = d2(qty.mul(unitCost));
    const newQ = d2(Q.sub(qty));
    const newV = d2(V.sub(outValue));
    const newA = newQ.greaterThan(0) ? d2(newV.div(newQ)) : unitCost;

    const balance = await (tx as any).stockBalance.upsert({
      where: {
        companyId_warehouseId_itemId: {
          companyId: input.companyId,
          warehouseId: input.warehouseId,
          itemId: input.itemId,
        },
      },
      update: {
        qtyOnHand: newQ,
        avgUnitCost: newA,
        inventoryValue: newV,
      },
      create: {
        companyId: input.companyId,
        warehouseId: input.warehouseId,
        itemId: input.itemId,
        qtyOnHand: newQ,
        avgUnitCost: newA,
        inventoryValue: newV,
      },
    });

    const move = await (tx as any).stockMove.create({
      data: {
        companyId: input.companyId,
        warehouseId: input.warehouseId,
        itemId: input.itemId,
        date: input.date,
        type: input.type,
        direction: input.direction,
        quantity: qty,
        unitCostApplied: unitCost,
        totalCostApplied: outValue,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        correlationId: input.correlationId ?? null,
        createdByUserId: input.createdByUserId ?? null,
        journalEntryId: input.journalEntryId ?? null,
      },
    });

    return {
      balance,
      move,
      unitCostApplied: unitCost,
      totalCostApplied: outValue,
    };
  }

  // IN
  const unitCost = d2(input.unitCostApplied);
  const inValue = d2(qty.mul(unitCost));
  const newQ = d2(Q.add(qty));
  const newV = d2(V.add(inValue));
  const newA = newQ.greaterThan(0) ? d2(newV.div(newQ)) : d2(unitCost);

  const balance = await (tx as any).stockBalance.upsert({
    where: {
      companyId_warehouseId_itemId: {
        companyId: input.companyId,
        warehouseId: input.warehouseId,
        itemId: input.itemId,
      },
    },
    update: {
      qtyOnHand: newQ,
      avgUnitCost: newA,
      inventoryValue: newV,
    },
    create: {
      companyId: input.companyId,
      warehouseId: input.warehouseId,
      itemId: input.itemId,
      qtyOnHand: newQ,
      avgUnitCost: newA,
      inventoryValue: newV,
    },
  });

  const move = await (tx as any).stockMove.create({
    data: {
      companyId: input.companyId,
      warehouseId: input.warehouseId,
      itemId: input.itemId,
      date: input.date,
      type: input.type,
      direction: input.direction,
      quantity: qty,
      unitCostApplied: unitCost,
      totalCostApplied: inValue,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      correlationId: input.correlationId ?? null,
      createdByUserId: input.createdByUserId ?? null,
      journalEntryId: input.journalEntryId ?? null,
    },
  });

  return {
    balance,
    move,
    unitCostApplied: unitCost,
    totalCostApplied: inValue,
  };
}

async function lockAndGetStockBalanceRowForUpdate(
  tx: PrismaTx,
  input: { companyId: number; warehouseId: number; itemId: number }
): Promise<{ qtyOnHand: Prisma.Decimal; avgUnitCost: Prisma.Decimal; inventoryValue: Prisma.Decimal } | null> {
  const { companyId, warehouseId, itemId } = input;
  if (!Number.isInteger(companyId) || companyId <= 0) return null;
  if (!Number.isInteger(warehouseId) || warehouseId <= 0) return null;
  if (!Number.isInteger(itemId) || itemId <= 0) return null;

  // Ensure the row exists so we can reliably acquire a row lock.
  // Uses the unique key (companyId, warehouseId, itemId).
  await (tx as any).$executeRaw`
    INSERT INTO StockBalance (companyId, warehouseId, itemId, qtyOnHand, avgUnitCost, inventoryValue, createdAt, updatedAt)
    VALUES (${companyId}, ${warehouseId}, ${itemId}, 0, 0, 0, NOW(), NOW())
    ON DUPLICATE KEY UPDATE updatedAt = updatedAt
  `;

  const rows = (await (tx as any).$queryRaw`
    SELECT qtyOnHand, avgUnitCost, inventoryValue
    FROM StockBalance
    WHERE companyId = ${companyId} AND warehouseId = ${warehouseId} AND itemId = ${itemId}
    FOR UPDATE
  `) as Array<{ qtyOnHand: any; avgUnitCost: any; inventoryValue: any }>;

  const r = rows?.[0];
  if (!r) return null;
  return {
    qtyOnHand: new Prisma.Decimal(r.qtyOnHand),
    avgUnitCost: new Prisma.Decimal(r.avgUnitCost),
    inventoryValue: new Prisma.Decimal(r.inventoryValue),
  };
}

export async function getStockBalanceForUpdate(
  tx: PrismaTx,
  input: { companyId: number; warehouseId: number; itemId: number }
) {
  return await lockAndGetStockBalanceRowForUpdate(tx, input);
}


