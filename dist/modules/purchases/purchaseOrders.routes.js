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
import { nextPurchaseOrderNumber } from '../sequence/sequence.service.js';
import { assertOpenPeriodOrThrow } from '../../utils/periodClosePolicy.js';
import { computeRemainingByPoLine } from './receiving.service.js';
import { nextPurchaseReceiptNumber } from '../sequence/sequence.service.js';
import { nextPurchaseBillNumber } from '../sequence/sequence.service.js';
import { ensureInventoryCompanyDefaults, ensureInventoryItem } from '../inventory/stock.service.js';
import { applyStockMoveWac } from '../inventory/stock.service.js';
import { postJournalEntry } from '../ledger/posting.service.js';
import { ensureGrniAccount } from './grni.service.js';
import { publishEventsFastPath } from '../../infrastructure/pubsub.js';
import { runInventoryRecalcForward } from '../inventory/recalc.service.js';
function d2(n) {
    return new Prisma.Decimal(n).toDecimalPlaces(2);
}
export async function purchaseOrdersRoutes(fastify) {
    fastify.addHook('preHandler', fastify.authenticate);
    const redis = getRedis();
    // List
    fastify.get('/companies/:companyId/purchase-orders', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const rows = await prisma.purchaseOrder.findMany({
            where: { companyId },
            orderBy: [{ orderDate: 'desc' }, { id: 'desc' }],
            include: { vendor: true, location: true },
        });
        return rows.map((po) => ({
            id: po.id,
            poNumber: po.poNumber,
            status: po.status,
            orderDate: po.orderDate,
            expectedDate: po.expectedDate ?? null,
            vendorName: po.vendor?.name ?? null,
            locationName: po.location?.name ?? null,
            total: po.total.toString(),
            createdAt: po.createdAt,
            updatedAt: po.updatedAt,
        }));
    });
    // Detail
    fastify.get('/companies/:companyId/purchase-orders/:purchaseOrderId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const purchaseOrderId = Number(request.params?.purchaseOrderId);
        if (!Number.isInteger(purchaseOrderId) || purchaseOrderId <= 0) {
            reply.status(400);
            return { error: 'invalid purchaseOrderId' };
        }
        const po = await prisma.purchaseOrder.findFirst({
            where: { companyId, id: purchaseOrderId },
            include: { vendor: true, location: true, lines: { include: { item: true } } },
        });
        if (!po) {
            reply.status(404);
            return { error: 'purchase order not found' };
        }
        return {
            id: po.id,
            poNumber: po.poNumber,
            status: po.status,
            orderDate: po.orderDate,
            expectedDate: po.expectedDate ?? null,
            currency: po.currency ?? null,
            notes: po.notes ?? null,
            vendor: po.vendor ?? null,
            location: po.location ?? null,
            total: po.total.toString(),
            lines: (po.lines ?? []).map((l) => ({
                id: l.id,
                itemId: l.itemId,
                item: l.item ? { id: l.item.id, name: l.item.name, sku: l.item.sku ?? null } : null,
                description: l.description ?? null,
                quantity: l.quantity.toString(),
                unitCost: l.unitCost.toString(),
                discountAmount: (l.discountAmount ?? new Prisma.Decimal(0)).toString(),
                lineTotal: l.lineTotal.toString(),
            })),
            createdAt: po.createdAt,
            updatedAt: po.updatedAt,
        };
    });
    // Create (DRAFT)
    fastify.post('/companies/:companyId/purchase-orders', async (request, reply) => {
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
        const orderDate = parseDateInput(body.orderDate) ?? new Date();
        if (body.orderDate && isNaN(orderDate.getTime())) {
            reply.status(400);
            return { error: 'invalid orderDate' };
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
        const lockKey = `lock:purchase-order:create:${companyId}:${orderDate.toISOString().slice(0, 10)}`;
        const { response } = await withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
            const created = await prisma.$transaction(async (tx) => {
                // OPTIMIZED: Batch validate vendor + location + all items in parallel
                const lineItemIds = (body.lines ?? []).map((l) => Number(l.itemId)).filter((id) => Number.isInteger(id) && id > 0);
                const [periodCheck, vendorResult, locResult, itemsResult] = await Promise.all([
                    assertOpenPeriodOrThrow(tx, { companyId, transactionDate: orderDate, action: 'purchase_order.create' }).then(() => true),
                    body.vendorId ? tx.vendor.findFirst({ where: { id: body.vendorId, companyId }, select: { id: true } }) : Promise.resolve({ id: body.vendorId }),
                    tx.location.findFirst({ where: { id: locationId, companyId }, select: { id: true } }),
                    lineItemIds.length > 0 ? tx.item.findMany({ where: { id: { in: lineItemIds }, companyId }, select: { id: true } }) : Promise.resolve([]),
                ]);
                void periodCheck;
                if (body.vendorId && !vendorResult)
                    throw Object.assign(new Error('vendorId not found in this company'), { statusCode: 400 });
                if (!locResult)
                    throw Object.assign(new Error('locationId not found in this company'), { statusCode: 400 });
                const validItemIds = new Set(itemsResult.map((i) => i.id));
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
                    if (!validItemIds.has(itemId))
                        throw Object.assign(new Error(`lines[${idx}].itemId not found in this company`), { statusCode: 400 });
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
                        purchaseOrderId: undefined,
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
                const poNumber = await nextPurchaseOrderNumber(tx, companyId);
                const po = await tx.purchaseOrder.create({
                    data: {
                        companyId,
                        vendorId: body.vendorId ?? null,
                        locationId,
                        poNumber,
                        status: 'DRAFT',
                        orderDate,
                        expectedDate: expectedDate ?? null,
                        currency: body.currency ?? null,
                        total,
                        notes: body.notes ?? null,
                        createdByUserId: request.user?.userId ?? null,
                        updatedByUserId: request.user?.userId ?? null,
                        lines: { create: computedLines },
                    },
                    include: { vendor: true, location: true, lines: { include: { item: true } } },
                });
                await writeAuditLog(tx, {
                    companyId,
                    userId: request.user?.userId ?? null,
                    action: 'purchase_order.create',
                    entityType: 'PurchaseOrder',
                    entityId: po.id,
                    idempotencyKey,
                    correlationId,
                    metadata: { poNumber, orderDate, locationId, vendorId: body.vendorId ?? null, total: total.toString() },
                });
                return po;
            });
            return created;
        }, redis));
        return response;
    });
    // Update (DRAFT only)
    fastify.put('/companies/:companyId/purchase-orders/:purchaseOrderId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const purchaseOrderId = Number(request.params?.purchaseOrderId);
        if (!Number.isInteger(purchaseOrderId) || purchaseOrderId <= 0) {
            reply.status(400);
            return { error: 'invalid purchaseOrderId' };
        }
        const body = request.body;
        if (!body.lines?.length) {
            reply.status(400);
            return { error: 'lines is required' };
        }
        const orderDate = parseDateInput(body.orderDate) ?? new Date();
        if (body.orderDate && isNaN(orderDate.getTime())) {
            reply.status(400);
            return { error: 'invalid orderDate' };
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
        const lockKey = `lock:purchase-order:update:${companyId}:${purchaseOrderId}`;
        const idempotencyKey = request.headers?.['idempotency-key'];
        if (!idempotencyKey) {
            reply.status(400);
            return { error: 'Idempotency-Key header is required' };
        }
        const correlationId = randomUUID();
        try {
            const { response } = await withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const updated = await prisma.$transaction(async (tx) => {
                    await tx.$queryRaw `
              SELECT id FROM PurchaseOrder
              WHERE id = ${purchaseOrderId} AND companyId = ${companyId}
              FOR UPDATE
            `;
                    const existing = await tx.purchaseOrder.findFirst({ where: { id: purchaseOrderId, companyId }, select: { id: true, status: true, poNumber: true } });
                    if (!existing)
                        throw Object.assign(new Error('purchase order not found'), { statusCode: 404 });
                    if (existing.status !== 'DRAFT')
                        throw Object.assign(new Error('only DRAFT purchase orders can be edited'), { statusCode: 400 });
                    await assertOpenPeriodOrThrow(tx, { companyId, transactionDate: orderDate, action: 'purchase_order.update' });
                    if (body.vendorId) {
                        const vendor = await tx.vendor.findFirst({ where: { id: body.vendorId, companyId } });
                        if (!vendor)
                            throw Object.assign(new Error('vendorId not found in this company'), { statusCode: 400 });
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
                        const item = await tx.item.findFirst({ where: { id: itemId, companyId }, select: { id: true } });
                        if (!item)
                            throw Object.assign(new Error(`lines[${idx}].itemId not found in this company`), { statusCode: 400 });
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
                    const po = await tx.purchaseOrder.update({
                        where: { id: purchaseOrderId, companyId },
                        data: {
                            vendorId: body.vendorId ?? null,
                            locationId,
                            orderDate,
                            expectedDate: expectedDate ?? null,
                            currency: body.currency ?? null,
                            notes: body.notes ?? null,
                            total,
                            updatedByUserId: request.user?.userId ?? null,
                            lines: {
                                deleteMany: {},
                                create: computedLines,
                            },
                        },
                        include: { vendor: true, location: true, lines: { include: { item: true } } },
                    });
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
                        action: 'purchase_order.update',
                        entityType: 'PurchaseOrder',
                        entityId: po.id,
                        idempotencyKey,
                        correlationId,
                        metadata: { poNumber: po.poNumber, orderDate, locationId, vendorId: body.vendorId ?? null, total: total.toString() },
                    });
                    return po;
                });
                return updated;
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
    fastify.delete('/companies/:companyId/purchase-orders/:purchaseOrderId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const purchaseOrderId = Number(request.params?.purchaseOrderId);
        if (!Number.isInteger(purchaseOrderId) || purchaseOrderId <= 0) {
            reply.status(400);
            return { error: 'invalid purchaseOrderId' };
        }
        const idempotencyKey = request.headers?.['idempotency-key'];
        if (!idempotencyKey) {
            reply.status(400);
            return { error: 'Idempotency-Key header is required' };
        }
        const correlationId = randomUUID();
        const lockKey = `lock:purchase-order:delete:${companyId}:${purchaseOrderId}`;
        try {
            const { response } = await withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const res = await prisma.$transaction(async (tx) => {
                    await tx.$queryRaw `
              SELECT id FROM PurchaseOrder
              WHERE id = ${purchaseOrderId} AND companyId = ${companyId}
              FOR UPDATE
            `;
                    const po = await tx.purchaseOrder.findFirst({ where: { id: purchaseOrderId, companyId }, select: { id: true, status: true, poNumber: true, orderDate: true } });
                    if (!po)
                        throw Object.assign(new Error('purchase order not found'), { statusCode: 404 });
                    if (po.status !== 'DRAFT')
                        throw Object.assign(new Error('only DRAFT purchase orders can be deleted'), { statusCode: 400 });
                    await assertOpenPeriodOrThrow(tx, { companyId, transactionDate: new Date(po.orderDate), action: 'purchase_order.delete' });
                    await tx.purchaseOrderLine.deleteMany({ where: { companyId, purchaseOrderId: po.id } });
                    await tx.purchaseOrder.delete({ where: { id: po.id, companyId } });
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
                        action: 'purchase_order.delete',
                        entityType: 'PurchaseOrder',
                        entityId: po.id,
                        idempotencyKey,
                        correlationId,
                        metadata: { poNumber: po.poNumber },
                    });
                    return { purchaseOrderId: po.id, deleted: true };
                });
                return res;
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
    // Approve (DRAFT -> APPROVED)
    fastify.post('/companies/:companyId/purchase-orders/:purchaseOrderId/approve', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const purchaseOrderId = Number(request.params?.purchaseOrderId);
        if (!Number.isInteger(purchaseOrderId) || purchaseOrderId <= 0) {
            reply.status(400);
            return { error: 'invalid purchaseOrderId' };
        }
        const lockKey = `lock:purchase-order:approve:${companyId}:${purchaseOrderId}`;
        const correlationId = randomUUID();
        try {
            const updated = await withLockBestEffort(redis, lockKey, 30_000, async () => prisma.$transaction(async (tx) => {
                await tx.$queryRaw `
            SELECT id FROM PurchaseOrder
            WHERE id = ${purchaseOrderId} AND companyId = ${companyId}
            FOR UPDATE
          `;
                const po = await tx.purchaseOrder.findFirst({ where: { id: purchaseOrderId, companyId }, select: { id: true, status: true, orderDate: true, poNumber: true } });
                if (!po)
                    throw Object.assign(new Error('purchase order not found'), { statusCode: 404 });
                if (po.status !== 'DRAFT')
                    throw Object.assign(new Error('only DRAFT purchase orders can be approved'), { statusCode: 400 });
                await assertOpenPeriodOrThrow(tx, { companyId, transactionDate: new Date(po.orderDate), action: 'purchase_order.approve' });
                const upd = await tx.purchaseOrder.update({
                    where: { id: po.id, companyId },
                    data: { status: 'APPROVED', updatedByUserId: request.user?.userId ?? null },
                    select: { id: true, status: true, poNumber: true },
                });
                await writeAuditLog(tx, {
                    companyId,
                    userId: request.user?.userId ?? null,
                    action: 'purchase_order.approve',
                    entityType: 'PurchaseOrder',
                    entityId: po.id,
                    idempotencyKey: request.headers?.['idempotency-key'] ?? null,
                    correlationId,
                    metadata: { poNumber: po.poNumber, fromStatus: 'DRAFT', toStatus: 'APPROVED' },
                });
                return upd;
            }));
            return updated;
        }
        catch (err) {
            if (err?.statusCode) {
                reply.status(err.statusCode);
                return { error: err.message };
            }
            throw err;
        }
    });
    // Cancel (DRAFT/APPROVED -> CANCELLED)
    fastify.post('/companies/:companyId/purchase-orders/:purchaseOrderId/cancel', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const purchaseOrderId = Number(request.params?.purchaseOrderId);
        if (!Number.isInteger(purchaseOrderId) || purchaseOrderId <= 0) {
            reply.status(400);
            return { error: 'invalid purchaseOrderId' };
        }
        const lockKey = `lock:purchase-order:cancel:${companyId}:${purchaseOrderId}`;
        const correlationId = randomUUID();
        try {
            const updated = await withLockBestEffort(redis, lockKey, 30_000, async () => prisma.$transaction(async (tx) => {
                await tx.$queryRaw `
            SELECT id FROM PurchaseOrder
            WHERE id = ${purchaseOrderId} AND companyId = ${companyId}
            FOR UPDATE
          `;
                const po = await tx.purchaseOrder.findFirst({ where: { id: purchaseOrderId, companyId }, select: { id: true, status: true, orderDate: true, poNumber: true } });
                if (!po)
                    throw Object.assign(new Error('purchase order not found'), { statusCode: 404 });
                if (po.status !== 'DRAFT' && po.status !== 'APPROVED')
                    throw Object.assign(new Error('only DRAFT/APPROVED purchase orders can be cancelled'), { statusCode: 400 });
                await assertOpenPeriodOrThrow(tx, { companyId, transactionDate: new Date(po.orderDate), action: 'purchase_order.cancel' });
                const upd = await tx.purchaseOrder.update({
                    where: { id: po.id, companyId },
                    data: { status: 'CANCELLED', updatedByUserId: request.user?.userId ?? null },
                    select: { id: true, status: true, poNumber: true },
                });
                await writeAuditLog(tx, {
                    companyId,
                    userId: request.user?.userId ?? null,
                    action: 'purchase_order.cancel',
                    entityType: 'PurchaseOrder',
                    entityId: po.id,
                    idempotencyKey: request.headers?.['idempotency-key'] ?? null,
                    correlationId,
                    metadata: { poNumber: po.poNumber, fromStatus: po.status, toStatus: 'CANCELLED' },
                });
                return upd;
            }));
            return updated;
        }
        catch (err) {
            if (err?.statusCode) {
                reply.status(err.statusCode);
                return { error: err.message };
            }
            throw err;
        }
    });
    // --- Receiving: summary of remaining quantities ---
    fastify.get('/companies/:companyId/purchase-orders/:purchaseOrderId/receiving/summary', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const purchaseOrderId = Number(request.params?.purchaseOrderId);
        if (!Number.isInteger(purchaseOrderId) || purchaseOrderId <= 0) {
            reply.status(400);
            return { error: 'invalid purchaseOrderId' };
        }
        const po = await prisma.purchaseOrder.findFirst({
            where: { companyId, id: purchaseOrderId },
            include: { lines: true },
        });
        if (!po) {
            reply.status(404);
            return { error: 'purchase order not found' };
        }
        // Only count POSTED receipts as "received" for remaining qty.
        // DRAFT receipts do not impact inventory yet (no stock moves), so they should not reduce remaining.
        const receiptLines = await prisma.purchaseReceiptLine.findMany({
            where: {
                companyId,
                purchaseOrderLineId: { in: po.lines.map((l) => l.id) },
                purchaseReceipt: { status: 'POSTED' },
            },
            select: { purchaseOrderLineId: true, quantity: true },
        });
        const remaining = computeRemainingByPoLine({
            poLines: po.lines.map((l) => ({ id: l.id, itemId: l.itemId, quantity: l.quantity })),
            receiptLines: receiptLines.map((r) => ({ purchaseOrderLineId: r.purchaseOrderLineId ?? null, quantity: r.quantity })),
        });
        return {
            purchaseOrderId: po.id,
            poNumber: po.poNumber,
            status: po.status,
            rows: po.lines.map((l) => ({
                purchaseOrderLineId: l.id,
                itemId: l.itemId,
                orderedQty: new Prisma.Decimal(l.quantity).toDecimalPlaces(2).toString(),
                remainingQty: (remaining.get(l.id) ?? new Prisma.Decimal(0)).toDecimalPlaces(2).toString(),
            })),
        };
    });
    // --- Receiving: create a DRAFT receipt from PO remaining quantities ---
    // POST /companies/:companyId/purchase-orders/:purchaseOrderId/receipts
    // Requires Idempotency-Key header.
    fastify.post('/companies/:companyId/purchase-orders/:purchaseOrderId/receipts', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const purchaseOrderId = Number(request.params?.purchaseOrderId);
        if (!Number.isInteger(purchaseOrderId) || purchaseOrderId <= 0) {
            reply.status(400);
            return { error: 'invalid purchaseOrderId' };
        }
        const idempotencyKey = request.headers?.['idempotency-key'];
        if (!idempotencyKey) {
            reply.status(400);
            return { error: 'Idempotency-Key header is required' };
        }
        const body = (request.body ?? {});
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
        const correlationId = randomUUID();
        const lockKey = `lock:purchase-order:receive:${companyId}:${purchaseOrderId}`;
        try {
            const { response } = await withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const created = await prisma.$transaction(async (tx) => {
                    await tx.$queryRaw `
              SELECT id FROM PurchaseOrder
              WHERE id = ${purchaseOrderId} AND companyId = ${companyId}
              FOR UPDATE
            `;
                    const po = await tx.purchaseOrder.findFirst({
                        where: { id: purchaseOrderId, companyId },
                        include: { lines: true },
                    });
                    if (!po)
                        throw Object.assign(new Error('purchase order not found'), { statusCode: 404 });
                    if (po.status === 'CANCELLED')
                        throw Object.assign(new Error('cannot receive against a CANCELLED purchase order'), { statusCode: 400 });
                    await assertOpenPeriodOrThrow(tx, { companyId, transactionDate: receiptDate, action: 'purchase_receipt.create_from_po' });
                    // Load receipt lines already recorded for these PO lines
                    // Only count POSTED receipts as "received" for remaining qty.
                    const priorReceiptLines = await tx.purchaseReceiptLine.findMany({
                        where: {
                            companyId,
                            purchaseOrderLineId: { in: po.lines.map((l) => l.id) },
                            purchaseReceipt: { status: 'POSTED' },
                        },
                        select: { purchaseOrderLineId: true, quantity: true },
                    });
                    const remaining = computeRemainingByPoLine({
                        poLines: po.lines.map((l) => ({ id: l.id, itemId: l.itemId, quantity: l.quantity })),
                        receiptLines: priorReceiptLines.map((r) => ({ purchaseOrderLineId: r.purchaseOrderLineId ?? null, quantity: r.quantity })),
                    });
                    // Choose which lines to receive
                    const requested = (body.lines ?? []).filter((l) => l && l.purchaseOrderLineId);
                    const toReceive = requested.length
                        ? requested.map((l) => ({ purchaseOrderLineId: Number(l.purchaseOrderLineId), qty: Number(l.quantity ?? 0) }))
                        : po.lines
                            .map((l) => ({ purchaseOrderLineId: l.id, qty: Number((remaining.get(l.id) ?? new Prisma.Decimal(0)).toString()) }))
                            .filter((x) => Number.isFinite(x.qty) && x.qty > 0);
                    if (toReceive.length === 0)
                        throw Object.assign(new Error('no remaining quantities to receive'), { statusCode: 400 });
                    // Build receipt lines from PO lines
                    let total = new Prisma.Decimal(0);
                    const receiptLinesCreate = [];
                    for (const [idx, reqLine] of toReceive.entries()) {
                        const poLineId = Number(reqLine.purchaseOrderLineId);
                        const qtyNum = Number(reqLine.qty);
                        if (!Number.isInteger(poLineId) || poLineId <= 0)
                            throw Object.assign(new Error(`lines[${idx}].purchaseOrderLineId is required`), { statusCode: 400 });
                        if (!Number.isFinite(qtyNum) || qtyNum <= 0)
                            throw Object.assign(new Error(`lines[${idx}].quantity must be > 0`), { statusCode: 400 });
                        const poLine = po.lines.find((l) => Number(l.id) === poLineId);
                        if (!poLine)
                            throw Object.assign(new Error(`purchaseOrderLineId ${poLineId} not found on this PO`), { statusCode: 400 });
                        const remainingQty = remaining.get(poLineId) ?? new Prisma.Decimal(0);
                        const qtyDec = new Prisma.Decimal(qtyNum).toDecimalPlaces(2);
                        if (qtyDec.greaterThan(remainingQty)) {
                            throw Object.assign(new Error(`quantity exceeds remaining for purchaseOrderLineId ${poLineId}`), {
                                statusCode: 400,
                                remainingQty: remainingQty.toString(),
                                requestedQty: qtyDec.toString(),
                            });
                        }
                        // Ensure item is tracked inventory (receipt system v1)
                        const item = await tx.item.findFirst({ where: { id: poLine.itemId, companyId }, select: { id: true, type: true, trackInventory: true } });
                        if (!item)
                            throw Object.assign(new Error(`itemId ${poLine.itemId} not found in this company`), { statusCode: 400 });
                        if (item.type !== ItemType.GOODS || !item.trackInventory) {
                            throw Object.assign(new Error('PO receiving v1 only supports tracked GOODS items'), { statusCode: 400 });
                        }
                        const unitCost = new Prisma.Decimal(poLine.unitCost).toDecimalPlaces(2);
                        // Pro-rate discount amount by received qty vs ordered qty (simple & deterministic)
                        const orderedQty = new Prisma.Decimal(poLine.quantity).toDecimalPlaces(2);
                        const fullDisc = new Prisma.Decimal(poLine.discountAmount ?? 0).toDecimalPlaces(2);
                        const proratedDisc = orderedQty.greaterThan(0) ? fullDisc.mul(qtyDec).div(orderedQty).toDecimalPlaces(2) : new Prisma.Decimal(0);
                        const gross = qtyDec.mul(unitCost).toDecimalPlaces(2);
                        const lineTotal = gross.sub(proratedDisc).toDecimalPlaces(2);
                        total = total.add(lineTotal);
                        receiptLinesCreate.push({
                            companyId,
                            locationId: po.locationId,
                            itemId: poLine.itemId,
                            purchaseOrderLineId: poLineId,
                            description: poLine.description ?? null,
                            quantity: qtyDec,
                            unitCost,
                            discountAmount: proratedDisc,
                            lineTotal,
                        });
                    }
                    total = total.toDecimalPlaces(2);
                    const receiptNumber = await nextPurchaseReceiptNumber(tx, companyId);
                    const r = await tx.purchaseReceipt.create({
                        data: {
                            companyId,
                            vendorId: po.vendorId ?? null,
                            purchaseOrderId: po.id,
                            locationId: po.locationId,
                            receiptNumber,
                            status: 'DRAFT',
                            receiptDate,
                            expectedDate: expectedDate ?? null,
                            currency: po.currency ?? null,
                            total,
                            createdByUserId: request.user?.userId ?? null,
                            updatedByUserId: request.user?.userId ?? null,
                            lines: { create: receiptLinesCreate },
                        },
                        include: { location: true, lines: { include: { item: true } } },
                    });
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
                        action: 'purchase_receipt.create_from_po',
                        entityType: 'PurchaseReceipt',
                        entityId: r.id,
                        idempotencyKey,
                        correlationId,
                        metadata: { purchaseOrderId: po.id, poNumber: po.poNumber, receiptNumber, receiptDate, total: total.toString() },
                    });
                    return r;
                });
                return created;
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
    // --- Billing: convert PO to a DRAFT bill (non-inventory/service only) ---
    // For tracked inventory items, use the receipt flow (Receive & Bill) to preserve GRNI.
    fastify.post('/companies/:companyId/purchase-orders/:purchaseOrderId/convert-to-bill', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const purchaseOrderId = Number(request.params?.purchaseOrderId);
        if (!Number.isInteger(purchaseOrderId) || purchaseOrderId <= 0) {
            reply.status(400);
            return { error: 'invalid purchaseOrderId' };
        }
        const idempotencyKey = request.headers?.['idempotency-key'];
        if (!idempotencyKey) {
            reply.status(400);
            return { error: 'Idempotency-Key header is required' };
        }
        const body = (request.body ?? {});
        const billDate = parseDateInput(body.billDate) ?? new Date();
        if (body.billDate && isNaN(billDate.getTime())) {
            reply.status(400);
            return { error: 'invalid billDate' };
        }
        const dueDate = body.dueDate ? parseDateInput(body.dueDate) : null;
        if (body.dueDate && body.dueDate !== null && dueDate && isNaN(dueDate.getTime())) {
            reply.status(400);
            return { error: 'invalid dueDate' };
        }
        const correlationId = randomUUID();
        const lockKey = `lock:purchase-order:convert-to-bill:${companyId}:${purchaseOrderId}`;
        try {
            const { response } = await withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const created = await prisma.$transaction(async (tx) => {
                    await tx.$queryRaw `
              SELECT id FROM PurchaseOrder
              WHERE id = ${purchaseOrderId} AND companyId = ${companyId}
              FOR UPDATE
            `;
                    const po = await tx.purchaseOrder.findFirst({
                        where: { id: purchaseOrderId, companyId },
                        include: { vendor: true, location: true, lines: { include: { item: true } } },
                    });
                    if (!po)
                        throw Object.assign(new Error('purchase order not found'), { statusCode: 404 });
                    if (po.status === 'CANCELLED')
                        throw Object.assign(new Error('cannot bill a CANCELLED purchase order'), { statusCode: 400 });
                    const cfg = await ensureInventoryCompanyDefaults(tx, companyId);
                    // OPTIMIZED: Pre-analyze lines and batch validate expense accounts
                    const nonTrackedLines = [];
                    let skippedTracked = 0;
                    for (const [idx, l] of (po.lines ?? []).entries()) {
                        const item = l.item;
                        if (!item)
                            continue;
                        const isTracked = item.type === ItemType.GOODS && !!item.trackInventory;
                        if (isTracked) {
                            skippedTracked += 1;
                            continue;
                        }
                        const accountId = Number(item.expenseAccountId ?? 0) || null;
                        if (!accountId) {
                            throw Object.assign(new Error(`line[${idx}] item is missing expenseAccountId (required for non-inventory billing)`), {
                                statusCode: 400,
                            });
                        }
                        nonTrackedLines.push({ idx, line: l, item, accountId });
                    }
                    // Batch validate all expense accounts in one query
                    const accountIdsToCheck = Array.from(new Set(nonTrackedLines.map((x) => x.accountId)));
                    const validAccounts = accountIdsToCheck.length > 0
                        ? await tx.account.findMany({ where: { id: { in: accountIdsToCheck }, companyId, type: 'EXPENSE' }, select: { id: true } })
                        : [];
                    const validAccountIds = new Set(validAccounts.map((a) => a.id));
                    let total = new Prisma.Decimal(0);
                    const linesCreate = [];
                    for (const { idx, line: l, accountId } of nonTrackedLines) {
                        if (!validAccountIds.has(accountId)) {
                            throw Object.assign(new Error(`line[${idx}] item.expenseAccountId must be an EXPENSE account in this company`), { statusCode: 400 });
                        }
                        const qty = new Prisma.Decimal(l.quantity).toDecimalPlaces(2);
                        const unitCost = new Prisma.Decimal(l.unitCost).toDecimalPlaces(2);
                        const disc = new Prisma.Decimal(l.discountAmount ?? 0).toDecimalPlaces(2);
                        const lineTotal = new Prisma.Decimal(l.lineTotal).toDecimalPlaces(2);
                        if (qty.lessThanOrEqualTo(0) || unitCost.lessThanOrEqualTo(0) || lineTotal.lessThanOrEqualTo(0)) {
                            throw Object.assign(new Error(`invalid PO line[${idx}] quantity/unitCost/lineTotal`), { statusCode: 400 });
                        }
                        total = total.add(lineTotal);
                        linesCreate.push({
                            companyId,
                            locationId: po.locationId,
                            itemId: l.itemId,
                            purchaseOrderLineId: l.id,
                            accountId,
                            description: l.description ?? null,
                            quantity: qty,
                            unitCost,
                            discountAmount: disc,
                            lineTotal,
                        });
                    }
                    if (!linesCreate.length) {
                        throw Object.assign(new Error(skippedTracked > 0
                            ? 'PO contains only tracked inventory items. Use Receive & Bill (receipt -> GRNI -> bill).'
                            : 'PO has no billable lines'), { statusCode: 400 });
                    }
                    total = total.toDecimalPlaces(2);
                    const billNumber = await nextPurchaseBillNumber(tx, companyId);
                    const bill = await tx.purchaseBill.create({
                        data: {
                            companyId,
                            vendorId: po.vendorId ?? null,
                            purchaseOrderId: po.id,
                            purchaseReceiptId: null,
                            locationId: po.locationId,
                            billNumber,
                            status: 'DRAFT',
                            billDate,
                            dueDate: dueDate ?? null,
                            currency: po.currency ?? null,
                            total,
                            amountPaid: new Prisma.Decimal(0),
                            lines: { create: linesCreate },
                        },
                        include: { vendor: true, location: true, lines: { include: { item: true, account: true } } },
                    });
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
                        action: 'purchase_bill.create_from_po',
                        entityType: 'PurchaseBill',
                        entityId: bill.id,
                        idempotencyKey,
                        correlationId,
                        metadata: { purchaseOrderId: po.id, poNumber: po.poNumber, billNumber, billDate, total: total.toString() },
                    });
                    // cfg used only as a sanity import above; avoid unused warnings if inlined later
                    void cfg;
                    return bill;
                });
                return created;
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
    // --- Receiving + Billing: receive remaining quantities and immediately create a linked bill ---
    // This posts the receipt (creates stock moves + JE Dr Inventory / Cr GRNI) and then creates a DRAFT bill linked to that receipt.
    fastify.post('/companies/:companyId/purchase-orders/:purchaseOrderId/receive-and-bill', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const purchaseOrderId = Number(request.params?.purchaseOrderId);
        if (!Number.isInteger(purchaseOrderId) || purchaseOrderId <= 0) {
            reply.status(400);
            return { error: 'invalid purchaseOrderId' };
        }
        const idempotencyKey = request.headers?.['idempotency-key'];
        if (!idempotencyKey) {
            reply.status(400);
            return { error: 'Idempotency-Key header is required' };
        }
        const body = (request.body ?? {});
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
        const billDate = parseDateInput(body.billDate) ?? receiptDate;
        if (body.billDate && isNaN(billDate.getTime())) {
            reply.status(400);
            return { error: 'invalid billDate' };
        }
        const dueDate = body.dueDate ? parseDateInput(body.dueDate) : null;
        if (body.dueDate && body.dueDate !== null && dueDate && isNaN(dueDate.getTime())) {
            reply.status(400);
            return { error: 'invalid dueDate' };
        }
        // Pre-read to compute stock locks (avoid concurrent WAC updates)
        const prePo = await prisma.purchaseOrder.findFirst({
            where: { companyId, id: purchaseOrderId },
            select: {
                id: true,
                locationId: true,
                lines: { select: { itemId: true, item: { select: { type: true, trackInventory: true } } } },
            },
        });
        if (!prePo) {
            reply.status(404);
            return { error: 'purchase order not found' };
        }
        // Only lock stock for tracked inventory items (avoid unnecessary conflicts for services/non-inventory).
        const trackedItemIds = Array.from(new Set((prePo.lines ?? [])
            .filter((l) => l?.itemId && l?.item?.type === 'GOODS' && !!l?.item?.trackInventory)
            .map((l) => Number(l.itemId))
            .filter((n) => Number.isFinite(n) && n > 0)));
        const stockLocks = Array.from(new Set(trackedItemIds.map((itemId) => `lock:stock:${companyId}:${prePo.locationId}:${itemId}`)));
        const correlationId = randomUUID();
        const occurredAt = isoNow();
        const lockKey = `lock:purchase-order:receive-and-bill:${companyId}:${purchaseOrderId}`;
        try {
            const { replay, response: result } = await runWithResourceLockRetry(() => withLocksBestEffort(redis, stockLocks, 30_000, async () => withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const txResult = await prisma.$transaction(async (tx) => {
                    await tx.$queryRaw `
                SELECT id FROM PurchaseOrder
                WHERE id = ${purchaseOrderId} AND companyId = ${companyId}
                FOR UPDATE
              `;
                    const po = await tx.purchaseOrder.findFirst({
                        where: { id: purchaseOrderId, companyId },
                        include: { vendor: true, location: true, lines: { include: { item: true } } },
                    });
                    if (!po)
                        throw Object.assign(new Error('purchase order not found'), { statusCode: 404 });
                    if (po.status === 'CANCELLED')
                        throw Object.assign(new Error('cannot receive/bill a CANCELLED purchase order'), { statusCode: 400 });
                    await assertOpenPeriodOrThrow(tx, { companyId, transactionDate: receiptDate, action: 'purchase_receipt.receive_and_bill' });
                    // Only count POSTED receipts as "received" for remaining qty.
                    const priorReceiptLines = await tx.purchaseReceiptLine.findMany({
                        where: {
                            companyId,
                            purchaseOrderLineId: { in: po.lines.map((l) => l.id) },
                            purchaseReceipt: { status: 'POSTED' },
                        },
                        select: { purchaseOrderLineId: true, quantity: true },
                    });
                    const remaining = computeRemainingByPoLine({
                        poLines: po.lines.map((l) => ({ id: l.id, itemId: l.itemId, quantity: l.quantity })),
                        receiptLines: priorReceiptLines.map((r) => ({ purchaseOrderLineId: r.purchaseOrderLineId ?? null, quantity: r.quantity })),
                    });
                    const requested = (body.lines ?? []).filter((l) => l && l.purchaseOrderLineId);
                    const toReceive = requested.length
                        ? requested.map((l) => ({ purchaseOrderLineId: Number(l.purchaseOrderLineId), qty: Number(l.quantity ?? 0) }))
                        : po.lines
                            .map((l) => ({ purchaseOrderLineId: l.id, qty: Number((remaining.get(l.id) ?? new Prisma.Decimal(0)).toString()) }))
                            .filter((x) => Number.isFinite(x.qty) && x.qty > 0);
                    if (toReceive.length === 0)
                        throw Object.assign(new Error('no remaining quantities to receive'), { statusCode: 400 });
                    let receiptTotal = new Prisma.Decimal(0);
                    const receiptLinesCreate = [];
                    for (const [idx, reqLine] of toReceive.entries()) {
                        const poLineId = Number(reqLine.purchaseOrderLineId);
                        const qtyNum = Number(reqLine.qty);
                        if (!Number.isInteger(poLineId) || poLineId <= 0)
                            throw Object.assign(new Error(`lines[${idx}].purchaseOrderLineId is required`), { statusCode: 400 });
                        if (!Number.isFinite(qtyNum) || qtyNum <= 0)
                            throw Object.assign(new Error(`lines[${idx}].quantity must be > 0`), { statusCode: 400 });
                        const poLine = (po.lines ?? []).find((l) => Number(l.id) === poLineId);
                        if (!poLine)
                            throw Object.assign(new Error(`purchaseOrderLineId ${poLineId} not found on this PO`), { statusCode: 400 });
                        const remainingQty = remaining.get(poLineId) ?? new Prisma.Decimal(0);
                        const qtyDec = new Prisma.Decimal(qtyNum).toDecimalPlaces(2);
                        if (qtyDec.greaterThan(remainingQty)) {
                            throw Object.assign(new Error(`quantity exceeds remaining for purchaseOrderLineId ${poLineId}`), {
                                statusCode: 400,
                                remainingQty: remainingQty.toString(),
                                requestedQty: qtyDec.toString(),
                            });
                        }
                        const item = poLine.item;
                        const isTracked = item?.type === ItemType.GOODS && !!item?.trackInventory;
                        if (!isTracked) {
                            throw Object.assign(new Error('Receive & Bill only supports tracked GOODS items (inventory) in v1'), { statusCode: 400 });
                        }
                        await ensureInventoryItem(tx, companyId, poLine.itemId);
                        const unitCost = new Prisma.Decimal(poLine.unitCost).toDecimalPlaces(2);
                        const orderedQty = new Prisma.Decimal(poLine.quantity).toDecimalPlaces(2);
                        const fullDisc = new Prisma.Decimal(poLine.discountAmount ?? 0).toDecimalPlaces(2);
                        const proratedDisc = orderedQty.greaterThan(0) ? fullDisc.mul(qtyDec).div(orderedQty).toDecimalPlaces(2) : new Prisma.Decimal(0);
                        const gross = qtyDec.mul(unitCost).toDecimalPlaces(2);
                        const lineTotal = gross.sub(proratedDisc).toDecimalPlaces(2);
                        receiptTotal = receiptTotal.add(lineTotal);
                        receiptLinesCreate.push({
                            companyId,
                            locationId: po.locationId,
                            itemId: poLine.itemId,
                            purchaseOrderLineId: poLineId,
                            description: poLine.description ?? null,
                            quantity: qtyDec,
                            unitCost,
                            discountAmount: proratedDisc,
                            lineTotal,
                        });
                    }
                    receiptTotal = receiptTotal.toDecimalPlaces(2);
                    const receiptNumber = await nextPurchaseReceiptNumber(tx, companyId);
                    const r = await tx.purchaseReceipt.create({
                        data: {
                            companyId,
                            vendorId: po.vendorId ?? null,
                            purchaseOrderId: po.id,
                            locationId: po.locationId,
                            receiptNumber,
                            status: 'DRAFT',
                            receiptDate,
                            expectedDate: expectedDate ?? null,
                            currency: po.currency ?? null,
                            total: receiptTotal,
                            createdByUserId: request.user?.userId ?? null,
                            updatedByUserId: request.user?.userId ?? null,
                            lines: { create: receiptLinesCreate },
                        },
                        include: { lines: { include: { item: true } }, vendor: true },
                    });
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
                        action: 'purchase_receipt.create_from_po',
                        entityType: 'PurchaseReceipt',
                        entityId: r.id,
                        idempotencyKey,
                        correlationId,
                        metadata: { purchaseOrderId: po.id, poNumber: po.poNumber, receiptNumber, receiptDate, total: receiptTotal.toString() },
                    });
                    // Post receipt (DRAFT -> POSTED): creates stock moves + JE Dr Inventory / Cr GRNI
                    // OPTIMIZED: Skip duplicate period check - same date already checked above
                    // OPTIMIZED: Batch fetch inventory config + GRNI account in parallel
                    const [cfg, grniId] = await Promise.all([
                        ensureInventoryCompanyDefaults(tx, companyId),
                        ensureGrniAccount(tx, companyId),
                    ]);
                    if (!cfg.inventoryAssetAccountId)
                        throw Object.assign(new Error('company.inventoryAssetAccountId is not set'), { statusCode: 400 });
                    const grniAcc = await tx.account.findFirst({ where: { id: grniId, companyId, type: AccountType.LIABILITY } });
                    if (!grniAcc)
                        throw Object.assign(new Error('GRNI account must be a LIABILITY in this company'), { statusCode: 400 });
                    // OPTIMIZED: Batch ensure inventory items
                    const itemIdsToEnsure = (r.lines ?? []).map((l) => l.itemId);
                    await Promise.all(itemIdsToEnsure.map((itemId) => ensureInventoryItem(tx, companyId, itemId)));
                    let recomputedTotal = new Prisma.Decimal(0);
                    let inventoryRecalcFromDate = null;
                    for (const [idx, l] of (r.lines ?? []).entries()) {
                        const item = l.item;
                        if (!item || item.type !== ItemType.GOODS || !item.trackInventory) {
                            throw Object.assign(new Error(`line[${idx}] item must be tracked GOODS`), { statusCode: 400 });
                        }
                        const qty = new Prisma.Decimal(l.quantity).toDecimalPlaces(2);
                        const unitCost = new Prisma.Decimal(l.unitCost).toDecimalPlaces(2);
                        const lineTotal = new Prisma.Decimal(l.lineTotal).toDecimalPlaces(2);
                        recomputedTotal = recomputedTotal.add(lineTotal);
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
                    recomputedTotal = recomputedTotal.toDecimalPlaces(2);
                    const storedTotal = new Prisma.Decimal(r.total).toDecimalPlaces(2);
                    if (!recomputedTotal.equals(storedTotal)) {
                        throw Object.assign(new Error(`rounding mismatch: recomputed total ${recomputedTotal.toString()} != stored total ${storedTotal.toString()}`), {
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
                        skipLocationValidation: true, // OPTIMIZED: locationId from PO row
                        lines: [
                            { accountId: cfg.inventoryAssetAccountId, debit: storedTotal, credit: new Prisma.Decimal(0) },
                            { accountId: grniAcc.id, debit: new Prisma.Decimal(0), credit: storedTotal },
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
                        metadata: { receiptNumber: r.receiptNumber, receiptDate: r.receiptDate, total: storedTotal.toString(), journalEntryId: je.id },
                    });
                    // Create bill linked to receipt (DRAFT)
                    const billNumber = await nextPurchaseBillNumber(tx, companyId);
                    const bill = await tx.purchaseBill.create({
                        data: {
                            companyId,
                            vendorId: po.vendorId ?? null,
                            purchaseOrderId: po.id,
                            purchaseReceiptId: r.id,
                            locationId: po.locationId,
                            billNumber,
                            status: 'DRAFT',
                            billDate,
                            dueDate: dueDate ?? null,
                            currency: po.currency ?? null,
                            total: storedTotal,
                            amountPaid: new Prisma.Decimal(0),
                            lines: {
                                create: (r.lines ?? []).map((l) => ({
                                    companyId,
                                    locationId: po.locationId,
                                    itemId: l.itemId,
                                    purchaseOrderLineId: l.purchaseOrderLineId ?? null,
                                    purchaseReceiptLineId: l.id,
                                    description: l.description ?? null,
                                    quantity: new Prisma.Decimal(l.quantity).toDecimalPlaces(2),
                                    unitCost: new Prisma.Decimal(l.unitCost).toDecimalPlaces(2),
                                    discountAmount: new Prisma.Decimal(l.discountAmount ?? 0).toDecimalPlaces(2),
                                    lineTotal: new Prisma.Decimal(l.lineTotal).toDecimalPlaces(2),
                                    accountId: cfg.inventoryAssetAccountId ?? null,
                                })),
                            },
                        },
                        include: { vendor: true, location: true, lines: { include: { item: true, account: true } }, purchaseReceipt: true },
                    });
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
                        action: 'purchase_bill.create_from_receipt',
                        entityType: 'PurchaseBill',
                        entityId: bill.id,
                        idempotencyKey,
                        correlationId,
                        metadata: {
                            purchaseOrderId: po.id,
                            poNumber: po.poNumber,
                            purchaseReceiptId: r.id,
                            receiptNumber: r.receiptNumber,
                            purchaseBillId: bill.id,
                            billNumber,
                            receiptDate,
                            billDate,
                            total: storedTotal.toString(),
                        },
                    });
                    return {
                        purchaseOrderId: po.id,
                        purchaseReceiptId: r.id,
                        receiptNumber: r.receiptNumber,
                        purchaseBillId: bill.id,
                        billNumber,
                        total: storedTotal.toString(),
                        _eventIds: [jeEventId, ...(inventoryRecalcEventId ? [inventoryRecalcEventId] : [])],
                    };
                });
                return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
            }, redis))));
            if (!replay && result?._eventIds?.length) {
                publishEventsFastPath(result._eventIds);
            }
            return {
                purchaseOrderId: result.purchaseOrderId,
                purchaseReceiptId: result.purchaseReceiptId,
                receiptNumber: result.receiptNumber,
                purchaseBillId: result.purchaseBillId,
                billNumber: result.billNumber,
                total: result.total,
            };
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
//# sourceMappingURL=purchaseOrders.routes.js.map