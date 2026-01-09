import { prisma } from '../../infrastructure/db.js';
import { AccountType, ItemType, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { requireCompanyIdParam } from '../../utils/tenant.js';
import { getRedis } from '../../infrastructure/redis.js';
import { runWithResourceLockRetry, withLockBestEffort, withLocksBestEffort } from '../../infrastructure/locks.js';
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
function d2(n) {
    return new Prisma.Decimal(n).toDecimalPlaces(2);
}
export async function purchaseReceiptsRoutes(fastify) {
    fastify.addHook('preHandler', fastify.authenticate);
    const redis = getRedis();
    // List
    fastify.get('/companies/:companyId/purchase-receipts', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const purchaseOrderIdRaw = request.query?.purchaseOrderId;
        const purchaseOrderId = purchaseOrderIdRaw !== undefined && purchaseOrderIdRaw !== null && purchaseOrderIdRaw !== '' ? Number(purchaseOrderIdRaw) : null;
        if (purchaseOrderId !== null && (!Number.isInteger(purchaseOrderId) || purchaseOrderId <= 0)) {
            reply.status(400);
            return { error: 'invalid purchaseOrderId' };
        }
        const rows = await prisma.purchaseReceipt.findMany({
            where: { companyId, ...(purchaseOrderId ? { purchaseOrderId } : {}) },
            orderBy: [{ receiptDate: 'desc' }, { id: 'desc' }],
            include: { vendor: true, location: true, purchaseOrder: true, billedBy: true },
        });
        return rows.map((r) => ({
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
        const purchaseReceiptId = Number(request.params?.purchaseReceiptId);
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
            receiptNumber: r.receiptNumber,
            status: r.status,
            receiptDate: r.receiptDate,
            expectedDate: r.expectedDate ?? null,
            currency: r.currency ?? null,
            vendor: r.vendor ?? null,
            location: r.location ?? null,
            purchaseOrder: r.purchaseOrder ? { id: r.purchaseOrder.id, poNumber: r.purchaseOrder.poNumber } : null,
            purchaseBill: r.billedBy ? { id: r.billedBy.id, billNumber: r.billedBy.billNumber, status: r.billedBy.status } : null,
            journalEntryId: r.journalEntryId ?? null,
            total: r.total.toString(),
            lines: (r.lines ?? []).map((l) => ({
                id: l.id,
                itemId: l.itemId,
                item: l.item ? { id: l.item.id, name: l.item.name, sku: l.item.sku ?? null } : null,
                description: l.description ?? null,
                quantity: l.quantity.toString(),
                unitCost: l.unitCost.toString(),
                discountAmount: (l.discountAmount ?? new Prisma.Decimal(0)).toString(),
                lineTotal: l.lineTotal.toString(),
            })),
            voidedAt: r.voidedAt ?? null,
            voidReason: r.voidReason ?? null,
            voidJournalEntryId: r.voidJournalEntryId ?? null,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
        };
    });
    // Create receipt (DRAFT)
    fastify.post('/companies/:companyId/purchase-receipts', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const idempotencyKey = request.headers?.['idempotency-key'];
        if (!idempotencyKey) {
            reply.status(400);
            return { error: 'Idempotency-Key header is required' };
        }
        const body = request.body;
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
        const { response } = await withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
            const created = await prisma.$transaction(async (tx) => {
                // OPTIMIZED: Batch validate vendor + location + purchaseOrder + all items in parallel
                const lineItemIds = (body.lines ?? []).map((l) => Number(l.itemId)).filter((id) => Number.isInteger(id) && id > 0);
                const [periodCheck, vendorResult, locResult, poResult, itemsResult] = await Promise.all([
                    assertOpenPeriodOrThrow(tx, { companyId, transactionDate: receiptDate, action: 'purchase_receipt.create' }).then(() => true),
                    body.vendorId ? tx.vendor.findFirst({ where: { id: body.vendorId, companyId }, select: { id: true } }) : Promise.resolve({ id: body.vendorId }),
                    tx.location.findFirst({ where: { id: locationId, companyId }, select: { id: true } }),
                    body.purchaseOrderId ? tx.purchaseOrder.findFirst({ where: { id: body.purchaseOrderId, companyId }, select: { id: true } }) : Promise.resolve({ id: body.purchaseOrderId }),
                    lineItemIds.length > 0 ? tx.item.findMany({ where: { id: { in: lineItemIds }, companyId }, select: { id: true, type: true, trackInventory: true } }) : Promise.resolve([]),
                ]);
                void periodCheck;
                if (body.vendorId && !vendorResult)
                    throw Object.assign(new Error('vendorId not found in this company'), { statusCode: 400 });
                if (!locResult)
                    throw Object.assign(new Error('locationId not found in this company'), { statusCode: 400 });
                if (body.purchaseOrderId && !poResult)
                    throw Object.assign(new Error('purchaseOrderId not found in this company'), { statusCode: 400 });
                const itemsById = new Map(itemsResult.map((i) => [i.id, i]));
                let total = new Prisma.Decimal(0);
                const computedLines = [];
                for (const [idx, l] of (body.lines ?? []).entries()) {
                    const itemId = Number(l.itemId);
                    const qty = Number(l.quantity ?? 0);
                    const unitCost = Number(l.unitCost ?? 0);
                    const discountAmount = Number(l.discountAmount ?? 0);
                    if (!Number.isInteger(itemId) || itemId <= 0)
                        throw Object.assign(new Error(`lines[${idx}].itemId is required`), { statusCode: 400 });
                    if (!Number.isFinite(qty) || qty <= 0)
                        throw Object.assign(new Error(`lines[${idx}].quantity must be > 0`), { statusCode: 400 });
                    if (!Number.isFinite(unitCost) || unitCost <= 0)
                        throw Object.assign(new Error(`lines[${idx}].unitCost must be > 0`), { statusCode: 400 });
                    if (!Number.isFinite(discountAmount) || discountAmount < 0)
                        throw Object.assign(new Error(`lines[${idx}].discountAmount must be >= 0`), { statusCode: 400 });
                    // OPTIMIZED: Check against pre-fetched items instead of individual query
                    const item = itemsById.get(itemId);
                    if (!item)
                        throw Object.assign(new Error(`lines[${idx}].itemId not found in this company`), { statusCode: 400 });
                    if (item.type !== ItemType.GOODS || !item.trackInventory) {
                        throw Object.assign(new Error('purchase receipts only support tracked GOODS items (inventory) for now'), { statusCode: 400 });
                    }
                    const qtyDec = d2(qty);
                    const unitDec = d2(unitCost);
                    const gross = qtyDec.mul(unitDec).toDecimalPlaces(2);
                    const disc = d2(discountAmount);
                    if (disc.greaterThan(gross))
                        throw Object.assign(new Error(`lines[${idx}].discountAmount cannot exceed line subtotal`), { statusCode: 400 });
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
                const receiptNumber = await nextPurchaseReceiptNumber(tx, companyId);
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
                        createdByUserId: request.user?.userId ?? null,
                        updatedByUserId: request.user?.userId ?? null,
                        lines: { create: computedLines },
                    },
                    include: { vendor: true, location: true, lines: { include: { item: true } } },
                });
                await writeAuditLog(tx, {
                    companyId,
                    userId: request.user?.userId ?? null,
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
        }, redis));
        return response;
    });
    // Update (DRAFT only)
    fastify.put('/companies/:companyId/purchase-receipts/:purchaseReceiptId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const purchaseReceiptId = Number(request.params?.purchaseReceiptId);
        if (!Number.isInteger(purchaseReceiptId) || purchaseReceiptId <= 0) {
            reply.status(400);
            return { error: 'invalid purchaseReceiptId' };
        }
        const idempotencyKey = request.headers?.['idempotency-key'];
        if (!idempotencyKey) {
            reply.status(400);
            return { error: 'Idempotency-Key header is required' };
        }
        const body = request.body;
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
            const { response } = await withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const updated = await prisma.$transaction(async (tx) => {
                    await tx.$queryRaw `
              SELECT id FROM PurchaseReceipt
              WHERE id = ${purchaseReceiptId} AND companyId = ${companyId}
              FOR UPDATE
            `;
                    const existing = await tx.purchaseReceipt.findFirst({
                        where: { id: purchaseReceiptId, companyId },
                        select: { id: true, status: true, receiptNumber: true },
                    });
                    if (!existing)
                        throw Object.assign(new Error('purchase receipt not found'), { statusCode: 404 });
                    if (existing.status !== 'DRAFT')
                        throw Object.assign(new Error('only DRAFT purchase receipts can be edited'), { statusCode: 400 });
                    await assertOpenPeriodOrThrow(tx, { companyId, transactionDate: receiptDate, action: 'purchase_receipt.update' });
                    if (body.vendorId) {
                        const vendor = await tx.vendor.findFirst({ where: { id: body.vendorId, companyId } });
                        if (!vendor)
                            throw Object.assign(new Error('vendorId not found in this company'), { statusCode: 400 });
                    }
                    if (body.purchaseOrderId) {
                        const po = await tx.purchaseOrder.findFirst({ where: { id: body.purchaseOrderId, companyId } });
                        if (!po)
                            throw Object.assign(new Error('purchaseOrderId not found in this company'), { statusCode: 400 });
                    }
                    const loc = await tx.location.findFirst({ where: { id: locationId, companyId } });
                    if (!loc)
                        throw Object.assign(new Error('locationId not found in this company'), { statusCode: 400 });
                    let total = new Prisma.Decimal(0);
                    const computedLines = [];
                    for (const [idx, l] of (body.lines ?? []).entries()) {
                        const itemId = Number(l.itemId);
                        const qty = Number(l.quantity ?? 0);
                        const unitCost = Number(l.unitCost ?? 0);
                        const discountAmount = Number(l.discountAmount ?? 0);
                        if (!Number.isInteger(itemId) || itemId <= 0)
                            throw Object.assign(new Error(`lines[${idx}].itemId is required`), { statusCode: 400 });
                        if (!Number.isFinite(qty) || qty <= 0)
                            throw Object.assign(new Error(`lines[${idx}].quantity must be > 0`), { statusCode: 400 });
                        if (!Number.isFinite(unitCost) || unitCost <= 0)
                            throw Object.assign(new Error(`lines[${idx}].unitCost must be > 0`), { statusCode: 400 });
                        if (!Number.isFinite(discountAmount) || discountAmount < 0)
                            throw Object.assign(new Error(`lines[${idx}].discountAmount must be >= 0`), { statusCode: 400 });
                        const item = await tx.item.findFirst({ where: { id: itemId, companyId }, select: { id: true, type: true, trackInventory: true } });
                        if (!item)
                            throw Object.assign(new Error(`lines[${idx}].itemId not found in this company`), { statusCode: 400 });
                        if (item.type !== ItemType.GOODS || !item.trackInventory) {
                            throw Object.assign(new Error('purchase receipts only support tracked GOODS items (inventory) for now'), { statusCode: 400 });
                        }
                        const qtyDec = d2(qty);
                        const unitDec = d2(unitCost);
                        const gross = qtyDec.mul(unitDec).toDecimalPlaces(2);
                        const disc = d2(discountAmount);
                        if (disc.greaterThan(gross))
                            throw Object.assign(new Error(`lines[${idx}].discountAmount cannot exceed line subtotal`), { statusCode: 400 });
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
                            updatedByUserId: request.user?.userId ?? null,
                            lines: { deleteMany: {}, create: computedLines },
                        },
                        include: { vendor: true, location: true, lines: { include: { item: true } } },
                    });
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
                        action: 'purchase_receipt.update',
                        entityType: 'PurchaseReceipt',
                        entityId: r.id,
                        idempotencyKey,
                        correlationId,
                        metadata: { receiptNumber: r.receiptNumber, receiptDate, locationId, total: total.toString() },
                    });
                    return r;
                });
                return { ...updated, _correlationId: correlationId, _occurredAt: occurredAt };
            }, redis));
            return response;
        }
        catch (err) {
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
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const purchaseReceiptId = Number(request.params?.purchaseReceiptId);
        if (!Number.isInteger(purchaseReceiptId) || purchaseReceiptId <= 0) {
            reply.status(400);
            return { error: 'invalid purchaseReceiptId' };
        }
        const idempotencyKey = request.headers?.['idempotency-key'];
        if (!idempotencyKey) {
            reply.status(400);
            return { error: 'Idempotency-Key header is required' };
        }
        const correlationId = randomUUID();
        const occurredAt = isoNow();
        const lockKey = `lock:purchase-receipt:delete:${companyId}:${purchaseReceiptId}`;
        try {
            const { response } = await withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const res = await prisma.$transaction(async (tx) => {
                    await tx.$queryRaw `
              SELECT id FROM PurchaseReceipt
              WHERE id = ${purchaseReceiptId} AND companyId = ${companyId}
              FOR UPDATE
            `;
                    const r = await tx.purchaseReceipt.findFirst({
                        where: { id: purchaseReceiptId, companyId },
                        select: { id: true, status: true, receiptNumber: true, receiptDate: true },
                    });
                    if (!r)
                        throw Object.assign(new Error('purchase receipt not found'), { statusCode: 404 });
                    if (r.status !== 'DRAFT')
                        throw Object.assign(new Error('only DRAFT purchase receipts can be deleted'), { statusCode: 400 });
                    const linkedBill = await tx.purchaseBill.findFirst({ where: { companyId, purchaseReceiptId: r.id }, select: { id: true } });
                    if (linkedBill)
                        throw Object.assign(new Error('cannot delete a receipt that is linked to a purchase bill'), { statusCode: 400 });
                    await assertOpenPeriodOrThrow(tx, { companyId, transactionDate: new Date(r.receiptDate), action: 'purchase_receipt.delete' });
                    await tx.purchaseReceiptLine.deleteMany({ where: { companyId, purchaseReceiptId: r.id } });
                    await tx.purchaseReceipt.delete({ where: { id: r.id, companyId } });
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
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
            }, redis));
            return response;
        }
        catch (err) {
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
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const purchaseReceiptId = Number(request.params?.purchaseReceiptId);
        if (!Number.isInteger(purchaseReceiptId) || purchaseReceiptId <= 0) {
            reply.status(400);
            return { error: 'invalid purchaseReceiptId' };
        }
        const idempotencyKey = request.headers?.['idempotency-key'];
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
        const stockLocks = (pre.lines ?? []).map((l) => `lock:stock:${companyId}:${pre.locationId}:${l.itemId}`);
        const correlationId = randomUUID();
        const occurredAt = isoNow();
        const lockKey = `lock:purchase-receipt:post:${companyId}:${purchaseReceiptId}`;
        const { replay, response: result } = await runWithResourceLockRetry(() => withLocksBestEffort(redis, stockLocks, 30_000, async () => withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
            const txResult = await prisma.$transaction(async (tx) => {
                await tx.$queryRaw `
              SELECT id FROM PurchaseReceipt
              WHERE id = ${purchaseReceiptId} AND companyId = ${companyId}
              FOR UPDATE
            `;
                const r = await tx.purchaseReceipt.findFirst({
                    where: { id: purchaseReceiptId, companyId },
                    include: { vendor: true, location: true, lines: { include: { item: true } } },
                });
                if (!r)
                    throw Object.assign(new Error('purchase receipt not found'), { statusCode: 404 });
                if (r.status !== 'DRAFT')
                    throw Object.assign(new Error('only DRAFT purchase receipts can be posted'), { statusCode: 400 });
                // OPTIMIZED: Batch period check + inventory config + GRNI in parallel
                const [periodCheck, cfg, grniId] = await Promise.all([
                    assertOpenPeriodOrThrow(tx, { companyId, transactionDate: new Date(r.receiptDate), action: 'purchase_receipt.post' }).then(() => true),
                    ensureInventoryCompanyDefaults(tx, companyId),
                    ensureGrniAccount(tx, companyId),
                ]);
                void periodCheck;
                if (!cfg.inventoryAssetAccountId)
                    throw Object.assign(new Error('company.inventoryAssetAccountId is not set'), { statusCode: 400 });
                const grniAcc = await tx.account.findFirst({ where: { id: grniId, companyId, type: AccountType.LIABILITY } });
                if (!grniAcc)
                    throw Object.assign(new Error('GRNI account must be a LIABILITY in this company'), { statusCode: 400 });
                // OPTIMIZED: Batch ensure inventory items
                const itemIdsToEnsure = (r.lines ?? []).map((l) => l.itemId);
                await Promise.all(itemIdsToEnsure.map((itemId) => ensureInventoryItem(tx, companyId, itemId)));
                // Apply stock moves and compute total from lines
                let total = new Prisma.Decimal(0);
                let inventoryRecalcFromDate = null;
                for (const [idx, l] of (r.lines ?? []).entries()) {
                    const item = l.item;
                    if (!item || item.type !== ItemType.GOODS || !item.trackInventory) {
                        throw Object.assign(new Error(`line[${idx}] item must be tracked GOODS`), { statusCode: 400 });
                    }
                    const qty = new Prisma.Decimal(l.quantity).toDecimalPlaces(2);
                    const unitCost = new Prisma.Decimal(l.unitCost).toDecimalPlaces(2);
                    const lineTotal = new Prisma.Decimal(l.lineTotal).toDecimalPlaces(2);
                    total = total.add(lineTotal);
                    const applied = await applyStockMoveWac(tx, {
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
                        createdByUserId: request.user?.userId ?? null,
                        journalEntryId: null,
                        allowBackdated: true,
                    });
                    const from = applied?.requiresInventoryRecalcFromDate;
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
                const je = await postJournalEntry(tx, {
                    companyId,
                    date: new Date(r.receiptDate),
                    description: `Purchase Receipt ${r.receiptNumber}${r.vendor ? ` from ${r.vendor.name}` : ''}`,
                    locationId: r.locationId,
                    createdByUserId: request.user?.userId ?? null,
                    skipAccountValidation: true, // OPTIMIZED: accounts from ensured company defaults
                    skipPeriodCheck: true, // OPTIMIZED: already checked above
                    skipLocationValidation: true, // OPTIMIZED: locationId from receipt row
                    lines: [
                        { accountId: cfg.inventoryAssetAccountId, debit: total, credit: new Prisma.Decimal(0) },
                        { accountId: grniAcc.id, debit: new Prisma.Decimal(0), credit: total },
                    ],
                });
                await tx.stockMove.updateMany({
                    where: { companyId, correlationId, journalEntryId: null },
                    data: { journalEntryId: je.id },
                });
                await tx.purchaseReceipt.update({
                    where: { id: r.id, companyId },
                    data: { status: 'POSTED', journalEntryId: je.id, updatedByUserId: request.user?.userId ?? null },
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
                let inventoryRecalcEventId = null;
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
                    await runInventoryRecalcForward(tx, {
                        companyId,
                        fromDate: normalizeToDay(new Date(inventoryRecalcFromDate)),
                        now: new Date(occurredAt),
                    });
                }
                await writeAuditLog(tx, {
                    companyId,
                    userId: request.user?.userId ?? null,
                    action: 'purchase_receipt.post',
                    entityType: 'PurchaseReceipt',
                    entityId: r.id,
                    idempotencyKey,
                    correlationId,
                    metadata: { receiptNumber: r.receiptNumber, receiptDate: r.receiptDate, total: total.toString(), journalEntryId: je.id },
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
        }, redis))));
        if (!replay && result._jeEventId) {
            const ids = [result._jeEventId];
            if (result._inventoryRecalcEventId)
                ids.push(result._inventoryRecalcEventId);
            publishEventsFastPath(ids);
        }
        return {
            purchaseReceiptId: result.purchaseReceiptId,
            status: result.status,
            journalEntryId: result.journalEntryId,
            total: result.total,
        };
    });
    // Void (POSTED -> VOID): reverse JE and reverse stock via OUT moves at original values
    fastify.post('/companies/:companyId/purchase-receipts/:purchaseReceiptId/void', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const purchaseReceiptId = Number(request.params?.purchaseReceiptId);
        if (!Number.isInteger(purchaseReceiptId) || purchaseReceiptId <= 0) {
            reply.status(400);
            return { error: 'invalid purchaseReceiptId' };
        }
        const idempotencyKey = request.headers?.['idempotency-key'];
        if (!idempotencyKey) {
            reply.status(400);
            return { error: 'Idempotency-Key header is required' };
        }
        const body = (request.body ?? {});
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
            const stockLockKeys = Array.from(new Set((preMoves ?? []).map((m) => `lock:stock:${companyId}:${m.locationId}:${m.itemId}`)));
            const wrapped = async (fn) => stockLockKeys.length > 0 ? withLocksBestEffort(redis, stockLockKeys, 30_000, async () => withLockBestEffort(redis, lockKey, 30_000, fn)) : withLockBestEffort(redis, lockKey, 30_000, fn);
            const { replay, response: result } = await wrapped(async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const txResult = await prisma.$transaction(async (tx) => {
                    await tx.$queryRaw `
              SELECT id FROM PurchaseReceipt
              WHERE id = ${purchaseReceiptId} AND companyId = ${companyId}
              FOR UPDATE
            `;
                    const r = await tx.purchaseReceipt.findFirst({ where: { id: purchaseReceiptId, companyId }, include: { journalEntry: { include: { lines: true } } } });
                    if (!r)
                        throw Object.assign(new Error('purchase receipt not found'), { statusCode: 404 });
                    if (r.status === 'VOID')
                        return { purchaseReceiptId: r.id, status: 'VOID', voidJournalEntryId: r.voidJournalEntryId ?? null, alreadyVoided: true };
                    if (r.status !== 'POSTED')
                        throw Object.assign(new Error('only POSTED purchase receipts can be voided'), { statusCode: 400 });
                    if (!r.journalEntryId)
                        throw Object.assign(new Error('purchase receipt is POSTED but missing journal entry link'), { statusCode: 500 });
                    await assertOpenPeriodOrThrow(tx, { companyId, transactionDate: voidDate, action: 'purchase_receipt.void' });
                    const linkedBill = await tx.purchaseBill.findFirst({ where: { companyId, purchaseReceiptId: r.id, status: { in: ['POSTED', 'PARTIAL', 'PAID'] } }, select: { id: true } });
                    if (linkedBill)
                        throw Object.assign(new Error('cannot void a receipt that is linked to a posted purchase bill'), { statusCode: 400 });
                    // Reverse stock: OUT at original totals (audit-friendly)
                    const origMoves = await tx.stockMove.findMany({
                        where: { companyId, referenceType: 'PurchaseReceipt', referenceId: String(r.id), direction: 'IN' },
                        select: { locationId: true, itemId: true, quantity: true, totalCostApplied: true },
                    });
                    let inventoryRecalcFromDate = null;
                    for (const m of origMoves) {
                        const applied = await applyStockMoveWac(tx, {
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
                            createdByUserId: request.user?.userId ?? null,
                            journalEntryId: null,
                            allowBackdated: true,
                        });
                        const from = applied?.requiresInventoryRecalcFromDate;
                        if (from && !isNaN(new Date(from).getTime())) {
                            inventoryRecalcFromDate =
                                !inventoryRecalcFromDate || new Date(from).getTime() < inventoryRecalcFromDate.getTime() ? new Date(from) : inventoryRecalcFromDate;
                        }
                    }
                    // Reverse JE (Inventory/GRNI)
                    const reversalLines = r.journalEntry.lines.map((l) => ({
                        accountId: l.accountId,
                        debit: new Prisma.Decimal(l.credit).toDecimalPlaces(2),
                        credit: new Prisma.Decimal(l.debit).toDecimalPlaces(2),
                    }));
                    const reversal = await postJournalEntry(tx, {
                        companyId,
                        date: voidDate,
                        description: `VOID Purchase Receipt ${String(r.receiptNumber ?? r.id)}: ${String(body.reason).trim()}`,
                        createdByUserId: request.user?.userId ?? null,
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
                            voidedByUserId: request.user?.userId ?? null,
                            voidJournalEntryId: reversal.id,
                            updatedByUserId: request.user?.userId ?? null,
                        },
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
                            causationId: String(r.journalEntryId),
                            aggregateType: 'JournalEntry',
                            aggregateId: String(reversal.id),
                            type: 'JournalEntryCreated',
                            payload: { journalEntryId: reversal.id, companyId, source: 'PurchaseReceiptVoid', purchaseReceiptId: r.id },
                        },
                    });
                    let inventoryRecalcEventId = null;
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
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
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
            }, redis));
            if (!replay && result._jeEventId) {
                const ids = [result._jeEventId];
                if (result._inventoryRecalcEventId)
                    ids.push(result._inventoryRecalcEventId);
                publishEventsFastPath(ids);
            }
            return { purchaseReceiptId: result.purchaseReceiptId, status: result.status, voidJournalEntryId: result.voidJournalEntryId };
        }
        catch (err) {
            if (err?.statusCode) {
                reply.status(err.statusCode);
                return { error: err.message };
            }
            throw err;
        }
    });
}
//# sourceMappingURL=purchaseReceipts.routes.js.map