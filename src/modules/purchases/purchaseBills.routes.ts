import type { FastifyInstance } from 'fastify';
import { prisma } from '../../infrastructure/db.js';
import { AccountType, BankingAccountKind, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { requireCompanyIdParam } from '../../utils/tenant.js';
import { getRedis } from '../../infrastructure/redis.js';
import { withLockBestEffort, withLocksBestEffort } from '../../infrastructure/locks.js';
import { runIdempotentRequest } from '../../infrastructure/commandIdempotency.js';
import { postJournalEntry } from '../ledger/posting.service.js';
import { isoNow, normalizeToDay, parseDateInput } from '../../utils/date.js';
import { assertOpenPeriodOrThrow } from '../../utils/periodClosePolicy.js';
import { ensureInventoryCompanyDefaults, ensureInventoryItem } from '../inventory/stock.service.js';
import { applyStockMoveWac, applyStockValueAdjustmentWac } from '../inventory/stock.service.js';
import { toMoneyDecimal } from '../../utils/money.js';
import { nextPurchaseBillNumber } from '../sequence/sequence.service.js';
import { requireAnyRole, Roles } from '../../utils/rbac.js';
import { writeAuditLog } from '../../infrastructure/auditLog.js';
import { createReversalJournalEntry, computeNetByAccount, diffNets, buildAdjustmentLinesFromNets } from '../ledger/reversal.service.js';
import { publishEventsFastPath } from '../../infrastructure/pubsub.js';
import { ensureGrniAccount } from './grni.service.js';
import { ensurePurchasePriceVarianceAccount } from './ppv.service.js';

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
      include: { vendor: true, location: true },
    });
    return rows.map((b) => ({
      id: b.id,
      billNumber: b.billNumber,
      status: b.status,
      billDate: b.billDate,
      dueDate: b.dueDate ?? null,
      vendorName: b.vendor?.name ?? null,
      locationName: (b as any).location?.name ?? null,
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
      purchaseReceiptId?: number | null;
      billDate?: string;
      dueDate?: string;
      currency?: string;
      locationId?: number;
      warehouseId?: number; // backward-compatible alias
      lines?: {
        itemId?: number;
        quantity?: number;
        unitCost?: number;
        discountAmount?: number;
        description?: string;
        accountId?: number;
      }[];
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

    if (body.purchaseReceiptId) {
      const pr = await prisma.purchaseReceipt.findFirst({ where: { id: body.purchaseReceiptId, companyId }, select: { id: true, status: true, locationId: true } });
      if (!pr) {
        reply.status(400);
        return { error: 'purchaseReceiptId not found in this company' };
      }
      if (pr.status !== 'POSTED') {
        reply.status(400);
        return { error: 'purchaseReceiptId must be POSTED before billing' };
      }
      // Enforce same location for v1 simplicity (prevents confusing partial receipts).
      if (Number(pr.locationId) !== Number(locationId)) {
        reply.status(400);
        return { error: 'purchaseReceipt location must match bill location (v1)' };
      }
    }

    const loc = await prisma.location.findFirst({ where: { id: locationId, companyId } });
    if (!loc) {
      reply.status(400);
      return { error: 'locationId not found in this company' };
    }

    // Compute lines + totals
    let total = new Prisma.Decimal(0);
    const computedLines: any[] = [];
    for (const [idx, l] of (body.lines ?? []).entries()) {
      const itemId = Number(l.itemId);
      const qty = Number(l.quantity ?? 0);
      const unitCost = Number(l.unitCost ?? 0);
      const discountAmount = Number(l.discountAmount ?? 0);
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
      const gross = qtyDec.mul(unitDec).toDecimalPlaces(2);
      const disc = new Prisma.Decimal(discountAmount).toDecimalPlaces(2);
      if (disc.greaterThan(gross)) {
        reply.status(400);
        return { error: `lines[${idx}].discountAmount cannot exceed line subtotal` };
      }
      const lineTotal = gross.sub(disc).toDecimalPlaces(2);
      total = total.add(lineTotal);
      computedLines.push({
        companyId,
        locationId,
        itemId,
        accountId,
        description: l.description ?? null,
        quantity: qtyDec,
        unitCost: unitDec,
        discountAmount: disc,
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
          purchaseReceiptId: body.purchaseReceiptId ?? null,
          locationId,
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
          location: true,
          purchaseReceipt: true,
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
        location: true,
        lines: { include: { item: true, account: true } },
        creditApplications: {
          include: {
            vendorCredit: { select: { id: true, creditNumber: true, creditDate: true, status: true } },
          },
          orderBy: { appliedDate: 'desc' },
        },
        vendorAdvanceApplications: {
          include: {
            vendorAdvance: { select: { id: true, advanceDate: true } } as any,
          } as any,
          orderBy: { appliedDate: 'desc' } as any,
        } as any,
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
    const totalPayments = (bill.payments ?? [])
      .filter((p: any) => !p.reversedAt)
      .reduce((sum: number, p: any) => sum + Number(p.amount), 0);
    // Avoid TS reduce overload inference issues by using explicit loops.
    let totalCredits = 0;
    for (const a of (bill.creditApplications ?? []) as any[]) totalCredits += Number((a as any).amount ?? 0);

    let totalAdvances = 0;
    for (const a of (bill.vendorAdvanceApplications ?? []) as any[]) totalAdvances += Number((a as any).amount ?? 0);
    const totalPaid = totalPayments + totalCredits + totalAdvances;

    return {
      id: bill.id,
      billNumber: bill.billNumber,
      status: bill.status,
      billDate: bill.billDate,
      dueDate: bill.dueDate ?? null,
      currency: bill.currency ?? null,
      vendor: bill.vendor,
      location: (bill as any).location,
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
        discountAmount: (l as any).discountAmount ?? new Prisma.Decimal(0),
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
      creditsApplied: [
        ...(bill.creditApplications ?? []).map((a: any) => ({
          id: a.id,
          appliedDate: a.appliedDate,
          amount: a.amount,
          kind: 'VENDOR_CREDIT',
          vendorCredit: a.vendorCredit
            ? { id: a.vendorCredit.id, creditNumber: a.vendorCredit.creditNumber, creditDate: a.vendorCredit.creditDate, status: a.vendorCredit.status }
            : null,
          vendorAdvance: null,
          journalEntryId: null,
        })),
        ...(bill.vendorAdvanceApplications ?? []).map((a: any) => ({
          id: a.id,
          appliedDate: a.appliedDate,
          amount: a.amount,
          kind: 'VENDOR_ADVANCE',
          vendorCredit: null,
          vendorAdvance: a.vendorAdvance ? { id: a.vendorAdvance.id, advanceDate: a.vendorAdvance.advanceDate } : { id: a.vendorAdvanceId, advanceDate: null },
          journalEntryId: a.journalEntryId ?? null,
        })),
      ],
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
      purchaseReceiptId?: number | null;
      billDate?: string;
      dueDate?: string | null;
      currency?: string | null;
      locationId?: number;
      warehouseId?: number; // backward-compatible alias
      lines?: {
        itemId?: number;
        quantity?: number;
        unitCost?: number;
        discountAmount?: number;
        description?: string;
        accountId?: number;
      }[];
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

    if (body.purchaseReceiptId) {
      const pr = await prisma.purchaseReceipt.findFirst({ where: { id: body.purchaseReceiptId, companyId }, select: { id: true, status: true, locationId: true } });
      if (!pr) {
        reply.status(400);
        return { error: 'purchaseReceiptId not found in this company' };
      }
      if (pr.status !== 'POSTED') {
        reply.status(400);
        return { error: 'purchaseReceiptId must be POSTED before billing' };
      }
      if (Number(pr.locationId) !== Number(locationId)) {
        reply.status(400);
        return { error: 'purchaseReceipt location must match bill location (v1)' };
      }
    }

    const loc2 = await prisma.location.findFirst({ where: { id: locationId, companyId } });
    if (!loc2) {
      reply.status(400);
      return { error: 'locationId not found in this company' };
    }

    // Compute lines + totals (same rules as create)
    let total = new Prisma.Decimal(0);
    const computedLines: any[] = [];
    for (const [idx, l] of (body.lines ?? []).entries()) {
      const itemId = Number(l.itemId);
      const qty = Number(l.quantity ?? 0);
      const unitCost = Number(l.unitCost ?? 0);
      const discountAmount = Number(l.discountAmount ?? 0);
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
      const gross = qtyDec.mul(unitDec).toDecimalPlaces(2);
      const disc = new Prisma.Decimal(discountAmount).toDecimalPlaces(2);
      if (disc.greaterThan(gross)) {
        reply.status(400);
        return { error: `lines[${idx}].discountAmount cannot exceed line subtotal` };
      }
      const lineTotal = gross.sub(disc).toDecimalPlaces(2);
      total = total.add(lineTotal);
      computedLines.push({
        companyId,
        locationId,
        itemId,
        accountId,
        description: l.description ?? null,
        quantity: qtyDec,
        unitCost: unitDec,
        discountAmount: disc,
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
      if ((existing.status !== 'DRAFT' && existing.status !== 'APPROVED') || existing.journalEntryId) {
        throw Object.assign(new Error('only DRAFT/APPROVED purchase bills can be edited'), { statusCode: 400 });
      }

      return await tx.purchaseBill.update({
        where: { id: purchaseBillId, companyId },
        data: {
          vendorId: body.vendorId ?? null,
          locationId,
          purchaseReceiptId: body.purchaseReceiptId ?? null,
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
          location: true,
          lines: { include: { item: true, account: true } },
        },
      });
    });

    return updated;
  });

  // Delete purchase bill (DRAFT/APPROVED only)
  fastify.delete('/companies/:companyId/purchase-bills/:purchaseBillId', async (request, reply) => {
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

    const correlationId = randomUUID();
    const occurredAt = isoNow();
    const lockKey = `lock:purchase-bill:delete:${companyId}:${purchaseBillId}`;

    try {
      const { response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () =>
        runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
          const txResult = await prisma.$transaction(async (tx: any) => {
            await tx.$queryRaw`
              SELECT id FROM PurchaseBill
              WHERE id = ${purchaseBillId} AND companyId = ${companyId}
              FOR UPDATE
            `;

            const bill = await tx.purchaseBill.findFirst({
              where: { id: purchaseBillId, companyId },
              select: { id: true, status: true, billNumber: true, journalEntryId: true },
            });
            if (!bill) throw Object.assign(new Error('purchase bill not found'), { statusCode: 404 });
            if (bill.status !== 'DRAFT' && bill.status !== 'APPROVED') {
              throw Object.assign(new Error('only DRAFT/APPROVED purchase bills can be deleted'), { statusCode: 400 });
            }
            if (bill.journalEntryId) {
              throw Object.assign(new Error('cannot delete a purchase bill that already has a journal entry'), { statusCode: 400 });
            }

            const payCount = await tx.purchaseBillPayment.count({ where: { companyId, purchaseBillId: bill.id } });
            if (payCount > 0) throw Object.assign(new Error('cannot delete a purchase bill that has payments'), { statusCode: 400 });

            await tx.purchaseBillLine.deleteMany({ where: { companyId, purchaseBillId: bill.id } });
            await tx.purchaseBill.delete({ where: { id: bill.id } });

            await writeAuditLog(tx as any, {
              companyId,
              userId: (request as any).user?.userId ?? null,
              action: 'purchase_bill.delete_unposted',
              entityType: 'PurchaseBill',
              entityId: bill.id,
              idempotencyKey,
              correlationId,
              metadata: { billNumber: bill.billNumber, status: bill.status, occurredAt },
            });

            return { purchaseBillId: bill.id, deleted: true };
          });
          return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
        }, redis)
      );

      return { purchaseBillId: (result as any).purchaseBillId, deleted: true };
    } catch (err: any) {
      if (err?.statusCode) {
        reply.status(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });

  // Approve purchase bill (DRAFT -> APPROVED)
  fastify.post('/companies/:companyId/purchase-bills/:purchaseBillId/approve', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const purchaseBillId = Number((request.params as any)?.purchaseBillId);
    if (!companyId || Number.isNaN(purchaseBillId)) {
      reply.status(400);
      return { error: 'invalid companyId or purchaseBillId' };
    }
    const correlationId = randomUUID();
    const occurredAt = isoNow();

    try {
      const updated = await prisma.$transaction(async (tx: any) => {
        await tx.$queryRaw`
          SELECT id FROM PurchaseBill
          WHERE id = ${purchaseBillId} AND companyId = ${companyId}
          FOR UPDATE
        `;
        const bill = await tx.purchaseBill.findFirst({
          where: { id: purchaseBillId, companyId },
          select: { id: true, status: true, journalEntryId: true, billNumber: true },
        });
        if (!bill) throw Object.assign(new Error('purchase bill not found'), { statusCode: 404 });
        if (bill.status !== 'DRAFT') throw Object.assign(new Error('only DRAFT purchase bills can be approved'), { statusCode: 400 });
        if (bill.journalEntryId) throw Object.assign(new Error('cannot approve a purchase bill that already has a journal entry'), { statusCode: 400 });

        const upd = await tx.purchaseBill.update({
          where: { id: bill.id },
          data: { status: 'APPROVED', updatedByUserId: (request as any).user?.userId ?? null } as any,
          select: { id: true, status: true, billNumber: true },
        });

        await writeAuditLog(tx as any, {
          companyId,
          userId: (request as any).user?.userId ?? null,
          action: 'purchase_bill.approve',
          entityType: 'PurchaseBill',
          entityId: bill.id,
          idempotencyKey: (request.headers as any)?.['idempotency-key'] ?? null,
          correlationId,
          metadata: { billNumber: bill.billNumber, fromStatus: 'DRAFT', toStatus: 'APPROVED', occurredAt },
        });

        return upd;
      });
      return updated;
    } catch (err: any) {
      if (err?.statusCode) {
        reply.status(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
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
      select: { id: true, locationId: true, lines: { select: { itemId: true } } },
    });
    if (!pre) {
      reply.status(404);
      return { error: 'purchase bill not found' };
    }

    const stockLocks = (pre.lines ?? []).map((l) => `lock:stock:${companyId}:${pre.locationId}:${l.itemId}`);

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
              include: { company: true, vendor: true, location: true, lines: { include: { item: true } } },
            });
            if (!bill) throw Object.assign(new Error('purchase bill not found'), { statusCode: 404 });
            if (bill.status !== 'DRAFT' && bill.status !== 'APPROVED') {
              throw Object.assign(new Error('only DRAFT/APPROVED purchase bills can be posted'), { statusCode: 400 });
            }

            // Period-close guard: block posting into closed periods (backdating rule).
            await assertOpenPeriodOrThrow(tx as any, {
              companyId,
              transactionDate: new Date(bill.billDate),
              action: 'purchase_bill.post',
            });

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
            let inventoryRecalcFromDate: Date | null = null;

            const linkedReceiptId = Number((bill as any).purchaseReceiptId ?? 0) || null;
            let linkedReceipt: any | null = null;
            if (linkedReceiptId) {
              linkedReceipt = await (tx as any).purchaseReceipt.findFirst({
                where: { id: linkedReceiptId, companyId },
                select: { id: true, status: true, locationId: true, receiptDate: true, total: true, vendorId: true },
              });
              if (!linkedReceipt) {
                throw Object.assign(new Error('purchaseReceiptId not found in this company'), { statusCode: 400 });
              }
              if (linkedReceipt.status !== 'POSTED') {
                throw Object.assign(new Error('linked purchase receipt must be POSTED before billing'), { statusCode: 400 });
              }
              if (Number(linkedReceipt.locationId) !== Number(bill.locationId)) {
                throw Object.assign(new Error('linked purchase receipt location must match bill location (v1)'), { statusCode: 400 });
              }
            }

            let inventoryLinesTotal = new Prisma.Decimal(0);
            let landedCostTotal = new Prisma.Decimal(0);

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
                if (linkedReceipt) {
                  inventoryLinesTotal = inventoryLinesTotal.add(lineTotal);
                  // We'll build the final JE after the loop:
                  // - Dr GRNI (receiptTotal)
                  // - Dr Inventory (landedCostTotal, via value-only stock moves)
                  // - Dr/Cr PPV (inventoryLinesTotal - receiptTotal)
                  // - Cr AP (billTotal)
                  continue;
                } else {
                  debitAccountId = cfg.inventoryAssetAccountId!;
                  await ensureInventoryItem(tx as any, companyId, l.itemId);
                  const applied = await applyStockMoveWac(tx as any, {
                    companyId,
                    locationId: bill.locationId,
                    itemId: l.itemId,
                    date: bill.billDate,
                    type: 'PURCHASE_RECEIPT',
                    direction: 'IN',
                    quantity: qty,
                    unitCostApplied: unitCost,
                    // Preserve the exact discounted line total in inventory value / WAC.
                    totalCostApplied: lineTotal,
                    referenceType: 'PurchaseBill',
                    referenceId: String(bill.id),
                    correlationId,
                    createdByUserId: (request as any).user?.userId ?? null,
                    journalEntryId: null,
                    // Allow backdating: WAC is recalculated by replaying the full move timeline.
                    allowBackdated: true,
                  });
                  const from = (applied as any)?.requiresInventoryRecalcFromDate as Date | null | undefined;
                  if (from && !isNaN(new Date(from).getTime())) {
                    inventoryRecalcFromDate =
                      !inventoryRecalcFromDate || new Date(from).getTime() < inventoryRecalcFromDate.getTime()
                        ? new Date(from)
                        : inventoryRecalcFromDate;
                  }
                }
              } else {
                if (linkedReceipt) {
                  // Treat non-inventory lines on a linked receipt bill as landed cost (capitalized into inventory).
                  landedCostTotal = landedCostTotal.add(lineTotal);
                  continue;
                }
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
            inventoryLinesTotal = inventoryLinesTotal.toDecimalPlaces(2);
            landedCostTotal = landedCostTotal.toDecimalPlaces(2);

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

            // If linked to a receipt, override debits to clear GRNI + post PPV variance.
            let finalDebitLines = debitLines;
            if (linkedReceipt) {
              const grniId = await ensureGrniAccount(tx as any, companyId);
              const ppvId = await ensurePurchasePriceVarianceAccount(tx as any, companyId);
              const receiptTotal = new Prisma.Decimal(linkedReceipt.total).toDecimalPlaces(2);
              const variance = inventoryLinesTotal.sub(receiptTotal).toDecimalPlaces(2); // + => billed inventory > received

              if (inventoryLinesTotal.lessThanOrEqualTo(0)) {
                throw Object.assign(new Error('linked receipt bill must include at least one inventory line'), { statusCode: 400 });
              }

              finalDebitLines = [];
              // Dr GRNI (reduce liability) up to receipt total
              finalDebitLines.push({ accountId: grniId, debit: receiptTotal, credit: new Prisma.Decimal(0) });

              // Capitalize landed cost into inventory (value-only moves) and also debit Inventory in the bill JE.
              if (landedCostTotal.greaterThan(0)) {
                // IMPORTANT: these value moves are dated at the receipt date (so they revalue subsequent issues),
                // therefore they must also be inside an OPEN period.
                await assertOpenPeriodOrThrow(tx as any, {
                  companyId,
                  transactionDate: new Date(linkedReceipt.receiptDate),
                  action: 'purchase_bill.post_landed_cost',
                });

                finalDebitLines.push({ accountId: cfg.inventoryAssetAccountId!, debit: landedCostTotal, credit: new Prisma.Decimal(0) });

                const receiptLines = await (tx as any).purchaseReceiptLine.findMany({
                  where: { companyId, purchaseReceiptId: linkedReceiptId },
                  select: { id: true, itemId: true, locationId: true, lineTotal: true, quantity: true },
                  orderBy: [{ id: 'asc' }],
                });
                if (!receiptLines?.length) {
                  throw Object.assign(new Error('linked receipt has no lines to allocate landed cost'), { statusCode: 400 });
                }

                const baseSum = receiptLines.reduce(
                  (sum: Prisma.Decimal, l: any) => sum.add(new Prisma.Decimal(l.lineTotal ?? 0).toDecimalPlaces(2)),
                  new Prisma.Decimal(0)
                ).toDecimalPlaces(2);
                if (baseSum.lessThanOrEqualTo(0)) {
                  throw Object.assign(new Error('cannot allocate landed cost: receipt lines total is zero'), { statusCode: 400 });
                }

                // Clear prior allocations if any (idempotency safety for partial retries).
                await (tx as any).purchaseBillLandedCostAllocation.deleteMany({
                  where: { companyId, purchaseBillId: bill.id },
                });

                let allocated = new Prisma.Decimal(0);
                for (const [i, rl] of (receiptLines as any[]).entries()) {
                  const weight = new Prisma.Decimal(rl.lineTotal ?? 0).toDecimalPlaces(2).div(baseSum);
                  let amt =
                    i === receiptLines.length - 1
                      ? landedCostTotal.sub(allocated).toDecimalPlaces(2)
                      : landedCostTotal.mul(weight).toDecimalPlaces(2);
                  if (amt.equals(0)) continue;
                  allocated = allocated.add(amt).toDecimalPlaces(2);

                  await (tx as any).purchaseBillLandedCostAllocation.create({
                    data: {
                      companyId,
                      purchaseBillId: bill.id,
                      purchaseReceiptId: linkedReceiptId,
                      purchaseReceiptLineId: rl.id,
                      amount: amt,
                    },
                  });

                  const applied = await applyStockValueAdjustmentWac(tx as any, {
                    companyId,
                    locationId: rl.locationId,
                    itemId: rl.itemId,
                    date: new Date(linkedReceipt.receiptDate),
                    valueDelta: amt,
                    allowBackdated: true,
                    referenceType: 'PurchaseBillLandedCost',
                    referenceId: String(bill.id),
                    correlationId,
                    createdByUserId: (request as any).user?.userId ?? null,
                    journalEntryId: null,
                  });
                  const from = (applied as any)?.requiresInventoryRecalcFromDate as Date | null | undefined;
                  if (from && !isNaN(new Date(from).getTime())) {
                    inventoryRecalcFromDate =
                      !inventoryRecalcFromDate || new Date(from).getTime() < inventoryRecalcFromDate.getTime()
                        ? new Date(from)
                        : inventoryRecalcFromDate;
                  }
                }
              }

              if (!variance.equals(0)) {
                if (variance.greaterThan(0)) {
                  // Bill > receipt: extra expense
                  finalDebitLines.push({ accountId: ppvId, debit: variance, credit: new Prisma.Decimal(0) });
                } else {
                  // Bill < receipt: credit variance account (reduces expense)
                  finalDebitLines.push({ accountId: ppvId, debit: new Prisma.Decimal(0), credit: variance.abs() });
                }
              }
            }

            const je = await postJournalEntry(tx as any, {
              companyId,
              date: bill.billDate,
              description: `Purchase Bill ${bill.billNumber}${bill.vendor ? ` for ${bill.vendor.name}` : ''}`,
              createdByUserId: (request as any).user?.userId ?? null,
              skipAccountValidation: true,
              lines: [
                ...(finalDebitLines as any),
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

            // If we inserted a truly backdated stock move, schedule an inventory recalc forward from that date.
            let inventoryRecalcEventId: string | null = null;
            if (inventoryRecalcFromDate) {
              inventoryRecalcEventId = randomUUID();
              await (tx as any).event.create({
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
                    source: 'PurchaseBillPost',
                    purchaseBillId: bill.id,
                  },
                },
              });
            }

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
                locationId: bill.locationId,
                total: total.toString(),
                journalEntryId: je.id,
              },
            });

            return {
              purchaseBillId: updated.id,
              status: updated.status,
              journalEntryId: je.id,
              total: total.toString(),
              _jeEventId: jeEventId,
              _inventoryRecalcEventId: inventoryRecalcEventId,
            };
          });

          return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
        }, redis)
      )
    );

    // Fast-path publish: fire-and-forget to Pub/Sub (non-blocking)
    if (!replay && (result as any)._jeEventId) {
      const ids = [(result as any)._jeEventId] as string[];
      if ((result as any)._inventoryRecalcEventId) ids.push((result as any)._inventoryRecalcEventId);
      publishEventsFastPath(ids);
    }

    return {
      purchaseBillId: (result as any).purchaseBillId,
      status: (result as any).status,
      journalEntryId: (result as any).journalEntryId,
      total: (result as any).total,
    };
  });

  // Adjust posted purchase bill (immutable ledger): only supported for non-inventory bills (no stock moves).
  // POST /companies/:companyId/purchase-bills/:purchaseBillId/adjust
  fastify.post('/companies/:companyId/purchase-bills/:purchaseBillId/adjust', async (request, reply) => {
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

    const body = (request.body ?? {}) as {
      reason?: string;
      adjustmentDate?: string;
      lines?: { itemId?: number; quantity?: number; unitCost?: number; discountAmount?: number; description?: string; accountId?: number }[];
    };
    if (!body.reason || !String(body.reason).trim()) {
      reply.status(400);
      return { error: 'reason is required' };
    }
    if (!body.lines?.length) {
      reply.status(400);
      return { error: 'lines is required' };
    }
    const adjustmentDate = parseDateInput(body.adjustmentDate) ?? new Date();
    if (body.adjustmentDate && isNaN(adjustmentDate.getTime())) {
      reply.status(400);
      return { error: 'invalid adjustmentDate' };
    }

    const correlationId = randomUUID();
    const occurredAt = isoNow();
    const lockKey = `lock:purchase-bill:adjust:${companyId}:${purchaseBillId}`;

    try {
      const preMoves = await prisma.stockMove.findMany({
        where: { companyId, referenceType: 'PurchaseBill', referenceId: String(purchaseBillId) },
        select: { id: true },
      });
      if ((preMoves ?? []).length > 0) {
        reply.status(400);
        return { error: 'cannot adjust an inventory-affecting purchase bill (void + recreate)' };
      }

      const { response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () =>
        runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
          const txResult = await prisma.$transaction(async (tx: any) => {
            await tx.$queryRaw`
              SELECT id FROM PurchaseBill
              WHERE id = ${purchaseBillId} AND companyId = ${companyId}
              FOR UPDATE
            `;

            const bill = await tx.purchaseBill.findFirst({
              where: { id: purchaseBillId, companyId },
              include: { company: true, lines: { include: { item: true } }, journalEntry: { include: { lines: true } } },
            });
            if (!bill) throw Object.assign(new Error('purchase bill not found'), { statusCode: 404 });
            if (bill.status !== 'POSTED') throw Object.assign(new Error('only POSTED purchase bills can be adjusted'), { statusCode: 400 });
            if (!bill.journalEntryId || !(bill as any).journalEntry) {
              throw Object.assign(new Error('purchase bill is POSTED but missing journal entry link'), { statusCode: 500 });
            }

            await assertOpenPeriodOrThrow(tx as any, {
              companyId,
              transactionDate: adjustmentDate,
              action: 'purchase_bill.adjust',
            });

            const payCount = await tx.purchaseBillPayment.count({ where: { companyId, purchaseBillId: bill.id, reversedAt: null } });
            if (payCount > 0) throw Object.assign(new Error('cannot adjust a purchase bill that has payments (reverse payments first)'), { statusCode: 400 });

            const cfg = await ensureInventoryCompanyDefaults(tx as any, companyId);
            const apId = (bill.company as any).accountsPayableAccountId;
            if (!apId) throw Object.assign(new Error('company.accountsPayableAccountId is not set'), { statusCode: 400 });

            // Compute new lines + total (non-inventory only)
            let total = new Prisma.Decimal(0);
            const computedLines: any[] = [];
            const debitByAccount = new Map<number, Prisma.Decimal>();

            for (const [idx, l] of (body.lines ?? []).entries()) {
              const itemId = Number(l.itemId);
              const qty = Number(l.quantity ?? 0);
              const unitCost = Number(l.unitCost ?? 0);
              const discountAmount = Number((l as any).discountAmount ?? 0);
              if (!itemId || Number.isNaN(itemId)) throw Object.assign(new Error(`lines[${idx}].itemId is required`), { statusCode: 400 });
              if (!qty || qty <= 0) throw Object.assign(new Error(`lines[${idx}].quantity must be > 0`), { statusCode: 400 });
              if (!unitCost || unitCost <= 0) throw Object.assign(new Error(`lines[${idx}].unitCost must be > 0`), { statusCode: 400 });
              if (!Number.isFinite(discountAmount) || discountAmount < 0) {
                throw Object.assign(new Error(`lines[${idx}].discountAmount must be >= 0`), { statusCode: 400 });
              }

              const item = await tx.item.findFirst({
                where: { id: itemId, companyId },
                select: { id: true, type: true, trackInventory: true, expenseAccountId: true, name: true },
              });
              if (!item) throw Object.assign(new Error(`lines[${idx}].itemId not found in this company`), { statusCode: 400 });
              if (item.type === 'GOODS' && !!item.trackInventory) {
                throw Object.assign(new Error('cannot adjust an inventory-tracked purchase bill (void + recreate)'), { statusCode: 400 });
              }

              const accountId = Number(l.accountId ?? item.expenseAccountId ?? 0) || null;
              if (!accountId) throw Object.assign(new Error(`lines[${idx}].accountId is required for non-inventory items`), { statusCode: 400 });
              const acc = await tx.account.findFirst({ where: { id: accountId, companyId, type: AccountType.EXPENSE } });
              if (!acc) throw Object.assign(new Error(`lines[${idx}].accountId must be an EXPENSE account in this company`), { statusCode: 400 });

              const qtyDec = new Prisma.Decimal(qty).toDecimalPlaces(2);
              const unitDec = new Prisma.Decimal(unitCost).toDecimalPlaces(2);
              const gross = qtyDec.mul(unitDec).toDecimalPlaces(2);
              const disc = new Prisma.Decimal(discountAmount).toDecimalPlaces(2);
              if (disc.greaterThan(gross)) {
                throw Object.assign(new Error(`lines[${idx}].discountAmount cannot exceed line subtotal`), { statusCode: 400 });
              }
              const lineTotal = gross.sub(disc).toDecimalPlaces(2);
              total = total.add(lineTotal);
              computedLines.push({
                companyId,
                locationId: bill.locationId,
                itemId,
                accountId,
                description: l.description ?? null,
                quantity: qtyDec,
                unitCost: unitDec,
                discountAmount: disc,
                lineTotal,
              });
              const prev = debitByAccount.get(accountId) ?? new Prisma.Decimal(0);
              debitByAccount.set(accountId, prev.add(lineTotal).toDecimalPlaces(2));
            }
            total = total.toDecimalPlaces(2);

            const desiredPostingLines: Array<{ accountId: number; debit: Prisma.Decimal; credit: Prisma.Decimal }> = [
              ...Array.from(debitByAccount.entries()).map(([accountId, amt]) => ({
                accountId,
                debit: amt.toDecimalPlaces(2),
                credit: new Prisma.Decimal(0),
              })),
              { accountId: apId, debit: new Prisma.Decimal(0), credit: total },
            ];

            const originalNet = computeNetByAccount(((bill as any).journalEntry.lines ?? []).map((l: any) => ({
              accountId: l.accountId,
              debit: l.debit,
              credit: l.credit,
            })));
            const desiredNet = computeNetByAccount(desiredPostingLines);
            const deltaNet = diffNets(originalNet, desiredNet);
            const adjustmentLines = buildAdjustmentLinesFromNets(deltaNet);

            const priorAdjId = Number((bill as any).lastAdjustmentJournalEntryId ?? 0) || null;
            let reversedPriorAdjustmentJournalEntryId: number | null = null;
            if (priorAdjId) {
              const { reversal } = await createReversalJournalEntry(tx, {
                companyId,
                originalJournalEntryId: priorAdjId,
                reversalDate: adjustmentDate,
                reason: `superseded by purchase bill adjustment: ${String(body.reason).trim()}`,
                createdByUserId: (request as any).user?.userId ?? null,
              });
              reversedPriorAdjustmentJournalEntryId = reversal.id;
              const createdEventId = randomUUID();
              await tx.event.create({
                data: {
                  companyId,
                  eventId: createdEventId,
                  eventType: 'journal.entry.created',
                  schemaVersion: 'v1',
                  occurredAt: new Date(occurredAt),
                  source: 'cashflow-api',
                  partitionKey: String(companyId),
                  correlationId,
                  causationId: String(priorAdjId),
                  aggregateType: 'JournalEntry',
                  aggregateId: String(reversal.id),
                  type: 'JournalEntryCreated',
                  payload: { journalEntryId: reversal.id, companyId, reversalOfJournalEntryId: priorAdjId },
                },
              });
              await tx.event.create({
                data: {
                  companyId,
                  eventId: randomUUID(),
                  eventType: 'journal.entry.reversed',
                  schemaVersion: 'v1',
                  occurredAt: new Date(occurredAt),
                  source: 'cashflow-api',
                  partitionKey: String(companyId),
                  correlationId,
                  causationId: createdEventId,
                  aggregateType: 'JournalEntry',
                  aggregateId: String(priorAdjId),
                  type: 'JournalEntryReversed',
                  payload: { originalJournalEntryId: priorAdjId, reversalJournalEntryId: reversal.id, companyId, reason: 'superseded' },
                },
              });
            }

            let adjustmentJournalEntryId: number | null = null;
            if (adjustmentLines.length > 0) {
              if (adjustmentLines.length < 2) throw Object.assign(new Error('adjustment resulted in an invalid journal entry (needs >=2 lines)'), { statusCode: 400 });
              const je = await postJournalEntry(tx, {
                companyId,
                date: adjustmentDate,
                description: `ADJUSTMENT for Purchase Bill ${(bill as any).billNumber}: ${String(body.reason).trim()}`,
                createdByUserId: (request as any).user?.userId ?? null,
                skipAccountValidation: true,
                lines: adjustmentLines,
              });
              adjustmentJournalEntryId = je.id;
              await tx.event.create({
                data: {
                  companyId,
                  eventId: randomUUID(),
                  eventType: 'journal.entry.created',
                  schemaVersion: 'v1',
                  occurredAt: new Date(occurredAt),
                  source: 'cashflow-api',
                  partitionKey: String(companyId),
                  correlationId,
                  aggregateType: 'JournalEntry',
                  aggregateId: String(je.id),
                  type: 'JournalEntryCreated',
                  payload: { journalEntryId: je.id, companyId, source: 'PurchaseBillAdjustment', purchaseBillId: bill.id },
                },
              });
            }

            await tx.purchaseBill.update({
              where: { id: bill.id },
              data: {
                total,
                lastAdjustmentJournalEntryId: adjustmentJournalEntryId,
                updatedByUserId: (request as any).user?.userId ?? null,
                lines: { deleteMany: {}, create: computedLines },
              } as any,
            });

            await writeAuditLog(tx as any, {
              companyId,
              userId: (request as any).user?.userId ?? null,
              action: 'purchase_bill.adjust_posted',
              entityType: 'PurchaseBill',
              entityId: bill.id,
              idempotencyKey,
              correlationId,
              metadata: {
                billNumber: (bill as any).billNumber,
                reason: String(body.reason).trim(),
                adjustmentDate,
                priorAdjustmentJournalEntryId: priorAdjId,
                reversedPriorAdjustmentJournalEntryId,
                adjustmentJournalEntryId,
                total: total.toString(),
              },
            });

            return { purchaseBillId: bill.id, status: bill.status, adjustmentJournalEntryId, reversedPriorAdjustmentJournalEntryId, total: total.toString() };
          });

          return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
        }, redis)
      );

      return {
        purchaseBillId: (result as any).purchaseBillId,
        status: (result as any).status,
        adjustmentJournalEntryId: (result as any).adjustmentJournalEntryId ?? null,
        reversedPriorAdjustmentJournalEntryId: (result as any).reversedPriorAdjustmentJournalEntryId ?? null,
        total: (result as any).total,
      };
    } catch (err: any) {
      if (err?.statusCode) {
        reply.status(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });

  // Void posted purchase bill (immutable ledger): marks purchase bill VOID and posts a reversal journal entry.
  // Also reverses any inventory moves created by posting the purchase bill.
  // POST /companies/:companyId/purchase-bills/:purchaseBillId/void
  fastify.post('/companies/:companyId/purchase-bills/:purchaseBillId/void', async (request, reply) => {
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

    const correlationId = randomUUID();
    const occurredAt = isoNow();
    const lockKey = `lock:purchase-bill:void:${companyId}:${purchaseBillId}`;

    try {
      const preMoves = await prisma.stockMove.findMany({
        where: { companyId, referenceType: 'PurchaseBill', referenceId: String(purchaseBillId) },
        select: { locationId: true, itemId: true },
      });
      const stockLockKeys = Array.from(
        new Set((preMoves ?? []).map((m: any) => `lock:stock:${companyId}:${m.locationId}:${m.itemId}`))
      );
      const wrapped = async (fn: () => Promise<any>) =>
        stockLockKeys.length > 0
          ? withLocksBestEffort(redis, stockLockKeys, 30_000, async () => withLockBestEffort(redis, lockKey, 30_000, fn))
          : withLockBestEffort(redis, lockKey, 30_000, fn);

      const { response: result } = await wrapped(async () =>
        runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
          const txResult = await prisma.$transaction(async (tx: any) => {
            await tx.$queryRaw`
              SELECT id FROM PurchaseBill
              WHERE id = ${purchaseBillId} AND companyId = ${companyId}
              FOR UPDATE
            `;

            const bill = await tx.purchaseBill.findFirst({
              where: { id: purchaseBillId, companyId },
              include: { journalEntry: { include: { lines: true } } },
            });
            if (!bill) throw Object.assign(new Error('purchase bill not found'), { statusCode: 404 });
            if (bill.status === 'VOID') {
              return { purchaseBillId: bill.id, status: bill.status, voidJournalEntryId: (bill as any).voidJournalEntryId ?? null, alreadyVoided: true };
            }
            if (bill.status !== 'POSTED') throw Object.assign(new Error('only POSTED purchase bills can be voided'), { statusCode: 400 });
            if (!bill.journalEntryId || !(bill as any).journalEntry) throw Object.assign(new Error('purchase bill is POSTED but missing journal entry link'), { statusCode: 500 });

            await assertOpenPeriodOrThrow(tx as any, { companyId, transactionDate: voidDate, action: 'purchase_bill.void' });

            const payCount = await tx.purchaseBillPayment.count({ where: { companyId, purchaseBillId: bill.id, reversedAt: null } });
            if (payCount > 0) throw Object.assign(new Error('cannot void a purchase bill that has payments (reverse payments first)'), { statusCode: 400 });

            const priorAdjId = Number((bill as any).lastAdjustmentJournalEntryId ?? 0) || null;
            let reversedPriorAdjustmentJournalEntryId: number | null = null;
            if (priorAdjId) {
              const { reversal } = await createReversalJournalEntry(tx, {
                companyId,
                originalJournalEntryId: priorAdjId,
                reversalDate: voidDate,
                reason: `void purchase bill: ${String(body.reason).trim()}`,
                createdByUserId: (request as any).user?.userId ?? null,
              });
              reversedPriorAdjustmentJournalEntryId = reversal.id;
              const createdEventId = randomUUID();
              await tx.event.create({
                data: {
                  companyId,
                  eventId: createdEventId,
                  eventType: 'journal.entry.created',
                  schemaVersion: 'v1',
                  occurredAt: new Date(occurredAt),
                  source: 'cashflow-api',
                  partitionKey: String(companyId),
                  correlationId,
                  causationId: String(priorAdjId),
                  aggregateType: 'JournalEntry',
                  aggregateId: String(reversal.id),
                  type: 'JournalEntryCreated',
                  payload: { journalEntryId: reversal.id, companyId, reversalOfJournalEntryId: priorAdjId },
                },
              });
              await tx.event.create({
                data: {
                  companyId,
                  eventId: randomUUID(),
                  eventType: 'journal.entry.reversed',
                  schemaVersion: 'v1',
                  occurredAt: new Date(occurredAt),
                  source: 'cashflow-api',
                  partitionKey: String(companyId),
                  correlationId,
                  causationId: createdEventId,
                  aggregateType: 'JournalEntry',
                  aggregateId: String(priorAdjId),
                  type: 'JournalEntryReversed',
                  payload: { originalJournalEntryId: priorAdjId, reversalJournalEntryId: reversal.id, companyId, reason: 'void purchase bill' },
                },
              });
            }

            const origMoves = await tx.stockMove.findMany({
              where: { companyId, referenceType: 'PurchaseBill', referenceId: String(bill.id) },
              select: { locationId: true, itemId: true, quantity: true, totalCostApplied: true },
            });

            const { reversal } = await createReversalJournalEntry(tx, {
              companyId,
              originalJournalEntryId: bill.journalEntryId,
              reversalDate: voidDate,
              reason: String(body.reason).trim(),
              createdByUserId: (request as any).user?.userId ?? null,
            });

            if ((origMoves ?? []).length > 0) {
              let inventoryRecalcFromDate: Date | null = null;
              for (const m of origMoves as any[]) {
                const applied = await applyStockMoveWac(tx as any, {
                  companyId,
                  locationId: m.locationId,
                  itemId: m.itemId,
                  date: voidDate,
                  type: 'ADJUSTMENT',
                  direction: 'OUT',
                  quantity: new Prisma.Decimal(m.quantity).toDecimalPlaces(2),
                  unitCostApplied: new Prisma.Decimal(0),
                  totalCostApplied: new Prisma.Decimal(m.totalCostApplied).toDecimalPlaces(2),
                  referenceType: 'PurchaseBillVoid',
                  referenceId: String(bill.id),
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
              }
              await tx.stockMove.updateMany({
                where: { companyId, correlationId, journalEntryId: null, referenceType: 'PurchaseBillVoid', referenceId: String(bill.id) },
                data: { journalEntryId: reversal.id },
              });

              if (inventoryRecalcFromDate) {
                await tx.event.create({
                  data: {
                    companyId,
                    eventId: randomUUID(),
                    eventType: 'inventory.recalc.requested',
                    schemaVersion: 'v1',
                    occurredAt: new Date(occurredAt),
                    source: 'cashflow-api',
                    partitionKey: String(companyId),
                    correlationId,
                    causationId: String(bill.journalEntryId),
                    aggregateType: 'Company',
                    aggregateId: String(companyId),
                    type: 'InventoryRecalcRequested',
                    payload: {
                      companyId,
                      fromDate: normalizeToDay(new Date(inventoryRecalcFromDate)).toISOString().slice(0, 10),
                      reason: 'backdated_stock_move_insert',
                      source: 'PurchaseBillVoid',
                      purchaseBillId: bill.id,
                    },
                  },
                });
              }
            }

            const createdEventId = randomUUID();
            await tx.event.create({
              data: {
                companyId,
                eventId: createdEventId,
                eventType: 'journal.entry.created',
                schemaVersion: 'v1',
                occurredAt: new Date(occurredAt),
                source: 'cashflow-api',
                partitionKey: String(companyId),
                correlationId,
                causationId: String(bill.journalEntryId),
                aggregateType: 'JournalEntry',
                aggregateId: String(reversal.id),
                type: 'JournalEntryCreated',
                payload: { journalEntryId: reversal.id, companyId, reversalOfJournalEntryId: bill.journalEntryId, source: 'PurchaseBillVoid', purchaseBillId: bill.id },
              },
            });
            await tx.event.create({
              data: {
                companyId,
                eventId: randomUUID(),
                eventType: 'journal.entry.reversed',
                schemaVersion: 'v1',
                occurredAt: new Date(occurredAt),
                source: 'cashflow-api',
                partitionKey: String(companyId),
                correlationId,
                causationId: createdEventId,
                aggregateType: 'JournalEntry',
                aggregateId: String(bill.journalEntryId),
                type: 'JournalEntryReversed',
                payload: { originalJournalEntryId: bill.journalEntryId, reversalJournalEntryId: reversal.id, companyId, reason: String(body.reason).trim() },
              },
            });

            const voidedAt = new Date();
            await tx.purchaseBill.update({
              where: { id: bill.id },
              data: {
                status: 'VOID',
                voidedAt,
                voidReason: String(body.reason).trim(),
                voidedByUserId: (request as any).user?.userId ?? null,
                voidJournalEntryId: reversal.id,
                lastAdjustmentJournalEntryId: null,
                updatedByUserId: (request as any).user?.userId ?? null,
              } as any,
            });

            await tx.journalEntry.updateMany({
              where: { id: bill.journalEntryId, companyId },
              data: {
                voidedAt,
                voidReason: String(body.reason).trim(),
                voidedByUserId: (request as any).user?.userId ?? null,
                updatedByUserId: (request as any).user?.userId ?? null,
              } as any,
            });

            await writeAuditLog(tx as any, {
              companyId,
              userId: (request as any).user?.userId ?? null,
              action: 'purchase_bill.void',
              entityType: 'PurchaseBill',
              entityId: bill.id,
              idempotencyKey,
              correlationId,
              metadata: {
                reason: String(body.reason).trim(),
                voidDate,
                voidedAt,
                originalJournalEntryId: bill.journalEntryId,
                voidJournalEntryId: reversal.id,
                priorAdjustmentJournalEntryId: priorAdjId,
                reversedPriorAdjustmentJournalEntryId,
                inventoryMovesReversed: (origMoves ?? []).length,
              },
            });

            return { purchaseBillId: bill.id, status: 'VOID', voidJournalEntryId: reversal.id };
          });

          return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
        }, redis)
      );

      return { purchaseBillId: (result as any).purchaseBillId, status: (result as any).status, voidJournalEntryId: (result as any).voidJournalEntryId };
    } catch (err: any) {
      if (err?.statusCode) {
        reply.status(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
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

            await assertOpenPeriodOrThrow(tx as any, {
              companyId,
              transactionDate: paymentDate,
              action: 'purchase_bill.payment.create',
            });

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
            const creditsAgg = await (tx as any).vendorCreditApplication.aggregate({
              where: { purchaseBillId: bill.id, companyId },
              _sum: { amount: true },
            });
            const totalCredits = (creditsAgg._sum.amount ?? new Prisma.Decimal(0)).toDecimalPlaces(2);
            const totalSettled = totalPaid.add(totalCredits).toDecimalPlaces(2);
            const newStatus = totalSettled.greaterThanOrEqualTo(bill.total) ? 'PAID' : 'PARTIAL';

            const updBill = await (tx as any).purchaseBill.updateMany({
              where: { id: bill.id, companyId },
              data: { amountPaid: totalSettled, status: newStatus },
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

      // Fast-path publish: fire-and-forget to Pub/Sub (non-blocking)
      if (!replay && (result as any)._jeEventId) {
        publishEventsFastPath([(result as any)._jeEventId]);
      }

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

  // Apply vendor credit to purchase bill (sub-ledger only; no new journal entry).
  // POST /companies/:companyId/purchase-bills/:purchaseBillId/apply-credits
  fastify.post('/companies/:companyId/purchase-bills/:purchaseBillId/apply-credits', async (request, reply) => {
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

    const body = (request.body ?? {}) as { vendorCreditId?: number; amount?: number; appliedDate?: string };
    if (!body.vendorCreditId || !body.amount || body.amount <= 0) {
      reply.status(400);
      return { error: 'vendorCreditId and amount (>0) are required' };
    }

    const amount = toMoneyDecimal(body.amount);
    const appliedDate = parseDateInput(body.appliedDate) ?? new Date();
    if (body.appliedDate && isNaN(appliedDate.getTime())) {
      reply.status(400);
      return { error: 'invalid appliedDate' };
    }

    const correlationId = randomUUID();
    const occurredAt = isoNow();
    const lockKey = `lock:purchase-bill:apply-credit:${companyId}:${purchaseBillId}`;

    try {
      const { response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () =>
        runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
          const txResult = await prisma.$transaction(async (tx: any) => {
            await tx.$queryRaw`
              SELECT id FROM PurchaseBill
              WHERE id = ${purchaseBillId} AND companyId = ${companyId}
              FOR UPDATE
            `;

            const bill = await tx.purchaseBill.findFirst({
              where: { id: purchaseBillId, companyId },
              select: { id: true, status: true, total: true, vendorId: true, billNumber: true },
            });
            if (!bill) throw Object.assign(new Error('purchase bill not found'), { statusCode: 404 });
            if (bill.status !== 'POSTED' && bill.status !== 'PARTIAL') {
              throw Object.assign(new Error('credits can be applied only to POSTED or PARTIAL bills'), { statusCode: 400 });
            }

            const vc = await tx.vendorCredit.findFirst({
              where: { id: Number(body.vendorCreditId), companyId },
              select: { id: true, status: true, total: true, amountApplied: true, vendorId: true, creditNumber: true },
            });
            if (!vc) throw Object.assign(new Error('vendor credit not found'), { statusCode: 404 });
            if (vc.status !== 'POSTED') throw Object.assign(new Error('only POSTED vendor credits can be applied'), { statusCode: 400 });
            if (bill.vendorId && vc.vendorId && bill.vendorId !== vc.vendorId) {
              throw Object.assign(new Error('vendor credit vendor does not match bill vendor'), { statusCode: 400 });
            }

            const creditsAggForVc = await tx.vendorCreditApplication.aggregate({
              where: { companyId, vendorCreditId: vc.id },
              _sum: { amount: true },
            });
            const appliedSoFar = (creditsAggForVc._sum.amount ?? new Prisma.Decimal(0)).toDecimalPlaces(2);
            const remainingCredit = new Prisma.Decimal(vc.total).sub(appliedSoFar).toDecimalPlaces(2);
            if (amount.greaterThan(remainingCredit)) {
              throw Object.assign(new Error(`amount cannot exceed remaining vendor credit of ${remainingCredit.toString()}`), { statusCode: 400 });
            }

            const paymentsAgg = await tx.purchaseBillPayment.aggregate({
              where: { purchaseBillId: bill.id, companyId, reversedAt: null },
              _sum: { amount: true },
            });
            const paid = (paymentsAgg._sum.amount ?? new Prisma.Decimal(0)).toDecimalPlaces(2);
            const creditsAggForBill = await tx.vendorCreditApplication.aggregate({
              where: { purchaseBillId: bill.id, companyId },
              _sum: { amount: true },
            });
            const creditsAlready = (creditsAggForBill._sum.amount ?? new Prisma.Decimal(0)).toDecimalPlaces(2);
            const settled = paid.add(creditsAlready).toDecimalPlaces(2);
            const remainingBill = new Prisma.Decimal(bill.total).sub(settled).toDecimalPlaces(2);
            if (amount.greaterThan(remainingBill)) {
              throw Object.assign(new Error(`amount cannot exceed remaining bill balance of ${remainingBill.toString()}`), { statusCode: 400 });
            }

            const app = await tx.vendorCreditApplication.create({
              data: {
                companyId,
                vendorCreditId: vc.id,
                purchaseBillId: bill.id,
                appliedDate,
                amount,
                createdByUserId: (request as any).user?.userId ?? null,
              },
            });

            const newCreditsForBill = creditsAlready.add(amount).toDecimalPlaces(2);
            const newSettled = paid.add(newCreditsForBill).toDecimalPlaces(2);
            const newStatus = newSettled.greaterThanOrEqualTo(bill.total) ? 'PAID' : 'PARTIAL';
            const updBill = await tx.purchaseBill.updateMany({
              where: { id: bill.id, companyId },
              data: { amountPaid: newSettled, status: newStatus } as any,
            });
            if ((updBill as any).count !== 1) {
              throw Object.assign(new Error('purchase bill not found'), { statusCode: 404 });
            }

            const newAppliedForVc = appliedSoFar.add(amount).toDecimalPlaces(2);
            const updVc = await tx.vendorCredit.updateMany({
              where: { id: vc.id, companyId },
              data: { amountApplied: newAppliedForVc } as any,
            });
            if ((updVc as any).count !== 1) {
              throw Object.assign(new Error('vendor credit not found'), { statusCode: 404 });
            }

            await writeAuditLog(tx as any, {
              companyId,
              userId: (request as any).user?.userId ?? null,
              action: 'purchase_bill.credit.apply',
              entityType: 'VendorCreditApplication',
              entityId: app.id,
              idempotencyKey,
              correlationId,
              metadata: {
                purchaseBillId: bill.id,
                billNumber: bill.billNumber,
                vendorCreditId: vc.id,
                creditNumber: vc.creditNumber,
                amount: amount.toString(),
                appliedDate,
                newStatus,
                occurredAt,
              },
            });

            return { purchaseBillId: bill.id, vendorCreditApplicationId: app.id, status: newStatus };
          });

          return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
        }, redis)
      );

      return {
        purchaseBillId: (result as any).purchaseBillId,
        vendorCreditApplicationId: (result as any).vendorCreditApplicationId,
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


