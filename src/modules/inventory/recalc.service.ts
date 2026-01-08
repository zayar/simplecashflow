import { Prisma } from '@prisma/client';
import type { PrismaTx } from '../ledger/posting.service.js';
import { postJournalEntry } from '../ledger/posting.service.js';
import { normalizeToDay } from '../../utils/date.js';
import { assertOpenPeriodOrThrow, dayAfter, getClosedThroughDate } from '../../utils/periodClosePolicy.js';
import { randomUUID } from 'node:crypto';

function d2(x: Prisma.Decimal | number | string) {
  return new Prisma.Decimal(x).toDecimalPlaces(2);
}

function endOfDayUTC(day: Date): Date {
  const d = normalizeToDay(day);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

type Key = string; // `${locationId}:${itemId}`

type State = {
  qty: Prisma.Decimal;
  value: Prisma.Decimal;
  avg: Prisma.Decimal;
};

export function _test_applyWacReplay(args: {
  baselineByKey: Map<Key, { qty: Prisma.Decimal; value: Prisma.Decimal }>;
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
  updatedOutMoves: Array<{ id: number; unitCostApplied: Prisma.Decimal; totalCostApplied: Prisma.Decimal }>;
  deltaByJournalEntryId: Map<number, Prisma.Decimal>;
  endingByKey: Map<Key, State>;
} {
  const state = new Map<Key, State>();
  for (const [k, b] of args.baselineByKey.entries()) {
    const qty = d2(b.qty);
    const value = d2(b.value);
    const avg = qty.equals(0) ? new Prisma.Decimal(0) : d2(value.div(qty));
    state.set(k, { qty, value, avg });
  }

  const updatedOutMoves: Array<{ id: number; unitCostApplied: Prisma.Decimal; totalCostApplied: Prisma.Decimal }> = [];
  const deltaByJournalEntryId = new Map<number, Prisma.Decimal>();

  const moves = (args.moves ?? []).slice().sort((a, b) => {
    const da = new Date(a.date).getTime();
    const db = new Date(b.date).getTime();
    if (da !== db) return da - db;
    return (a.id ?? 0) - (b.id ?? 0);
  });

  for (const m of moves) {
    const key = `${m.locationId}:${m.itemId}`;
    const st = state.get(key) ?? { qty: new Prisma.Decimal(0), value: new Prisma.Decimal(0), avg: new Prisma.Decimal(0) };
    const qty = d2(m.quantity);
    const totalStored = d2(m.totalCostApplied);

    if (m.direction === 'IN') {
      st.qty = d2(st.qty.add(qty));
      st.value = d2(st.value.add(totalStored));
      st.avg = st.qty.equals(0) ? new Prisma.Decimal(0) : d2(st.value.div(st.qty));
      state.set(key, st);
      continue;
    }

    // OUT
    // Do not revalue "void" style moves that explicitly preserve historical unit cost/value.
    const ref = (m.referenceType ?? '').toString();
    const isVoidLike = ref.endsWith('Void') || ref.endsWith('VOID');

    const desiredTotal = isVoidLike ? totalStored : d2(qty.mul(st.avg));
    const desiredUnit = qty.equals(0) ? d2(st.avg) : d2(desiredTotal.div(qty));

    if (!isVoidLike && (!desiredTotal.equals(totalStored) || !desiredUnit.equals(d2(m.unitCostApplied)))) {
      updatedOutMoves.push({ id: m.id, unitCostApplied: desiredUnit, totalCostApplied: desiredTotal });
      if (m.journalEntryId) {
        const prev = deltaByJournalEntryId.get(m.journalEntryId) ?? new Prisma.Decimal(0);
        deltaByJournalEntryId.set(m.journalEntryId, d2(prev.add(desiredTotal.sub(totalStored))));
      }
    }

    st.qty = d2(st.qty.sub(qty));
    st.value = d2(st.value.sub(desiredTotal));
    st.avg = st.qty.equals(0) ? new Prisma.Decimal(0) : d2(st.value.div(st.qty));
    state.set(key, st);
  }

  return { updatedOutMoves, deltaByJournalEntryId, endingByKey: state };
}

async function computeBaselineByKey(tx: PrismaTx, companyId: number, startInclusive: Date): Promise<Map<Key, { qty: Prisma.Decimal; value: Prisma.Decimal }>> {
  // Baseline is the net position strictly before startInclusive.
  // Using stored totalCostApplied for OUT moves is correct because the backdated change is at/after startInclusive.
  const rows = (await (tx as any).$queryRaw`
    SELECT
      warehouseId AS locationId,
      itemId AS itemId,
      SUM(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END) AS qty,
      SUM(CASE WHEN direction = 'IN' THEN totalCostApplied ELSE -totalCostApplied END) AS value
    FROM StockMove
    WHERE companyId = ${companyId}
      AND date < ${startInclusive}
    GROUP BY warehouseId, itemId
  `) as Array<{ locationId: number; itemId: number; qty: any; value: any }>;

  const out = new Map<Key, { qty: Prisma.Decimal; value: Prisma.Decimal }>();
  for (const r of rows ?? []) {
    const key = `${Number(r.locationId)}:${Number(r.itemId)}`;
    out.set(key, { qty: d2(r.qty ?? 0), value: d2(r.value ?? 0) });
  }
  return out;
}

async function loadMovesFrom(tx: PrismaTx, companyId: number, fromInclusive: Date, toInclusive: Date) {
  const moves = await (tx as any).stockMove.findMany({
    where: { companyId, date: { gte: fromInclusive, lte: toInclusive } },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      date: true,
      locationId: true,
      itemId: true,
      direction: true,
      quantity: true,
      unitCostApplied: true,
      totalCostApplied: true,
      referenceType: true,
      journalEntryId: true,
    },
  });
  return moves as Array<{
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
}

async function upsertStockBalancesFromState(tx: PrismaTx, companyId: number, ending: Map<Key, State>) {
  // Upsert current snapshot for all affected keys. Chunk to keep queries sane.
  const rows = Array.from(ending.entries()).map(([key, st]) => {
    const [locationIdStr, itemIdStr] = key.split(':');
    return {
      companyId,
      locationId: Number(locationIdStr),
      itemId: Number(itemIdStr),
      qtyOnHand: d2(st.qty),
      avgUnitCost: d2(st.avg),
      inventoryValue: d2(st.value),
    };
  });

  const chunkSize = 200;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    // Prisma upsert is per-row; use raw UPSERT for bulk.
    // Note: StockBalance is mapped to table StockBalance with warehouseId column name in DB.
    for (const r of chunk) {
      await (tx as any).stockBalance.upsert({
        where: {
          companyId_locationId_itemId: {
            companyId: r.companyId,
            locationId: r.locationId,
            itemId: r.itemId,
          },
        },
        update: { qtyOnHand: r.qtyOnHand, avgUnitCost: r.avgUnitCost, inventoryValue: r.inventoryValue },
        create: r,
      });
    }
  }
}

async function applyOutMoveRevaluations(tx: PrismaTx, companyId: number, updates: Array<{ id: number; unitCostApplied: Prisma.Decimal; totalCostApplied: Prisma.Decimal }>) {
  // Update per-row (safe + simple). These are immutable-audit *values*, but the system already treats StockMove as an audit log;
  // we only rewrite costs deterministically to enforce the chosen valuation method.
  for (const u of updates) {
    await (tx as any).stockMove.updateMany({
      where: { companyId, id: u.id },
      data: { unitCostApplied: d2(u.unitCostApplied), totalCostApplied: d2(u.totalCostApplied) },
    });
  }
}

async function adjustCogsForJournalEntries(tx: PrismaTx, companyId: number, deltas: Map<number, Prisma.Decimal>) {
  if (deltas.size === 0) return { adjustedCount: 0 };

  // Ensure inventory accounts exist.
  const company = await (tx as any).company.findUnique({
    where: { id: companyId },
    select: { id: true, inventoryAssetAccountId: true, cogsAccountId: true },
  });
  if (!company) throw Object.assign(new Error('company not found'), { statusCode: 404 });
  if (!company.inventoryAssetAccountId || !company.cogsAccountId) {
    throw Object.assign(new Error('company inventory accounts are not configured'), { statusCode: 400 });
  }

  const jeIds = Array.from(deltas.keys());
  type JournalEntryRow = { id: number; date: Date; locationId: number | null };
  const entries = (await (tx as any).journalEntry.findMany({
    where: { companyId, id: { in: jeIds } },
    select: { id: true, date: true, locationId: true },
  })) as JournalEntryRow[];
  const byId = new Map<number, JournalEntryRow>(entries.map((e) => [Number(e.id), e]));

  let adjustedCount = 0;

  for (const [sourceJeId, deltaRaw] of deltas.entries()) {
    const delta = d2(deltaRaw);
    if (delta.equals(0)) continue;
    const je = byId.get(sourceJeId);
    if (!je) continue;

    // Period guard: never create adjustments inside closed period.
    await assertOpenPeriodOrThrow(tx, { companyId, transactionDate: new Date(je.date), action: 'inventory.recalc.adjust_cogs' });

    // Deterministic idempotency: keep a per-source JE "last computed" state.
    // We lock the row (or create it) and only post the delta from the stored value to the new desired value.
    await (tx as any).$executeRaw`
      INSERT INTO JournalEntryInventoryValuation (companyId, sourceJournalEntryId, lastComputedCogs, updatedAt)
      VALUES (${companyId}, ${sourceJeId}, 0, NOW())
      ON DUPLICATE KEY UPDATE updatedAt = updatedAt
    `;
    const rows = (await (tx as any).$queryRaw`
      SELECT lastComputedCogs
      FROM JournalEntryInventoryValuation
      WHERE companyId = ${companyId} AND sourceJournalEntryId = ${sourceJeId}
      FOR UPDATE
    `) as Array<{ lastComputedCogs: any }>;
    const prevComputed = d2(rows?.[0]?.lastComputedCogs ?? 0);

    const desiredComputed = d2(prevComputed.add(delta));
    if (delta.equals(0)) continue;

    const lines =
      delta.greaterThan(0)
        ? [
            { accountId: company.cogsAccountId, debit: delta, credit: new Prisma.Decimal(0) },
            { accountId: company.inventoryAssetAccountId, debit: new Prisma.Decimal(0), credit: delta },
          ]
        : [
            { accountId: company.inventoryAssetAccountId, debit: delta.abs(), credit: new Prisma.Decimal(0) },
            { accountId: company.cogsAccountId, debit: new Prisma.Decimal(0), credit: delta.abs() },
          ];

    const adj = await postJournalEntry(tx, {
      companyId,
      date: new Date(je.date),
      description: `Inventory valuation adjustment for JE ${sourceJeId}`,
      locationId: je.locationId ?? null,
      skipAccountValidation: true,
      lines: lines.map((l) => ({ accountId: l.accountId, debit: d2(l.debit), credit: d2(l.credit) })),
    });

    await (tx as any).event.create({
      data: {
        companyId,
        eventId: randomUUID(),
        eventType: 'journal.entry.created',
        schemaVersion: 'v1',
        occurredAt: new Date(),
        source: 'cashflow-worker',
        partitionKey: String(companyId),
        correlationId: `inventory-recalc:${companyId}:${sourceJeId}`,
        causationId: String(sourceJeId),
        aggregateType: 'JournalEntry',
        aggregateId: String(adj.id),
        type: 'JournalEntryCreated',
        payload: { journalEntryId: adj.id, companyId, source: 'InventoryRecalc', sourceJournalEntryId: sourceJeId },
      },
    });

    await (tx as any).$executeRaw`
      UPDATE JournalEntryInventoryValuation
      SET lastComputedCogs = ${desiredComputed}, updatedAt = NOW()
      WHERE companyId = ${companyId} AND sourceJournalEntryId = ${sourceJeId}
    `;

    adjustedCount += 1;
  }

  return { adjustedCount };
}

export async function runInventoryRecalcForward(tx: PrismaTx, args: { companyId: number; fromDate: Date; now?: Date }) {
  const companyId = args.companyId;
  const now = args.now ?? new Date();

  const closedThrough = await getClosedThroughDate(tx, companyId);
  const minStart = closedThrough ? dayAfter(closedThrough) : null;
  const requested = normalizeToDay(new Date(args.fromDate));
  const effectiveStart = minStart ? (requested.getTime() < minStart.getTime() ? minStart : requested) : requested;

  // If effectiveStart is in closed period (shouldn't happen if callers validate), fail closed.
  await assertOpenPeriodOrThrow(tx, { companyId, transactionDate: effectiveStart, action: 'inventory.recalc' });

  const toInclusive = endOfDayUTC(now);

  const baseline = await computeBaselineByKey(tx, companyId, effectiveStart);
  const moves = await loadMovesFrom(tx, companyId, effectiveStart, toInclusive);

  const { updatedOutMoves, deltaByJournalEntryId, endingByKey } = _test_applyWacReplay({
    baselineByKey: baseline,
    moves: moves.map((m) => ({ ...m, unitCostApplied: d2(m.unitCostApplied), totalCostApplied: d2(m.totalCostApplied) })),
  });

  await applyOutMoveRevaluations(tx, companyId, updatedOutMoves);
  await upsertStockBalancesFromState(tx, companyId, endingByKey);
  const adj = await adjustCogsForJournalEntries(tx, companyId, deltaByJournalEntryId);

  return {
    companyId,
    closedThroughDate: closedThrough?.toISOString() ?? null,
    effectiveStartDate: effectiveStart.toISOString(),
    toDate: toInclusive.toISOString(),
    revaluedOutMoves: updatedOutMoves.length,
    adjustedJournalEntries: adj.adjustedCount,
  };
}

export async function rebuildProjectionsFromLedger(tx: PrismaTx, args: { companyId: number; fromDate: Date; toDate: Date }) {
  const companyId = args.companyId;
  const fromDate = normalizeToDay(args.fromDate);
  const toDate = normalizeToDay(args.toDate);

  // Clear existing projections in range
  await (tx as any).accountBalance.deleteMany({ where: { companyId, date: { gte: fromDate, lte: toDate } } });
  await (tx as any).dailySummary.deleteMany({ where: { companyId, date: { gte: fromDate, lte: toDate } } });

  // Rebuild AccountBalance
  const abRows = (await (tx as any).$queryRaw`
    SELECT
      DATE(je.date) AS day,
      jl.accountId AS accountId,
      SUM(jl.debit) AS debitTotal,
      SUM(jl.credit) AS creditTotal
    FROM JournalLine jl
    JOIN JournalEntry je ON je.id = jl.journalEntryId
    WHERE jl.companyId = ${companyId}
      AND je.companyId = ${companyId}
      AND je.date >= ${fromDate}
      AND je.date <= ${toDate}
    GROUP BY day, jl.accountId
  `) as Array<{ day: Date; accountId: number; debitTotal: any; creditTotal: any }>;

  const abData = abRows.map((r) => ({
    companyId,
    accountId: Number(r.accountId),
    date: normalizeToDay(new Date(r.day)),
    debitTotal: d2(r.debitTotal ?? 0),
    creditTotal: d2(r.creditTotal ?? 0),
  }));

  const chunkSize = 500;
  for (let i = 0; i < abData.length; i += chunkSize) {
    const chunk = abData.slice(i, i + chunkSize);
    await (tx as any).accountBalance.createMany({ data: chunk, skipDuplicates: true });
  }

  // Rebuild DailySummary (income/expense only)
  const dsRows = (await (tx as any).$queryRaw`
    SELECT
      DATE(je.date) AS day,
      SUM(CASE WHEN a.type = 'INCOME' THEN (jl.credit - jl.debit) ELSE 0 END) AS totalIncome,
      SUM(CASE WHEN a.type = 'EXPENSE' THEN (jl.debit - jl.credit) ELSE 0 END) AS totalExpense
    FROM JournalLine jl
    JOIN JournalEntry je ON je.id = jl.journalEntryId
    JOIN Account a ON a.id = jl.accountId
    WHERE jl.companyId = ${companyId}
      AND je.companyId = ${companyId}
      AND a.companyId = ${companyId}
      AND je.date >= ${fromDate}
      AND je.date <= ${toDate}
    GROUP BY day
  `) as Array<{ day: Date; totalIncome: any; totalExpense: any }>;

  const dsData = dsRows
    .map((r) => ({
      companyId,
      date: normalizeToDay(new Date(r.day)),
      totalIncome: d2(r.totalIncome ?? 0),
      totalExpense: d2(r.totalExpense ?? 0),
    }))
    .filter((r) => !r.totalIncome.equals(0) || !r.totalExpense.equals(0));

  for (let i = 0; i < dsData.length; i += chunkSize) {
    const chunk = dsData.slice(i, i + chunkSize);
    await (tx as any).dailySummary.createMany({ data: chunk, skipDuplicates: true });
  }

  // Mark outbox journal.entry.created events as processed for this range, so the worker
  // does not double-apply projections after a rebuild.
  const eventIds = (await (tx as any).$queryRaw`
    SELECT e.eventId AS eventId
    FROM Event e
    JOIN JournalEntry je
      ON CAST(JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.journalEntryId')) AS SIGNED) = je.id
    WHERE e.companyId = ${companyId}
      AND e.eventType = 'journal.entry.created'
      AND je.companyId = ${companyId}
      AND je.date >= ${fromDate}
      AND je.date <= ${toDate}
  `) as Array<{ eventId: string }>;

  if (eventIds.length > 0) {
    const peData = eventIds
      .map((r) => r.eventId)
      .filter((x) => typeof x === 'string' && x.length > 0)
      .map((eventId) => ({ eventId, companyId }));
    for (let i = 0; i < peData.length; i += 1000) {
      const chunk = peData.slice(i, i + 1000);
      await (tx as any).processedEvent.createMany({ data: chunk, skipDuplicates: true });
    }
  }

  return { companyId, fromDate: fromDate.toISOString(), toDate: toDate.toISOString(), rebuilt: true };
}

