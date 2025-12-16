import type { FastifyInstance } from 'fastify';
import { prisma } from '../../infrastructure/db.js';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { requireCompanyIdParam } from '../../utils/tenant.js';
import { getRedis } from '../../infrastructure/redis.js';
import { withLocksBestEffort } from '../../infrastructure/locks.js';
import { runIdempotentRequest } from '../../infrastructure/commandIdempotency.js';
import { postJournalEntry } from '../ledger/posting.service.js';
import { publishDomainEvent } from '../../infrastructure/pubsub.js';
import { markEventPublished } from '../../infrastructure/events.js';
import { isoNow } from '../../utils/date.js';
import { applyStockMoveWac, ensureInventoryCompanyDefaults, ensureInventoryItem, ensureWarehouse } from './stock.service.js';

function d2(n: number) {
  return new Prisma.Decimal(n).toDecimalPlaces(2);
}

export async function inventoryRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate);
  const redis = getRedis();

  // --- Warehouses ---
  fastify.get('/companies/:companyId/warehouses', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    return await prisma.warehouse.findMany({
      where: { companyId },
      orderBy: [{ isDefault: 'desc' }, { id: 'asc' }],
    });
  });

  fastify.post('/companies/:companyId/warehouses', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const body = request.body as { name?: string; isDefault?: boolean };
    if (!body.name) {
      reply.status(400);
      return { error: 'name is required' };
    }

    const created = await prisma.$transaction(async (tx) => {
      if (body.isDefault) {
        await tx.warehouse.updateMany({ where: { companyId, isDefault: true }, data: { isDefault: false } });
      }
      const wh = await tx.warehouse.create({
        data: { companyId, name: body.name!, isDefault: body.isDefault ?? false },
      });
      if (body.isDefault) {
        await tx.company.update({ where: { id: companyId }, data: { defaultWarehouseId: wh.id } });
      }
      return wh;
    });

    return created;
  });

  // --- Inventory: Opening Balance (posts stock + GL) ---
  // POST /companies/:companyId/inventory/opening-balance
  // Header: Idempotency-Key
  fastify.post('/companies/:companyId/inventory/opening-balance', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      reply.status(400);
      return { error: 'Idempotency-Key header is required' };
    }

    const body = request.body as {
      date?: string;
      warehouseId?: number;
      lines?: { itemId?: number; quantity?: number; unitCost?: number }[];
    };
    if (!body.lines?.length) {
      reply.status(400);
      return { error: 'lines is required' };
    }

    const occurredAt = isoNow();
    const correlationId = randomUUID();
    const date = body.date ? new Date(body.date) : new Date();
    if (body.date && isNaN(date.getTime())) {
      reply.status(400);
      return { error: 'invalid date' };
    }

    const warehouseIdHint = body.warehouseId ? Number(body.warehouseId) : null;

    const lockKeys = body.lines.map((l) => `lock:stock:${companyId}:${warehouseIdHint ?? 'default'}:${l.itemId}`);

    const { replay, response: result } = await withLocksBestEffort(redis, lockKeys, 30_000, async () =>
      runIdempotentRequest(
        prisma,
        companyId,
        idempotencyKey,
        async () => {
          const txResult = await prisma.$transaction(async (tx) => {
            const cfg = await ensureInventoryCompanyDefaults(tx as any, companyId);
            const warehouseId = Number(warehouseIdHint ?? cfg.defaultWarehouseId);
            if (!warehouseId || Number.isNaN(warehouseId)) {
              throw Object.assign(new Error('warehouseId is required (or set company defaultWarehouseId)'), { statusCode: 400 });
            }

            await ensureWarehouse(tx as any, companyId, warehouseId);

            let totalValue = new Prisma.Decimal(0);
            const moves: any[] = [];

            for (const [idx, l] of (body.lines ?? []).entries()) {
              const itemId = Number(l.itemId);
              const qty = l.quantity ?? 0;
              const unitCost = l.unitCost ?? 0;
              if (!itemId || Number.isNaN(itemId)) {
                throw Object.assign(new Error(`lines[${idx}].itemId is required`), { statusCode: 400 });
              }
              if (!qty || qty <= 0) {
                throw Object.assign(new Error(`lines[${idx}].quantity must be > 0`), { statusCode: 400 });
              }
              if (unitCost <= 0) {
                throw Object.assign(new Error(`lines[${idx}].unitCost must be > 0`), { statusCode: 400 });
              }

              await ensureInventoryItem(tx as any, companyId, itemId);

              const applied = await applyStockMoveWac(tx as any, {
                companyId,
                warehouseId,
                itemId,
                date,
                type: 'OPENING',
                direction: 'IN',
                quantity: d2(qty),
                unitCostApplied: d2(unitCost),
                referenceType: 'OpeningBalance',
                referenceId: null,
                correlationId,
                createdByUserId: (request as any).user?.userId ?? null,
                journalEntryId: null,
              });

              totalValue = totalValue.add(new Prisma.Decimal(applied.totalCostApplied));
              moves.push(applied.move);
            }

            totalValue = totalValue.toDecimalPlaces(2);
            if (totalValue.lessThanOrEqualTo(0)) {
              throw Object.assign(new Error('opening balance total must be > 0'), { statusCode: 400 });
            }

            const je = await postJournalEntry(tx as any, {
              companyId,
              date,
              description: `Opening Stock Balance`,
              createdByUserId: (request as any).user?.userId ?? null,
              skipAccountValidation: true,
              lines: [
                { accountId: cfg.inventoryAssetAccountId!, debit: totalValue, credit: new Prisma.Decimal(0) },
                { accountId: cfg.openingBalanceEquityAccountId!, debit: new Prisma.Decimal(0), credit: totalValue },
              ],
            });

            // backfill journalEntryId on StockMoves (best-effort)
            await (tx as any).stockMove.updateMany({
              where: { companyId, correlationId, journalEntryId: null },
              data: { journalEntryId: je.id },
            });

            const jeEventId = randomUUID();
            await tx.event.create({
              data: {
                companyId,
                eventId: jeEventId,
                eventType: 'journal.entry.created',
                schemaVersion: 'v1',
                occurredAt: new Date(occurredAt),
                source: 'cashflow-api',
                partitionKey: String(companyId),
                correlationId,
                aggregateType: 'JournalEntry',
                aggregateId: String(je.id),
                type: 'JournalEntryCreated',
                payload: { journalEntryId: je.id, companyId },
              },
            });

            return { journalEntryId: je.id, totalValue: totalValue.toString(), warehouseId, _jeEventId: jeEventId };
          });

          return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
        },
        redis
      )
    );

    if (!replay) {
      const ok = await publishDomainEvent({
        eventId: (result as any)._jeEventId,
        eventType: 'journal.entry.created',
        schemaVersion: 'v1',
        occurredAt: (result as any)._occurredAt,
        companyId,
        partitionKey: String(companyId),
        correlationId: (result as any)._correlationId,
        aggregateType: 'JournalEntry',
        aggregateId: String((result as any).journalEntryId),
        source: 'cashflow-api',
        payload: { journalEntryId: (result as any).journalEntryId, companyId },
      });
      if (ok) await markEventPublished((result as any)._jeEventId);
    }

    return {
      warehouseId: (result as any).warehouseId,
      journalEntryId: (result as any).journalEntryId,
      totalValue: (result as any).totalValue,
    };
  });

  // --- Inventory: Adjust Stock (Quantity only, V1) ---
  // POST /companies/:companyId/inventory/adjustments
  fastify.post('/companies/:companyId/inventory/adjustments', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      reply.status(400);
      return { error: 'Idempotency-Key header is required' };
    }

    const body = request.body as {
      date?: string;
      warehouseId?: number;
      offsetAccountId?: number;
      referenceNumber?: string;
      reason?: string;
      lines?: { itemId?: number; quantityDelta?: number; unitCost?: number }[];
    };
    if (!body.lines?.length) {
      reply.status(400);
      return { error: 'lines is required' };
    }

    const occurredAt = isoNow();
    const correlationId = randomUUID();
    const date = body.date ? new Date(body.date) : new Date();
    if (body.date && isNaN(date.getTime())) {
      reply.status(400);
      return { error: 'invalid date' };
    }

    const warehouseIdHint = body.warehouseId ? Number(body.warehouseId) : null;

    const lockKeys = body.lines.map((l) => `lock:stock:${companyId}:${warehouseIdHint ?? 'default'}:${l.itemId}`);

    const { replay, response: result } = await withLocksBestEffort(redis, lockKeys, 30_000, async () =>
      runIdempotentRequest(
        prisma,
        companyId,
        idempotencyKey,
        async () => {
          const txResult = await prisma.$transaction(async (tx) => {
            const cfg = await ensureInventoryCompanyDefaults(tx as any, companyId);
            const warehouseId = Number(warehouseIdHint ?? cfg.defaultWarehouseId);
            if (!warehouseId || Number.isNaN(warehouseId)) {
              throw Object.assign(new Error('warehouseId is required (or set company defaultWarehouseId)'), { statusCode: 400 });
            }

            const offsetAccountId = body.offsetAccountId ?? cfg.cogsAccountId;
            if (!offsetAccountId) {
              throw Object.assign(new Error('offsetAccountId is required (or set company.cogsAccountId)'), { statusCode: 400 });
            }

            await ensureWarehouse(tx as any, companyId, warehouseId);

            // Validate offset account belongs to tenant
            const offsetAcc = await tx.account.findFirst({ where: { id: offsetAccountId, companyId } });
            if (!offsetAcc) throw Object.assign(new Error('offsetAccountId not found in this company'), { statusCode: 400 });

            let totalDebit = new Prisma.Decimal(0);
            let totalCredit = new Prisma.Decimal(0);

            for (const [idx, l] of (body.lines ?? []).entries()) {
              const itemId = Number(l.itemId);
              const delta = Number(l.quantityDelta ?? 0);
              if (!itemId || Number.isNaN(itemId)) {
                throw Object.assign(new Error(`lines[${idx}].itemId is required`), { statusCode: 400 });
              }
              if (!delta || delta === 0) {
                throw Object.assign(new Error(`lines[${idx}].quantityDelta must be non-zero`), { statusCode: 400 });
              }

              await ensureInventoryItem(tx as any, companyId, itemId);

              if (delta > 0) {
                const unitCost = Number(l.unitCost ?? 0);
                if (unitCost <= 0) {
                  throw Object.assign(new Error(`lines[${idx}].unitCost must be > 0 for positive adjustments`), {
                    statusCode: 400,
                  });
                }
                const applied = await applyStockMoveWac(tx as any, {
                  companyId,
                  warehouseId,
                  itemId,
                  date,
                  type: 'ADJUSTMENT',
                  direction: 'IN',
                  quantity: d2(delta),
                  unitCostApplied: d2(unitCost),
                  referenceType: 'InventoryAdjustment',
                  referenceId: body.referenceNumber ?? null,
                  correlationId,
                  createdByUserId: (request as any).user?.userId ?? null,
                  journalEntryId: null,
                });
                const value = new Prisma.Decimal(applied.totalCostApplied).toDecimalPlaces(2);
                totalDebit = totalDebit.add(value);
                totalCredit = totalCredit.add(value);
              } else {
                const qty = d2(Math.abs(delta));
                const applied = await applyStockMoveWac(tx as any, {
                  companyId,
                  warehouseId,
                  itemId,
                  date,
                  type: 'ADJUSTMENT',
                  direction: 'OUT',
                  quantity: qty,
                  // ignored for OUT; WAC uses current avg
                  unitCostApplied: new Prisma.Decimal(0),
                  referenceType: 'InventoryAdjustment',
                  referenceId: body.referenceNumber ?? null,
                  correlationId,
                  createdByUserId: (request as any).user?.userId ?? null,
                  journalEntryId: null,
                });
                const value = new Prisma.Decimal(applied.totalCostApplied).toDecimalPlaces(2);
                totalDebit = totalDebit.add(value);
                totalCredit = totalCredit.add(value);
              }
            }

            // Build JE:
            // - Net increase: Dr Inventory / Cr offset
            // - Net decrease: Dr offset / Cr Inventory
            // For V1 we compute net by comparing totals from moves:
            const sumIn = await (tx as any).stockMove.aggregate({
              where: { companyId, correlationId, direction: 'IN' },
              _sum: { totalCostApplied: true },
            });
            const sumOut = await (tx as any).stockMove.aggregate({
              where: { companyId, correlationId, direction: 'OUT' },
              _sum: { totalCostApplied: true },
            });

            const inValue = new Prisma.Decimal(sumIn?._sum?.totalCostApplied ?? 0).toDecimalPlaces(2);
            const outValue = new Prisma.Decimal(sumOut?._sum?.totalCostApplied ?? 0).toDecimalPlaces(2);
            const net = inValue.sub(outValue).toDecimalPlaces(2);

            if (net.equals(0)) {
              throw Object.assign(new Error('adjustment net value is zero; nothing to post'), { statusCode: 400 });
            }

            const lines =
              net.greaterThan(0)
                ? [
                    { accountId: cfg.inventoryAssetAccountId!, debit: net, credit: new Prisma.Decimal(0) },
                    { accountId: offsetAccountId, debit: new Prisma.Decimal(0), credit: net },
                  ]
                : [
                    { accountId: offsetAccountId, debit: net.abs(), credit: new Prisma.Decimal(0) },
                    { accountId: cfg.inventoryAssetAccountId!, debit: new Prisma.Decimal(0), credit: net.abs() },
                  ];

            const je = await postJournalEntry(tx as any, {
              companyId,
              date,
              description: `Inventory Adjustment${body.reason ? `: ${body.reason}` : ''}`,
              createdByUserId: (request as any).user?.userId ?? null,
              skipAccountValidation: true,
              lines: lines.map((l) => ({
                accountId: l.accountId!,
                debit: new Prisma.Decimal(l.debit).toDecimalPlaces(2),
                credit: new Prisma.Decimal(l.credit).toDecimalPlaces(2),
              })),
            });

            await (tx as any).stockMove.updateMany({
              where: { companyId, correlationId, journalEntryId: null },
              data: { journalEntryId: je.id },
            });

            const jeEventId = randomUUID();
            await tx.event.create({
              data: {
                companyId,
                eventId: jeEventId,
                eventType: 'journal.entry.created',
                schemaVersion: 'v1',
                occurredAt: new Date(occurredAt),
                source: 'cashflow-api',
                partitionKey: String(companyId),
                correlationId,
                aggregateType: 'JournalEntry',
                aggregateId: String(je.id),
                type: 'JournalEntryCreated',
                payload: { journalEntryId: je.id, companyId },
              },
            });

            return { journalEntryId: je.id, netValue: net.toString(), warehouseId, _jeEventId: jeEventId };
          });

          return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
        },
        redis
      )
    );

    if (!replay) {
      const ok = await publishDomainEvent({
        eventId: (result as any)._jeEventId,
        eventType: 'journal.entry.created',
        schemaVersion: 'v1',
        occurredAt: (result as any)._occurredAt,
        companyId,
        partitionKey: String(companyId),
        correlationId: (result as any)._correlationId,
        aggregateType: 'JournalEntry',
        aggregateId: String((result as any).journalEntryId),
        source: 'cashflow-api',
        payload: { journalEntryId: (result as any).journalEntryId, companyId },
      });
      if (ok) await markEventPublished((result as any)._jeEventId);
    }

    return {
      warehouseId: (result as any).warehouseId,
      journalEntryId: (result as any).journalEntryId,
      netValue: (result as any).netValue,
    };
  });

  // --- Inventory Summary (Accounting stock) ---
  // GET /companies/:companyId/reports/inventory-summary?warehouseId=...
  fastify.get('/companies/:companyId/reports/inventory-summary', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const query = request.query as { warehouseId?: string };

    const where: any = { companyId };
    if (query.warehouseId) {
      const wid = Number(query.warehouseId);
      if (Number.isNaN(wid)) {
        reply.status(400);
        return { error: 'invalid warehouseId' };
      }
      where.warehouseId = wid;
    }

    const rows = await prisma.stockBalance.findMany({
      where,
      include: {
        item: { select: { id: true, name: true, sku: true } },
        warehouse: { select: { id: true, name: true } },
      },
      orderBy: [{ warehouseId: 'asc' }, { itemId: 'asc' }],
    });

    return rows.map((r) => ({
      warehouse: r.warehouse,
      item: r.item,
      qtyOnHand: r.qtyOnHand.toString(),
      avgUnitCost: r.avgUnitCost.toString(),
      inventoryValue: r.inventoryValue.toString(),
      updatedAt: r.updatedAt,
    }));
  });

  // Inventory valuation "as of" date (replayed from StockMove totals)
  fastify.get('/companies/:companyId/reports/inventory-valuation', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const asOfStr = (request.query as any)?.asOf as string | undefined;
    const warehouseIdParam = (request.query as any)?.warehouseId as string | undefined;
    const asOf = asOfStr ? new Date(asOfStr) : new Date();
    if (asOfStr && isNaN(asOf.getTime())) {
      reply.status(400);
      return { error: 'invalid asOf' };
    }
    const warehouseId = warehouseIdParam ? Number(warehouseIdParam) : null;
    if (warehouseIdParam && Number.isNaN(warehouseId)) {
      reply.status(400);
      return { error: 'invalid warehouseId' };
    }

    const moves = await prisma.stockMove.findMany({
      where: {
        companyId,
        date: { lte: asOf },
        ...(warehouseId ? { warehouseId } : {}),
      },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
      include: {
        item: { select: { id: true, name: true, sku: true, type: true, trackInventory: true } },
        warehouse: { select: { id: true, name: true } },
      },
    });

    type Key = string; // `${warehouseId}:${itemId}`
    const state = new Map<Key, { qty: Prisma.Decimal; value: Prisma.Decimal }>();
    const meta = new Map<Key, { warehouseId: number; warehouseName: string; itemId: number; itemName: string; sku: string | null }>();

    for (const m of moves as any[]) {
      if (!m.item?.trackInventory) continue;
      const key = `${m.warehouseId}:${m.itemId}`;
      if (!state.has(key)) state.set(key, { qty: new Prisma.Decimal(0), value: new Prisma.Decimal(0) });
      if (!meta.has(key)) {
        meta.set(key, {
          warehouseId: m.warehouseId,
          warehouseName: m.warehouse?.name ?? '',
          itemId: m.itemId,
          itemName: m.item?.name ?? '',
          sku: m.item?.sku ?? null,
        });
      }
      const st = state.get(key)!;
      const qty = new Prisma.Decimal(m.quantity).toDecimalPlaces(2);
      const cost = new Prisma.Decimal(m.totalCostApplied).toDecimalPlaces(2);
      if (m.direction === 'IN') {
        st.qty = st.qty.add(qty);
        st.value = st.value.add(cost);
      } else {
        st.qty = st.qty.sub(qty);
        st.value = st.value.sub(cost);
      }
    }

    const rows = Array.from(state.entries())
      .map(([key, st]) => {
        const m = meta.get(key)!;
        const qtyOnHand = st.qty.toDecimalPlaces(2);
        const inventoryValue = st.value.toDecimalPlaces(2);
        const avgUnitCost = qtyOnHand.equals(0) ? new Prisma.Decimal(0) : inventoryValue.div(qtyOnHand).toDecimalPlaces(2);
        return {
          warehouseId: m.warehouseId,
          warehouseName: m.warehouseName,
          itemId: m.itemId,
          itemName: m.itemName,
          sku: m.sku,
          qtyOnHand: qtyOnHand.toString(),
          avgUnitCost: avgUnitCost.toString(),
          inventoryValue: inventoryValue.toString(),
        };
      })
      .filter((r) => Number(r.qtyOnHand) !== 0 || Number(r.inventoryValue) !== 0)
      .sort((a, b) => (a.itemName || '').localeCompare(b.itemName || '') || (a.warehouseName || '').localeCompare(b.warehouseName || ''));

    const totals = rows.reduce(
      (acc, r) => {
        acc.qty = acc.qty.add(new Prisma.Decimal(r.qtyOnHand));
        acc.value = acc.value.add(new Prisma.Decimal(r.inventoryValue));
        return acc;
      },
      { qty: new Prisma.Decimal(0), value: new Prisma.Decimal(0) }
    );

    return {
      companyId,
      asOf: asOf.toISOString(),
      warehouseId: warehouseId ?? null,
      totals: { qtyOnHand: totals.qty.toDecimalPlaces(2).toString(), inventoryValue: totals.value.toDecimalPlaces(2).toString() },
      rows,
    };
  });

  // Inventory movement report (by item/warehouse, range)
  fastify.get('/companies/:companyId/reports/inventory-movement', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const fromStr = (request.query as any)?.from as string | undefined;
    const toStr = (request.query as any)?.to as string | undefined;
    const warehouseIdParam = (request.query as any)?.warehouseId as string | undefined;
    const itemIdParam = (request.query as any)?.itemId as string | undefined;

    const from = fromStr ? new Date(fromStr) : null;
    const to = toStr ? new Date(toStr) : null;
    if (fromStr && (!from || isNaN(from.getTime()))) {
      reply.status(400);
      return { error: 'invalid from' };
    }
    if (toStr && (!to || isNaN(to.getTime()))) {
      reply.status(400);
      return { error: 'invalid to' };
    }
    const warehouseId = warehouseIdParam ? Number(warehouseIdParam) : null;
    const itemId = itemIdParam ? Number(itemIdParam) : null;
    if (warehouseIdParam && Number.isNaN(warehouseId)) {
      reply.status(400);
      return { error: 'invalid warehouseId' };
    }
    if (itemIdParam && Number.isNaN(itemId)) {
      reply.status(400);
      return { error: 'invalid itemId' };
    }

    const rows = await prisma.stockMove.groupBy({
      by: ['warehouseId', 'itemId', 'direction'],
      where: {
        companyId,
        ...(from ? { date: { gte: from } } : {}),
        ...(to ? { date: { ...(from ? { gte: from } : {}), lte: to } } : {}),
        ...(warehouseId ? { warehouseId } : {}),
        ...(itemId ? { itemId } : {}),
      },
      _sum: { quantity: true, totalCostApplied: true },
    });

    const ids = Array.from(new Set(rows.map((r) => r.itemId)));
    const whIds = Array.from(new Set(rows.map((r) => r.warehouseId)));
    const items = await prisma.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, name: true, sku: true, trackInventory: true } });
    const whs = await prisma.warehouse.findMany({ where: { companyId, id: { in: whIds } }, select: { id: true, name: true } });
    const itemById = new Map(items.map((i) => [i.id, i]));
    const whById = new Map(whs.map((w) => [w.id, w]));

    type Key = string; // `${warehouseId}:${itemId}`
    const agg = new Map<Key, any>();
    for (const r of rows as any[]) {
      const it = itemById.get(r.itemId);
      if (!it?.trackInventory) continue;
      const key = `${r.warehouseId}:${r.itemId}`;
      if (!agg.has(key)) {
        agg.set(key, {
          warehouseId: r.warehouseId,
          warehouseName: whById.get(r.warehouseId)?.name ?? '',
          itemId: r.itemId,
          itemName: it?.name ?? '',
          sku: it?.sku ?? null,
          qtyIn: new Prisma.Decimal(0),
          valueIn: new Prisma.Decimal(0),
          qtyOut: new Prisma.Decimal(0),
          valueOut: new Prisma.Decimal(0),
        });
      }
      const a = agg.get(key);
      const qty = new Prisma.Decimal(r._sum.quantity ?? 0).toDecimalPlaces(2);
      const val = new Prisma.Decimal(r._sum.totalCostApplied ?? 0).toDecimalPlaces(2);
      if (r.direction === 'IN') {
        a.qtyIn = a.qtyIn.add(qty);
        a.valueIn = a.valueIn.add(val);
      } else {
        a.qtyOut = a.qtyOut.add(qty);
        a.valueOut = a.valueOut.add(val);
      }
    }

    const out = Array.from(agg.values()).map((a: any) => ({
      warehouseId: a.warehouseId,
      warehouseName: a.warehouseName,
      itemId: a.itemId,
      itemName: a.itemName,
      sku: a.sku,
      qtyIn: a.qtyIn.toDecimalPlaces(2).toString(),
      valueIn: a.valueIn.toDecimalPlaces(2).toString(),
      qtyOut: a.qtyOut.toDecimalPlaces(2).toString(),
      valueOut: a.valueOut.toDecimalPlaces(2).toString(),
      netQty: a.qtyIn.sub(a.qtyOut).toDecimalPlaces(2).toString(),
      netValue: a.valueIn.sub(a.valueOut).toDecimalPlaces(2).toString(),
    }));

    return { companyId, from: from?.toISOString() ?? null, to: to?.toISOString() ?? null, rows: out };
  });

  // COGS by item (from StockMove SALE_ISSUE OUT)
  fastify.get('/companies/:companyId/reports/cogs-by-item', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const fromStr = (request.query as any)?.from as string | undefined;
    const toStr = (request.query as any)?.to as string | undefined;
    const from = fromStr ? new Date(fromStr) : null;
    const to = toStr ? new Date(toStr) : null;
    if (fromStr && (!from || isNaN(from.getTime()))) {
      reply.status(400);
      return { error: 'invalid from' };
    }
    if (toStr && (!to || isNaN(to.getTime()))) {
      reply.status(400);
      return { error: 'invalid to' };
    }

    const rows = await prisma.stockMove.groupBy({
      by: ['itemId'],
      where: {
        companyId,
        type: 'SALE_ISSUE',
        direction: 'OUT',
        ...(from ? { date: { gte: from } } : {}),
        ...(to ? { date: { ...(from ? { gte: from } : {}), lte: to } } : {}),
      } as any,
      _sum: { quantity: true, totalCostApplied: true },
    });
    const ids = rows.map((r) => r.itemId);
    const items = await prisma.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, name: true, sku: true } });
    const itemById = new Map(items.map((i) => [i.id, i]));
    const out = rows
      .map((r: any) => ({
        itemId: r.itemId,
        itemName: itemById.get(r.itemId)?.name ?? '',
        sku: itemById.get(r.itemId)?.sku ?? null,
        quantity: new Prisma.Decimal(r._sum.quantity ?? 0).toDecimalPlaces(2).toString(),
        cogs: new Prisma.Decimal(r._sum.totalCostApplied ?? 0).toDecimalPlaces(2).toString(),
      }))
      .sort((a, b) => (a.itemName || '').localeCompare(b.itemName || ''));

    const totalCogs = out.reduce((acc, r) => acc.add(new Prisma.Decimal(r.cogs)), new Prisma.Decimal(0));
    return { companyId, from: from?.toISOString() ?? null, to: to?.toISOString() ?? null, totalCogs: totalCogs.toDecimalPlaces(2).toString(), rows: out };
  });

  // --- Item inventory detail (V1 accounting stock) ---
  // GET /companies/:companyId/items/:itemId/stock-balances
  fastify.get('/companies/:companyId/items/:itemId/stock-balances', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const itemId = Number((request.params as any)?.itemId);
    if (Number.isNaN(itemId)) {
      reply.status(400);
      return { error: 'invalid itemId' };
    }

    // Ensure item exists in tenant
    const item = await prisma.item.findFirst({ where: { id: itemId, companyId }, select: { id: true } });
    if (!item) {
      reply.status(404);
      return { error: 'item not found' };
    }

    const balances = await prisma.stockBalance.findMany({
      where: { companyId, itemId },
      include: {
        warehouse: { select: { id: true, name: true, isDefault: true } },
      },
      orderBy: [{ warehouseId: 'asc' }],
    });

    return balances.map((b) => ({
      warehouse: b.warehouse,
      qtyOnHand: b.qtyOnHand.toString(),
      avgUnitCost: b.avgUnitCost.toString(),
      inventoryValue: b.inventoryValue.toString(),
      updatedAt: b.updatedAt,
    }));
  });

  // GET /companies/:companyId/items/:itemId/stock-moves?take=50
  fastify.get('/companies/:companyId/items/:itemId/stock-moves', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const itemId = Number((request.params as any)?.itemId);
    if (Number.isNaN(itemId)) {
      reply.status(400);
      return { error: 'invalid itemId' };
    }
    const query = request.query as { take?: string };
    const take = Math.min(Math.max(Number(query.take ?? 50) || 50, 1), 200);

    // Ensure item exists in tenant
    const item = await prisma.item.findFirst({ where: { id: itemId, companyId }, select: { id: true } });
    if (!item) {
      reply.status(404);
      return { error: 'item not found' };
    }

    const moves = await prisma.stockMove.findMany({
      where: { companyId, itemId },
      include: {
        warehouse: { select: { id: true, name: true } },
      },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take,
    });

    return moves.map((m) => ({
      id: m.id,
      date: m.date,
      type: m.type,
      direction: m.direction,
      quantity: m.quantity.toString(),
      unitCostApplied: m.unitCostApplied.toString(),
      totalCostApplied: m.totalCostApplied.toString(),
      referenceType: m.referenceType,
      referenceId: m.referenceId,
      warehouse: m.warehouse,
      journalEntryId: m.journalEntryId ?? null,
      createdAt: m.createdAt,
    }));
  });
}

export const _internal = { withLocksBestEffort };


