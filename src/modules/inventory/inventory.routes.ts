import type { FastifyInstance } from 'fastify';
import { prisma } from '../../infrastructure/db.js';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { requireCompanyIdParam } from '../../utils/tenant.js';
import { getRedis } from '../../infrastructure/redis.js';
import { withLocksBestEffort } from '../../infrastructure/locks.js';
import { runIdempotentRequest } from '../../infrastructure/commandIdempotency.js';
import { postJournalEntry } from '../ledger/posting.service.js';
import { isoNow, normalizeToDay, parseDateInput } from '../../utils/date.js';
import { applyStockMoveWac, ensureInventoryCompanyDefaults, ensureInventoryItem, ensureLocation } from './stock.service.js';
import { requireAnyRole, Roles } from '../../utils/rbac.js';
import { writeAuditLog } from '../../infrastructure/auditLog.js';
import { assertOpenPeriodOrThrow } from '../../utils/periodClosePolicy.js';
import { publishEventsFastPath } from '../../infrastructure/pubsub.js';

function d2(n: number) {
  return new Prisma.Decimal(n).toDecimalPlaces(2);
}

export async function inventoryRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate);
  const redis = getRedis();

  async function resolveDefaultLocationId(companyId: number): Promise<number | null> {
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { defaultLocationId: true },
    });
    const fromCompany = company?.defaultLocationId ?? null;
    if (fromCompany) return fromCompany;
    const loc = await prisma.location.findFirst({
      where: { companyId, isDefault: true },
      select: { id: true },
    });
    return loc?.id ?? null;
  }

  // --- Locations (legacy: /warehouses) ---
  async function listLocations(request: any, reply: any) {
    const companyId = requireCompanyIdParam(request, reply);
    return await prisma.location.findMany({
      where: { companyId },
      orderBy: [{ isDefault: 'desc' }, { id: 'asc' }],
    });
  }
  fastify.get('/companies/:companyId/locations', listLocations);
  fastify.get('/companies/:companyId/warehouses', listLocations); // backward-compatible alias

  async function createLocation(request: any, reply: any) {
    const companyId = requireCompanyIdParam(request, reply);
    const body = request.body as { name?: string; isDefault?: boolean };
    if (!body.name) {
      reply.status(400);
      return { error: 'name is required' };
    }

    const created = await prisma.$transaction(async (tx) => {
      if (body.isDefault) {
        await tx.location.updateMany({ where: { companyId, isDefault: true }, data: { isDefault: false } });
      }
      const loc = await tx.location.create({
        data: { companyId, name: body.name!, isDefault: body.isDefault ?? false },
      });
      if (body.isDefault) {
        await tx.company.update({ where: { id: companyId }, data: { defaultLocationId: loc.id } });
      }
      return loc;
    });

    return created;
  }
  fastify.post('/companies/:companyId/locations', createLocation);
  fastify.post('/companies/:companyId/warehouses', createLocation); // backward-compatible alias

  // --- Inventory: Opening Balance (posts stock + GL) ---
  // POST /companies/:companyId/inventory/opening-balance
  // Header: Idempotency-Key
  fastify.post('/companies/:companyId/inventory/opening-balance', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      reply.status(400);
      return { error: 'Idempotency-Key header is required' };
    }

    const body = request.body as {
      date?: string;
      locationId?: number;
      warehouseId?: number; // backward-compatible alias
      lines?: { itemId?: number; quantity?: number; unitCost?: number }[];
    };
    if (!body.lines?.length) {
      reply.status(400);
      return { error: 'lines is required' };
    }

    const occurredAt = isoNow();
    const correlationId = randomUUID();
    const date = parseDateInput(body.date) ?? new Date();
    if (body.date && isNaN(date.getTime())) {
      reply.status(400);
      return { error: 'invalid date' };
    }

    const locationIdHint = (body.locationId ?? body.warehouseId) ? Number(body.locationId ?? body.warehouseId) : null;

    const defaultLocationId = await resolveDefaultLocationId(companyId);
    const resolvedLocationId =
      locationIdHint !== null ? Number(locationIdHint) : Number(defaultLocationId ?? NaN);

    const lockKeys = body.lines.flatMap((l) => {
      // Always lock by resolved numeric warehouseId when available to prevent races
      // between "default warehouse" calls and explicit warehouseId calls.
      const keys: string[] = [];
      if (Number.isInteger(resolvedLocationId) && resolvedLocationId > 0) {
        keys.push(`lock:stock:${companyId}:${resolvedLocationId}:${l.itemId}`);
        if (defaultLocationId && resolvedLocationId === defaultLocationId) {
          keys.push(`lock:stock:${companyId}:default:${l.itemId}`);
        }
      } else {
        // Fallback: lock on default alias (also serializes callers while defaults are being bootstrapped).
        keys.push(`lock:stock:${companyId}:default:${l.itemId}`);
      }
      return keys;
    });

    const { replay, response: result } = await withLocksBestEffort(redis, lockKeys, 30_000, async () =>
      runIdempotentRequest(
        prisma,
        companyId,
        idempotencyKey,
        async () => {
          const txResult = await prisma.$transaction(async (tx) => {
            const cfg = await ensureInventoryCompanyDefaults(tx as any, companyId);
            const locationId = Number(locationIdHint ?? (cfg as any).defaultLocationId);
            if (!locationId || Number.isNaN(locationId)) {
              throw Object.assign(new Error('locationId is required (or set company defaultLocationId)'), { statusCode: 400 });
            }

            await ensureLocation(tx as any, companyId, locationId);

            await assertOpenPeriodOrThrow(tx as any, {
              companyId,
              transactionDate: date,
              action: 'inventory.opening_balance',
            });

            let totalValue = new Prisma.Decimal(0);
            const appliedLines: Array<{
              itemId: number;
              quantity: string;
              unitCostApplied: string;
              totalCostApplied: string;
              stockMoveId: number;
            }> = [];

            for (const [idx, l] of (body.lines ?? []).entries()) {
              const itemId = Number(l.itemId);
              const qty = Number(l.quantity ?? 0);
              const unitCost = Number(l.unitCost ?? 0);
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
                locationId,
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
                allowBackdated: true,
              });

              totalValue = totalValue.add(new Prisma.Decimal(applied.totalCostApplied));
              appliedLines.push({
                itemId,
                quantity: new Prisma.Decimal(applied.move.quantity).toString(),
                unitCostApplied: new Prisma.Decimal(applied.move.unitCostApplied).toString(),
                totalCostApplied: new Prisma.Decimal(applied.move.totalCostApplied).toString(),
                stockMoveId: applied.move.id,
              });
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

            await writeAuditLog(tx as any, {
              companyId,
              userId: (request as any).user?.userId ?? null,
              action: 'inventory.opening_balance',
              entityType: 'JournalEntry',
              entityId: je.id,
              idempotencyKey,
              correlationId,
              metadata: {
                locationId,
                totalValue: totalValue.toString(),
                linesCount: (body.lines ?? []).length,
              },
            });

            return {
              journalEntryId: je.id,
              totalValue: totalValue.toString(),
              locationId,
              lines: appliedLines,
              _jeEventId: jeEventId,
            };
          });

          return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
        },
        redis
      )
    );

    return {
      locationId: (result as any).locationId,
      journalEntryId: (result as any).journalEntryId,
      totalValue: (result as any).totalValue,
      lines: (result as any).lines ?? [],
    };
  });

  // --- Inventory: Adjust Stock (Quantity only, V1) ---
  // POST /companies/:companyId/inventory/adjustments
  fastify.post('/companies/:companyId/inventory/adjustments', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      reply.status(400);
      return { error: 'Idempotency-Key header is required' };
    }

    const body = request.body as {
      date?: string;
      locationId?: number;
      warehouseId?: number; // backward-compatible alias
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
    const date = parseDateInput(body.date) ?? new Date();
    if (body.date && isNaN(date.getTime())) {
      reply.status(400);
      return { error: 'invalid date' };
    }

    const locationIdHint = (body.locationId ?? body.warehouseId) ? Number(body.locationId ?? body.warehouseId) : null;

    const defaultLocationId = await resolveDefaultLocationId(companyId);
    const resolvedLocationId =
      locationIdHint !== null ? Number(locationIdHint) : Number(defaultLocationId ?? NaN);

    const lockKeys = body.lines.flatMap((l) => {
      const keys: string[] = [];
      if (Number.isInteger(resolvedLocationId) && resolvedLocationId > 0) {
        keys.push(`lock:stock:${companyId}:${resolvedLocationId}:${l.itemId}`);
        if (defaultLocationId && resolvedLocationId === defaultLocationId) {
          keys.push(`lock:stock:${companyId}:default:${l.itemId}`);
        }
      } else {
        keys.push(`lock:stock:${companyId}:default:${l.itemId}`);
      }
      return keys;
    });

    const { replay, response: result } = await withLocksBestEffort(redis, lockKeys, 30_000, async () =>
      runIdempotentRequest(
        prisma,
        companyId,
        idempotencyKey,
        async () => {
          const txResult = await prisma.$transaction(async (tx) => {
            const cfg = await ensureInventoryCompanyDefaults(tx as any, companyId);
            const locationId = Number(locationIdHint ?? (cfg as any).defaultLocationId);
            if (!locationId || Number.isNaN(locationId)) {
              throw Object.assign(new Error('locationId is required (or set company defaultLocationId)'), { statusCode: 400 });
            }

            const offsetAccountId = body.offsetAccountId ?? cfg.cogsAccountId;
            if (!offsetAccountId) {
              throw Object.assign(new Error('offsetAccountId is required (or set company.cogsAccountId)'), { statusCode: 400 });
            }

            await ensureLocation(tx as any, companyId, locationId);

            await assertOpenPeriodOrThrow(tx as any, {
              companyId,
              transactionDate: date,
              action: 'inventory.adjustment',
            });

            // Validate offset account belongs to tenant
            const offsetAcc = await tx.account.findFirst({ where: { id: offsetAccountId, companyId } });
            if (!offsetAcc) throw Object.assign(new Error('offsetAccountId not found in this company'), { statusCode: 400 });

            let totalDebit = new Prisma.Decimal(0);
            let totalCredit = new Prisma.Decimal(0);
            let inventoryRecalcFromDate: Date | null = null;

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
                  locationId,
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
                  allowBackdated: true,
                });
                const from = (applied as any)?.requiresInventoryRecalcFromDate as Date | null | undefined;
                if (from && !isNaN(new Date(from).getTime())) {
                  inventoryRecalcFromDate =
                    !inventoryRecalcFromDate || new Date(from).getTime() < inventoryRecalcFromDate.getTime()
                      ? new Date(from)
                      : inventoryRecalcFromDate;
                }
                const value = new Prisma.Decimal(applied.totalCostApplied).toDecimalPlaces(2);
                totalDebit = totalDebit.add(value);
                totalCredit = totalCredit.add(value);
              } else {
                const qty = d2(Math.abs(delta));
                const applied = await applyStockMoveWac(tx as any, {
                  companyId,
                  locationId,
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
                  allowBackdated: true,
                });
                const from = (applied as any)?.requiresInventoryRecalcFromDate as Date | null | undefined;
                if (from && !isNaN(new Date(from).getTime())) {
                  inventoryRecalcFromDate =
                    !inventoryRecalcFromDate || new Date(from).getTime() < inventoryRecalcFromDate.getTime()
                      ? new Date(from)
                      : inventoryRecalcFromDate;
                }
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

            let inventoryRecalcEventId: string | null = null;
            if (inventoryRecalcFromDate) {
              inventoryRecalcEventId = randomUUID();
              await tx.event.create({
                data: {
                  companyId,
                  eventId: inventoryRecalcEventId,
                  eventType: 'inventory.recalc.requested',
                  schemaVersion: 'v1',
                  occurredAt: new Date(occurredAt),
                  source: 'cashflow-api',
                  partitionKey: String(companyId),
                  correlationId,
                  causationId: jeEventId,
                  aggregateType: 'Company',
                  aggregateId: String(companyId),
                  type: 'InventoryRecalcRequested',
                  payload: {
                    companyId,
                    fromDate: normalizeToDay(new Date(inventoryRecalcFromDate)).toISOString().slice(0, 10),
                    reason: 'backdated_stock_move_insert',
                    source: 'InventoryAdjustment',
                    journalEntryId: je.id,
                  },
                },
              });
            }

            await writeAuditLog(tx as any, {
              companyId,
              userId: (request as any).user?.userId ?? null,
              action: 'inventory.adjustment',
              entityType: 'JournalEntry',
              entityId: je.id,
              idempotencyKey,
              correlationId,
              metadata: {
                locationId,
                offsetAccountId,
                referenceNumber: body.referenceNumber ?? null,
                reason: body.reason ?? null,
                linesCount: (body.lines ?? []).length,
                netValue: net.toString(),
              },
            });

            return { journalEntryId: je.id, netValue: net.toString(), locationId, _jeEventId: jeEventId, _inventoryRecalcEventId: inventoryRecalcEventId };
          });

          return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
        },
        redis
      )
    );

    return {
      locationId: (result as any).locationId,
      journalEntryId: (result as any).journalEntryId,
      netValue: (result as any).netValue,
    };
  });

  // --- Inventory Summary (Accounting stock) ---
  // GET /companies/:companyId/reports/inventory-summary?locationId=... (legacy: warehouseId)
  fastify.get('/companies/:companyId/reports/inventory-summary', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const query = request.query as { locationId?: string; warehouseId?: string };

    const where: any = { companyId };
    const locIdStr = query.locationId ?? query.warehouseId;
    if (locIdStr) {
      const lid = Number(locIdStr);
      if (Number.isNaN(lid)) {
        reply.status(400);
        return { error: 'invalid locationId' };
      }
      where.locationId = lid;
    }

    const rows = await prisma.stockBalance.findMany({
      where,
      include: {
        item: { select: { id: true, name: true, sku: true } },
        location: { select: { id: true, name: true } },
      },
      orderBy: [{ locationId: 'asc' }, { itemId: 'asc' }],
    });

    return rows.map((r) => ({
      location: (r as any).location,
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
    const locationIdParam = ((request.query as any)?.locationId ?? (request.query as any)?.warehouseId) as string | undefined;
    const asOf = asOfStr ? new Date(asOfStr) : new Date();
    if (asOfStr && isNaN(asOf.getTime())) {
      reply.status(400);
      return { error: 'invalid asOf' };
    }
    const locationId = locationIdParam ? Number(locationIdParam) : null;
    if (locationIdParam && Number.isNaN(locationId)) {
      reply.status(400);
      return { error: 'invalid locationId' };
    }

    const moves = await prisma.stockMove.findMany({
      where: {
        companyId,
        date: { lte: asOf },
        ...(locationId ? { locationId } : {}),
      },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
      include: {
        item: { select: { id: true, name: true, sku: true, type: true, trackInventory: true } },
        location: { select: { id: true, name: true } },
      },
    });

    type Key = string; // `${locationId}:${itemId}`
    const state = new Map<Key, { qty: Prisma.Decimal; value: Prisma.Decimal }>();
    const meta = new Map<Key, { locationId: number; locationName: string; itemId: number; itemName: string; sku: string | null }>();

    for (const m of moves as any[]) {
      if (!m.item?.trackInventory) continue;
      const key = `${m.locationId}:${m.itemId}`;
      if (!state.has(key)) state.set(key, { qty: new Prisma.Decimal(0), value: new Prisma.Decimal(0) });
      if (!meta.has(key)) {
        meta.set(key, {
          locationId: m.locationId,
          locationName: m.location?.name ?? '',
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
        // Avoid displaying "-0.00" (can happen due to decimal rounding after IN/OUT).
        const qtyOnHandRaw = st.qty.toDecimalPlaces(2);
        const inventoryValueRaw = st.value.toDecimalPlaces(2);
        const qtyOnHand = qtyOnHandRaw.equals(0) ? new Prisma.Decimal(0) : qtyOnHandRaw;
        const inventoryValue = inventoryValueRaw.equals(0) ? new Prisma.Decimal(0) : inventoryValueRaw;
        const avgUnitCost = qtyOnHand.equals(0) ? new Prisma.Decimal(0) : inventoryValue.div(qtyOnHand).toDecimalPlaces(2);
        return {
          locationId: m.locationId,
          locationName: m.locationName,
          itemId: m.itemId,
          itemName: m.itemName,
          sku: m.sku,
          qtyOnHand: qtyOnHand.toString(),
          avgUnitCost: avgUnitCost.toString(),
          inventoryValue: inventoryValue.toString(),
        };
      })
      // Do NOT filter out rows when qty/value becomes 0; users want to keep the item visible for audit trail.
      // Note: rows are already limited to items/locations that had at least one StockMove up to asOf.
      .sort((a, b) => (a.itemName || '').localeCompare(b.itemName || '') || (a.locationName || '').localeCompare(b.locationName || ''));

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
      locationId: locationId ?? null,
      totals: { qtyOnHand: totals.qty.toDecimalPlaces(2).toString(), inventoryValue: totals.value.toDecimalPlaces(2).toString() },
      rows,
    };
  });

  // Inventory valuation detail for a single item over a date range (ledger-style)
  // GET /companies/:companyId/reports/inventory-valuation/items/:itemId?from=YYYY-MM-DD&to=YYYY-MM-DD&warehouseId=...
  fastify.get('/companies/:companyId/reports/inventory-valuation/items/:itemId', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const itemId = Number((request.params as any)?.itemId);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      reply.status(400);
      return { error: 'invalid itemId' };
    }

    const q = request.query as { from?: string; to?: string; locationId?: string; warehouseId?: string };
    const from = parseDateInput(q.from) ?? null;
    const to = parseDateInput(q.to) ?? null;
    if (!from) {
      reply.status(400);
      return { error: 'from is required (YYYY-MM-DD)' };
    }
    if (!to) {
      reply.status(400);
      return { error: 'to is required (YYYY-MM-DD)' };
    }
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      reply.status(400);
      return { error: 'invalid from/to' };
    }
    if (to.getTime() < from.getTime()) {
      reply.status(400);
      return { error: 'to must be >= from' };
    }

    const toEnd = /^\d{4}-\d{2}-\d{2}$/.test(String(q.to ?? '').trim())
      ? new Date(`${String(q.to).trim()}T23:59:59.999Z`)
      : new Date(to.getTime());

    const locationId = (q.locationId ?? q.warehouseId) ? Number(q.locationId ?? q.warehouseId) : null;
    if ((q.locationId ?? q.warehouseId) && (Number.isNaN(locationId) || !locationId)) {
      reply.status(400);
      return { error: 'invalid locationId' };
    }

    const item = await prisma.item.findFirst({
      where: { id: itemId, companyId },
      select: { id: true, name: true, sku: true, trackInventory: true, type: true },
    });
    if (!item) {
      reply.status(404);
      return { error: 'item not found' };
    }
    if (item.type !== 'GOODS' || !item.trackInventory) {
      reply.status(400);
      return { error: 'item is not an inventoried GOODS item' };
    }

    const moves = await prisma.stockMove.findMany({
      where: {
        companyId,
        itemId,
        date: { lte: toEnd },
        ...(locationId ? { locationId } : {}),
      },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
      include: {
        location: { select: { id: true, name: true } },
      },
    });

    let qty = new Prisma.Decimal(0);
    let value = new Prisma.Decimal(0);

    // Apply pre-range to get opening balances as-of `from`
    for (const m of moves as any[]) {
      if (new Date(m.date).getTime() >= from.getTime()) break;
      const q2 = new Prisma.Decimal(m.quantity).toDecimalPlaces(2);
      const v2 = new Prisma.Decimal(m.totalCostApplied).toDecimalPlaces(2);
      if (m.direction === 'IN') {
        qty = qty.add(q2);
        value = value.add(v2);
      } else {
        qty = qty.sub(q2);
        value = value.sub(v2);
      }
    }

    function labelForMove(m: any): string {
      switch (m.type) {
        case 'OPENING':
          return 'Opening Balance';
        case 'PURCHASE_RECEIPT':
          return 'Purchase Receipt';
        case 'SALE_ISSUE':
          return 'Sale (Issue)';
        case 'SALE_RETURN':
          return 'Sales Return';
        case 'ADJUSTMENT':
          return 'Adjustment';
        case 'TRANSFER_IN':
          return 'Transfer In';
        case 'TRANSFER_OUT':
          return 'Transfer Out';
        default:
          return String(m.type ?? 'Transaction');
      }
    }

    const rows: any[] = [];
    rows.push({
      kind: 'OPENING',
      date: from.toISOString(),
      transactionDetails: '*** Opening Stock ***',
      quantity: null,
      unitCost: null,
      totalCost: null,
      stockOnHand: qty.toDecimalPlaces(2).toString(),
      inventoryAssetValue: value.toDecimalPlaces(2).toString(),
      locationName: locationId ? (moves?.[0]?.location?.name ?? null) : null,
    });

    // Now apply and emit in-range moves
    for (const m of moves as any[]) {
      const dt = new Date(m.date).getTime();
      if (dt < from.getTime()) continue;
      if (dt > toEnd.getTime()) break;

      const q2 = new Prisma.Decimal(m.quantity).toDecimalPlaces(2);
      const unit = new Prisma.Decimal(m.unitCostApplied).toDecimalPlaces(2);
      const total = new Prisma.Decimal(m.totalCostApplied).toDecimalPlaces(2);

      if (m.direction === 'IN') {
        qty = qty.add(q2);
        value = value.add(total);
      } else {
        qty = qty.sub(q2);
        value = value.sub(total);
      }

      rows.push({
        kind: 'MOVE',
        stockMoveId: m.id,
        date: new Date(m.date).toISOString(),
        transactionDetails: labelForMove(m),
        type: m.type,
        direction: m.direction,
        locationId: m.locationId,
        locationName: m.location?.name ?? null,
        quantity: q2.toString(),
        unitCost: unit.toString(),
        totalCost: total.toString(),
        stockOnHand: qty.toDecimalPlaces(2).toString(),
        inventoryAssetValue: value.toDecimalPlaces(2).toString(),
        journalEntryId: m.journalEntryId ?? null,
      });
    }

    rows.push({
      kind: 'CLOSING',
      date: toEnd.toISOString(),
      transactionDetails: '*** Closing Stock ***',
      quantity: null,
      unitCost: null,
      totalCost: null,
      stockOnHand: qty.toDecimalPlaces(2).toString(),
      inventoryAssetValue: value.toDecimalPlaces(2).toString(),
    });

    return {
      companyId,
      item: { id: item.id, name: item.name, sku: item.sku ?? null },
      from: from.toISOString(),
      to: toEnd.toISOString(),
      locationId: locationId ?? null,
      rows,
    };
  });

  // Inventory movement report (by item/warehouse, range)
  fastify.get('/companies/:companyId/reports/inventory-movement', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const fromStr = (request.query as any)?.from as string | undefined;
    const toStr = (request.query as any)?.to as string | undefined;
    const locationIdParam = ((request.query as any)?.locationId ?? (request.query as any)?.warehouseId) as string | undefined;
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
    const locationId = locationIdParam ? Number(locationIdParam) : null;
    const itemId = itemIdParam ? Number(itemIdParam) : null;
    if (locationIdParam && Number.isNaN(locationId)) {
      reply.status(400);
      return { error: 'invalid locationId' };
    }
    if (itemIdParam && Number.isNaN(itemId)) {
      reply.status(400);
      return { error: 'invalid itemId' };
    }

    // Movement within range
    const rows = await prisma.stockMove.groupBy({
      by: ['locationId', 'itemId', 'direction'],
      where: {
        companyId,
        ...(from ? { date: { gte: from } } : {}),
        ...(to ? { date: { ...(from ? { gte: from } : {}), lte: to } } : {}),
        ...(locationId ? { locationId } : {}),
        ...(itemId ? { itemId } : {}),
      },
      _sum: { quantity: true, totalCostApplied: true },
    });

    // Beginning balance before range (for context; prevents confusion when net is negative within the window).
    const beforeRows =
      from
        ? await prisma.stockMove.groupBy({
            by: ['locationId', 'itemId', 'direction'],
            where: {
              companyId,
              date: { lt: from },
              ...(locationId ? { locationId } : {}),
              ...(itemId ? { itemId } : {}),
            },
            _sum: { quantity: true, totalCostApplied: true },
          })
        : [];

    const ids = Array.from(new Set(rows.map((r) => r.itemId)));
    const locIds = Array.from(new Set(rows.map((r) => r.locationId)));
    const items = await prisma.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, name: true, sku: true, trackInventory: true } });
    const locs = await prisma.location.findMany({ where: { companyId, id: { in: locIds } }, select: { id: true, name: true } });
    const itemById = new Map(items.map((i) => [i.id, i]));
    const locById = new Map(locs.map((l) => [l.id, l]));

    type Key = string; // `${locationId}:${itemId}`
    const agg = new Map<Key, any>();
    const begin = new Map<Key, { qty: Prisma.Decimal; value: Prisma.Decimal }>();

    for (const r of beforeRows as any[]) {
      const key = `${r.locationId}:${r.itemId}`;
      if (!begin.has(key)) begin.set(key, { qty: new Prisma.Decimal(0), value: new Prisma.Decimal(0) });
      const b = begin.get(key)!;
      const qty = new Prisma.Decimal(r._sum.quantity ?? 0).toDecimalPlaces(2);
      const val = new Prisma.Decimal(r._sum.totalCostApplied ?? 0).toDecimalPlaces(2);
      if (r.direction === 'IN') {
        b.qty = b.qty.add(qty);
        b.value = b.value.add(val);
      } else {
        b.qty = b.qty.sub(qty);
        b.value = b.value.sub(val);
      }
    }

    for (const r of rows as any[]) {
      const it = itemById.get(r.itemId);
      if (!it?.trackInventory) continue;
      const key = `${r.locationId}:${r.itemId}`;
      if (!agg.has(key)) {
        const b = begin.get(key) ?? { qty: new Prisma.Decimal(0), value: new Prisma.Decimal(0) };
        agg.set(key, {
          locationId: r.locationId,
          locationName: locById.get(r.locationId)?.name ?? '',
          itemId: r.itemId,
          itemName: it?.name ?? '',
          sku: it?.sku ?? null,
          beginQty: b.qty.toDecimalPlaces(2),
          beginValue: b.value.toDecimalPlaces(2),
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

    const out = Array.from(agg.values()).map((a: any) => {
      const netQty = a.qtyIn.sub(a.qtyOut).toDecimalPlaces(2);
      const netValue = a.valueIn.sub(a.valueOut).toDecimalPlaces(2);
      const endQty = a.beginQty.add(netQty).toDecimalPlaces(2);
      const endValue = a.beginValue.add(netValue).toDecimalPlaces(2);
      return {
        locationId: a.locationId,
        locationName: a.locationName,
        itemId: a.itemId,
        itemName: a.itemName,
        sku: a.sku,
        beginQty: a.beginQty.toString(),
        beginValue: a.beginValue.toString(),
        qtyIn: a.qtyIn.toDecimalPlaces(2).toString(),
        valueIn: a.valueIn.toDecimalPlaces(2).toString(),
        qtyOut: a.qtyOut.toDecimalPlaces(2).toString(),
        valueOut: a.valueOut.toDecimalPlaces(2).toString(),
        netQty: netQty.toString(),
        netValue: netValue.toString(),
        endQty: endQty.toString(),
        endValue: endValue.toString(),
      };
    });

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
        location: { select: { id: true, name: true, isDefault: true } },
      },
      orderBy: [{ locationId: 'asc' }],
    });

    return balances.map((b) => ({
      location: (b as any).location,
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
        location: { select: { id: true, name: true } },
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
      location: (m as any).location,
      journalEntryId: m.journalEntryId ?? null,
      createdAt: m.createdAt,
    }));
  });

  // --- Admin: request inventory recalc forward ---
  // POST /companies/:companyId/admin/inventory/recalc?from=YYYY-MM-DD
  // Requires Idempotency-Key header.
  fastify.post('/companies/:companyId/admin/inventory/recalc', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      reply.status(400);
      return { error: 'Idempotency-Key header is required' };
    }

    const fromStr = ((request.query as any)?.from ?? '') as string;
    if (!fromStr || typeof fromStr !== 'string') {
      reply.status(400);
      return { error: 'from is required (YYYY-MM-DD)' };
    }
    const from = parseDateInput(fromStr);
    if (!from || isNaN(from.getTime())) {
      reply.status(400);
      return { error: 'invalid from (YYYY-MM-DD)' };
    }

    const occurredAt = isoNow();
    const correlationId = randomUUID();
    const lockKey = `lock:inventory:recalc:${companyId}:${fromStr}`;

    const { replay, response: result } = await withLocksBestEffort(redis, [lockKey], 30_000, async () =>
      runIdempotentRequest(
        prisma,
        companyId,
        idempotencyKey,
        async () => {
          const txResult = await prisma.$transaction(async (tx) => {
            const eventId = randomUUID();
            await (tx as any).event.create({
              data: {
                companyId,
                eventId,
                eventType: 'inventory.recalc.requested',
                schemaVersion: 'v1',
                occurredAt: new Date(occurredAt),
                source: 'cashflow-api',
                partitionKey: String(companyId),
                correlationId,
                aggregateType: 'Company',
                aggregateId: String(companyId),
                type: 'InventoryRecalcRequested',
                payload: {
                  companyId,
                  fromDate: normalizeToDay(from).toISOString().slice(0, 10),
                  reason: 'manual_admin_request',
                  source: 'Admin',
                },
              },
            });

            await writeAuditLog(tx as any, {
              companyId,
              userId: (request as any).user?.userId ?? null,
              action: 'inventory.recalc.request',
              entityType: 'Company',
              entityId: companyId,
              idempotencyKey,
              correlationId,
              metadata: { from: normalizeToDay(from).toISOString().slice(0, 10), occurredAt },
            });

            return { eventId };
          });

          return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
        },
        redis
      )
    );

    if (!replay && (result as any).eventId) {
      publishEventsFastPath([(result as any).eventId]);
    }

    return {
      companyId,
      queued: true,
      from: normalizeToDay(from).toISOString().slice(0, 10),
      eventId: (result as any).eventId,
    };
  });
}

export const _internal = { withLocksBestEffort };


