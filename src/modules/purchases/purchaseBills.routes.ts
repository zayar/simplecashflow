import type { FastifyInstance } from 'fastify';
import { prisma } from '../../infrastructure/db.js';
import { AccountType, BankingAccountKind, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { requireCompanyIdParam } from '../../utils/tenant.js';
import { getRedis } from '../../infrastructure/redis.js';
import { withLockBestEffort, withLocksBestEffort } from '../../infrastructure/locks.js';
import { runIdempotentRequest } from '../../infrastructure/commandIdempotency.js';
import { postJournalEntry } from '../ledger/posting.service.js';
import { isoNow, parseDateInput } from '../../utils/date.js';
import { ensureInventoryCompanyDefaults, ensureInventoryItem } from '../inventory/stock.service.js';
import { applyStockMoveWac } from '../inventory/stock.service.js';
import { toMoneyDecimal } from '../../utils/money.js';
import { nextPurchaseBillNumber } from '../sequence/sequence.service.js';
import { requireAnyRole, Roles } from '../../utils/rbac.js';
import { writeAuditLog } from '../../infrastructure/auditLog.js';

function generatePurchaseBillNumber(): string {
  // legacy fallback (should not be used in new code paths)
  return `PBILL-${Date.now()}`;
}

export async function purchaseBillsRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate);
  const redis = getRedis();

  // List purchase bills
  fastify.get('/companies/:companyId/purchase-bills', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const rows = await prisma.purchaseBill.findMany({
      where: { companyId },
      orderBy: [{ billDate: 'desc' }, { id: 'desc' }],
      include: { vendor: true, warehouse: true },
    });
    return rows.map((b) => ({
      id: b.id,
      billNumber: b.billNumber,
      status: b.status,
      billDate: b.billDate,
      dueDate: b.dueDate ?? null,
      vendorName: b.vendor?.name ?? null,
      warehouseName: b.warehouse?.name ?? null,
      total: b.total.toString(),
      amountPaid: b.amountPaid.toString(),
      createdAt: b.createdAt,
    }));
  });

  // Create purchase bill (DRAFT)
  fastify.post('/companies/:companyId/purchase-bills', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const body = request.body as {
      vendorId?: number | null;
      billDate?: string;
      dueDate?: string;
      currency?: string;
      warehouseId?: number;
      lines?: { itemId?: number; quantity?: number; unitCost?: number; description?: string; accountId?: number }[];
    };

    if (!body.lines?.length) {
      reply.status(400);
      return { error: 'lines is required' };
    }

    const billDate = parseDateInput(body.billDate) ?? new Date();
    const dueDate = body.dueDate ? parseDateInput(body.dueDate) : null;
    if (body.billDate && isNaN(billDate.getTime())) {
      reply.status(400);
      return { error: 'invalid billDate' };
    }
    if (body.dueDate && dueDate && isNaN(dueDate.getTime())) {
      reply.status(400);
      return { error: 'invalid dueDate' };
    }

    // Bootstrap defaults for older companies
    const cfg = await ensureInventoryCompanyDefaults(prisma as any, companyId);
    const warehouseId = Number(body.warehouseId ?? cfg.defaultWarehouseId);
    if (!warehouseId || Number.isNaN(warehouseId)) {
      reply.status(400);
      return { error: 'warehouseId is required (or set company defaultWarehouseId)' };
    }

    if (body.vendorId) {
      const vendor = await prisma.vendor.findFirst({ where: { id: body.vendorId, companyId } });
      if (!vendor) {
        reply.status(400);
        return { error: 'vendorId not found in this company' };
      }
    }

    const wh = await prisma.warehouse.findFirst({ where: { id: warehouseId, companyId } });
    if (!wh) {
      reply.status(400);
      return { error: 'warehouseId not found in this company' };
    }

    // Compute lines + totals
    let total = new Prisma.Decimal(0);
    const computedLines: any[] = [];
    for (const [idx, l] of (body.lines ?? []).entries()) {
      const itemId = Number(l.itemId);
      const qty = Number(l.quantity ?? 0);
      const unitCost = Number(l.unitCost ?? 0);
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

      // Item can be GOODS (tracked or not) or SERVICE.
      const item = await prisma.item.findFirst({
        where: { id: itemId, companyId },
        select: { id: true, type: true, trackInventory: true, name: true, expenseAccountId: true },
      });
      if (!item) {
        reply.status(400);
        return { error: `lines[${idx}].itemId not found in this company` };
      }

      // Determine accountId for this line.
      // - Tracked inventory: force Inventory Asset
      // - Otherwise: prefer EXPENSE account (line.accountId or item.expenseAccountId)
      //
      // UX rule: allow saving DRAFT even if account mapping is missing.
      // Posting will enforce required account mappings.
      let accountId: number | null = null;
      const isTracked = item.type === 'GOODS' && !!item.trackInventory;
      if (isTracked) {
        accountId = cfg.inventoryAssetAccountId ?? null;
      } else {
        accountId = Number(l.accountId ?? item.expenseAccountId ?? 0) || null;
        // Validate if provided
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
      const lineTotal = qtyDec.mul(unitDec).toDecimalPlaces(2);
      total = total.add(lineTotal);
      computedLines.push({
        companyId,
        warehouseId,
        itemId,
        accountId,
        description: l.description ?? null,
        quantity: qtyDec,
        unitCost: unitDec,
        lineTotal,
      });
    }

    total = total.toDecimalPlaces(2);

    const bill = await prisma.$transaction(async (tx) => {
      const billNumber = await nextPurchaseBillNumber(tx as any, companyId);
      return await (tx as any).purchaseBill.create({
        data: {
          companyId,
          vendorId: body.vendorId ?? null,
          warehouseId,
          billNumber,
          status: 'DRAFT',
          billDate,
          dueDate: dueDate ?? null,
          currency: body.currency ?? null,
          total,
          amountPaid: new Prisma.Decimal(0),
          lines: { create: computedLines },
        } as any,
        include: {
          vendor: true,
          warehouse: true,
          lines: { include: { item: true, account: true } },
        },
      });
    });

    return bill;
  });

  // Detail view
  fastify.get('/companies/:companyId/purchase-bills/:purchaseBillId', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const purchaseBillId = Number((request.params as any)?.purchaseBillId);
    if (Number.isNaN(purchaseBillId)) {
      reply.status(400);
      return { error: 'invalid purchaseBillId' };
    }

    const bill = await prisma.purchaseBill.findFirst({
      where: { id: purchaseBillId, companyId },
      include: {
        vendor: true,
        warehouse: true,
        lines: { include: { item: true, account: true } },
        payments: {
          include: {
            bankAccount: true,
            journalEntry: {
              include: {
                lines: { include: { account: { select: { id: true, code: true, name: true, type: true } } } },
              },
            },
          },
          orderBy: { paymentDate: 'desc' },
        },
        journalEntry: {
          include: {
            lines: { include: { account: { select: { id: true, code: true, name: true, type: true } } } },
          },
        },
      },
    });
    if (!bill) {
      reply.status(404);
      return { error: 'purchase bill not found' };
    }
    const totalPaid = (bill.payments ?? [])
      .filter((p: any) => !p.reversedAt)
      .reduce((sum: number, p: any) => sum + Number(p.amount), 0);

    return {
      id: bill.id,
      billNumber: bill.billNumber,
      status: bill.status,
      billDate: bill.billDate,
      dueDate: bill.dueDate ?? null,
      currency: bill.currency ?? null,
      vendor: bill.vendor,
      warehouse: bill.warehouse,
      total: bill.total,
      totalPaid,
      remainingBalance: Number(bill.total) - totalPaid,
      journalEntryId: bill.journalEntryId ?? null,
      lines: (bill.lines ?? []).map((l: any) => ({
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
      payments: (bill.payments ?? []).map((p: any) => ({
        id: p.id,
        paymentDate: p.paymentDate,
        amount: p.amount,
        bankAccount: { id: p.bankAccount.id, code: p.bankAccount.code, name: p.bankAccount.name },
        journalEntryId: p.journalEntry?.id ?? null,
        reversedAt: (p as any).reversedAt ?? null,
        reversalReason: (p as any).reversalReason ?? null,
        reversalJournalEntryId: (p as any).reversalJournalEntryId ?? null,
      })),
    };
  });

  // Update purchase bill (DRAFT only)
  fastify.put('/companies/:companyId/purchase-bills/:purchaseBillId', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const purchaseBillId = Number((request.params as any)?.purchaseBillId);
    if (!companyId || Number.isNaN(purchaseBillId)) {
      reply.status(400);
      return { error: 'invalid companyId or purchaseBillId' };
    }

    const body = request.body as {
      vendorId?: number | null;
      billDate?: string;
      dueDate?: string | null;
      currency?: string | null;
      warehouseId?: number;
      lines?: { itemId?: number; quantity?: number; unitCost?: number; description?: string; accountId?: number }[];
    };

    if (!body.lines?.length) {
      reply.status(400);
      return { error: 'lines is required' };
    }

    const billDate = parseDateInput(body.billDate) ?? new Date();
    const dueDate = body.dueDate ? parseDateInput(body.dueDate) : null;
    if (body.billDate && isNaN(billDate.getTime())) {
      reply.status(400);
      return { error: 'invalid billDate' };
    }
    if (body.dueDate && dueDate && isNaN(dueDate.getTime())) {
      reply.status(400);
      return { error: 'invalid dueDate' };
    }

    const cfg = await ensureInventoryCompanyDefaults(prisma as any, companyId);
    const warehouseId = Number(body.warehouseId ?? cfg.defaultWarehouseId);
    if (!warehouseId || Number.isNaN(warehouseId)) {
      reply.status(400);
      return { error: 'warehouseId is required (or set company defaultWarehouseId)' };
    }

    if (body.vendorId) {
      const vendor = await prisma.vendor.findFirst({ where: { id: body.vendorId, companyId } });
      if (!vendor) {
        reply.status(400);
        return { error: 'vendorId not found in this company' };
      }
    }

    const wh = await prisma.warehouse.findFirst({ where: { id: warehouseId, companyId } });
    if (!wh) {
      reply.status(400);
      return { error: 'warehouseId not found in this company' };
    }

    // Compute lines + totals (same rules as create)
    let total = new Prisma.Decimal(0);
    const computedLines: any[] = [];
    for (const [idx, l] of (body.lines ?? []).entries()) {
      const itemId = Number(l.itemId);
      const qty = Number(l.quantity ?? 0);
      const unitCost = Number(l.unitCost ?? 0);
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

      const item = await prisma.item.findFirst({
        where: { id: itemId, companyId },
        select: { id: true, type: true, trackInventory: true, name: true, expenseAccountId: true },
      });
      if (!item) {
        reply.status(400);
        return { error: `lines[${idx}].itemId not found in this company` };
      }

      let accountId: number | null = null;
      const isTracked = item.type === 'GOODS' && !!item.trackInventory;
      if (isTracked) {
        accountId = cfg.inventoryAssetAccountId ?? null;
      } else {
        accountId = Number(l.accountId ?? item.expenseAccountId ?? 0) || null;
        // Validate if provided
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
      const lineTotal = qtyDec.mul(unitDec).toDecimalPlaces(2);
      total = total.add(lineTotal);
      computedLines.push({
        companyId,
        warehouseId,
        itemId,
        accountId,
        description: l.description ?? null,
        quantity: qtyDec,
        unitCost: unitDec,
        lineTotal,
      });
    }

    total = total.toDecimalPlaces(2);

    const updated = await prisma.$transaction(async (tx: any) => {
      await tx.$queryRaw`
        SELECT id FROM PurchaseBill
        WHERE id = ${purchaseBillId} AND companyId = ${companyId}
        FOR UPDATE
      `;

      const existing = await tx.purchaseBill.findFirst({
        where: { id: purchaseBillId, companyId },
        select: { id: true, status: true, journalEntryId: true },
      });
      if (!existing) {
        throw Object.assign(new Error('purchase bill not found'), { statusCode: 404 });
      }
      if (existing.status !== 'DRAFT' || existing.journalEntryId) {
        throw Object.assign(new Error('only DRAFT purchase bills can be edited'), { statusCode: 400 });
      }

      return await tx.purchaseBill.update({
        where: { id: purchaseBillId, companyId },
        data: {
          vendorId: body.vendorId ?? null,
          warehouseId,
          billDate,
          dueDate: dueDate ?? null,
          currency: body.currency ?? null,
          total,
          lines: {
            deleteMany: {},
            create: computedLines,
          },
        },
        include: {
          vendor: true,
          warehouse: true,
          lines: { include: { item: true, account: true } },
        },
      });
    });

    return updated;
  });

  // Post purchase bill: DRAFT -> POSTED (creates stock moves + JE Dr Inventory / Cr AP)
  fastify.post('/companies/:companyId/purchase-bills/:purchaseBillId/post', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const purchaseBillId = Number((request.params as any)?.purchaseBillId);
    if (!companyId || Number.isNaN(purchaseBillId)) {
      reply.status(400);
      return { error: 'invalid companyId or purchaseBillId' };
    }

    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      reply.status(400);
      return { error: 'Idempotency-Key header is required' };
    }

    const occurredAt = isoNow();
    const correlationId = randomUUID();
    const lockKey = `lock:purchase-bill:post:${companyId}:${purchaseBillId}`;

    const pre = await prisma.purchaseBill.findFirst({
      where: { id: purchaseBillId, companyId },
      select: { id: true, warehouseId: true, lines: { select: { itemId: true } } },
    });
    if (!pre) {
      reply.status(404);
      return { error: 'purchase bill not found' };
    }

    const stockLocks = (pre.lines ?? []).map((l) => `lock:stock:${companyId}:${pre.warehouseId}:${l.itemId}`);

    const { replay, response: result } = await withLocksBestEffort(redis, stockLocks, 30_000, async () =>
      withLockBestEffort(redis, lockKey, 30_000, async () =>
        runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
          const txResult = await prisma.$transaction(async (tx) => {
            // DB-level serialization safety: lock the purchase bill row so concurrent posts
            // (with different idempotency keys) cannot double-post.
            const locked = (await (tx as any).$queryRaw`
              SELECT id FROM PurchaseBill
              WHERE id = ${purchaseBillId} AND companyId = ${companyId}
              FOR UPDATE
            `) as Array<{ id: number }>;
            if (!locked?.length) {
              throw Object.assign(new Error('purchase bill not found'), { statusCode: 404 });
            }

            const bill = await (tx as any).purchaseBill.findFirst({
              where: { id: purchaseBillId, companyId },
              include: { company: true, vendor: true, warehouse: true, lines: { include: { item: true } } },
            });
            if (!bill) throw Object.assign(new Error('purchase bill not found'), { statusCode: 404 });
            if (bill.status !== 'DRAFT') {
              throw Object.assign(new Error('only DRAFT purchase bills can be posted'), { statusCode: 400 });
            }

            const cfg = await ensureInventoryCompanyDefaults(tx as any, companyId);
            if (!cfg.inventoryAssetAccountId) {
              throw Object.assign(new Error('company.inventoryAssetAccountId is not set'), { statusCode: 400 });
            }
            const apId = (bill.company as any).accountsPayableAccountId;
            if (!apId) {
              throw Object.assign(new Error('company.accountsPayableAccountId is not set'), { statusCode: 400 });
            }
            const apAcc = await (tx as any).account.findFirst({ where: { id: apId, companyId, type: 'LIABILITY' } });
            if (!apAcc) {
              throw Object.assign(new Error('accountsPayableAccountId must be a LIABILITY account in this company'), {
                statusCode: 400,
              });
            }

            // Apply stock moves for tracked items, and compute per-account debits.
            let total = new Prisma.Decimal(0);
            const debitByAccount = new Map<number, Prisma.Decimal>();

            for (const [idx, l] of (bill.lines ?? []).entries()) {
              const qty = new Prisma.Decimal(l.quantity).toDecimalPlaces(2);
              const unitCost = new Prisma.Decimal(l.unitCost).toDecimalPlaces(2);
              if (qty.lessThanOrEqualTo(0) || unitCost.lessThanOrEqualTo(0)) {
                throw Object.assign(new Error(`invalid line[${idx}] quantity/unitCost`), { statusCode: 400 });
              }

              const lineTotal = new Prisma.Decimal(l.lineTotal).toDecimalPlaces(2);
              total = total.add(lineTotal);

              const item = (l as any).item;
              const isTracked = item?.type === 'GOODS' && !!item?.trackInventory;

              let debitAccountId: number | null = (l as any).accountId ?? null;
              if (isTracked) {
                debitAccountId = cfg.inventoryAssetAccountId!;
                await ensureInventoryItem(tx as any, companyId, l.itemId);
                await applyStockMoveWac(tx as any, {
                  companyId,
                  warehouseId: bill.warehouseId,
                  itemId: l.itemId,
                  date: bill.billDate,
                  type: 'PURCHASE_RECEIPT',
                  direction: 'IN',
                  quantity: qty,
                  unitCostApplied: unitCost,
                  referenceType: 'PurchaseBill',
                  referenceId: String(bill.id),
                  correlationId,
                  createdByUserId: (request as any).user?.userId ?? null,
                  journalEntryId: null,
                });
              } else {
                if (!debitAccountId) {
                  debitAccountId = item?.expenseAccountId ?? null;
                }
                if (!debitAccountId) {
                  throw Object.assign(new Error(`line[${idx}] accountId is required for non-inventory items`), { statusCode: 400 });
                }
                const exp = await (tx as any).account.findFirst({ where: { id: debitAccountId, companyId, type: 'EXPENSE' } });
                if (!exp) throw Object.assign(new Error(`line[${idx}] accountId must be an EXPENSE account`), { statusCode: 400 });
              }

              const prev = debitByAccount.get(debitAccountId) ?? new Prisma.Decimal(0);
              debitByAccount.set(debitAccountId, prev.add(lineTotal));
            }

            total = total.toDecimalPlaces(2);

            // CRITICAL FIX #3: Rounding validation - ensure recomputed total matches stored total.
            // This prevents debit != credit if line-level rounding drifted from sum-then-round.
            const storedTotal = new Prisma.Decimal(bill.total).toDecimalPlaces(2);
            if (!total.equals(storedTotal)) {
              throw Object.assign(
                new Error(
                  `rounding mismatch: recomputed total ${total.toString()} != stored total ${storedTotal.toString()}. Purchase bill may have been corrupted.`
                ),
                { statusCode: 400, recomputedTotal: total.toString(), storedTotal: storedTotal.toString() }
              );
            }

            const debitLines = Array.from(debitByAccount.entries()).map(([accountId, amt]) => ({
              accountId,
              debit: amt.toDecimalPlaces(2),
              credit: new Prisma.Decimal(0),
            }));

            const je = await postJournalEntry(tx as any, {
              companyId,
              date: bill.billDate,
              description: `Purchase Bill ${bill.billNumber}${bill.vendor ? ` for ${bill.vendor.name}` : ''}`,
              createdByUserId: (request as any).user?.userId ?? null,
              skipAccountValidation: true,
              lines: [
                ...debitLines,
                { accountId: apAcc.id, debit: new Prisma.Decimal(0), credit: total },
              ],
            });

            await (tx as any).stockMove.updateMany({
              where: { companyId, correlationId, journalEntryId: null },
              data: { journalEntryId: je.id },
            });

            const upd = await (tx as any).purchaseBill.updateMany({
              where: { id: bill.id, companyId },
              data: { status: 'POSTED', journalEntryId: je.id, total, amountPaid: new Prisma.Decimal(0) },
            });
            if ((upd as any).count !== 1) {
              throw Object.assign(new Error('purchase bill not found'), { statusCode: 404 });
            }
            const updated = await (tx as any).purchaseBill.findFirst({
              where: { id: bill.id, companyId },
              select: { id: true, status: true },
            });
            if (!updated) {
              throw Object.assign(new Error('purchase bill not found'), { statusCode: 404 });
            }

            const jeEventId = randomUUID();
            await (tx as any).event.create({
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
              action: 'purchase_bill.post',
              entityType: 'PurchaseBill',
              entityId: bill.id,
              idempotencyKey,
              correlationId,
              metadata: {
                billNumber: bill.billNumber,
                billDate: bill.billDate,
                warehouseId: bill.warehouseId,
                total: total.toString(),
                journalEntryId: je.id,
              },
            });

            return { purchaseBillId: updated.id, status: updated.status, journalEntryId: je.id, total: total.toString(), _jeEventId: jeEventId };
          });

          return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
        }, redis)
      )
    );

    return {
      purchaseBillId: (result as any).purchaseBillId,
      status: (result as any).status,
      journalEntryId: (result as any).journalEntryId,
      total: (result as any).total,
    };
  });

  // Record purchase bill payment: Dr AP / Cr Cash-Bank
  fastify.post('/companies/:companyId/purchase-bills/:purchaseBillId/payments', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const purchaseBillId = Number((request.params as any)?.purchaseBillId);
    if (!companyId || Number.isNaN(purchaseBillId)) {
      reply.status(400);
      return { error: 'invalid companyId or purchaseBillId' };
    }

    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      reply.status(400);
      return { error: 'Idempotency-Key header is required' };
    }

    const body = request.body as { paymentDate?: string; amount?: number; bankAccountId?: number };
    if (!body.amount || body.amount <= 0 || !body.bankAccountId) {
      reply.status(400);
      return { error: 'amount (>0) and bankAccountId are required' };
    }

    const occurredAt = isoNow();
    const correlationId = randomUUID();
    const lockKey = `lock:purchase-bill:payment:${companyId}:${purchaseBillId}`;

    try {
      const { replay, response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () =>
        runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
          const txResult = await prisma.$transaction(async (tx) => {
            // DB-level serialization safety: lock the purchase bill row so concurrent payments
            // cannot overspend remaining balance even if Redis is unavailable.
            const locked = (await (tx as any).$queryRaw`
              SELECT id FROM PurchaseBill
              WHERE id = ${purchaseBillId} AND companyId = ${companyId}
              FOR UPDATE
            `) as Array<{ id: number }>;
            if (!locked?.length) {
              throw Object.assign(new Error('purchase bill not found'), { statusCode: 404 });
            }

            const bill = await (tx as any).purchaseBill.findFirst({
              where: { id: purchaseBillId, companyId },
              include: { company: true },
            });
            if (!bill) throw Object.assign(new Error('purchase bill not found'), { statusCode: 404 });
            if (bill.status !== 'POSTED' && bill.status !== 'PARTIAL') {
              throw Object.assign(new Error('payments allowed only for POSTED or PARTIAL purchase bills'), { statusCode: 400 });
            }

            // CRITICAL FIX #1: Currency validation - ensure purchase bill currency matches company baseCurrency
            const baseCurrency = ((bill.company as any).baseCurrency ?? '').trim().toUpperCase() || null;
            const billCurrency = ((bill as any).currency ?? '').trim().toUpperCase() || null;
            if (baseCurrency && billCurrency && baseCurrency !== billCurrency) {
              throw Object.assign(
                new Error(`currency mismatch: purchase bill currency ${billCurrency} must match company baseCurrency ${baseCurrency}`),
                { statusCode: 400 }
              );
            }

            const apId = (bill.company as any).accountsPayableAccountId;
            if (!apId) throw Object.assign(new Error('company.accountsPayableAccountId is not set'), { statusCode: 400 });
            const apAcc = await (tx as any).account.findFirst({ where: { id: apId, companyId, type: AccountType.LIABILITY } });
            if (!apAcc) throw Object.assign(new Error('accountsPayableAccountId must be a LIABILITY account in this company'), { statusCode: 400 });

            const bankAccount = await (tx as any).account.findFirst({
              where: { id: body.bankAccountId!, companyId, type: AccountType.ASSET },
            });
            if (!bankAccount) throw Object.assign(new Error('bankAccountId must be an ASSET account in this company'), { statusCode: 400 });

            const banking = await (tx as any).bankingAccount.findFirst({
              where: { companyId, accountId: bankAccount.id },
              select: { kind: true },
            });
            if (!banking) {
              throw Object.assign(new Error('Pay From must be a banking account (create it under Banking first)'), {
                statusCode: 400,
              });
            }
            if (banking.kind === BankingAccountKind.CREDIT_CARD) {
              throw Object.assign(new Error('cannot pay from a credit card account'), { statusCode: 400 });
            }

            const paymentDate = parseDateInput(body.paymentDate) ?? new Date();
            if (body.paymentDate && isNaN(paymentDate.getTime())) {
              throw Object.assign(new Error('invalid paymentDate'), { statusCode: 400 });
            }

            const amount = toMoneyDecimal(body.amount!);

            const sumAgg = await (tx as any).purchaseBillPayment.aggregate({
              where: { purchaseBillId: bill.id, companyId, reversedAt: null },
              _sum: { amount: true },
            });
            const totalPaidBefore = (sumAgg._sum.amount ?? new Prisma.Decimal(0)).toDecimalPlaces(2);
            const remainingBefore = new Prisma.Decimal(bill.total).minus(totalPaidBefore).toDecimalPlaces(2);
            if (amount.greaterThan(remainingBefore)) {
              throw Object.assign(new Error(`amount cannot exceed remaining balance of ${remainingBefore.toString()}`), { statusCode: 400 });
            }

            const je = await postJournalEntry(tx as any, {
              companyId,
              date: paymentDate,
              description: `Payment for Purchase Bill ${bill.billNumber}`,
              createdByUserId: (request as any).user?.userId ?? null,
              skipAccountValidation: true,
              lines: [
                { accountId: apAcc.id, debit: amount, credit: new Prisma.Decimal(0) },
                { accountId: bankAccount.id, debit: new Prisma.Decimal(0), credit: amount },
              ],
            });

            const pay = await (tx as any).purchaseBillPayment.create({
              data: {
                companyId,
                purchaseBillId: bill.id,
                paymentDate,
                amount,
                bankAccountId: bankAccount.id,
                journalEntryId: je.id,
              },
            });

            const sumAgg2 = await (tx as any).purchaseBillPayment.aggregate({
              where: { purchaseBillId: bill.id, companyId, reversedAt: null },
              _sum: { amount: true },
            });
            const totalPaid = (sumAgg2._sum.amount ?? new Prisma.Decimal(0)).toDecimalPlaces(2);
            const newStatus = totalPaid.greaterThanOrEqualTo(bill.total) ? 'PAID' : 'PARTIAL';

            const updBill = await (tx as any).purchaseBill.updateMany({
              where: { id: bill.id, companyId },
              data: { amountPaid: totalPaid, status: newStatus },
            });
            if ((updBill as any).count !== 1) {
              throw Object.assign(new Error('purchase bill not found'), { statusCode: 404 });
            }

            const jeEventId = randomUUID();
            await (tx as any).event.create({
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
              action: 'purchase_bill.payment.create',
              entityType: 'PurchaseBillPayment',
              entityId: pay.id,
              idempotencyKey,
              correlationId,
              metadata: {
                purchaseBillId: bill.id,
                billNumber: bill.billNumber,
                amount: amount.toString(),
                paymentDate,
                bankAccountId: bankAccount.id,
                journalEntryId: je.id,
                newStatus,
              },
            });

            return { pay, je, jeEventId, newStatus };
          });

          return {
            purchaseBillId,
            purchaseBillPaymentId: txResult.pay.id,
            journalEntryId: txResult.je.id,
            status: txResult.newStatus,
            _jeEventId: txResult.jeEventId,
            _correlationId: correlationId,
            _occurredAt: occurredAt,
          };
        }, redis)
      );

      return {
        purchaseBillId,
        purchaseBillPaymentId: (result as any).purchaseBillPaymentId,
        journalEntryId: (result as any).journalEntryId,
        status: (result as any).status,
      };
    } catch (err: any) {
      if (err?.statusCode) {
        reply.status(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });
}


