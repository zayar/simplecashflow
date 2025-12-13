import Fastify from 'fastify';
import { PrismaClient, AccountType, Prisma, ItemType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PubSub } from '@google-cloud/pubsub';
const pubsub = new PubSub();
const PUBSUB_TOPIC = process.env.PUBSUB_TOPIC || 'cashflow-events';
const fastify = Fastify({ logger: true });
const prisma = new PrismaClient();
function parseCompanyId(params) {
    const raw = params?.companyId;
    const n = Number(raw);
    if (!raw || Number.isNaN(n))
        return null;
    return n;
}
function isoNow() {
    return new Date().toISOString();
}
function toMoneyDecimal(value) {
    // Use Decimal for money to avoid floating point drift.
    // We round to 2 decimals because our DB columns are Decimal(18,2).
    return new Prisma.Decimal(Number(value).toFixed(2));
}
function generateInvoiceNumber() {
    // Beginner-friendly and “good enough” for now.
    // Later we can make this per-company sequential numbers (INV-0001).
    return `INV-${Date.now()}`;
}
async function publishDomainEvent(event) {
    try {
        const dataBuffer = Buffer.from(JSON.stringify(event));
        const attributes = {
            eventId: event.eventId,
            eventType: event.eventType,
            companyId: event.companyId.toString(),
            schemaVersion: event.schemaVersion,
            correlationId: event.correlationId,
            aggregateType: event.aggregateType,
            aggregateId: event.aggregateId,
        };
        await pubsub.topic(PUBSUB_TOPIC).publishMessage({
            data: dataBuffer,
            attributes,
            orderingKey: event.partitionKey,
        });
        return true;
    }
    catch (err) {
        console.error('Failed to publish Pub/Sub event', err);
        return false;
    }
}
async function markEventPublished(eventId) {
    try {
        await prisma.event.update({
            where: { eventId },
            data: {
                publishedAt: new Date(),
                nextPublishAttemptAt: null,
                lastPublishError: null,
            },
        });
    }
    catch (err) {
        // If this fails, the publisher will re-send later; consumers are idempotent.
        console.error('Failed to mark event as published', { eventId, err });
    }
}
// Health check
fastify.get('/health', async () => {
    return { status: 'ok' };
});
// List companies
fastify.get('/companies', async () => {
    const companies = await prisma.company.findMany();
    return companies;
});
// --- Company settings (Books layer) ---
// This is intentionally minimal for now: it lets you configure default Accounts Receivable (AR).
// AR is used when posting invoices (Invoice POSTED => Debit AR).
fastify.get('/companies/:companyId/settings', async (request, reply) => {
    const companyId = parseCompanyId(request.params);
    if (!companyId) {
        reply.status(400);
        return { error: 'invalid companyId' };
    }
    const company = await prisma.company.findUnique({
        where: { id: companyId },
        include: {
            accountsReceivableAccount: true,
        },
    });
    if (!company) {
        reply.status(404);
        return { error: 'company not found' };
    }
    return {
        companyId: company.id,
        name: company.name,
        accountsReceivableAccountId: company.accountsReceivableAccountId,
        accountsReceivableAccount: company.accountsReceivableAccount
            ? {
                id: company.accountsReceivableAccount.id,
                code: company.accountsReceivableAccount.code,
                name: company.accountsReceivableAccount.name,
                type: company.accountsReceivableAccount.type,
            }
            : null,
    };
});
// Update settings. Body supports:
// - accountsReceivableAccountId: number (set)
// - accountsReceivableAccountId: null (clear)
fastify.put('/companies/:companyId/settings', async (request, reply) => {
    const companyId = parseCompanyId(request.params);
    if (!companyId) {
        reply.status(400);
        return { error: 'invalid companyId' };
    }
    const body = request.body;
    // If field is absent, do nothing (beginner-friendly, avoids accidental wipes).
    if (!('accountsReceivableAccountId' in body)) {
        reply.status(400);
        return { error: 'accountsReceivableAccountId is required (number or null)' };
    }
    // Ensure company exists (tenant-safe)
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) {
        reply.status(404);
        return { error: 'company not found' };
    }
    // Validate AR account if setting
    if (body.accountsReceivableAccountId !== null) {
        const arId = body.accountsReceivableAccountId;
        if (!arId || Number.isNaN(Number(arId))) {
            reply.status(400);
            return { error: 'accountsReceivableAccountId must be a valid number or null' };
        }
        // AR must be an ASSET account in this company.
        const arAccount = await prisma.account.findFirst({
            where: { id: arId, companyId, type: AccountType.ASSET },
        });
        if (!arAccount) {
            reply.status(400);
            return { error: 'accountsReceivableAccountId must be an ASSET account in this company' };
        }
    }
    const updated = await prisma.company.update({
        where: { id: companyId },
        data: {
            accountsReceivableAccountId: body.accountsReceivableAccountId,
        },
        include: {
            accountsReceivableAccount: true,
        },
    });
    return {
        companyId: updated.id,
        name: updated.name,
        accountsReceivableAccountId: updated.accountsReceivableAccountId,
        accountsReceivableAccount: updated.accountsReceivableAccount
            ? {
                id: updated.accountsReceivableAccount.id,
                code: updated.accountsReceivableAccount.code,
                name: updated.accountsReceivableAccount.name,
                type: updated.accountsReceivableAccount.type,
            }
            : null,
    };
});
// Create company
fastify.post('/companies', async (request, reply) => {
    const body = request.body;
    if (!body.name) {
        reply.status(400);
        return { error: 'name is required' };
    }
    const company = await prisma.company.create({
        data: {
            name: body.name,
            accounts: {
                create: DEFAULT_ACCOUNTS.map((acc) => ({
                    code: acc.code,
                    name: acc.name,
                    type: acc.type,
                })),
            },
        },
        include: { accounts: true },
    });
    return company;
});
// --- Account APIs ---
// List accounts for a company
fastify.get('/companies/:companyId/accounts', async (request, reply) => {
    const { companyId } = request.params;
    const query = request.query;
    const accounts = await prisma.account.findMany({
        where: {
            companyId: Number(companyId),
            ...(query.type ? { type: query.type } : {}),
        },
        orderBy: { code: 'asc' },
    });
    return accounts;
});
// --- Books: Customers ---
fastify.get('/companies/:companyId/customers', async (request, reply) => {
    const companyId = parseCompanyId(request.params);
    if (!companyId) {
        reply.status(400);
        return { error: 'invalid companyId' };
    }
    return await prisma.customer.findMany({
        where: { companyId },
        orderBy: { createdAt: 'desc' },
    });
});
fastify.post('/companies/:companyId/customers', async (request, reply) => {
    const companyId = parseCompanyId(request.params);
    if (!companyId) {
        reply.status(400);
        return { error: 'invalid companyId' };
    }
    const body = request.body;
    if (!body.name) {
        reply.status(400);
        return { error: 'name is required' };
    }
    const customer = await prisma.customer.create({
        data: {
            companyId,
            name: body.name,
            email: body.email ?? null,
            phone: body.phone ?? null,
            currency: body.currency ?? null,
            openingBalance: body.openingBalance === undefined ? null : toMoneyDecimal(body.openingBalance),
        },
    });
    return customer;
});
// --- Books: Items ---
fastify.get('/companies/:companyId/items', async (request, reply) => {
    const companyId = parseCompanyId(request.params);
    if (!companyId) {
        reply.status(400);
        return { error: 'invalid companyId' };
    }
    return await prisma.item.findMany({
        where: { companyId },
        orderBy: { createdAt: 'desc' },
        include: {
            incomeAccount: true,
            expenseAccount: true,
        },
    });
});
fastify.post('/companies/:companyId/items', async (request, reply) => {
    const companyId = parseCompanyId(request.params);
    if (!companyId) {
        reply.status(400);
        return { error: 'invalid companyId' };
    }
    const body = request.body;
    if (!body.name || !body.type || body.sellingPrice === undefined || !body.incomeAccountId) {
        reply.status(400);
        return { error: 'name, type, sellingPrice, incomeAccountId are required' };
    }
    // Tenant-safe validation: incomeAccount must belong to same company and be INCOME.
    const incomeAccount = await prisma.account.findFirst({
        where: { id: body.incomeAccountId, companyId, type: AccountType.INCOME },
    });
    if (!incomeAccount) {
        reply.status(400);
        return { error: 'incomeAccountId must be an INCOME account in this company' };
    }
    if (body.expenseAccountId) {
        const expenseAccount = await prisma.account.findFirst({
            where: { id: body.expenseAccountId, companyId, type: AccountType.EXPENSE },
        });
        if (!expenseAccount) {
            reply.status(400);
            return { error: 'expenseAccountId must be an EXPENSE account in this company' };
        }
    }
    const item = await prisma.item.create({
        data: {
            companyId,
            name: body.name,
            sku: body.sku ?? null,
            type: body.type,
            sellingPrice: toMoneyDecimal(body.sellingPrice),
            costPrice: body.costPrice === undefined ? null : toMoneyDecimal(body.costPrice),
            incomeAccountId: body.incomeAccountId,
            expenseAccountId: body.expenseAccountId ?? null,
        },
        include: {
            incomeAccount: true,
            expenseAccount: true,
        },
    });
    return item;
});
// --- Books: Invoices (DRAFT) ---
fastify.get('/companies/:companyId/invoices', async (request, reply) => {
    const companyId = parseCompanyId(request.params);
    if (!companyId) {
        reply.status(400);
        return { error: 'invalid companyId' };
    }
    const invoices = await prisma.invoice.findMany({
        where: { companyId },
        orderBy: { invoiceDate: 'desc' },
        include: { customer: true },
    });
    // Keep response simple and UI-friendly.
    return invoices.map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        customerName: inv.customer.name,
        status: inv.status,
        total: inv.total,
        invoiceDate: inv.invoiceDate,
        dueDate: inv.dueDate,
        createdAt: inv.createdAt,
    }));
});
fastify.post('/companies/:companyId/invoices', async (request, reply) => {
    const companyId = parseCompanyId(request.params);
    if (!companyId) {
        reply.status(400);
        return { error: 'invalid companyId' };
    }
    const body = request.body;
    if (!body.customerId || !body.lines || body.lines.length === 0) {
        reply.status(400);
        return { error: 'customerId and at least one line are required' };
    }
    // Validate customer belongs to company (tenant-safe).
    const customer = await prisma.customer.findFirst({
        where: { id: body.customerId, companyId },
    });
    if (!customer) {
        reply.status(400);
        return { error: 'customerId not found in this company' };
    }
    // Validate and load items (tenant-safe).
    const itemIds = body.lines.map((l) => l.itemId);
    const items = await prisma.item.findMany({
        where: { companyId, id: { in: itemIds } },
    });
    const itemById = new Map(items.map((i) => [i.id, i]));
    for (const line of body.lines) {
        if (!line.quantity || line.quantity <= 0) {
            reply.status(400);
            return { error: 'each line must have quantity > 0' };
        }
        if (!itemById.get(line.itemId)) {
            reply.status(400);
            return { error: `itemId ${line.itemId} not found in this company` };
        }
    }
    const invoiceDate = body.invoiceDate ? new Date(body.invoiceDate) : new Date();
    const dueDate = body.dueDate ? new Date(body.dueDate) : null;
    // Compute totals using Decimal (money-safe).
    let total = new Prisma.Decimal(0);
    const computedLines = body.lines.map((line) => {
        const item = itemById.get(line.itemId);
        const qty = toMoneyDecimal(line.quantity);
        const unit = toMoneyDecimal(line.unitPrice ?? Number(item.sellingPrice));
        const lineTotal = qty.mul(unit).toDecimalPlaces(2);
        total = total.add(lineTotal);
        return {
            itemId: item.id,
            description: line.description ?? null,
            quantity: qty,
            unitPrice: unit,
            lineTotal,
        };
    });
    const invoice = await prisma.invoice.create({
        data: {
            companyId,
            customerId: customer.id,
            invoiceNumber: generateInvoiceNumber(),
            status: 'DRAFT',
            invoiceDate,
            dueDate,
            currency: body.currency ?? customer.currency ?? null,
            total: total.toDecimalPlaces(2), // stored but will be recomputed when posted
            lines: { create: computedLines },
        },
        include: {
            customer: true,
            lines: { include: { item: true } },
        },
    });
    return invoice;
});
// POST (confirm) an invoice: DRAFT -> POSTED creates journal entry
fastify.post('/companies/:companyId/invoices/:invoiceId/post', async (request, reply) => {
    const companyId = parseCompanyId(request.params);
    const invoiceId = Number(request.params?.invoiceId);
    if (!companyId || Number.isNaN(invoiceId)) {
        reply.status(400);
        return { error: 'invalid companyId or invoiceId' };
    }
    const correlationId = randomUUID(); // one correlationId for the whole posting transaction
    const occurredAt = isoNow();
    const result = await prisma.$transaction(async (tx) => {
        const invoice = await tx.invoice.findFirst({
            where: { id: invoiceId, companyId },
            include: {
                company: true,
                customer: true,
                lines: { include: { item: true } },
            },
        });
        if (!invoice) {
            throw Object.assign(new Error('invoice not found'), { statusCode: 404 });
        }
        if (invoice.status !== 'DRAFT') {
            throw Object.assign(new Error('only DRAFT invoices can be posted'), { statusCode: 400 });
        }
        if (!invoice.company.accountsReceivableAccountId) {
            throw Object.assign(new Error('company.accountsReceivableAccountId is not set'), {
                statusCode: 400,
            });
        }
        // Validate AR account belongs to this company and is an ASSET (Accounts Receivable).
        const arAccount = await tx.account.findFirst({
            where: {
                id: invoice.company.accountsReceivableAccountId,
                companyId,
                type: AccountType.ASSET,
            },
        });
        if (!arAccount) {
            throw Object.assign(new Error('accountsReceivableAccountId must be an ASSET account in this company'), {
                statusCode: 400,
            });
        }
        // Recompute totals from stored lines (source of truth).
        let total = new Prisma.Decimal(0);
        const incomeBuckets = new Map();
        for (const line of invoice.lines) {
            // lineTotal is already stored, but recompute to be safe.
            const qty = new Prisma.Decimal(line.quantity);
            const unit = new Prisma.Decimal(line.unitPrice);
            const lineTotal = qty.mul(unit).toDecimalPlaces(2);
            total = total.add(lineTotal);
            const incomeAccountId = line.item.incomeAccountId;
            const prev = incomeBuckets.get(incomeAccountId) ?? new Prisma.Decimal(0);
            incomeBuckets.set(incomeAccountId, prev.add(lineTotal));
        }
        total = total.toDecimalPlaces(2);
        // Create JournalEntry for posting invoice:
        // Debit  Accounts Receivable (AR)
        // Credit Sales Income (grouped by incomeAccountId)
        const journalEntry = await tx.journalEntry.create({
            data: {
                companyId,
                date: invoice.invoiceDate,
                description: `Invoice ${invoice.invoiceNumber} for ${invoice.customer.name}`,
                lines: {
                    create: [
                        {
                            accountId: arAccount.id,
                            debit: total,
                            credit: new Prisma.Decimal(0),
                        },
                        ...Array.from(incomeBuckets.entries()).map(([incomeAccountId, amount]) => ({
                            accountId: incomeAccountId,
                            debit: new Prisma.Decimal(0),
                            credit: amount.toDecimalPlaces(2),
                        })),
                    ],
                },
            },
            include: { lines: true },
        });
        // Update invoice to POSTED and link journal entry.
        const updatedInvoice = await tx.invoice.update({
            where: { id: invoice.id },
            data: {
                status: 'POSTED',
                total,
                journalEntryId: journalEntry.id,
            },
        });
        // --- Event 1: journal.entry.created (keeps existing projections like DailySummary working) ---
        const jeEventId = randomUUID();
        const totalDebit = Number(total);
        const totalCredit = Number(total);
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
                aggregateId: String(journalEntry.id),
                type: 'JournalEntryCreated',
                payload: {
                    journalEntryId: journalEntry.id,
                    companyId,
                    totalDebit,
                    totalCredit,
                },
            },
        });
        // --- Event 2: invoice.posted (document-level event) ---
        const invoiceEventId = randomUUID();
        await tx.event.create({
            data: {
                companyId,
                eventId: invoiceEventId,
                eventType: 'invoice.posted',
                schemaVersion: 'v1',
                occurredAt: new Date(occurredAt),
                source: 'cashflow-api',
                partitionKey: String(companyId),
                correlationId,
                aggregateType: 'Invoice',
                aggregateId: String(invoice.id),
                type: 'InvoicePosted',
                payload: {
                    invoiceId: invoice.id,
                    journalEntryId: journalEntry.id,
                    total: total.toString(),
                    customerId: invoice.customerId,
                },
            },
        });
        return { updatedInvoice, journalEntry, jeEventId, invoiceEventId, totalDebit, totalCredit };
    });
    // Publish events (outside txn). If publish fails, outbox publisher will deliver later.
    const publishJeOk = await publishDomainEvent({
        eventId: result.jeEventId,
        eventType: 'journal.entry.created',
        schemaVersion: 'v1',
        occurredAt,
        companyId,
        partitionKey: String(companyId),
        correlationId,
        aggregateType: 'JournalEntry',
        aggregateId: String(result.journalEntry.id),
        source: 'cashflow-api',
        payload: {
            journalEntryId: result.journalEntry.id,
            companyId,
            totalDebit: result.totalDebit,
            totalCredit: result.totalCredit,
        },
    });
    if (publishJeOk)
        await markEventPublished(result.jeEventId);
    const publishInvoiceOk = await publishDomainEvent({
        eventId: result.invoiceEventId,
        eventType: 'invoice.posted',
        schemaVersion: 'v1',
        occurredAt,
        companyId,
        partitionKey: String(companyId),
        correlationId,
        aggregateType: 'Invoice',
        aggregateId: String(result.updatedInvoice.id),
        source: 'cashflow-api',
        payload: {
            invoiceId: result.updatedInvoice.id,
            journalEntryId: result.journalEntry.id,
            total: result.updatedInvoice.total,
            customerId: result.updatedInvoice.customerId,
        },
    });
    if (publishInvoiceOk)
        await markEventPublished(result.invoiceEventId);
    return {
        invoiceId: result.updatedInvoice.id,
        status: result.updatedInvoice.status,
        total: result.updatedInvoice.total,
        journalEntryId: result.updatedInvoice.journalEntryId,
    };
});
// Payments: record and post to ledger (Bank/Cash Dr, AR Cr)
fastify.post('/companies/:companyId/invoices/:invoiceId/payments', async (request, reply) => {
    const companyId = parseCompanyId(request.params);
    const invoiceId = Number(request.params?.invoiceId);
    if (!companyId || Number.isNaN(invoiceId)) {
        reply.status(400);
        return { error: 'invalid companyId or invoiceId' };
    }
    const body = request.body;
    if (!body.amount || body.amount <= 0 || !body.bankAccountId) {
        reply.status(400);
        return { error: 'amount (>0) and bankAccountId are required' };
    }
    // After validation, treat amount as a required number.
    const amountNumber = body.amount;
    const occurredAt = isoNow();
    const correlationId = randomUUID();
    try {
        const result = await prisma.$transaction(async (tx) => {
            const invoice = await tx.invoice.findFirst({
                where: { id: invoiceId, companyId },
                include: { company: true },
            });
            if (!invoice) {
                throw Object.assign(new Error('invoice not found'), { statusCode: 404 });
            }
            if (invoice.status === 'DRAFT') {
                throw Object.assign(new Error('cannot record payment for DRAFT invoice'), {
                    statusCode: 400,
                });
            }
            if (invoice.status !== 'POSTED' && invoice.status !== 'PARTIAL') {
                throw Object.assign(new Error('payments allowed only for POSTED or PARTIAL invoices'), {
                    statusCode: 400,
                });
            }
            if (!invoice.company.accountsReceivableAccountId) {
                throw Object.assign(new Error('company.accountsReceivableAccountId is not set'), {
                    statusCode: 400,
                });
            }
            const arAccount = await tx.account.findFirst({
                where: {
                    id: invoice.company.accountsReceivableAccountId,
                    companyId,
                    type: AccountType.ASSET,
                },
            });
            if (!arAccount) {
                throw Object.assign(new Error('accountsReceivableAccountId must be an ASSET account in this company'), {
                    statusCode: 400,
                });
            }
            const bankAccount = await tx.account.findFirst({
                where: { id: body.bankAccountId, companyId, type: AccountType.ASSET },
            });
            if (!bankAccount) {
                throw Object.assign(new Error('bankAccountId must be an ASSET account in this company'), {
                    statusCode: 400,
                });
            }
            const paymentDate = body.paymentDate ? new Date(body.paymentDate) : new Date();
            const amount = toMoneyDecimal(amountNumber);
            const payment = await tx.payment.create({
                data: {
                    companyId,
                    invoiceId: invoice.id,
                    paymentDate,
                    amount,
                    bankAccountId: bankAccount.id,
                },
            });
            const journalEntry = await tx.journalEntry.create({
                data: {
                    companyId,
                    date: paymentDate,
                    description: `Payment for Invoice ${invoice.invoiceNumber}`,
                    lines: {
                        create: [
                            // Debit Bank/Cash
                            { accountId: bankAccount.id, debit: amount, credit: new Prisma.Decimal(0) },
                            // Credit Accounts Receivable
                            { accountId: arAccount.id, debit: new Prisma.Decimal(0), credit: amount },
                        ],
                    },
                },
            });
            const updatedPayment = await tx.payment.update({
                where: { id: payment.id },
                data: { journalEntryId: journalEntry.id },
            });
            // Update invoice status based on total paid vs invoice total.
            const sumAgg = await tx.payment.aggregate({
                where: { invoiceId: invoice.id, companyId },
                _sum: { amount: true },
            });
            const totalPaid = sumAgg._sum.amount ?? new Prisma.Decimal(0);
            const newStatus = totalPaid.greaterThanOrEqualTo(invoice.total) ? 'PAID' : 'PARTIAL';
            const updatedInvoice = await tx.invoice.update({
                where: { id: invoice.id },
                data: { status: newStatus },
            });
            // Event: journal.entry.created (for consistency; no income/expense impact but still a JE)
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
                    aggregateId: String(journalEntry.id),
                    type: 'JournalEntryCreated',
                    payload: {
                        journalEntryId: journalEntry.id,
                        companyId,
                        totalDebit: Number(amountNumber),
                        totalCredit: Number(amountNumber),
                    },
                },
            });
            // Event: payment.recorded (document-level)
            const paymentEventId = randomUUID();
            await tx.event.create({
                data: {
                    companyId,
                    eventId: paymentEventId,
                    eventType: 'payment.recorded',
                    schemaVersion: 'v1',
                    occurredAt: new Date(occurredAt),
                    source: 'cashflow-api',
                    partitionKey: String(companyId),
                    correlationId,
                    aggregateType: 'Payment',
                    aggregateId: String(updatedPayment.id),
                    type: 'PaymentRecorded',
                    payload: {
                        paymentId: updatedPayment.id,
                        invoiceId: invoice.id,
                        journalEntryId: journalEntry.id,
                        amount: amount.toString(),
                        bankAccountId: bankAccount.id,
                    },
                },
            });
            return { updatedInvoice, updatedPayment, journalEntry, jeEventId, paymentEventId };
        });
        const publishPaymentJeOk = await publishDomainEvent({
            eventId: result.jeEventId,
            eventType: 'journal.entry.created',
            schemaVersion: 'v1',
            occurredAt,
            companyId,
            partitionKey: String(companyId),
            correlationId,
            aggregateType: 'JournalEntry',
            aggregateId: String(result.journalEntry.id),
            source: 'cashflow-api',
            payload: {
                journalEntryId: result.journalEntry.id,
                companyId,
            },
        });
        if (publishPaymentJeOk)
            await markEventPublished(result.jeEventId);
        const publishPaymentOk = await publishDomainEvent({
            eventId: result.paymentEventId,
            eventType: 'payment.recorded',
            schemaVersion: 'v1',
            occurredAt,
            companyId,
            partitionKey: String(companyId),
            correlationId,
            aggregateType: 'Payment',
            aggregateId: String(result.updatedPayment.id),
            source: 'cashflow-api',
            payload: {
                paymentId: result.updatedPayment.id,
                invoiceId: result.updatedPayment.invoiceId,
                journalEntryId: result.updatedPayment.journalEntryId,
                amount: result.updatedPayment.amount,
                bankAccountId: result.updatedPayment.bankAccountId,
            },
        });
        if (publishPaymentOk)
            await markEventPublished(result.paymentEventId);
        return {
            invoiceId: result.updatedInvoice.id,
            invoiceStatus: result.updatedInvoice.status,
            paymentId: result.updatedPayment.id,
            journalEntryId: result.updatedPayment.journalEntryId,
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
// Create an account
fastify.post('/accounts', async (request, reply) => {
    const body = request.body;
    if (!body.companyId || !body.code || !body.name || !body.type) {
        reply.status(400);
        return { error: 'companyId, code, name, type are required' };
    }
    const account = await prisma.account.create({
        data: {
            companyId: body.companyId,
            code: body.code,
            name: body.name,
            type: body.type,
        },
    });
    return account;
});
// --- Journal Entry API (with debit = credit check) ---
fastify.post('/journal-entries', async (request, reply) => {
    const body = request.body;
    if (!body.companyId || !body.lines || body.lines.length === 0) {
        reply.status(400);
        return { error: 'companyId and at least one line are required' };
    }
    let totalDebit = 0;
    let totalCredit = 0;
    for (const line of body.lines) {
        if (!line.accountId) {
            reply.status(400);
            return { error: 'each line needs accountId' };
        }
        const debit = line.debit ?? 0;
        const credit = line.credit ?? 0;
        if (debit < 0 || credit < 0) {
            reply.status(400);
            return { error: 'debit/credit cannot be negative' };
        }
        if (debit > 0 && credit > 0) {
            reply.status(400);
            return { error: 'line cannot have both debit and credit > 0' };
        }
        totalDebit += debit;
        totalCredit += credit;
    }
    if (totalDebit === 0 && totalCredit === 0) {
        reply.status(400);
        return { error: 'total debit and credit cannot both be zero' };
    }
    if (totalDebit !== totalCredit) {
        reply.status(400);
        return {
            error: 'debits and credits must be equal',
            totalDebit,
            totalCredit,
        };
    }
    const date = body.date ? new Date(body.date) : new Date();
    // Prepare event data
    const eventId = randomUUID();
    const correlationId = eventId; // Step 1 default: correlationId = first eventId in workflow
    const occurredAt = new Date().toISOString();
    const eventType = 'journal.entry.created';
    const schemaVersion = 'v1';
    const source = 'cashflow-api';
    // Wrap in a transaction so entry + event are consistent
    const result = await prisma.$transaction(async (tx) => {
        const entry = await tx.journalEntry.create({
            data: {
                companyId: body.companyId,
                date,
                description: body.description ?? '',
                lines: {
                    create: (body.lines ?? []).map((line) => ({
                        accountId: line.accountId,
                        debit: line.debit ?? 0,
                        credit: line.credit ?? 0,
                    })),
                },
            },
            include: { lines: true },
        });
        await tx.event.create({
            data: {
                companyId: body.companyId,
                eventId,
                eventType,
                schemaVersion,
                occurredAt: new Date(occurredAt),
                source,
                partitionKey: String(body.companyId),
                correlationId,
                aggregateType: 'JournalEntry',
                aggregateId: String(entry.id),
                type: 'JournalEntryCreated', // Legacy field, keeping for now
                payload: {
                    journalEntryId: entry.id,
                    companyId: body.companyId,
                    totalDebit,
                    totalCredit,
                },
            },
        });
        return entry;
    });
    const envelope = {
        eventId,
        eventType,
        schemaVersion,
        occurredAt,
        companyId: body.companyId,
        partitionKey: String(body.companyId),
        correlationId,
        aggregateType: 'JournalEntry',
        aggregateId: String(result.id),
        source,
        payload: {
            journalEntryId: result.id,
            companyId: body.companyId,
            totalDebit,
            totalCredit,
        },
    };
    const published = await publishDomainEvent(envelope);
    if (published) {
        await markEventPublished(eventId);
    }
    return result;
});
// --- Piti integration: simple cash sale ---
// This simulates Piti sending a sale event to the ledger.
fastify.post('/integrations/piti/sale', async (request, reply) => {
    const body = request.body;
    if (!body.companyId || !body.amount || body.amount <= 0) {
        reply.status(400);
        return { error: 'companyId and positive amount are required' };
    }
    const companyId = body.companyId;
    const amount = body.amount;
    // For now we assume:
    //   Cash account code = 1000
    //   Sales Income code = 4000
    const cashAccount = await prisma.account.findFirst({
        where: { companyId, code: '1000' },
    });
    const salesAccount = await prisma.account.findFirst({
        where: { companyId, code: '4000' },
    });
    if (!cashAccount || !salesAccount) {
        reply.status(400);
        return {
            error: 'Required accounts not found (need code 1000 and 4000)',
        };
    }
    const date = new Date();
    // Prepare event data
    const eventId = randomUUID();
    const correlationId = eventId;
    const occurredAt = new Date().toISOString();
    const eventType = 'integration.piti.sale.imported'; // Canonical dot-delimited name
    const schemaVersion = 'v1';
    const source = 'integration:piti';
    const entry = await prisma.$transaction(async (tx) => {
        const journalEntry = await tx.journalEntry.create({
            data: {
                companyId,
                date,
                description: body.description ?? 'Piti sale',
                lines: {
                    create: [
                        {
                            accountId: cashAccount.id,
                            debit: amount,
                            credit: 0,
                        },
                        {
                            accountId: salesAccount.id,
                            debit: 0,
                            credit: amount,
                        },
                    ],
                },
            },
            include: { lines: true },
        });
        await tx.event.create({
            data: {
                companyId,
                eventId,
                eventType,
                schemaVersion,
                occurredAt: new Date(occurredAt),
                source,
                partitionKey: String(companyId),
                correlationId,
                aggregateType: 'JournalEntry',
                aggregateId: String(journalEntry.id),
                type: 'PitiSaleImported', // Legacy field
                payload: {
                    journalEntryId: journalEntry.id,
                    amount,
                },
            },
        });
        return journalEntry;
    });
    const envelope = {
        eventId,
        eventType,
        schemaVersion,
        occurredAt,
        companyId,
        partitionKey: String(companyId),
        correlationId,
        aggregateType: 'JournalEntry',
        aggregateId: String(entry.id),
        source,
        payload: {
            journalEntryId: entry.id,
            amount,
        },
    };
    const published = await publishDomainEvent(envelope);
    if (published) {
        await markEventPublished(eventId);
    }
    return entry;
});
// --- Simple Profit & Loss report ---
// Example: GET /reports/pnl?companyId=2&from=2025-12-01&to=2025-12-31
fastify.get('/reports/pnl', async (request, reply) => {
    const query = request.query;
    if (!query.companyId || !query.from || !query.to) {
        reply.status(400);
        return { error: 'companyId, from, to are required (YYYY-MM-DD)' };
    }
    const companyId = Number(query.companyId);
    const fromDate = new Date(query.from);
    const toDate = new Date(query.to);
    if (Number.isNaN(companyId) || isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
        reply.status(400);
        return { error: 'Invalid companyId or dates' };
    }
    // Include all entries where date >= from AND date <= to (end of day)
    toDate.setHours(23, 59, 59, 999);
    const lines = await prisma.journalLine.findMany({
        where: {
            journalEntry: {
                companyId,
                date: {
                    gte: fromDate,
                    lte: toDate,
                },
            },
        },
        include: {
            account: true,
        },
    });
    const income = {};
    const expense = {};
    for (const line of lines) {
        const acc = line.account;
        if (acc.type === 'INCOME') {
            // For income accounts: credit increases income, debit decreases income
            const delta = Number(line.credit) - Number(line.debit);
            if (!income[acc.code]) {
                income[acc.code] = { code: acc.code, name: acc.name, amount: 0 };
            }
            income[acc.code].amount += delta;
        }
        if (acc.type === 'EXPENSE') {
            // For expense accounts: debit increases expense, credit decreases expense
            const delta = Number(line.debit) - Number(line.credit);
            if (!expense[acc.code]) {
                expense[acc.code] = { code: acc.code, name: acc.name, amount: 0 };
            }
            expense[acc.code].amount += delta;
        }
    }
    const incomeAccounts = Object.values(income);
    const expenseAccounts = Object.values(expense);
    const totalIncome = incomeAccounts.reduce((sum, a) => sum + a.amount, 0);
    const totalExpense = expenseAccounts.reduce((sum, a) => sum + a.amount, 0);
    const netProfit = totalIncome - totalExpense;
    return {
        companyId,
        from: query.from,
        to: query.to,
        totalIncome,
        totalExpense,
        netProfit,
        incomeAccounts,
        expenseAccounts,
    };
});
const start = async () => {
    try {
        const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
        await fastify.listen({ port, host: '0.0.0.0' });
        console.log(`Server running on http://localhost:${port}`);
    }
    catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};
const DEFAULT_ACCOUNTS = [
    { code: "1000", name: "Cash", type: "ASSET" },
    { code: "1010", name: "Bank", type: "ASSET" },
    { code: "2000", name: "Accounts Payable", type: "LIABILITY" },
    { code: "3000", name: "Owner Equity", type: "EQUITY" },
    { code: "4000", name: "Sales Income", type: "INCOME" },
    { code: "5000", name: "General Expense", type: "EXPENSE" },
];
start();
//# sourceMappingURL=index.js.map