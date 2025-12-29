import { Prisma, AccountType, BankingAccountKind } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../infrastructure/db.js';
import { getRedis } from '../../infrastructure/redis.js';
import { withLockBestEffort } from '../../infrastructure/locks.js';
import { runIdempotentRequest } from '../../infrastructure/commandIdempotency.js';
import { writeAuditLog } from '../../infrastructure/auditLog.js';
import { requireCompanyIdParam } from '../../utils/tenant.js';
import { isoNow, parseDateInput } from '../../utils/date.js';
import { toMoneyDecimal } from '../../utils/money.js';
import { requireAnyRole, Roles } from '../../utils/rbac.js';
import { postJournalEntry } from '../ledger/posting.service.js';
export async function customerAdvancesRoutes(fastify) {
    fastify.addHook('preHandler', fastify.authenticate);
    const redis = getRedis();
    // List customer advances (used by "Apply Credits" UI)
    // GET /companies/:companyId/customers/:customerId/customer-advances?onlyOpen=1
    fastify.get('/companies/:companyId/customers/:customerId/customer-advances', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const customerId = Number(request.params?.customerId);
        if (!customerId || Number.isNaN(customerId)) {
            reply.status(400);
            return { error: 'invalid customerId' };
        }
        const onlyOpen = String(request.query?.onlyOpen ?? '1') !== '0';
        const rows = await prisma.customerAdvance.findMany({
            where: {
                companyId,
                customerId,
            },
            include: {
                location: { select: { id: true, name: true } },
                bankAccount: { select: { id: true, code: true, name: true, type: true } },
                liabilityAccount: { select: { id: true, code: true, name: true, type: true } },
            },
            orderBy: [{ advanceDate: 'desc' }, { id: 'desc' }],
        });
        // Prisma can't filter by computed remaining easily; do it in JS
        const out = rows
            .map((a) => {
            const amount = new Prisma.Decimal(a.amount ?? 0).toDecimalPlaces(2);
            const applied = new Prisma.Decimal(a.amountApplied ?? 0).toDecimalPlaces(2);
            const remaining = amount.sub(applied).toDecimalPlaces(2);
            return {
                id: a.id,
                advanceDate: a.advanceDate,
                currency: a.currency ?? null,
                amount: amount.toString(),
                amountApplied: applied.toString(),
                remaining: remaining.toString(),
                receivedVia: a.receivedVia ?? null,
                reference: a.reference ?? null,
                description: a.description ?? null,
                location: a.location ? { id: a.location.id, name: a.location.name } : null,
                bankAccount: a.bankAccount ?? null,
                liabilityAccount: a.liabilityAccount ?? null,
                journalEntryId: a.journalEntryId ?? null,
                createdAt: a.createdAt,
            };
        })
            .filter((r) => !onlyOpen || Number(r.remaining) > 0);
        return out;
    });
    // Create customer advance (posts a JE)
    // POST /companies/:companyId/customer-advances
    fastify.post('/companies/:companyId/customer-advances', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const idempotencyKey = request.headers?.['idempotency-key'];
        if (!idempotencyKey) {
            reply.status(400);
            return { error: 'Idempotency-Key header is required' };
        }
        const body = (request.body ?? {});
        const customerId = Number(body.customerId);
        const locationId = Number(body.locationId ?? body.warehouseId);
        const bankAccountId = Number(body.bankAccountId);
        const liabilityAccountId = Number(body.liabilityAccountId);
        if (!customerId || Number.isNaN(customerId)) {
            reply.status(400);
            return { error: 'customerId is required' };
        }
        if (!locationId || Number.isNaN(locationId)) {
            reply.status(400);
            return { error: 'locationId is required' };
        }
        if (!bankAccountId || Number.isNaN(bankAccountId)) {
            reply.status(400);
            return { error: 'bankAccountId is required' };
        }
        if (!liabilityAccountId || Number.isNaN(liabilityAccountId)) {
            reply.status(400);
            return { error: 'liabilityAccountId is required' };
        }
        if (body.amount == null) {
            reply.status(400);
            return { error: 'amount is required' };
        }
        const amount = toMoneyDecimal(body.amount);
        if (amount.lessThanOrEqualTo(0)) {
            reply.status(400);
            return { error: 'amount must be > 0' };
        }
        const advanceDate = parseDateInput(body.advanceDate) ?? new Date();
        if (body.advanceDate && isNaN(advanceDate.getTime())) {
            reply.status(400);
            return { error: 'invalid advanceDate' };
        }
        const correlationId = randomUUID();
        const occurredAt = isoNow();
        const lockKey = `lock:customer-advance:create:${companyId}:${customerId}`;
        try {
            const { response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const txResult = await prisma.$transaction(async (tx) => {
                    const customer = await tx.customer.findFirst({ where: { id: customerId, companyId }, select: { id: true, name: true } });
                    if (!customer)
                        throw Object.assign(new Error('customer not found'), { statusCode: 404 });
                    const loc = await tx.location.findFirst({ where: { id: locationId, companyId }, select: { id: true, name: true } });
                    if (!loc)
                        throw Object.assign(new Error('location not found'), { statusCode: 404 });
                    const [bankAcc, liabAcc] = await Promise.all([
                        tx.account.findFirst({ where: { id: bankAccountId, companyId }, select: { id: true, type: true } }),
                        tx.account.findFirst({ where: { id: liabilityAccountId, companyId }, select: { id: true, type: true } }),
                    ]);
                    if (!bankAcc)
                        throw Object.assign(new Error('bankAccountId not found in this company'), { statusCode: 400 });
                    if (bankAcc.type !== AccountType.ASSET) {
                        throw Object.assign(new Error('bankAccountId must be an ASSET account'), { statusCode: 400 });
                    }
                    if (!liabAcc)
                        throw Object.assign(new Error('liabilityAccountId not found in this company'), { statusCode: 400 });
                    if (liabAcc.type !== AccountType.LIABILITY) {
                        throw Object.assign(new Error('liabilityAccountId must be a LIABILITY account'), { statusCode: 400 });
                    }
                    const receivedVia = body.receivedVia ?? null;
                    const reference = body.reference ? String(body.reference).trim() : null;
                    const descriptionRaw = body.description ? String(body.description).trim() : '';
                    const receivedViaLabel = receivedVia ? ` (${receivedVia.replace('_', '-')})` : '';
                    const description = `Customer advance • ${customer.name}${receivedViaLabel}${descriptionRaw ? ` — ${descriptionRaw}` : ''}`.trim();
                    const adv = await tx.customerAdvance.create({
                        data: {
                            companyId,
                            customerId,
                            locationId,
                            advanceDate,
                            currency: body.currency ?? null,
                            amount,
                            amountApplied: new Prisma.Decimal(0),
                            bankAccountId,
                            liabilityAccountId,
                            receivedVia,
                            reference,
                            description: descriptionRaw || null,
                            createdByUserId: request.user?.userId ?? null,
                        },
                    });
                    const je = await postJournalEntry(tx, {
                        companyId,
                        date: advanceDate,
                        description,
                        locationId,
                        createdByUserId: request.user?.userId ?? null,
                        lines: [
                            { accountId: bankAccountId, debit: amount, credit: new Prisma.Decimal(0) },
                            { accountId: liabilityAccountId, debit: new Prisma.Decimal(0), credit: amount },
                        ],
                        skipAccountValidation: true,
                    });
                    await tx.customerAdvance.updateMany({
                        where: { id: adv.id, companyId },
                        data: { journalEntryId: je.id },
                    });
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
                        action: 'customer_advance.create',
                        entityType: 'CustomerAdvance',
                        entityId: String(adv.id),
                        idempotencyKey,
                        correlationId,
                        metadata: {
                            customerId,
                            amount: amount.toString(),
                            advanceDate,
                            journalEntryId: je.id,
                            occurredAt,
                        },
                    });
                    return { customerAdvanceId: adv.id, journalEntryId: je.id };
                });
                return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
            }, redis));
            return {
                customerAdvanceId: result.customerAdvanceId,
                journalEntryId: result.journalEntryId,
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
    // Apply a customer advance to an invoice (posts a JE: Dr deposits / Cr AR)
    // POST /companies/:companyId/invoices/:invoiceId/apply-credits
    fastify.post('/companies/:companyId/invoices/:invoiceId/apply-credits', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const invoiceId = Number(request.params?.invoiceId);
        if (!invoiceId || Number.isNaN(invoiceId)) {
            reply.status(400);
            return { error: 'invalid invoiceId' };
        }
        const idempotencyKey = request.headers?.['idempotency-key'];
        if (!idempotencyKey) {
            reply.status(400);
            return { error: 'Idempotency-Key header is required' };
        }
        const body = (request.body ?? {});
        if (!body.customerAdvanceId || !body.amount || body.amount <= 0) {
            reply.status(400);
            return { error: 'customerAdvanceId and amount (>0) are required' };
        }
        const amount = toMoneyDecimal(body.amount);
        const appliedDate = parseDateInput(body.appliedDate) ?? new Date();
        if (body.appliedDate && isNaN(appliedDate.getTime())) {
            reply.status(400);
            return { error: 'invalid appliedDate' };
        }
        const correlationId = randomUUID();
        const occurredAt = isoNow();
        const lockKey = `lock:invoice:apply-customer-advance:${companyId}:${invoiceId}`;
        try {
            const { response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const txResult = await prisma.$transaction(async (tx) => {
                    await tx.$queryRaw `
              SELECT id FROM Invoice
              WHERE id = ${invoiceId} AND companyId = ${companyId}
              FOR UPDATE
            `;
                    const inv = await tx.invoice.findFirst({
                        where: { id: invoiceId, companyId },
                        select: { id: true, status: true, total: true, customerId: true, invoiceNumber: true, locationId: true },
                    });
                    if (!inv)
                        throw Object.assign(new Error('invoice not found'), { statusCode: 404 });
                    if (inv.status !== 'POSTED' && inv.status !== 'PARTIAL') {
                        throw Object.assign(new Error('credits can be applied only to POSTED or PARTIAL invoices'), { statusCode: 400 });
                    }
                    const company = await tx.company.findUnique({
                        where: { id: companyId },
                        select: { accountsReceivableAccountId: true },
                    });
                    const arId = company?.accountsReceivableAccountId ?? null;
                    if (!arId)
                        throw Object.assign(new Error('Company AR account is not configured'), { statusCode: 400 });
                    const adv = await tx.customerAdvance.findFirst({
                        where: { id: Number(body.customerAdvanceId), companyId },
                        select: {
                            id: true,
                            customerId: true,
                            amount: true,
                            amountApplied: true,
                            liabilityAccountId: true,
                        },
                    });
                    if (!adv)
                        throw Object.assign(new Error('customer advance not found'), { statusCode: 404 });
                    if (adv.customerId !== inv.customerId) {
                        throw Object.assign(new Error('customer advance customer does not match invoice customer'), { statusCode: 400 });
                    }
                    const remainingAdvance = new Prisma.Decimal(adv.amount).sub(new Prisma.Decimal(adv.amountApplied ?? 0)).toDecimalPlaces(2);
                    if (amount.greaterThan(remainingAdvance)) {
                        throw Object.assign(new Error(`amount cannot exceed remaining customer advance of ${remainingAdvance.toString()}`), { statusCode: 400 });
                    }
                    const paymentsAgg = await tx.payment.aggregate({
                        where: { invoiceId: inv.id, companyId, reversedAt: null },
                        _sum: { amount: true },
                    });
                    const paid = (paymentsAgg._sum.amount ?? new Prisma.Decimal(0)).toDecimalPlaces(2);
                    const creditsAgg = await tx.customerAdvanceApplication.aggregate({
                        where: { invoiceId: inv.id, companyId },
                        _sum: { amount: true },
                    });
                    const creditsAlready = (creditsAgg._sum.amount ?? new Prisma.Decimal(0)).toDecimalPlaces(2);
                    const settled = paid.add(creditsAlready).toDecimalPlaces(2);
                    const remainingInvoice = new Prisma.Decimal(inv.total).sub(settled).toDecimalPlaces(2);
                    if (amount.greaterThan(remainingInvoice)) {
                        throw Object.assign(new Error(`amount cannot exceed remaining invoice balance of ${remainingInvoice.toString()}`), { statusCode: 400 });
                    }
                    // Create JE: Dr deposits (liability), Cr AR
                    const je = await postJournalEntry(tx, {
                        companyId,
                        date: appliedDate,
                        description: `Apply customer advance to ${inv.invoiceNumber}`,
                        locationId: inv.locationId ?? null,
                        createdByUserId: request.user?.userId ?? null,
                        lines: [
                            { accountId: adv.liabilityAccountId, debit: amount, credit: new Prisma.Decimal(0) },
                            { accountId: arId, debit: new Prisma.Decimal(0), credit: amount },
                        ],
                        skipAccountValidation: false,
                    });
                    const app = await tx.customerAdvanceApplication.create({
                        data: {
                            companyId,
                            customerAdvanceId: adv.id,
                            invoiceId: inv.id,
                            appliedDate,
                            amount,
                            journalEntryId: je.id,
                            createdByUserId: request.user?.userId ?? null,
                        },
                    });
                    const newApplied = new Prisma.Decimal(adv.amountApplied ?? 0).add(amount).toDecimalPlaces(2);
                    await tx.customerAdvance.updateMany({
                        where: { id: adv.id, companyId },
                        data: { amountApplied: newApplied },
                    });
                    const newCredits = creditsAlready.add(amount).toDecimalPlaces(2);
                    const newSettled = paid.add(newCredits).toDecimalPlaces(2);
                    const newStatus = newSettled.greaterThanOrEqualTo(inv.total) ? 'PAID' : 'PARTIAL';
                    await tx.invoice.updateMany({
                        where: { id: inv.id, companyId },
                        data: { amountPaid: newSettled, status: newStatus },
                    });
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
                        action: 'invoice.customer_advance.apply',
                        entityType: 'CustomerAdvanceApplication',
                        entityId: String(app.id),
                        idempotencyKey,
                        correlationId,
                        metadata: {
                            invoiceId: inv.id,
                            invoiceNumber: inv.invoiceNumber,
                            customerAdvanceId: adv.id,
                            amount: amount.toString(),
                            appliedDate,
                            journalEntryId: je.id,
                            newStatus,
                            occurredAt,
                        },
                    });
                    return { invoiceId: inv.id, customerAdvanceApplicationId: app.id, journalEntryId: je.id, status: newStatus };
                });
                return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
            }, redis));
            return {
                invoiceId: result.invoiceId,
                customerAdvanceApplicationId: result.customerAdvanceApplicationId,
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
//# sourceMappingURL=customerAdvances.routes.js.map