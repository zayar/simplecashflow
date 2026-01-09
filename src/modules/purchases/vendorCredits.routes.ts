import type { FastifyInstance } from 'fastify';
import { prisma } from '../../infrastructure/db.js';
import { AccountType, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { requireCompanyIdParam } from '../../utils/tenant.js';
import { getRedis } from '../../infrastructure/redis.js';
import { withLockBestEffort, withLocksBestEffort } from '../../infrastructure/locks.js';
import { runIdempotentRequest } from '../../infrastructure/commandIdempotency.js';
import { postJournalEntry } from '../ledger/posting.service.js';
import { isoNow, parseDateInput } from '../../utils/date.js';
import { ensureInventoryCompanyDefaults, ensureInventoryItem, applyStockMoveWac } from '../inventory/stock.service.js';
import { toMoneyDecimal } from '../../utils/money.js';
import { nextVendorCreditNumber } from '../sequence/sequence.service.js';
import { requireAnyRole, Roles } from '../../utils/rbac.js';
import { writeAuditLog } from '../../infrastructure/auditLog.js';
import { createReversalJournalEntry } from '../ledger/reversal.service.js';
import { publishEventsFastPath } from '../../infrastructure/pubsub.js';
import { ensureTaxReceivableAccountIfNeeded } from '../../utils/tax.js';

export async function vendorCreditsRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate);
  const redis = getRedis();

  // List vendor credits
  fastify.get('/companies/:companyId/vendor-credits', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const query = (request.query ?? {}) as any;
    const vendorIdRaw = query.vendorId ?? query.vendor_id ?? null;
    const vendorId = vendorIdRaw === null || vendorIdRaw === undefined || vendorIdRaw === ''
      ? null
      : Number(vendorIdRaw);
    if (vendorId !== null && (!Number.isInteger(vendorId) || vendorId <= 0)) {
      reply.status(400);
      return { error: 'invalid vendorId' };
    }
    const eligibleOnly = String(query.eligibleOnly ?? query.eligible ?? 'false').toLowerCase() === 'true';
    const statusFilter = (query.status ? String(query.status).trim().toUpperCase() : null) as string | null;

    const rows = await prisma.vendorCredit.findMany({
      where: {
        companyId,
        ...(vendorId ? { vendorId } : {}),
        ...(statusFilter ? { status: statusFilter as any } : {}),
        ...(eligibleOnly ? { status: 'POSTED' as any } : {}),
      },
      orderBy: [{ creditDate: 'desc' }, { id: 'desc' }],
      include: { vendor: true, location: true },
    });

    const mapped = rows.map((c) => ({
      id: c.id,
      creditNumber: c.creditNumber,
      status: c.status,
      creditDate: c.creditDate,
      vendorId: (c as any).vendorId ?? null,
      vendorName: c.vendor?.name ?? null,
      locationName: (c as any).location?.name ?? null,
      total: c.total.toString(),
      amountApplied: c.amountApplied.toString(),
      remaining: new Prisma.Decimal(c.total).sub(new Prisma.Decimal(c.amountApplied)).toDecimalPlaces(2).toString(),
      createdAt: c.createdAt,
    }));

    if (eligibleOnly) {
      return mapped.filter((c) => Number(c.remaining) > 0);
    }
    return mapped;
  });

  // Create vendor credit (DRAFT)
  fastify.post('/companies/:companyId/vendor-credits', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');

    const body = request.body as {
      vendorId?: number | null;
      creditDate?: string;
      currency?: string;
      locationId?: number;
      warehouseId?: number;
      lines?: {
        itemId?: number;
        quantity?: number;
        unitCost?: number;
        discountAmount?: number;
        taxRate?: number;
        description?: string;
        accountId?: number;
      }[];
    };

    if (!body.lines?.length) {
      reply.status(400);
      return { error: 'lines is required' };
    }

    const creditDate = parseDateInput(body.creditDate) ?? new Date();
    if (body.creditDate && isNaN(creditDate.getTime())) {
      reply.status(400);
      return { error: 'invalid creditDate' };
    }

    const cfg = await ensureInventoryCompanyDefaults(prisma as any, companyId);
    const locationId = Number(body.locationId ?? body.warehouseId ?? (cfg as any).defaultLocationId);
    if (!locationId || Number.isNaN(locationId)) {
      reply.status(400);
      return { error: 'locationId is required (or set company defaultLocationId)' };
    }

    if (body.vendorId) {
      const vendor = await prisma.vendor.findFirst({ where: { id: body.vendorId, companyId } });
      if (!vendor) {
        reply.status(400);
        return { error: 'vendorId not found in this company' };
      }
    }

    const loc = await prisma.location.findFirst({ where: { id: locationId, companyId } });
    if (!loc) {
      reply.status(400);
      return { error: 'locationId not found in this company' };
    }

    let subtotal = new Prisma.Decimal(0);
    let taxAmount = new Prisma.Decimal(0);
    const computedLines: any[] = [];
    for (const [idx, l] of (body.lines ?? []).entries()) {
      const itemId = Number(l.itemId);
      const qty = Number(l.quantity ?? 0);
      const unitCost = Number(l.unitCost ?? 0);
      const discountAmount = Number((l as any).discountAmount ?? 0);
      if (!itemId || Number.isNaN(itemId)) {
        reply.status(400);
        return { error: `lines[${idx}].itemId is required` };
      }
      if (!qty || qty <= 0) {
        reply.status(400);
        return { error: `lines[${idx}].quantity must be > 0` };
      }
      if (!unitCost || unitCost <= 0) {
        reply.status(400);
        return { error: `lines[${idx}].unitCost must be > 0` };
      }
      if (!Number.isFinite(discountAmount) || discountAmount < 0) {
        reply.status(400);
        return { error: `lines[${idx}].discountAmount must be >= 0` };
      }

      const item = await prisma.item.findFirst({
        where: { id: itemId, companyId },
        select: { id: true, type: true, trackInventory: true, name: true, expenseAccountId: true },
      });
      if (!item) {
        reply.status(400);
        return { error: `lines[${idx}].itemId not found in this company` };
      }

      // Draft-friendly: allow missing account mapping; posting will enforce.
      let accountId: number | null = null;
      const isTracked = item.type === 'GOODS' && !!item.trackInventory;
      if (isTracked) {
        accountId = cfg.inventoryAssetAccountId ?? null;
      } else {
        accountId = Number(l.accountId ?? item.expenseAccountId ?? 0) || null;
        if (accountId) {
          const acc = await prisma.account.findFirst({ where: { id: accountId, companyId, type: AccountType.EXPENSE } });
          if (!acc) {
            reply.status(400);
            return { error: `lines[${idx}].accountId must be an EXPENSE account in this company` };
          }
        }
      }

      const qtyDec = new Prisma.Decimal(qty).toDecimalPlaces(2);
      const unitDec = new Prisma.Decimal(unitCost).toDecimalPlaces(2);
      const gross = qtyDec.mul(unitDec).toDecimalPlaces(2);
      const disc = new Prisma.Decimal(discountAmount).toDecimalPlaces(2);
      if (disc.greaterThan(gross)) {
        reply.status(400);
        return { error: `lines[${idx}].discountAmount cannot exceed line subtotal` };
      }
      const lineTotal = gross.sub(disc).toDecimalPlaces(2); // net subtotal (tax-exclusive)
      const rate = new Prisma.Decimal(Number((l as any).taxRate ?? 0)).toDecimalPlaces(4);
      if (rate.lessThan(0) || rate.greaterThan(1)) {
        reply.status(400);
        return { error: `lines[${idx}].taxRate must be between 0 and 1 (e.g., 0.07 for 7%)` };
      }
      const lineTax = lineTotal.mul(rate).toDecimalPlaces(2);
      subtotal = subtotal.add(lineTotal);
      taxAmount = taxAmount.add(lineTax);

      computedLines.push({
        companyId,
        locationId,
        itemId,
        accountId,
        description: l.description ?? null,
        quantity: qtyDec,
        unitCost: unitDec,
        discountAmount: disc,
        lineTotal, // net subtotal
        taxRate: rate,
        taxAmount: lineTax,
      });
    }

    subtotal = subtotal.toDecimalPlaces(2);
    taxAmount = taxAmount.toDecimalPlaces(2);
    const total = subtotal.add(taxAmount).toDecimalPlaces(2);

    const created = await prisma.$transaction(async (tx: any) => {
      const creditNumber = await nextVendorCreditNumber(tx as any, companyId);
      return await tx.vendorCredit.create({
        data: {
          companyId,
          vendorId: body.vendorId ?? null,
          locationId,
          creditNumber,
          status: 'DRAFT',
          creditDate,
          currency: body.currency ?? null,
          subtotal,
          taxAmount,
          total,
          amountApplied: new Prisma.Decimal(0),
          lines: { create: computedLines },
        } as any,
        include: {
          vendor: true,
          location: true,
          lines: { include: { item: true, account: true } },
        },
      });
    });

    return created;
  });

  // Detail
  fastify.get('/companies/:companyId/vendor-credits/:vendorCreditId', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const vendorCreditId = Number((request.params as any)?.vendorCreditId);
    if (Number.isNaN(vendorCreditId)) {
      reply.status(400);
      return { error: 'invalid vendorCreditId' };
    }

    const vc = await prisma.vendorCredit.findFirst({
      where: { id: vendorCreditId, companyId },
      include: {
        vendor: true,
        location: true,
        lines: { include: { item: true, account: true } },
        applications: {
          include: {
            purchaseBill: { include: { vendor: true, location: true } },
          },
          orderBy: { appliedDate: 'desc' },
        },
        journalEntry: {
          include: {
            lines: { include: { account: { select: { id: true, code: true, name: true, type: true } } } },
          },
        },
      },
    });
    if (!vc) {
      reply.status(404);
      return { error: 'vendor credit not found' };
    }

    const applied = (vc.applications ?? []).reduce((s: Prisma.Decimal, a: any) => s.add(new Prisma.Decimal(a.amount)), new Prisma.Decimal(0)).toDecimalPlaces(2);
    const remaining = new Prisma.Decimal(vc.total).sub(applied).toDecimalPlaces(2);

    return {
      id: vc.id,
      creditNumber: vc.creditNumber,
      status: vc.status,
      creditDate: vc.creditDate,
      currency: vc.currency ?? null,
      vendor: vc.vendor,
      location: (vc as any).location,
      total: new Prisma.Decimal(vc.total).toDecimalPlaces(2).toString(),
      amountApplied: applied.toString(),
      remaining: remaining.toString(),
      journalEntryId: vc.journalEntryId ?? null,
      lines: (vc.lines ?? []).map((l: any) => ({
        id: l.id,
        itemId: l.itemId,
        item: l.item,
        accountId: l.accountId ?? null,
        account: l.account ? { id: l.account.id, code: l.account.code, name: l.account.name, type: l.account.type } : null,
        description: l.description ?? null,
        quantity: l.quantity,
        unitCost: l.unitCost,
        lineTotal: l.lineTotal,
      })),
      applications: (vc.applications ?? []).map((a: any) => ({
        id: a.id,
        appliedDate: a.appliedDate,
        amount: a.amount,
        purchaseBill: a.purchaseBill
          ? {
              id: a.purchaseBill.id,
              billNumber: a.purchaseBill.billNumber,
              billDate: a.purchaseBill.billDate,
              vendorName: a.purchaseBill.vendor?.name ?? null,
              locationName: a.purchaseBill.location?.name ?? null,
              total: a.purchaseBill.total?.toString?.() ?? String(a.purchaseBill.total ?? ''),
            }
          : null,
      })),
    };
  });

  // Post vendor credit (DRAFT/APPROVED -> POSTED): Dr AP / Cr Inventory or Expense
  fastify.post('/companies/:companyId/vendor-credits/:vendorCreditId/post', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const vendorCreditId = Number((request.params as any)?.vendorCreditId);
    if (!companyId || Number.isNaN(vendorCreditId)) {
      reply.status(400);
      return { error: 'invalid companyId or vendorCreditId' };
    }

    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      reply.status(400);
      return { error: 'Idempotency-Key header is required' };
    }

    const occurredAt = isoNow();
    const correlationId = randomUUID();
    const lockKey = `lock:vendor-credit:post:${companyId}:${vendorCreditId}`;

    const pre = await prisma.vendorCredit.findFirst({
      where: { id: vendorCreditId, companyId },
      select: { id: true, locationId: true, lines: { select: { itemId: true } } },
    });
    if (!pre) {
      reply.status(404);
      return { error: 'vendor credit not found' };
    }

    const stockLocks = (pre.lines ?? []).map((l: any) => `lock:stock:${companyId}:${pre.locationId}:${l.itemId}`);

    try {
      const { replay, response: result } = await withLocksBestEffort(redis, stockLocks, 30_000, async () =>
        withLockBestEffort(redis, lockKey, 30_000, async () =>
          runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
            const txResult = await prisma.$transaction(async (tx: any) => {
              await tx.$queryRaw`
                SELECT id FROM VendorCredit
                WHERE id = ${vendorCreditId} AND companyId = ${companyId}
                FOR UPDATE
              `;

              const vc = await tx.vendorCredit.findFirst({
                where: { id: vendorCreditId, companyId },
                include: { company: true, vendor: true, location: true, lines: { include: { item: true } } },
              });
              if (!vc) throw Object.assign(new Error('vendor credit not found'), { statusCode: 404 });
              if (vc.status !== 'DRAFT' && vc.status !== 'APPROVED') {
                throw Object.assign(new Error('only DRAFT/APPROVED vendor credits can be posted'), { statusCode: 400 });
              }
              if (vc.journalEntryId) {
                // already posted
                return { vendorCreditId: vc.id, status: vc.status, journalEntryId: vc.journalEntryId };
              }

              const cfg = await ensureInventoryCompanyDefaults(tx as any, companyId);
              const apId = (vc.company as any).accountsPayableAccountId;
              if (!apId) throw Object.assign(new Error('company.accountsPayableAccountId is not set'), { statusCode: 400 });
              const apAcc = await tx.account.findFirst({ where: { id: apId, companyId, type: AccountType.LIABILITY } });
              if (!apAcc) throw Object.assign(new Error('accountsPayableAccountId must be a LIABILITY account in this company'), { statusCode: 400 });

              let subtotal = new Prisma.Decimal(0);
              let taxAmount = new Prisma.Decimal(0);
              const creditByAccount = new Map<number, Prisma.Decimal>();

              for (const [idx, l] of (vc.lines ?? []).entries()) {
                const qty = new Prisma.Decimal(l.quantity).toDecimalPlaces(2);
                const unitCost = new Prisma.Decimal(l.unitCost).toDecimalPlaces(2);
                const lineTotal = new Prisma.Decimal(l.lineTotal).toDecimalPlaces(2);
                const lineTax = new Prisma.Decimal((l as any).taxAmount ?? 0).toDecimalPlaces(2);
                if (qty.lessThanOrEqualTo(0) || unitCost.lessThanOrEqualTo(0) || lineTotal.lessThanOrEqualTo(0)) {
                  throw Object.assign(new Error(`invalid line[${idx}] quantity/unitCost`), { statusCode: 400 });
                }
                subtotal = subtotal.add(lineTotal);
                taxAmount = taxAmount.add(lineTax);

                const item = (l as any).item;
                const isTracked = item?.type === 'GOODS' && !!item?.trackInventory;

                let creditAccountId: number | null = (l as any).accountId ?? null;
                if (isTracked) {
                  if (!cfg.inventoryAssetAccountId) {
                    throw Object.assign(new Error('company.inventoryAssetAccountId is not set'), { statusCode: 400 });
                  }
                  creditAccountId = cfg.inventoryAssetAccountId;
                  await ensureInventoryItem(tx as any, companyId, l.itemId);
                  await applyStockMoveWac(tx as any, {
                    companyId,
                    locationId: vc.locationId,
                    itemId: l.itemId,
                    date: vc.creditDate,
                    type: 'PURCHASE_RETURN',
                    direction: 'OUT',
                    quantity: qty,
                    unitCostApplied: new Prisma.Decimal(0),
                    totalCostApplied: lineTotal,
                    referenceType: 'VendorCredit',
                    referenceId: String(vc.id),
                    correlationId,
                    createdByUserId: (request as any).user?.userId ?? null,
                    journalEntryId: null,
                    // Allow backdating: WAC is recalculated by replaying the full move timeline.
                    allowBackdated: true,
                  });
                } else {
                  if (!creditAccountId) {
                    creditAccountId = item?.expenseAccountId ?? null;
                  }
                  if (!creditAccountId) {
                    throw Object.assign(new Error(`line[${idx}].accountId is required for non-inventory items`), { statusCode: 400 });
                  }
                  const exp = await tx.account.findFirst({ where: { id: creditAccountId, companyId, type: AccountType.EXPENSE } });
                  if (!exp) throw Object.assign(new Error(`line[${idx}].accountId must be an EXPENSE account`), { statusCode: 400 });
                }

                const prev = creditByAccount.get(creditAccountId) ?? new Prisma.Decimal(0);
                creditByAccount.set(creditAccountId, prev.add(lineTotal));
              }

              subtotal = subtotal.toDecimalPlaces(2);
              taxAmount = taxAmount.toDecimalPlaces(2);
              const storedTotal = new Prisma.Decimal(vc.total).toDecimalPlaces(2);
              const total = subtotal.add(taxAmount).toDecimalPlaces(2);
              if (!total.equals(storedTotal)) {
                throw Object.assign(
                  new Error(`rounding mismatch: recomputed total ${total.toString()} != stored total ${storedTotal.toString()}`),
                  { statusCode: 400 }
                );
              }

              const creditLines = Array.from(creditByAccount.entries()).map(([accountId, amt]) => ({
                accountId,
                debit: new Prisma.Decimal(0),
                credit: amt.toDecimalPlaces(2),
              }));

              const taxReceivableId = await ensureTaxReceivableAccountIfNeeded(tx as any, companyId, taxAmount);
              if (taxAmount.greaterThan(0)) {
                if (!taxReceivableId) throw Object.assign(new Error('tax receivable account required when taxAmount > 0'), { statusCode: 400 });
                creditLines.push({ accountId: taxReceivableId, debit: new Prisma.Decimal(0), credit: taxAmount });
              }

              const je = await postJournalEntry(tx as any, {
                companyId,
                date: vc.creditDate,
                description: `Vendor Credit ${vc.creditNumber}${vc.vendor ? ` for ${vc.vendor.name}` : ''}`,
                createdByUserId: (request as any).user?.userId ?? null,
                skipAccountValidation: true,
                lines: [
                  { accountId: apAcc.id, debit: total, credit: new Prisma.Decimal(0) },
                  ...creditLines,
                ],
              });

              await tx.stockMove.updateMany({
                where: { companyId, correlationId, journalEntryId: null, referenceType: 'VendorCredit', referenceId: String(vc.id) },
                data: { journalEntryId: je.id },
              });

              await tx.vendorCredit.update({
                where: { id: vc.id },
                data: { status: 'POSTED', journalEntryId: je.id, amountApplied: new Prisma.Decimal(0) } as any,
              });

              await writeAuditLog(tx as any, {
                companyId,
                userId: (request as any).user?.userId ?? null,
                action: 'vendor_credit.post',
                entityType: 'VendorCredit',
                entityId: vc.id,
                idempotencyKey,
                correlationId,
                metadata: { creditNumber: vc.creditNumber, creditDate: vc.creditDate, total: total.toString(), journalEntryId: je.id, occurredAt },
              });

              // Emit journal.entry.created event so worker updates AccountBalance (Balance Sheet fix)
              const jeEventId = randomUUID();
              await tx.event.create({
                data: {
                  companyId,
                  eventId: jeEventId,
                  eventType: 'journal.entry.created',
                  type: 'JournalEntryCreated',
                  schemaVersion: 'v1',
                  occurredAt: new Date(occurredAt),
                  source: 'cashflow-api',
                  partitionKey: String(companyId),
                  correlationId,
                  aggregateType: 'JournalEntry',
                  aggregateId: String(je.id),
                  payload: { journalEntryId: je.id, companyId },
                },
              });

              return { vendorCreditId: vc.id, status: 'POSTED', journalEntryId: je.id, total: total.toString(), _jeEventId: jeEventId };
            });

            return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
          }, redis)
        )
      );

      // Fast-path publish: fire-and-forget to Pub/Sub (non-blocking)
      if (!replay && (result as any)._jeEventId) {
        publishEventsFastPath([(result as any)._jeEventId]);
      }

      return { vendorCreditId: (result as any).vendorCreditId, status: (result as any).status, journalEntryId: (result as any).journalEntryId };
    } catch (err: any) {
      if (err?.statusCode) {
        reply.status(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });

  // Void vendor credit (POSTED only): reversal JE + reverse stock moves
  fastify.post('/companies/:companyId/vendor-credits/:vendorCreditId/void', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const vendorCreditId = Number((request.params as any)?.vendorCreditId);
    if (!companyId || Number.isNaN(vendorCreditId)) {
      reply.status(400);
      return { error: 'invalid companyId or vendorCreditId' };
    }

    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      reply.status(400);
      return { error: 'Idempotency-Key header is required' };
    }

    const body = (request.body ?? {}) as { reason?: string; voidDate?: string };
    if (!body.reason || !String(body.reason).trim()) {
      reply.status(400);
      return { error: 'reason is required' };
    }
    const voidDate = parseDateInput(body.voidDate) ?? new Date();
    if (body.voidDate && isNaN(voidDate.getTime())) {
      reply.status(400);
      return { error: 'invalid voidDate' };
    }

    const occurredAt = isoNow();
    const correlationId = randomUUID();
    const lockKey = `lock:vendor-credit:void:${companyId}:${vendorCreditId}`;

    try {
      const preMoves = await prisma.stockMove.findMany({
        where: { companyId, referenceType: 'VendorCredit', referenceId: String(vendorCreditId) },
        select: { locationId: true, itemId: true, quantity: true, unitCostApplied: true, totalCostApplied: true },
      });
      const stockLockKeys = Array.from(new Set((preMoves ?? []).map((m: any) => `lock:stock:${companyId}:${m.locationId}:${m.itemId}`)));

      const wrapped = async (fn: () => Promise<any>) =>
        stockLockKeys.length > 0
          ? withLocksBestEffort(redis, stockLockKeys, 30_000, async () => withLockBestEffort(redis, lockKey, 30_000, fn))
          : withLockBestEffort(redis, lockKey, 30_000, fn);

      const { replay, response: result } = await wrapped(async () =>
        runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
          const txResult = await prisma.$transaction(async (tx: any) => {
            await tx.$queryRaw`
              SELECT id FROM VendorCredit
              WHERE id = ${vendorCreditId} AND companyId = ${companyId}
              FOR UPDATE
            `;

            const vc = await tx.vendorCredit.findFirst({
              where: { id: vendorCreditId, companyId },
              include: { journalEntry: { include: { lines: true } } },
            });
            if (!vc) throw Object.assign(new Error('vendor credit not found'), { statusCode: 404 });
            if (vc.status === 'VOID') {
              return { vendorCreditId: vc.id, status: vc.status, voidJournalEntryId: (vc as any).voidJournalEntryId ?? null, alreadyVoided: true };
            }
            if (vc.status !== 'POSTED') throw Object.assign(new Error('only POSTED vendor credits can be voided'), { statusCode: 400 });
            if (!vc.journalEntryId) throw Object.assign(new Error('vendor credit missing journal entry link'), { statusCode: 500 });

            // Cannot void if already applied
            const appliedSum = await tx.vendorCreditApplication.aggregate({
              where: { companyId, vendorCreditId: vc.id },
              _sum: { amount: true },
            });
            const applied = (appliedSum._sum.amount ?? new Prisma.Decimal(0)).toDecimalPlaces(2);
            if (applied.greaterThan(0)) {
              throw Object.assign(new Error('cannot void a vendor credit that has been applied (unapply first)'), { statusCode: 400 });
            }

            const { reversal } = await createReversalJournalEntry(tx, {
              companyId,
              originalJournalEntryId: vc.journalEntryId,
              reversalDate: voidDate,
              reason: String(body.reason).trim(),
              createdByUserId: (request as any).user?.userId ?? null,
            });

            // Reverse inventory moves (OUT -> IN) at the originally applied unit cost.
            const origMoves = await tx.stockMove.findMany({
              where: { companyId, referenceType: 'VendorCredit', referenceId: String(vc.id) },
              select: { locationId: true, itemId: true, quantity: true, unitCostApplied: true },
            });
            if ((origMoves ?? []).length > 0) {
              for (const m of origMoves as any[]) {
                await applyStockMoveWac(tx as any, {
                  companyId,
                  locationId: m.locationId,
                  itemId: m.itemId,
                  date: voidDate,
                  type: 'PURCHASE_RECEIPT',
                  direction: 'IN',
                  quantity: new Prisma.Decimal(m.quantity).toDecimalPlaces(2),
                  unitCostApplied: new Prisma.Decimal(m.unitCostApplied ?? 0).toDecimalPlaces(2),
                  referenceType: 'VendorCreditVoid',
                  referenceId: String(vc.id),
                  correlationId,
                  createdByUserId: (request as any).user?.userId ?? null,
                  journalEntryId: reversal.id,
                  allowBackdated: true,
                });
              }
            }

            const voidedAt = new Date();
            await tx.vendorCredit.update({
              where: { id: vc.id },
              data: {
                status: 'VOID',
                voidedAt,
                voidReason: String(body.reason).trim(),
                voidedByUserId: (request as any).user?.userId ?? null,
                voidJournalEntryId: reversal.id,
                updatedByUserId: (request as any).user?.userId ?? null,
              } as any,
            });

            await writeAuditLog(tx as any, {
              companyId,
              userId: (request as any).user?.userId ?? null,
              action: 'vendor_credit.void',
              entityType: 'VendorCredit',
              entityId: vc.id,
              idempotencyKey,
              correlationId,
              metadata: { reason: String(body.reason).trim(), voidDate, voidedAt, originalJournalEntryId: vc.journalEntryId, voidJournalEntryId: reversal.id, occurredAt },
            });

            // Emit journal.entry.created event for reversal JE so worker updates AccountBalance
            const jeEventId = randomUUID();
            await tx.event.create({
              data: {
                companyId,
                eventId: jeEventId,
                eventType: 'journal.entry.created',
                type: 'JournalEntryCreated',
                schemaVersion: 'v1',
                occurredAt: new Date(occurredAt),
                source: 'cashflow-api',
                partitionKey: String(companyId),
                correlationId,
                aggregateType: 'JournalEntry',
                aggregateId: String(reversal.id),
                payload: { journalEntryId: reversal.id, companyId },
              },
            });

            return { vendorCreditId: vc.id, status: 'VOID', voidJournalEntryId: reversal.id, _jeEventId: jeEventId };
          });

          return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
        }, redis)
      );

      // Fast-path publish: fire-and-forget to Pub/Sub (non-blocking)
      if (!replay && (result as any)._jeEventId) {
        publishEventsFastPath([(result as any)._jeEventId]);
      }

      return { vendorCreditId: (result as any).vendorCreditId, status: (result as any).status, voidJournalEntryId: (result as any).voidJournalEntryId ?? null };
    } catch (err: any) {
      if (err?.statusCode) {
        reply.status(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });
}


