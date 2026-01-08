import type { FastifyInstance } from 'fastify';
import { prisma } from '../../infrastructure/db.js';
import { AccountType, ItemType, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { requireCompanyIdParam } from '../../utils/tenant.js';
import { getRedis } from '../../infrastructure/redis.js';
import { withLockBestEffort, withLocksBestEffort } from '../../infrastructure/locks.js';
import { runIdempotentRequest } from '../../infrastructure/commandIdempotency.js';
import { isoNow, normalizeToDay, parseDateInput } from '../../utils/date.js';
import { requireAnyRole, Roles } from '../../utils/rbac.js';
import { writeAuditLog } from '../../infrastructure/auditLog.js';
import { nextPurchaseReceiptNumber } from '../sequence/sequence.service.js';
import { assertOpenPeriodOrThrow } from '../../utils/periodClosePolicy.js';
import { ensureInventoryCompanyDefaults, ensureInventoryItem } from '../inventory/stock.service.js';
import { applyStockMoveWac } from '../inventory/stock.service.js';
import { postJournalEntry } from '../ledger/posting.service.js';
import { ensureGrniAccount } from './grni.service.js';
import { publishEventsFastPath } from '../../infrastructure/pubsub.js';
import { runInventoryRecalcForward } from '../inventory/recalc.service.js';

function d2(n: number | string | Prisma.Decimal) {
  return new Prisma.Decimal(n).toDecimalPlaces(2);
}

export async function purchaseReceiptsRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate);
  const redis = getRedis();

  // List
  fastify.get('/companies/:companyId/purchase-receipts', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const rows = await prisma.purchaseReceipt.findMany({
      where: { companyId },
      orderBy: [{ receiptDate: 'desc' }, { id: 'desc' }],
      include: { vendor: true, location: true, purchaseOrder: true, billedBy: true },
    });
    return rows.map((r: any) => ({
      id: r.id,
      receiptNumber: r.receiptNumber,
      status: r.status,
      receiptDate: r.receiptDate,
      vendorName: r.vendor?.name ?? null,
      locationName: r.location?.name ?? null,
      purchaseOrderId: r.purchaseOrderId ?? null,
      purchaseOrderNumber: r.purchaseOrder?.poNumber ?? null,
      purchaseBillId: r.billedBy?.id ?? null,
      total: r.total.toString(),
      createdAt: r.createdAt,
    }));
  });

  // Detail
  fastify.get('/companies/:companyId/purchase-receipts/:purchaseReceiptId', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const purchaseReceiptId = Number((request.params as any)?.purchaseReceiptId);
    if (!Number.isInteger(purchaseReceiptId) || purchaseReceiptId <= 0) {
      reply.status(400);
      return { error: 'invalid purchaseReceiptId' };
    }
    const r = await prisma.purchaseReceipt.findFirst({
      where: { companyId, id: purchaseReceiptId },
      include: { vendor: true, location: true, purchaseOrder: true, billedBy: true, lines: { include: { item: true } } },
    });
    if (!r) {
      reply.status(404);
      return { error: 'purchase receipt not found' };
    }
    return {
      id: r.id,
      receiptNumber: (r as any).receiptNumber,
      status: r.status,
      receiptDate: r.receiptDate,
      expectedDate: (r as any).expectedDate ?? null,
      currency: (r as any).currency ?? null,
      vendor: (r as any).vendor ?? null,
      location: (r as any).location ?? null,
      purchaseOrder: (r as any).purchaseOrder ? { id: (r as any).purchaseOrder.id, poNumber: (r as any).purchaseOrder.poNumber } : null,
      purchaseBill: (r as any).billedBy ? { id: (r as any).billedBy.id, billNumber: (r as any).billedBy.billNumber, status: (r as any).billedBy.status } : null,
      journalEntryId: (r as any).journalEntryId ?? null,
      total: (r as any).total.toString(),
      lines: (r.lines ?? []).map((l: any) => ({
        id: l.id,
        itemId: l.itemId,
        item: l.item ? { id: l.item.id, name: l.item.name, sku: l.item.sku ?? null } : null,
        description: l.description ?? null,
        quantity: l.quantity.toString(),
        unitCost: l.unitCost.toString(),
        discountAmount: (l.discountAmount ?? new Prisma.Decimal(0)).toString(),
        lineTotal: l.lineTotal.toString(),
      })),
      voidedAt: (r as any).voidedAt ?? null,
      voidReason: (r as any).voidReason ?? null,
      voidJournalEntryId: (r as any).voidJournalEntryId ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });

  // Create receipt (DRAFT)
  fastify.post('/companies/:companyId/purchase-receipts', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      reply.status(400);
      return { error: 'Idempotency-Key header is required' };
    }

    const body = request.body as {
      vendorId?: number | null;
      purchaseOrderId?: number | null;
      locationId?: number;
      warehouseId?: number;
      receiptDate?: string;
      expectedDate?: string | null;
      currency?: string | null;
      lines?: Array<{ itemId?: number; quantity?: number; unitCost?: number; discountAmount?: number; description?: string }>;
    };
    if (!body.lines?.length) {
      reply.status(400);
      return { error: 'lines is required' };
    }

    const receiptDate = parseDateInput(body.receiptDate) ?? new Date();
    if (body.receiptDate && isNaN(receiptDate.getTime())) {
      reply.status(400);
      return { error: 'invalid receiptDate' };
    }
    const expectedDate = body.expectedDate ? parseDateInput(body.expectedDate) : null;
    if (body.expectedDate && body.expectedDate !== null && expectedDate && isNaN(expectedDate.getTime())) {
      reply.status(400);
      return { error: 'invalid expectedDate' };
    }

    const locationId = Number(body.locationId ?? body.warehouseId ?? 0);
    if (!Number.isInteger(locationId) || locationId <= 0) {
      reply.status(400);
      return { error: 'locationId is required' };
    }

    const correlationId = randomUUID();
    const occurredAt = isoNow();
    const lockKey = `lock:purchase-receipt:create:${companyId}:${receiptDate.toISOString().slice(0, 10)}`;

    const { response } = await withLockBestEffort(redis, lockKey, 30_000, async () =>
      runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
        const created = await prisma.$transaction(async (tx: any) => {
          await assertOpenPeriodOrThrow(tx as any, { companyId, transactionDate: receiptDate, action: 'purchase_receipt.create' });

          if (body.vendorId) {
            const vendor = await tx.vendor.findFirst({ where: { id: body.vendorId, companyId } });
            if (!vendor) throw Object.assign(new Error('vendorId not found in this company'), { statusCode: 400 });
          }
          const loc = await tx.location.findFirst({ where: { id: locationId, companyId } });
          if (!loc) throw Object.assign(new Error('locationId not found in this company'), { statusCode: 400 });

          if (body.purchaseOrderId) {
            const po = await tx.purchaseOrder.findFirst({ where: { id: body.purchaseOrderId, companyId } });
            if (!po) throw Object.assign(new Error('purchaseOrderId not found in this company'), { statusCode: 400 });
          }

          let total = new Prisma.Decimal(0);
          const computedLines: any[] = [];
          for (const [idx, l] of (body.lines ?? []).entries()) {
            const itemId = Number(l.itemId);
            const qty = Number(l.quantity ?? 0);
            const unitCost = Number(l.unitCost ?? 0);
            const discountAmount = Number(l.discountAmount ?? 0);
            if (!Number.isInteger(itemId) || itemId <= 0) throw Object.assign(new Error(`lines[${idx}].itemId is required`), { statusCode: 400 });
            if (!Number.isFinite(qty) || qty <= 0) throw Object.assign(new Error(`lines[${idx}].quantity must be > 0`), { statusCode: 400 });
            if (!Number.isFinite(unitCost) || unitCost <= 0) throw Object.assign(new Error(`lines[${idx}].unitCost must be > 0`), { statusCode: 400 });
            if (!Number.isFinite(discountAmount) || discountAmount < 0) throw Object.assign(new Error(`lines[${idx}].discountAmount must be >= 0`), { statusCode: 400 });

            const item = await tx.item.findFirst({
              where: { id: itemId, companyId },
              select: { id: true, type: true, trackInventory: true },
            });
            if (!item) throw Object.assign(new Error(`lines[${idx}].itemId not found in this company`), { statusCode: 400 });
            if (item.type !== ItemType.GOODS || !item.trackInventory) {
              throw Object.assign(new Error('purchase receipts only support tracked GOODS items (inventory) for now'), { statusCode: 400 });
            }

            const qtyDec = d2(qty);
            const unitDec = d2(unitCost);
            const gross = qtyDec.mul(unitDec).toDecimalPlaces(2);
            const disc = d2(discountAmount);
            if (disc.greaterThan(gross)) throw Object.assign(new Error(`lines[${idx}].discountAmount cannot exceed line subtotal`), { statusCode: 400 });
            const lineTotal = gross.sub(disc).toDecimalPlaces(2);
            total = total.add(lineTotal);

            computedLines.push({
              companyId,
              locationId,
              itemId,
              description: l.description ?? null,
              quantity: qtyDec,
              unitCost: unitDec,
              discountAmount: disc,
              lineTotal,
            });
          }
          total = total.toDecimalPlaces(2);

          const receiptNumber = await nextPurchaseReceiptNumber(tx as any, companyId);
          const r = await tx.purchaseReceipt.create({
            data: {
              companyId,
              vendorId: body.vendorId ?? null,
              purchaseOrderId: body.purchaseOrderId ?? null,
              locationId,
              receiptNumber,
              status: 'DRAFT',
              receiptDate,
              expectedDate: expectedDate ?? null,
              currency: body.currency ?? null,
              total,
              createdByUserId: (request as any).user?.userId ?? null,
              updatedByUserId: (request as any).user?.userId ?? null,
              lines: { create: computedLines },
            } as any,
            include: { vendor: true, location: true, lines: { include: { item: true } } },
          });

          await writeAuditLog(tx as any, {
            companyId,
            userId: (request as any).user?.userId ?? null,
            action: 'purchase_receipt.create',
            entityType: 'PurchaseReceipt',
            entityId: r.id,
            idempotencyKey,
            correlationId,
            metadata: { receiptNumber, receiptDate, locationId, vendorId: body.vendorId ?? null, total: total.toString() },
          });

          return r;
        });
        return { ...created, _correlationId: correlationId, _occurredAt: occurredAt };
      }, redis)
    );
    return response as any;
  });

  // Update (DRAFT only)
  fastify.put('/companies/:companyId/purchase-receipts/:purchaseReceiptId', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const purchaseReceiptId = Number((request.params as any)?.purchaseReceiptId);
    if (!Number.isInteger(purchaseReceiptId) || purchaseReceiptId <= 0) {
      reply.status(400);
      return { error: 'invalid purchaseReceiptId' };
    }
    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      reply.status(400);
      return { error: 'Idempotency-Key header is required' };
    }

    const body = request.body as {
      vendorId?: number | null;
      purchaseOrderId?: number | null;
      locationId?: number;
      warehouseId?: number;
      receiptDate?: string;
      expectedDate?: string | null;
      currency?: string | null;
      lines?: Array<{ itemId?: number; quantity?: number; unitCost?: number; discountAmount?: number; description?: string }>;
    };
    if (!body.lines?.length) {
      reply.status(400);
      return { error: 'lines is required' };
    }

    const receiptDate = parseDateInput(body.receiptDate) ?? new Date();
    if (body.receiptDate && isNaN(receiptDate.getTime())) {
      reply.status(400);
      return { error: 'invalid receiptDate' };
    }
    const expectedDate = body.expectedDate ? parseDateInput(body.expectedDate) : null;
    if (body.expectedDate && body.expectedDate !== null && expectedDate && isNaN(expectedDate.getTime())) {
      reply.status(400);
      return { error: 'invalid expectedDate' };
    }

    const locationId = Number(body.locationId ?? body.warehouseId ?? 0);
    if (!Number.isInteger(locationId) || locationId <= 0) {
      reply.status(400);
      return { error: 'locationId is required' };
    }

    const correlationId = randomUUID();
    const occurredAt = isoNow();
    const lockKey = `lock:purchase-receipt:update:${companyId}:${purchaseReceiptId}`;

    try {
      const { response } = await withLockBestEffort(redis, lockKey, 30_000, async () =>
        runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
          const updated = await prisma.$transaction(async (tx: any) => {
            await (tx as any).$queryRaw`
              SELECT id FROM PurchaseReceipt
              WHERE id = ${purchaseReceiptId} AND companyId = ${companyId}
              FOR UPDATE
            `;
            const existing = await tx.purchaseReceipt.findFirst({
              where: { id: purchaseReceiptId, companyId },
              select: { id: true, status: true, receiptNumber: true },
            });
            if (!existing) throw Object.assign(new Error('purchase receipt not found'), { statusCode: 404 });
            if (existing.status !== 'DRAFT') throw Object.assign(new Error('only DRAFT purchase receipts can be edited'), { statusCode: 400 });

            await assertOpenPeriodOrThrow(tx as any, { companyId, transactionDate: receiptDate, action: 'purchase_receipt.update' });

            if (body.vendorId) {
              const vendor = await tx.vendor.findFirst({ where: { id: body.vendorId, companyId } });
              if (!vendor) throw Object.assign(new Error('vendorId not found in this company'), { statusCode: 400 });
            }
            if (body.purchaseOrderId) {
              const po = await tx.purchaseOrder.findFirst({ where: { id: body.purchaseOrderId, companyId } });
              if (!po) throw Object.assign(new Error('purchaseOrderId not found in this company'), { statusCode: 400 });
            }
            const loc = await tx.location.findFirst({ where: { id: locationId, companyId } });
            if (!loc) throw Object.assign(new Error('locationId not found in this company'), { statusCode: 400 });

            let total = new Prisma.Decimal(0);
            const computedLines: any[] = [];
            for (const [idx, l] of (body.lines ?? []).entries()) {
              const itemId = Number(l.itemId);
              const qty = Number(l.quantity ?? 0);
              const unitCost = Number(l.unitCost ?? 0);
              const discountAmount = Number(l.discountAmount ?? 0);
              if (!Number.isInteger(itemId) || itemId <= 0) throw Object.assign(new Error(`lines[${idx}].itemId is required`), { statusCode: 400 });
              if (!Number.isFinite(qty) || qty <= 0) throw Object.assign(new Error(`lines[${idx}].quantity must be > 0`), { statusCode: 400 });
              if (!Number.isFinite(unitCost) || unitCost <= 0) throw Object.assign(new Error(`lines[${idx}].unitCost must be > 0`), { statusCode: 400 });
              if (!Number.isFinite(discountAmount) || discountAmount < 0) throw Object.assign(new Error(`lines[${idx}].discountAmount must be >= 0`), { statusCode: 400 });

              const item = await tx.item.findFirst({ where: { id: itemId, companyId }, select: { id: true, type: true, trackInventory: true } });
              if (!item) throw Object.assign(new Error(`lines[${idx}].itemId not found in this company`), { statusCode: 400 });
              if (item.type !== ItemType.GOODS || !item.trackInventory) {
                throw Object.assign(new Error('purchase receipts only support tracked GOODS items (inventory) for now'), { statusCode: 400 });
              }

              const qtyDec = d2(qty);
              const unitDec = d2(unitCost);
              const gross = qtyDec.mul(unitDec).toDecimalPlaces(2);
              const disc = d2(discountAmount);
              if (disc.greaterThan(gross)) throw Object.assign(new Error(`lines[${idx}].discountAmount cannot exceed line subtotal`), { statusCode: 400 });
              const lineTotal = gross.sub(disc).toDecimalPlaces(2);
              total = total.add(lineTotal);

              computedLines.push({
                companyId,
                locationId,
                itemId,
                description: l.description ?? null,
                quantity: qtyDec,
                unitCost: unitDec,
                discountAmount: disc,
                lineTotal,
              });
            }
            total = total.toDecimalPlaces(2);

            const r = await tx.purchaseReceipt.update({
              where: { id: purchaseReceiptId, companyId },
              data: {
                vendorId: body.vendorId ?? null,
                purchaseOrderId: body.purchaseOrderId ?? null,
                locationId,
                receiptDate,
                expectedDate: expectedDate ?? null,
                currency: body.currency ?? null,
                total,
                updatedByUserId: (request as any).user?.userId ?? null,
                lines: { deleteMany: {}, create: computedLines },
              } as any,
              include: { vendor: true, location: true, lines: { include: { item: true } } },
            });

            await writeAuditLog(tx as any, {
              companyId,
              userId: (request as any).user?.userId ?? null,
              action: 'purchase_receipt.update',
              entityType: 'PurchaseReceipt',
              entityId: r.id,
              idempotencyKey,
              correlationId,
              metadata: { receiptNumber: (r as any).receiptNumber, receiptDate, locationId, total: total.toString() },
            });

            return r;
          });
          return { ...updated, _correlationId: correlationId, _occurredAt: occurredAt };
        }, redis)
      );
      return response as any;
    } catch (err: any) {
      if (err?.statusCode) {
        reply.status(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });

  // Delete (DRAFT only)
  fastify.delete('/companies/:companyId/purchase-receipts/:purchaseReceiptId', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const purchaseReceiptId = Number((request.params as any)?.purchaseReceiptId);
    if (!Number.isInteger(purchaseReceiptId) || purchaseReceiptId <= 0) {
      reply.status(400);
      return { error: 'invalid purchaseReceiptId' };
    }
    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      reply.status(400);
      return { error: 'Idempotency-Key header is required' };
    }
    const correlationId = randomUUID();
    const occurredAt = isoNow();
    const lockKey = `lock:purchase-receipt:delete:${companyId}:${purchaseReceiptId}`;

    try {
      const { response } = await withLockBestEffort(redis, lockKey, 30_000, async () =>
        runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
          const res = await prisma.$transaction(async (tx: any) => {
            await (tx as any).$queryRaw`
              SELECT id FROM PurchaseReceipt
              WHERE id = ${purchaseReceiptId} AND companyId = ${companyId}
              FOR UPDATE
            `;
            const r = await tx.purchaseReceipt.findFirst({
              where: { id: purchaseReceiptId, companyId },
              select: { id: true, status: true, receiptNumber: true, receiptDate: true },
            });
            if (!r) throw Object.assign(new Error('purchase receipt not found'), { statusCode: 404 });
            if (r.status !== 'DRAFT') throw Object.assign(new Error('only DRAFT purchase receipts can be deleted'), { statusCode: 400 });

            const linkedBill = await tx.purchaseBill.findFirst({ where: { companyId, purchaseReceiptId: r.id }, select: { id: true } });
            if (linkedBill) throw Object.assign(new Error('cannot delete a receipt that is linked to a purchase bill'), { statusCode: 400 });

            await assertOpenPeriodOrThrow(tx as any, { companyId, transactionDate: new Date(r.receiptDate), action: 'purchase_receipt.delete' });

            await tx.purchaseReceiptLine.deleteMany({ where: { companyId, purchaseReceiptId: r.id } });
            await tx.purchaseReceipt.delete({ where: { id: r.id, companyId } });

            await writeAuditLog(tx as any, {
              companyId,
              userId: (request as any).user?.userId ?? null,
              action: 'purchase_receipt.delete',
              entityType: 'PurchaseReceipt',
              entityId: r.id,
              idempotencyKey,
              correlationId,
              metadata: { receiptNumber: r.receiptNumber, occurredAt },
            });

            return { purchaseReceiptId: r.id, deleted: true };
          });
          return { ...res, _correlationId: correlationId, _occurredAt: occurredAt };
        }, redis)
      );
      return response as any;
    } catch (err: any) {
      if (err?.statusCode) {
        reply.status(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });

  // Post (DRAFT -> POSTED): creates stock moves + JE Dr Inventory / Cr GRNI
  fastify.post('/companies/:companyId/purchase-receipts/:purchaseReceiptId/post', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const purchaseReceiptId = Number((request.params as any)?.purchaseReceiptId);
    if (!Number.isInteger(purchaseReceiptId) || purchaseReceiptId <= 0) {
      reply.status(400);
      return { error: 'invalid purchaseReceiptId' };
    }
    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      reply.status(400);
      return { error: 'Idempotency-Key header is required' };
    }

    // Pre-read for stock locks
    const pre = await prisma.purchaseReceipt.findFirst({
      where: { companyId, id: purchaseReceiptId },
      select: { id: true, locationId: true, lines: { select: { itemId: true } } },
    });
    if (!pre) {
      reply.status(404);
      return { error: 'purchase receipt not found' };
    }
    const stockLocks = (pre.lines ?? []).map((l: any) => `lock:stock:${companyId}:${pre.locationId}:${l.itemId}`);

    const correlationId = randomUUID();
    const occurredAt = isoNow();
    const lockKey = `lock:purchase-receipt:post:${companyId}:${purchaseReceiptId}`;

    const { replay, response: result } = await withLocksBestEffort(redis, stockLocks, 30_000, async () =>
      withLockBestEffort(redis, lockKey, 30_000, async () =>
        runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
          const txResult = await prisma.$transaction(async (tx: any) => {
            await (tx as any).$queryRaw`
              SELECT id FROM PurchaseReceipt
              WHERE id = ${purchaseReceiptId} AND companyId = ${companyId}
              FOR UPDATE
            `;

            const r = await tx.purchaseReceipt.findFirst({
              where: { id: purchaseReceiptId, companyId },
              include: { vendor: true, location: true, lines: { include: { item: true } } },
            });
            if (!r) throw Object.assign(new Error('purchase receipt not found'), { statusCode: 404 });
            if (r.status !== 'DRAFT') throw Object.assign(new Error('only DRAFT purchase receipts can be posted'), { statusCode: 400 });

            await assertOpenPeriodOrThrow(tx as any, { companyId, transactionDate: new Date(r.receiptDate), action: 'purchase_receipt.post' });

            const cfg = await ensureInventoryCompanyDefaults(tx as any, companyId);
            if (!cfg.inventoryAssetAccountId) throw Object.assign(new Error('company.inventoryAssetAccountId is not set'), { statusCode: 400 });

            const grniId = await ensureGrniAccount(tx as any, companyId);
            const grniAcc = await tx.account.findFirst({ where: { id: grniId, companyId, type: AccountType.LIABILITY } });
            if (!grniAcc) throw Object.assign(new Error('GRNI account must be a LIABILITY in this company'), { statusCode: 400 });

            // Apply stock moves and compute total from lines
            let total = new Prisma.Decimal(0);
            let inventoryRecalcFromDate: Date | null = null;

            for (const [idx, l] of (r.lines ?? []).entries()) {
              const item = (l as any).item;
              if (!item || item.type !== ItemType.GOODS || !item.trackInventory) {
                throw Object.assign(new Error(`line[${idx}] item must be tracked GOODS`), { statusCode: 400 });
              }
              await ensureInventoryItem(tx as any, companyId, l.itemId);

              const qty = new Prisma.Decimal(l.quantity).toDecimalPlaces(2);
              const unitCost = new Prisma.Decimal(l.unitCost).toDecimalPlaces(2);
              const lineTotal = new Prisma.Decimal(l.lineTotal).toDecimalPlaces(2);
              total = total.add(lineTotal);

              const applied = await applyStockMoveWac(tx as any, {
                companyId,
                locationId: r.locationId,
                itemId: l.itemId,
                date: new Date(r.receiptDate),
                type: 'PURCHASE_RECEIPT',
                direction: 'IN',
                quantity: qty,
                unitCostApplied: unitCost,
                totalCostApplied: lineTotal,
                referenceType: 'PurchaseReceipt',
                referenceId: String(r.id),
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

            total = total.toDecimalPlaces(2);
            const storedTotal = new Prisma.Decimal(r.total).toDecimalPlaces(2);
            if (!total.equals(storedTotal)) {
              throw Object.assign(new Error(`rounding mismatch: recomputed total ${total.toString()} != stored total ${storedTotal.toString()}`), {
                statusCode: 400,
              });
            }

            const je = await postJournalEntry(tx as any, {
              companyId,
              date: new Date(r.receiptDate),
              description: `Purchase Receipt ${(r as any).receiptNumber}${r.vendor ? ` from ${r.vendor.name}` : ''}`,
              locationId: r.locationId,
              createdByUserId: (request as any).user?.userId ?? null,
              skipAccountValidation: true,
              lines: [
                { accountId: cfg.inventoryAssetAccountId!, debit: total, credit: new Prisma.Decimal(0) },
                { accountId: grniAcc.id, debit: new Prisma.Decimal(0), credit: total },
              ],
            });

            await tx.stockMove.updateMany({
              where: { companyId, correlationId, journalEntryId: null },
              data: { journalEntryId: je.id },
            });

            await tx.purchaseReceipt.update({
              where: { id: r.id, companyId },
              data: { status: 'POSTED', journalEntryId: je.id, updatedByUserId: (request as any).user?.userId ?? null } as any,
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
                payload: { journalEntryId: je.id, companyId, source: 'PurchaseReceipt', purchaseReceiptId: r.id },
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
                    source: 'PurchaseReceiptPost',
                    purchaseReceiptId: r.id,
                  },
                },
              });

              // IMPORTANT: inline fallback for correctness.
              // In some deployments the async publisher/worker may be delayed/misconfigured.
              // Running the deterministic recalc here guarantees that OUT moves (Sales Issue) and COGS are revalued
              // immediately after a truly backdated insert.
              await runInventoryRecalcForward(tx as any, {
                companyId,
                fromDate: normalizeToDay(new Date(inventoryRecalcFromDate)),
                now: new Date(occurredAt),
              });
            }

            await writeAuditLog(tx as any, {
              companyId,
              userId: (request as any).user?.userId ?? null,
              action: 'purchase_receipt.post',
              entityType: 'PurchaseReceipt',
              entityId: r.id,
              idempotencyKey,
              correlationId,
              metadata: { receiptNumber: (r as any).receiptNumber, receiptDate: r.receiptDate, total: total.toString(), journalEntryId: je.id },
            });

            return {
              purchaseReceiptId: r.id,
              status: 'POSTED',
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

    if (!replay && (result as any)._jeEventId) {
      const ids = [(result as any)._jeEventId] as string[];
      if ((result as any)._inventoryRecalcEventId) ids.push((result as any)._inventoryRecalcEventId);
      publishEventsFastPath(ids);
    }

    return {
      purchaseReceiptId: (result as any).purchaseReceiptId,
      status: (result as any).status,
      journalEntryId: (result as any).journalEntryId,
      total: (result as any).total,
    };
  });

  // Void (POSTED -> VOID): reverse JE and reverse stock via OUT moves at original values
  fastify.post('/companies/:companyId/purchase-receipts/:purchaseReceiptId/void', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const purchaseReceiptId = Number((request.params as any)?.purchaseReceiptId);
    if (!Number.isInteger(purchaseReceiptId) || purchaseReceiptId <= 0) {
      reply.status(400);
      return { error: 'invalid purchaseReceiptId' };
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
    const lockKey = `lock:purchase-receipt:void:${companyId}:${purchaseReceiptId}`;

    try {
      const preMoves = await prisma.stockMove.findMany({
        where: { companyId, referenceType: 'PurchaseReceipt', referenceId: String(purchaseReceiptId) },
        select: { locationId: true, itemId: true },
      });
      const stockLockKeys = Array.from(new Set((preMoves ?? []).map((m: any) => `lock:stock:${companyId}:${m.locationId}:${m.itemId}`)));

      const wrapped = async (fn: () => Promise<any>) =>
        stockLockKeys.length > 0 ? withLocksBestEffort(redis, stockLockKeys, 30_000, async () => withLockBestEffort(redis, lockKey, 30_000, fn)) : withLockBestEffort(redis, lockKey, 30_000, fn);

      const { replay, response: result } = await wrapped(async () =>
        runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
          const txResult = await prisma.$transaction(async (tx: any) => {
            await (tx as any).$queryRaw`
              SELECT id FROM PurchaseReceipt
              WHERE id = ${purchaseReceiptId} AND companyId = ${companyId}
              FOR UPDATE
            `;
            const r = await tx.purchaseReceipt.findFirst({ where: { id: purchaseReceiptId, companyId }, include: { journalEntry: { include: { lines: true } } } });
            if (!r) throw Object.assign(new Error('purchase receipt not found'), { statusCode: 404 });
            if (r.status === 'VOID') return { purchaseReceiptId: r.id, status: 'VOID', voidJournalEntryId: (r as any).voidJournalEntryId ?? null, alreadyVoided: true };
            if (r.status !== 'POSTED') throw Object.assign(new Error('only POSTED purchase receipts can be voided'), { statusCode: 400 });
            if (!(r as any).journalEntryId) throw Object.assign(new Error('purchase receipt is POSTED but missing journal entry link'), { statusCode: 500 });

            await assertOpenPeriodOrThrow(tx as any, { companyId, transactionDate: voidDate, action: 'purchase_receipt.void' });

            const linkedBill = await tx.purchaseBill.findFirst({ where: { companyId, purchaseReceiptId: r.id, status: { in: ['POSTED', 'PARTIAL', 'PAID'] } }, select: { id: true } });
            if (linkedBill) throw Object.assign(new Error('cannot void a receipt that is linked to a posted purchase bill'), { statusCode: 400 });

            // Reverse stock: OUT at original totals (audit-friendly)
            const origMoves = await tx.stockMove.findMany({
              where: { companyId, referenceType: 'PurchaseReceipt', referenceId: String(r.id), direction: 'IN' },
              select: { locationId: true, itemId: true, quantity: true, totalCostApplied: true },
            });
            let inventoryRecalcFromDate: Date | null = null;
            for (const m of origMoves as any[]) {
              const applied = await applyStockMoveWac(tx as any, {
                companyId,
                locationId: m.locationId,
                itemId: m.itemId,
                date: voidDate,
                type: 'PURCHASE_RETURN',
                direction: 'OUT',
                quantity: new Prisma.Decimal(m.quantity).toDecimalPlaces(2),
                unitCostApplied: new Prisma.Decimal(0),
                totalCostApplied: new Prisma.Decimal(m.totalCostApplied).toDecimalPlaces(2),
                referenceType: 'PurchaseReceiptVoid',
                referenceId: String(r.id),
                correlationId,
                createdByUserId: (request as any).user?.userId ?? null,
                journalEntryId: null,
                allowBackdated: true,
              });
              const from = (applied as any)?.requiresInventoryRecalcFromDate as Date | null | undefined;
              if (from && !isNaN(new Date(from).getTime())) {
                inventoryRecalcFromDate =
                  !inventoryRecalcFromDate || new Date(from).getTime() < inventoryRecalcFromDate.getTime() ? new Date(from) : inventoryRecalcFromDate;
              }
            }

            // Reverse JE (Inventory/GRNI)
            const reversalLines = (r as any).journalEntry.lines.map((l: any) => ({
              accountId: l.accountId,
              debit: new Prisma.Decimal(l.credit).toDecimalPlaces(2),
              credit: new Prisma.Decimal(l.debit).toDecimalPlaces(2),
            }));
            const reversal = await postJournalEntry(tx as any, {
              companyId,
              date: voidDate,
              description: `VOID Purchase Receipt ${String((r as any).receiptNumber ?? r.id)}: ${String(body.reason).trim()}`,
              createdByUserId: (request as any).user?.userId ?? null,
              skipAccountValidation: true,
              lines: reversalLines,
            });

            await tx.stockMove.updateMany({
              where: { companyId, correlationId, journalEntryId: null, referenceType: 'PurchaseReceiptVoid', referenceId: String(r.id) },
              data: { journalEntryId: reversal.id },
            });

            await tx.purchaseReceipt.update({
              where: { id: r.id, companyId },
              data: {
                status: 'VOID',
                voidedAt: new Date(),
                voidReason: String(body.reason).trim(),
                voidedByUserId: (request as any).user?.userId ?? null,
                voidJournalEntryId: reversal.id,
                updatedByUserId: (request as any).user?.userId ?? null,
              } as any,
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
                causationId: String((r as any).journalEntryId),
                aggregateType: 'JournalEntry',
                aggregateId: String(reversal.id),
                type: 'JournalEntryCreated',
                payload: { journalEntryId: reversal.id, companyId, source: 'PurchaseReceiptVoid', purchaseReceiptId: r.id },
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
                    source: 'PurchaseReceiptVoid',
                    purchaseReceiptId: r.id,
                  },
                },
              });
            }

            await writeAuditLog(tx as any, {
              companyId,
              userId: (request as any).user?.userId ?? null,
              action: 'purchase_receipt.void',
              entityType: 'PurchaseReceipt',
              entityId: r.id,
              idempotencyKey,
              correlationId,
              metadata: { reason: String(body.reason).trim(), voidDate, voidJournalEntryId: reversal.id, inventoryMovesReversed: (origMoves ?? []).length },
            });

            return {
              purchaseReceiptId: r.id,
              status: 'VOID',
              voidJournalEntryId: reversal.id,
              _jeEventId: jeEventId,
              _inventoryRecalcEventId: inventoryRecalcEventId,
            };
          });

          return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
        }, redis)
      );

      if (!replay && (result as any)._jeEventId) {
        const ids = [(result as any)._jeEventId] as string[];
        if ((result as any)._inventoryRecalcEventId) ids.push((result as any)._inventoryRecalcEventId);
        publishEventsFastPath(ids);
      }

      return { purchaseReceiptId: (result as any).purchaseReceiptId, status: (result as any).status, voidJournalEntryId: (result as any).voidJournalEntryId };
    } catch (err: any) {
      if (err?.statusCode) {
        reply.status(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });
}

