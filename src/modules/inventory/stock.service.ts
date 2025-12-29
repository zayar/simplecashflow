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
  type:
    | 'OPENING'
    | 'ADJUSTMENT'
    | 'SALE_ISSUE'
    | 'SALE_RETURN'
    | 'PURCHASE_RECEIPT'
    | 'PURCHASE_RETURN'
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
export function _test_replayStockMovesWithBackdatedInsert(args: {
  existingMoves: StockMoveRowForReplay[];
  insert: Omit<StockMoveInput, 'totalCostApplied'> & { totalCostApplied?: Prisma.Decimal };
}): { computedInsert: { unitCostApplied: Prisma.Decimal; totalCostApplied: Prisma.Decimal }; finalBalance: ReplayBalance } {
  const moves = (args.existingMoves ?? []).slice().sort((a, b) => {
    const da = new Date(a.date).getTime();
    const db = new Date(b.date).getTime();
    if (da !== db) return da - db;
    return (a.id ?? 0) - (b.id ?? 0);
  });

  const insert = args.insert;
  const insertQty = d2(new Prisma.Decimal(insert.quantity));
  if (insertQty.lessThanOrEqualTo(0)) {
    throw Object.assign(new Error('quantity must be > 0'), { statusCode: 400 });
  }

  // In v1 we treat date as the ordering key (no intra-day ordering).
  // The DB autoincrement id means the inserted move will come AFTER any existing moves on the same date.
  const insertTime = insert.date.getTime();

  let Q = d0();
  let A = d0();
  let V = d0();

  const applyIn = (qty: Prisma.Decimal, unitCostApplied: Prisma.Decimal, totalCostApplied: Prisma.Decimal) => {
    const q = d2(qty);
    const unit = d2(unitCostApplied);
    const value = d2(totalCostApplied);
    const newQ = d2(Q.add(q));
    const newV = d2(V.add(value));
    const newA = newQ.greaterThan(0) ? d2(newV.div(newQ)) : unit;
    Q = newQ;
    V = newV;
    A = newA;
  };

  const applyOut = (qty: Prisma.Decimal, totalCostApplied: Prisma.Decimal, meta: any) => {
    const q = d2(qty);
    if (Q.lessThan(q)) {
      throw Object.assign(new Error('insufficient stock (timeline replay)'), {
        statusCode: 400,
        atDate: meta?.date ? new Date(meta.date).toISOString() : null,
        qtyOnHand: Q.toString(),
        qtyRequested: q.toString(),
        causedByMove: meta ?? null,
      });
    }
    const outValue = d2(totalCostApplied);
    const unitCost = q.greaterThan(0) ? d2(outValue.div(q)) : d2(A);
    const newQ = d2(Q.sub(q));
    const newV = d2(V.sub(outValue));
    const newA = newQ.greaterThan(0) ? d2(newV.div(newQ)) : unitCost;
    Q = newQ;
    V = newV;
    A = newA;
  };

  const computeInsertCost = (): { unitCostApplied: Prisma.Decimal; totalCostApplied: Prisma.Decimal } => {
    if (insert.direction === 'IN') {
      const unit = d2(new Prisma.Decimal(insert.unitCostApplied));
      const inValue = d2(insertQty.mul(unit));
      return { unitCostApplied: unit, totalCostApplied: inValue };
    }

    // OUT: compute using current average cost unless caller overrides totalCostApplied.
    if (Q.lessThan(insertQty)) {
      throw Object.assign(new Error('insufficient stock (backdated insert)'), {
        statusCode: 400,
        atDate: new Date(insert.date).toISOString(),
        qtyOnHand: Q.toString(),
        qtyRequested: insertQty.toString(),
      });
    }
    const overrideOutValue = insert.totalCostApplied !== undefined && insert.totalCostApplied !== null;
    const outValue = overrideOutValue ? d2(new Prisma.Decimal(insert.totalCostApplied!)) : d2(insertQty.mul(d2(A)));
    if (outValue.lessThan(0)) {
      throw Object.assign(new Error('totalCostApplied cannot be negative'), { statusCode: 400 });
    }
    const unitCost = insertQty.greaterThan(0) ? d2(outValue.div(insertQty)) : d2(A);
    return { unitCostApplied: unitCost, totalCostApplied: outValue };
  };

  let inserted = false;
  let computedInsert: { unitCostApplied: Prisma.Decimal; totalCostApplied: Prisma.Decimal } | null = null;

  for (const m of moves) {
    const mt = new Date(m.date).getTime();
    if (!inserted && mt > insertTime) {
      computedInsert = computeInsertCost();
      if (insert.direction === 'IN') applyIn(insertQty, computedInsert.unitCostApplied, computedInsert.totalCostApplied);
      else applyOut(insertQty, computedInsert.totalCostApplied, { type: insert.type, date: insert.date, referenceType: insert.referenceType, referenceId: insert.referenceId });
      inserted = true;
    }

    if (m.direction === 'IN') {
      applyIn(m.quantity, m.unitCostApplied, m.totalCostApplied);
    } else {
      applyOut(m.quantity, m.totalCostApplied, { id: m.id, type: m.type, date: m.date, referenceType: m.referenceType, referenceId: m.referenceId });
    }
  }

  if (!inserted) {
    computedInsert = computeInsertCost();
    if (insert.direction === 'IN') applyIn(insertQty, computedInsert.unitCostApplied, computedInsert.totalCostApplied);
    else applyOut(insertQty, computedInsert.totalCostApplied, { type: insert.type, date: insert.date, referenceType: insert.referenceType, referenceId: insert.referenceId });
  }

  if (!computedInsert) {
    throw Object.assign(new Error('internal error computing backdated move cost'), { statusCode: 500 });
  }

  return {
    computedInsert,
    finalBalance: { qtyOnHand: d2(Q), avgUnitCost: d2(A), inventoryValue: d2(V) },
  };
}

export async function getCompanyInventoryConfig(tx: PrismaTx, companyId: number) {
  const company = await (tx as any).company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      inventoryAssetAccountId: true,
      cogsAccountId: true,
      openingBalanceEquityAccountId: true,
      defaultLocationId: true,
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
    defaultLocationId: number | null;
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
      defaultLocationId: true,
    },
  });
  if (!company) throw Object.assign(new Error('company not found'), { statusCode: 404 });

  // 1) Default location
  let defaultLocationId: number | null = company.defaultLocationId ?? null;
  if (!defaultLocationId) {
    const loc = await (tx as any).location.findFirst({
      where: { companyId, isDefault: true },
      select: { id: true },
    });
    if (loc?.id) {
      defaultLocationId = loc.id;
    } else {
      // Create a default location
      const created = await (tx as any).location.create({
        data: { companyId, name: 'Main Location', isDefault: true },
        select: { id: true },
      });
      defaultLocationId = created.id;
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
      defaultLocationId,
      inventoryAssetAccountId,
      cogsAccountId,
      openingBalanceEquityAccountId,
    },
  });

  return {
    id: companyId,
    defaultLocationId,
    inventoryAssetAccountId,
    cogsAccountId,
    openingBalanceEquityAccountId,
  };
}

export async function ensureLocation(tx: PrismaTx, companyId: number, locationId: number) {
  const loc = await (tx as any).location.findFirst({
    where: { id: locationId, companyId },
    select: { id: true, name: true, isDefault: true },
  });
  if (!loc) {
    throw Object.assign(new Error('location not found'), { statusCode: 400 });
  }
  return loc as { id: number; name: string; isDefault: boolean };
}

// Backward-compatible alias during migration.
export async function ensureWarehouse(tx: PrismaTx, companyId: number, warehouseId: number) {
  return await ensureLocation(tx, companyId, warehouseId);
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
    locationId: input.locationId,
    itemId: input.itemId,
  });

  // Safe backdated inserts (v1): if caller allows backdating and the move is truly backdated (date < last move),
  // we cannot use the current StockBalance snapshot. Instead we replay the full move timeline, compute the inserted
  // move's cost at its chronological position, validate no negative stock occurs, then rebuild StockBalance.
  if (input.allowBackdated) {
    const lastMove = await (tx as any).stockMove.findFirst({
      where: { companyId: input.companyId, locationId: input.locationId, itemId: input.itemId },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      select: { date: true },
    });
    const isTrulyBackdated = lastMove?.date && input.date.getTime() < new Date(lastMove.date).getTime();
    if (isTrulyBackdated) {
      const existingMoves = (await (tx as any).stockMove.findMany({
        where: { companyId: input.companyId, locationId: input.locationId, itemId: input.itemId },
        orderBy: [{ date: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          date: true,
          type: true,
          direction: true,
          quantity: true,
          unitCostApplied: true,
          totalCostApplied: true,
          referenceType: true,
          referenceId: true,
        },
      })) as StockMoveRowForReplay[];

      const simulated = _test_replayStockMovesWithBackdatedInsert({ existingMoves, insert: input as any });

      const move = await (tx as any).stockMove.create({
        data: {
          companyId: input.companyId,
          locationId: input.locationId,
          itemId: input.itemId,
          date: input.date,
          type: input.type,
          direction: input.direction,
          quantity: qty,
          unitCostApplied: simulated.computedInsert.unitCostApplied,
          totalCostApplied: simulated.computedInsert.totalCostApplied,
          referenceType: input.referenceType ?? null,
          referenceId: input.referenceId ?? null,
          correlationId: input.correlationId ?? null,
          createdByUserId: input.createdByUserId ?? null,
          journalEntryId: input.journalEntryId ?? null,
        },
      });

      const balance = await (tx as any).stockBalance.upsert({
        where: {
          companyId_locationId_itemId: {
            companyId: input.companyId,
            locationId: input.locationId,
            itemId: input.itemId,
          },
        },
        update: {
          qtyOnHand: simulated.finalBalance.qtyOnHand,
          avgUnitCost: simulated.finalBalance.avgUnitCost,
          inventoryValue: simulated.finalBalance.inventoryValue,
        },
        create: {
          companyId: input.companyId,
          locationId: input.locationId,
          itemId: input.itemId,
          qtyOnHand: simulated.finalBalance.qtyOnHand,
          avgUnitCost: simulated.finalBalance.avgUnitCost,
          inventoryValue: simulated.finalBalance.inventoryValue,
        },
      });

      return {
        balance,
        move,
        unitCostApplied: simulated.computedInsert.unitCostApplied,
        totalCostApplied: simulated.computedInsert.totalCostApplied,
      };
    }
  }

  // Prevent backdated stock moves (fixes "sell 7 after buying 4" when a sale is posted later but backdated).
  // Without this, StockBalance represents "now", so a backdated sale can incorrectly pass the stock check
  // after later purchases were already posted.
  if (!input.allowBackdated) {
    const lastMove = await (tx as any).stockMove.findFirst({
      where: { companyId: input.companyId, locationId: input.locationId, itemId: input.itemId },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      select: { date: true },
    });
    if (lastMove?.date && input.date.getTime() < new Date(lastMove.date).getTime()) {
      throw Object.assign(
        new Error(
          `cannot backdate stock movement before latest movement date (${new Date(lastMove.date).toISOString().slice(0, 10)}). ` +
            `Post documents in chronological order or use today's date.`
        ),
        { statusCode: 400, latestStockMoveDate: new Date(lastMove.date).toISOString() }
      );
    }
  }

  const Q = existing ? new Prisma.Decimal(existing.qtyOnHand) : d0();
  const A = existing ? new Prisma.Decimal(existing.avgUnitCost) : d0();
  const V = existing ? new Prisma.Decimal(existing.inventoryValue) : d0();

  if (input.direction === 'OUT') {
    if (Q.lessThan(qty)) {
      throw Object.assign(new Error('insufficient stock'), {
        statusCode: 400,
        itemId: input.itemId,
        locationId: input.locationId,
        qtyOnHand: Q.toString(),
        qtyRequested: qty.toString(),
      });
    }

    // Default WAC OUT: use current average cost.
    // Optional override: allow caller to specify totalCostApplied for exact reversal flows
    // (e.g., voiding a receipt/return at the originally applied unit cost).
    const overrideOutValue = input.totalCostApplied !== undefined && input.totalCostApplied !== null;
    const outValue = overrideOutValue
      ? d2(new Prisma.Decimal(input.totalCostApplied!))
      : d2(qty.mul(d2(A)));
    if (outValue.lessThan(0)) {
      throw Object.assign(new Error('totalCostApplied cannot be negative'), { statusCode: 400 });
    }
    const unitCost = qty.greaterThan(0) ? d2(outValue.div(qty)) : d2(A);
    const newQ = d2(Q.sub(qty));
    const newV = d2(V.sub(outValue));
    const newA = newQ.greaterThan(0) ? d2(newV.div(newQ)) : unitCost;

    const balance = await (tx as any).stockBalance.upsert({
      where: {
        companyId_locationId_itemId: {
          companyId: input.companyId,
          locationId: input.locationId,
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
        locationId: input.locationId,
        itemId: input.itemId,
        qtyOnHand: newQ,
        avgUnitCost: newA,
        inventoryValue: newV,
      },
    });

    const move = await (tx as any).stockMove.create({
      data: {
        companyId: input.companyId,
        locationId: input.locationId,
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
      companyId_locationId_itemId: {
        companyId: input.companyId,
        locationId: input.locationId,
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
      locationId: input.locationId,
      itemId: input.itemId,
      qtyOnHand: newQ,
      avgUnitCost: newA,
      inventoryValue: newV,
    },
  });

  const move = await (tx as any).stockMove.create({
    data: {
      companyId: input.companyId,
      locationId: input.locationId,
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
  input: { companyId: number; locationId: number; itemId: number }
): Promise<{ qtyOnHand: Prisma.Decimal; avgUnitCost: Prisma.Decimal; inventoryValue: Prisma.Decimal } | null> {
  const { companyId, locationId, itemId } = input;
  if (!Number.isInteger(companyId) || companyId <= 0) return null;
  if (!Number.isInteger(locationId) || locationId <= 0) return null;
  if (!Number.isInteger(itemId) || itemId <= 0) return null;

  // Ensure the row exists so we can reliably acquire a row lock.
  // Uses the unique key (companyId, warehouseId, itemId).
  await (tx as any).$executeRaw`
    INSERT INTO StockBalance (companyId, warehouseId, itemId, qtyOnHand, avgUnitCost, inventoryValue, createdAt, updatedAt)
    VALUES (${companyId}, ${locationId}, ${itemId}, 0, 0, 0, NOW(), NOW())
    ON DUPLICATE KEY UPDATE updatedAt = updatedAt
  `;

  const rows = (await (tx as any).$queryRaw`
    SELECT qtyOnHand, avgUnitCost, inventoryValue
    FROM StockBalance
    WHERE companyId = ${companyId} AND warehouseId = ${locationId} AND itemId = ${itemId}
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
  input: { companyId: number; locationId: number; itemId: number }
) {
  return await lockAndGetStockBalanceRowForUpdate(tx, input);
}


