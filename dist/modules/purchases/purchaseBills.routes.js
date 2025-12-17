import { prisma } from '../../infrastructure/db.js';
import { AccountType, BankingAccountKind, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { requireCompanyIdParam } from '../../utils/tenant.js';
import { getRedis } from '../../infrastructure/redis.js';
import { withLockBestEffort, withLocksBestEffort } from '../../infrastructure/locks.js';
import { runIdempotentRequest } from '../../infrastructure/commandIdempotency.js';
import { postJournalEntry } from '../ledger/posting.service.js';
import { publishDomainEvent } from '../../infrastructure/pubsub.js';
import { markEventPublished } from '../../infrastructure/events.js';
import { isoNow } from '../../utils/date.js';
import { ensureInventoryCompanyDefaults, ensureInventoryItem } from '../inventory/stock.service.js';
import { applyStockMoveWac } from '../inventory/stock.service.js';
import { toMoneyDecimal } from '../../utils/money.js';
import { nextPurchaseBillNumber } from '../sequence/sequence.service.js';
function generatePurchaseBillNumber() {
    // legacy fallback (should not be used in new code paths)
    return `PBILL-${Date.now()}`;
}
export async function purchaseBillsRoutes(fastify) {
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
        const body = request.body;
        if (!body.lines?.length) {
            reply.status(400);
            return { error: 'lines is required' };
        }
        const billDate = body.billDate ? new Date(body.billDate) : new Date();
        const dueDate = body.dueDate ? new Date(body.dueDate) : null;
        if (body.billDate && isNaN(billDate.getTime())) {
            reply.status(400);
            return { error: 'invalid billDate' };
        }
        if (body.dueDate && dueDate && isNaN(dueDate.getTime())) {
            reply.status(400);
            return { error: 'invalid dueDate' };
        }
        // Bootstrap defaults for older companies
        const cfg = await ensureInventoryCompanyDefaults(prisma, companyId);
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
        const computedLines = [];
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
            // - Otherwise: require EXPENSE account (line.accountId or item.expenseAccountId)
            let accountId = null;
            const isTracked = item.type === 'GOODS' && !!item.trackInventory;
            if (isTracked) {
                accountId = cfg.inventoryAssetAccountId ?? null;
                if (!accountId) {
                    reply.status(400);
                    return { error: 'company.inventoryAssetAccountId is not set' };
                }
            }
            else {
                accountId = Number(l.accountId ?? item.expenseAccountId ?? 0) || null;
                if (!accountId) {
                    reply.status(400);
                    return { error: `lines[${idx}].accountId is required for non-inventory items` };
                }
                const acc = await prisma.account.findFirst({ where: { id: accountId, companyId, type: AccountType.EXPENSE } });
                if (!acc) {
                    reply.status(400);
                    return { error: `lines[${idx}].accountId must be an EXPENSE account in this company` };
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
            const billNumber = await nextPurchaseBillNumber(tx, companyId);
            return await tx.purchaseBill.create({
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
                },
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
        const purchaseBillId = Number(request.params?.purchaseBillId);
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
            .filter((p) => !p.reversedAt)
            .reduce((sum, p) => sum + Number(p.amount), 0);
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
            lines: (bill.lines ?? []).map((l) => ({
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
            payments: (bill.payments ?? []).map((p) => ({
                id: p.id,
                paymentDate: p.paymentDate,
                amount: p.amount,
                bankAccount: { id: p.bankAccount.id, code: p.bankAccount.code, name: p.bankAccount.name },
                journalEntryId: p.journalEntry?.id ?? null,
                reversedAt: p.reversedAt ?? null,
                reversalReason: p.reversalReason ?? null,
                reversalJournalEntryId: p.reversalJournalEntryId ?? null,
            })),
        };
    });
    // Post purchase bill: DRAFT -> POSTED (creates stock moves + JE Dr Inventory / Cr AP)
    fastify.post('/companies/:companyId/purchase-bills/:purchaseBillId/post', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const purchaseBillId = Number(request.params?.purchaseBillId);
        if (!companyId || Number.isNaN(purchaseBillId)) {
            reply.status(400);
            return { error: 'invalid companyId or purchaseBillId' };
        }
        const idempotencyKey = request.headers?.['idempotency-key'];
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
        const { replay, response: result } = await withLocksBestEffort(redis, stockLocks, 30_000, async () => withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
            const txResult = await prisma.$transaction(async (tx) => {
                const bill = await tx.purchaseBill.findFirst({
                    where: { id: purchaseBillId, companyId },
                    include: { company: true, vendor: true, warehouse: true, lines: { include: { item: true } } },
                });
                if (!bill)
                    throw Object.assign(new Error('purchase bill not found'), { statusCode: 404 });
                if (bill.status !== 'DRAFT') {
                    throw Object.assign(new Error('only DRAFT purchase bills can be posted'), { statusCode: 400 });
                }
                const cfg = await ensureInventoryCompanyDefaults(tx, companyId);
                if (!cfg.inventoryAssetAccountId) {
                    throw Object.assign(new Error('company.inventoryAssetAccountId is not set'), { statusCode: 400 });
                }
                const apId = bill.company.accountsPayableAccountId;
                if (!apId) {
                    throw Object.assign(new Error('company.accountsPayableAccountId is not set'), { statusCode: 400 });
                }
                const apAcc = await tx.account.findFirst({ where: { id: apId, companyId, type: 'LIABILITY' } });
                if (!apAcc) {
                    throw Object.assign(new Error('accountsPayableAccountId must be a LIABILITY account in this company'), {
                        statusCode: 400,
                    });
                }
                // Apply stock moves for tracked items, and compute per-account debits.
                let total = new Prisma.Decimal(0);
                const debitByAccount = new Map();
                for (const [idx, l] of (bill.lines ?? []).entries()) {
                    const qty = new Prisma.Decimal(l.quantity).toDecimalPlaces(2);
                    const unitCost = new Prisma.Decimal(l.unitCost).toDecimalPlaces(2);
                    if (qty.lessThanOrEqualTo(0) || unitCost.lessThanOrEqualTo(0)) {
                        throw Object.assign(new Error(`invalid line[${idx}] quantity/unitCost`), { statusCode: 400 });
                    }
                    const lineTotal = new Prisma.Decimal(l.lineTotal).toDecimalPlaces(2);
                    total = total.add(lineTotal);
                    const item = l.item;
                    const isTracked = item?.type === 'GOODS' && !!item?.trackInventory;
                    let debitAccountId = l.accountId ?? null;
                    if (isTracked) {
                        debitAccountId = cfg.inventoryAssetAccountId;
                        await ensureInventoryItem(tx, companyId, l.itemId);
                        await applyStockMoveWac(tx, {
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
                            createdByUserId: request.user?.userId ?? null,
                            journalEntryId: null,
                        });
                    }
                    else {
                        if (!debitAccountId) {
                            debitAccountId = item?.expenseAccountId ?? null;
                        }
                        if (!debitAccountId) {
                            throw Object.assign(new Error(`line[${idx}] accountId is required for non-inventory items`), { statusCode: 400 });
                        }
                        const exp = await tx.account.findFirst({ where: { id: debitAccountId, companyId, type: 'EXPENSE' } });
                        if (!exp)
                            throw Object.assign(new Error(`line[${idx}] accountId must be an EXPENSE account`), { statusCode: 400 });
                    }
                    const prev = debitByAccount.get(debitAccountId) ?? new Prisma.Decimal(0);
                    debitByAccount.set(debitAccountId, prev.add(lineTotal));
                }
                total = total.toDecimalPlaces(2);
                const debitLines = Array.from(debitByAccount.entries()).map(([accountId, amt]) => ({
                    accountId,
                    debit: amt.toDecimalPlaces(2),
                    credit: new Prisma.Decimal(0),
                }));
                const je = await postJournalEntry(tx, {
                    companyId,
                    date: bill.billDate,
                    description: `Purchase Bill ${bill.billNumber}${bill.vendor ? ` for ${bill.vendor.name}` : ''}`,
                    createdByUserId: request.user?.userId ?? null,
                    skipAccountValidation: true,
                    lines: [
                        ...debitLines,
                        { accountId: apAcc.id, debit: new Prisma.Decimal(0), credit: total },
                    ],
                });
                await tx.stockMove.updateMany({
                    where: { companyId, correlationId, journalEntryId: null },
                    data: { journalEntryId: je.id },
                });
                const updated = await tx.purchaseBill.update({
                    where: { id: bill.id },
                    data: { status: 'POSTED', journalEntryId: je.id, total, amountPaid: new Prisma.Decimal(0) },
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
                return { purchaseBillId: updated.id, status: updated.status, journalEntryId: je.id, total: total.toString(), _jeEventId: jeEventId };
            });
            return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
        }, redis)));
        if (!replay) {
            const ok = await publishDomainEvent({
                eventId: result._jeEventId,
                eventType: 'journal.entry.created',
                schemaVersion: 'v1',
                occurredAt: result._occurredAt,
                companyId,
                partitionKey: String(companyId),
                correlationId: result._correlationId,
                aggregateType: 'JournalEntry',
                aggregateId: String(result.journalEntryId),
                source: 'cashflow-api',
                payload: { journalEntryId: result.journalEntryId, companyId },
            });
            if (ok)
                await markEventPublished(result._jeEventId);
        }
        return {
            purchaseBillId: result.purchaseBillId,
            status: result.status,
            journalEntryId: result.journalEntryId,
            total: result.total,
        };
    });
    // Record purchase bill payment: Dr AP / Cr Cash-Bank
    fastify.post('/companies/:companyId/purchase-bills/:purchaseBillId/payments', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const purchaseBillId = Number(request.params?.purchaseBillId);
        if (!companyId || Number.isNaN(purchaseBillId)) {
            reply.status(400);
            return { error: 'invalid companyId or purchaseBillId' };
        }
        const idempotencyKey = request.headers?.['idempotency-key'];
        if (!idempotencyKey) {
            reply.status(400);
            return { error: 'Idempotency-Key header is required' };
        }
        const body = request.body;
        if (!body.amount || body.amount <= 0 || !body.bankAccountId) {
            reply.status(400);
            return { error: 'amount (>0) and bankAccountId are required' };
        }
        const occurredAt = isoNow();
        const correlationId = randomUUID();
        const lockKey = `lock:purchase-bill:payment:${companyId}:${purchaseBillId}`;
        try {
            const { replay, response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const txResult = await prisma.$transaction(async (tx) => {
                    const bill = await tx.purchaseBill.findFirst({
                        where: { id: purchaseBillId, companyId },
                        include: { company: true },
                    });
                    if (!bill)
                        throw Object.assign(new Error('purchase bill not found'), { statusCode: 404 });
                    if (bill.status !== 'POSTED' && bill.status !== 'PARTIAL') {
                        throw Object.assign(new Error('payments allowed only for POSTED or PARTIAL purchase bills'), { statusCode: 400 });
                    }
                    const apId = bill.company.accountsPayableAccountId;
                    if (!apId)
                        throw Object.assign(new Error('company.accountsPayableAccountId is not set'), { statusCode: 400 });
                    const apAcc = await tx.account.findFirst({ where: { id: apId, companyId, type: AccountType.LIABILITY } });
                    if (!apAcc)
                        throw Object.assign(new Error('accountsPayableAccountId must be a LIABILITY account in this company'), { statusCode: 400 });
                    const bankAccount = await tx.account.findFirst({
                        where: { id: body.bankAccountId, companyId, type: AccountType.ASSET },
                    });
                    if (!bankAccount)
                        throw Object.assign(new Error('bankAccountId must be an ASSET account in this company'), { statusCode: 400 });
                    const banking = await tx.bankingAccount.findFirst({
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
                    const paymentDate = body.paymentDate ? new Date(body.paymentDate) : new Date();
                    if (body.paymentDate && isNaN(paymentDate.getTime())) {
                        throw Object.assign(new Error('invalid paymentDate'), { statusCode: 400 });
                    }
                    const amount = toMoneyDecimal(body.amount);
                    const sumAgg = await tx.purchaseBillPayment.aggregate({
                        where: { purchaseBillId: bill.id, companyId, reversedAt: null },
                        _sum: { amount: true },
                    });
                    const totalPaidBefore = (sumAgg._sum.amount ?? new Prisma.Decimal(0)).toDecimalPlaces(2);
                    const remainingBefore = new Prisma.Decimal(bill.total).minus(totalPaidBefore).toDecimalPlaces(2);
                    if (amount.greaterThan(remainingBefore)) {
                        throw Object.assign(new Error(`amount cannot exceed remaining balance of ${remainingBefore.toString()}`), { statusCode: 400 });
                    }
                    const je = await postJournalEntry(tx, {
                        companyId,
                        date: paymentDate,
                        description: `Payment for Purchase Bill ${bill.billNumber}`,
                        createdByUserId: request.user?.userId ?? null,
                        skipAccountValidation: true,
                        lines: [
                            { accountId: apAcc.id, debit: amount, credit: new Prisma.Decimal(0) },
                            { accountId: bankAccount.id, debit: new Prisma.Decimal(0), credit: amount },
                        ],
                    });
                    const pay = await tx.purchaseBillPayment.create({
                        data: {
                            companyId,
                            purchaseBillId: bill.id,
                            paymentDate,
                            amount,
                            bankAccountId: bankAccount.id,
                            journalEntryId: je.id,
                        },
                    });
                    const sumAgg2 = await tx.purchaseBillPayment.aggregate({
                        where: { purchaseBillId: bill.id, companyId, reversedAt: null },
                        _sum: { amount: true },
                    });
                    const totalPaid = (sumAgg2._sum.amount ?? new Prisma.Decimal(0)).toDecimalPlaces(2);
                    const newStatus = totalPaid.greaterThanOrEqualTo(bill.total) ? 'PAID' : 'PARTIAL';
                    await tx.purchaseBill.update({
                        where: { id: bill.id },
                        data: { amountPaid: totalPaid, status: newStatus },
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
            }, redis));
            if (!replay) {
                const ok = await publishDomainEvent({
                    eventId: result._jeEventId,
                    eventType: 'journal.entry.created',
                    schemaVersion: 'v1',
                    occurredAt: result._occurredAt,
                    companyId,
                    partitionKey: String(companyId),
                    correlationId: result._correlationId,
                    aggregateType: 'JournalEntry',
                    aggregateId: String(result.journalEntryId),
                    source: 'cashflow-api',
                    payload: { journalEntryId: result.journalEntryId, companyId },
                });
                if (ok)
                    await markEventPublished(result._jeEventId);
            }
            return {
                purchaseBillId,
                purchaseBillPaymentId: result.purchaseBillPaymentId,
                journalEntryId: result.journalEntryId,
                status: result.status,
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
//# sourceMappingURL=purchaseBills.routes.js.map