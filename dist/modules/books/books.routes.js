import { prisma } from '../../infrastructure/db.js';
import { toMoneyDecimal } from '../../utils/money.js';
import { isoNow, parseDateInput } from '../../utils/date.js';
import { isFutureBusinessDate } from '../../utils/docDatePolicy.js';
import { assertTotalsMatchStored, buildInvoicePostingJournalLines, computeInvoiceTotalsAndIncomeBuckets } from './invoiceAccounting.js';
import { ensureTaxPayableAccountIfNeeded } from '../../utils/tax.js';
import { randomUUID } from 'node:crypto';
import { AccountReportGroup, AccountType, CashflowActivity, ItemType, Prisma } from '@prisma/client';
import { postJournalEntry } from '../ledger/posting.service.js';
import { runIdempotentRequest } from '../../infrastructure/commandIdempotency.js';
import { requireCompanyIdParam } from '../../utils/tenant.js';
import { BankingAccountKind } from '@prisma/client';
import { getRedis } from '../../infrastructure/redis.js';
import { withLockBestEffort, withLocksBestEffort } from '../../infrastructure/locks.js';
import { applyStockMoveWac } from '../inventory/stock.service.js';
import { ensureInventoryCompanyDefaults, ensureInventoryItem, getStockBalanceForUpdate } from '../inventory/stock.service.js';
import { requireAnyRole, Roles } from '../../utils/rbac.js';
import { writeAuditLog } from '../../infrastructure/auditLog.js';
import { nextCreditNoteNumber } from '../sequence/sequence.service.js';
import { resolveLocationForStockIssue } from './warehousePolicy.js';
import { buildAdjustmentLinesFromNets, computeNetByAccount, createReversalJournalEntry, diffNets, } from '../ledger/reversal.service.js';
import { publishEventsFastPath } from '../../infrastructure/pubsub.js';
function generateInvoiceNumber() {
    // Beginner-friendly and “good enough” for now.
    // Later we can make this per-company sequential numbers (INV-0001).
    return `INV-${Date.now()}`;
}
function generateExpenseNumber() {
    // Beginner-friendly and “good enough” for now.
    // Later we can make this per-company sequential numbers (BILL-0001).
    return `BILL-${Date.now()}`;
}
export async function booksRoutes(fastify) {
    // All Books endpoints are tenant-scoped and must be authenticated.
    fastify.addHook('preHandler', fastify.authenticate);
    const redis = getRedis();
    function normalizeCurrencyOrNull(input) {
        if (input === undefined || input === null)
            return null;
        const s = String(input).trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(s)) {
            throw Object.assign(new Error('currency must be a 3-letter code (e.g. MMK, USD)'), {
                statusCode: 400,
            });
        }
        return s;
    }
    function enforceSingleCurrency(companyBaseCurrency, docCurrency) {
        if (!companyBaseCurrency)
            return;
        if (!docCurrency) {
            throw Object.assign(new Error('currency is required when company baseCurrency is set'), {
                statusCode: 400,
            });
        }
        if (docCurrency !== companyBaseCurrency) {
            throw Object.assign(new Error(`currency mismatch: document currency ${docCurrency} must equal company baseCurrency ${companyBaseCurrency}`), { statusCode: 400 });
        }
    }
    async function ensureSalesIncomeAccount(tx, companyId) {
        // Default revenue mapping for invoices when user doesn't care about accounting.
        // Code 4000 is our canonical "Sales Income" (seeded at company creation, but we also self-heal here).
        const existing = await tx.account.findFirst({
            where: { companyId, code: '4000', type: AccountType.INCOME },
            select: { id: true },
        });
        if (existing?.id)
            return existing.id;
        const created = await tx.account.create({
            data: {
                companyId,
                code: '4000',
                name: 'Sales Income',
                type: AccountType.INCOME,
                normalBalance: 'CREDIT',
                reportGroup: AccountReportGroup.SALES_REVENUE,
                cashflowActivity: CashflowActivity.OPERATING,
                isActive: true,
            },
            select: { id: true },
        });
        return created.id;
    }
    // Prisma client types in dev environments require `prisma generate` after schema changes.
    // We keep this include typed as `any` to avoid blocking builds in environments where the generated client
    // hasn't been refreshed yet (CI/local will regenerate and still work correctly).
    const invoiceLinesIncludeWithIncomeAccount = {
        include: { item: true, incomeAccount: { select: { id: true, code: true, name: true, type: true } } },
    };
    const creditNoteLinesIncludeWithIncomeAccount = {
        include: { item: true, incomeAccount: { select: { id: true, code: true, name: true, type: true } } },
    };
    // --- Books: Customers ---
    fastify.get('/companies/:companyId/customers', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        return await prisma.customer.findMany({
            where: { companyId },
            orderBy: { createdAt: 'desc' },
        });
    });
    // Customer detail (for UI)
    fastify.get('/companies/:companyId/customers/:customerId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const customerId = Number(request.params?.customerId);
        if (Number.isNaN(customerId)) {
            reply.status(400);
            return { error: 'invalid customerId' };
        }
        const customer = await prisma.customer.findFirst({
            where: { id: customerId, companyId },
        });
        if (!customer) {
            reply.status(404);
            return { error: 'customer not found' };
        }
        return customer;
    });
    fastify.post('/companies/:companyId/customers', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
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
    fastify.put('/companies/:companyId/customers/:customerId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const customerId = Number(request.params?.customerId);
        if (Number.isNaN(customerId)) {
            reply.status(400);
            return { error: 'invalid customerId' };
        }
        const body = request.body;
        if (!body.name) {
            reply.status(400);
            return { error: 'name is required' };
        }
        const existing = await prisma.customer.findFirst({ where: { id: customerId, companyId } });
        if (!existing) {
            reply.status(404);
            return { error: 'customer not found' };
        }
        const updated = await prisma.customer.update({
            where: { id: customerId },
            data: {
                name: body.name,
                email: body.email ?? null,
                phone: body.phone ?? null,
                currency: body.currency ?? null,
            },
        });
        return updated;
    });
    // --- Books: Vendors (for Accounts Payable / Bills) ---
    fastify.get('/companies/:companyId/vendors', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        return await prisma.vendor.findMany({
            where: { companyId },
            orderBy: { createdAt: 'desc' },
        });
    });
    // Vendor detail (for UI)
    fastify.get('/companies/:companyId/vendors/:vendorId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const vendorId = Number(request.params?.vendorId);
        if (Number.isNaN(vendorId)) {
            reply.status(400);
            return { error: 'invalid vendorId' };
        }
        const vendor = await prisma.vendor.findFirst({
            where: { id: vendorId, companyId },
        });
        if (!vendor) {
            reply.status(404);
            return { error: 'vendor not found' };
        }
        return vendor;
    });
    fastify.post('/companies/:companyId/vendors', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const body = request.body;
        if (!body.name) {
            reply.status(400);
            return { error: 'name is required' };
        }
        return await prisma.vendor.create({
            data: {
                companyId,
                name: body.name,
                email: body.email ?? null,
                phone: body.phone ?? null,
            },
        });
    });
    fastify.put('/companies/:companyId/vendors/:vendorId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const vendorId = Number(request.params?.vendorId);
        if (Number.isNaN(vendorId)) {
            reply.status(400);
            return { error: 'invalid vendorId' };
        }
        const body = request.body;
        if (!body.name) {
            reply.status(400);
            return { error: 'name is required' };
        }
        const existing = await prisma.vendor.findFirst({ where: { id: vendorId, companyId } });
        if (!existing) {
            reply.status(404);
            return { error: 'vendor not found' };
        }
        const updated = await prisma.vendor.update({
            where: { id: vendorId },
            data: {
                name: body.name,
                email: body.email ?? null,
                phone: body.phone ?? null,
            },
        });
        return updated;
    });
    // --- Books: Items ---
    fastify.get('/companies/:companyId/items', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        return await prisma.item.findMany({
            where: { companyId },
            orderBy: { createdAt: 'desc' },
            include: {
                incomeAccount: true,
                expenseAccount: true,
            },
        });
    });
    // Item detail (for UI)
    fastify.get('/companies/:companyId/items/:itemId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const itemId = Number(request.params?.itemId);
        if (Number.isNaN(itemId)) {
            reply.status(400);
            return { error: 'invalid itemId' };
        }
        const item = await prisma.item.findFirst({
            where: { id: itemId, companyId },
            include: {
                incomeAccount: { select: { id: true, code: true, name: true, type: true } },
                expenseAccount: { select: { id: true, code: true, name: true, type: true } },
                defaultLocation: { select: { id: true, name: true, isDefault: true } },
            },
        });
        if (!item) {
            reply.status(404);
            return { error: 'item not found' };
        }
        return item;
    });
    fastify.post('/companies/:companyId/items', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const body = request.body;
        if (!body.name) {
            reply.status(400);
            return { error: 'name is required' };
        }
        // Mobile-friendly defaults:
        // - If type omitted, default to SERVICE (most common for small businesses)
        // - If sellingPrice omitted, default to 0 (free item)
        // - If incomeAccountId omitted, default to the Sales income account
        const desiredType = body.type ?? ItemType.SERVICE;
        const desiredSellingPrice = body.sellingPrice === undefined ? 0 : body.sellingPrice;
        const desiredIncomeAccountId = body.incomeAccountId ??
            (await prisma.$transaction(async (tx) => await ensureSalesIncomeAccount(tx, companyId)));
        // Tenant-safe validation: incomeAccount must belong to same company and be INCOME.
        const incomeAccount = await prisma.account.findFirst({
            where: { id: desiredIncomeAccountId, companyId, type: AccountType.INCOME },
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
        if (body.trackInventory && desiredType !== ItemType.GOODS) {
            reply.status(400);
            return { error: 'trackInventory can only be enabled for GOODS' };
        }
        const desiredDefaultLocationId = body.defaultLocationId !== undefined ? body.defaultLocationId : body.defaultWarehouseId;
        if (desiredDefaultLocationId !== undefined && desiredDefaultLocationId !== null) {
            const loc = await prisma.location.findFirst({
                where: { id: desiredDefaultLocationId, companyId },
                select: { id: true },
            });
            if (!loc) {
                reply.status(400);
                return { error: 'defaultLocationId must be a location in this company' };
            }
        }
        const item = await prisma.item.create({
            data: {
                companyId,
                name: body.name,
                sku: body.sku ?? null,
                type: desiredType,
                sellingPrice: toMoneyDecimal(desiredSellingPrice),
                costPrice: body.costPrice === undefined ? null : toMoneyDecimal(body.costPrice),
                incomeAccountId: desiredIncomeAccountId,
                expenseAccountId: body.expenseAccountId ?? null,
                trackInventory: body.trackInventory ?? false,
                defaultLocationId: desiredDefaultLocationId ?? null,
            },
            include: {
                incomeAccount: true,
                expenseAccount: true,
            },
        });
        return item;
    });
    fastify.put('/companies/:companyId/items/:itemId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const itemId = Number(request.params?.itemId);
        if (Number.isNaN(itemId)) {
            reply.status(400);
            return { error: 'invalid itemId' };
        }
        const body = request.body;
        const existing = await prisma.item.findFirst({ where: { id: itemId, companyId } });
        if (!existing) {
            reply.status(404);
            return { error: 'item not found' };
        }
        // Keep update minimal for mobile UX (name/sku/price). More advanced fields can be added later.
        const data = {};
        if (body.name !== undefined)
            data.name = body.name;
        if (body.sku !== undefined)
            data.sku = body.sku;
        if (body.sellingPrice !== undefined)
            data.sellingPrice = toMoneyDecimal(body.sellingPrice);
        if (body.costPrice !== undefined)
            data.costPrice = body.costPrice === null ? null : toMoneyDecimal(body.costPrice);
        const updated = await prisma.item.update({
            where: { id: itemId },
            data,
            include: { incomeAccount: true, expenseAccount: true },
        });
        return updated;
    });
    // --- Books: Invoices (DRAFT) ---
    fastify.get('/companies/:companyId/invoices', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
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
    // Get single invoice with payments
    fastify.get('/companies/:companyId/invoices/:invoiceId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const invoiceId = Number(request.params?.invoiceId);
        if (Number.isNaN(invoiceId)) {
            reply.status(400);
            return { error: 'invalid invoiceId' };
        }
        const invoice = await prisma.invoice.findFirst({
            where: { id: invoiceId, companyId },
            include: {
                customer: true,
                location: true,
                lines: invoiceLinesIncludeWithIncomeAccount,
                journalEntry: {
                    include: {
                        lines: {
                            include: {
                                account: { select: { id: true, code: true, name: true, type: true } },
                            },
                        },
                    },
                },
                payments: {
                    include: {
                        bankAccount: true,
                        journalEntry: {
                            include: {
                                lines: {
                                    include: {
                                        account: { select: { id: true, code: true, name: true, type: true } },
                                    },
                                },
                            },
                        },
                    },
                    orderBy: { paymentDate: 'desc' },
                },
                customerAdvanceApplications: {
                    include: {
                        customerAdvance: { select: { id: true, advanceDate: true, receivedVia: true, reference: true } },
                    },
                    orderBy: { appliedDate: 'desc' },
                },
            },
        });
        if (!invoice) {
            reply.status(404);
            return { error: 'invoice not found' };
        }
        // Calculate total paid from payments + applied customer advances (source of truth), excluding reversed payments.
        // This keeps UI correct even if Invoice.amountPaid wasn't backfilled for older invoices.
        const totalPayments = invoice.payments
            .filter((p) => !p.reversedAt)
            .reduce((sum, p) => sum + Number(p.amount), 0);
        const totalCredits = (invoice.customerAdvanceApplications ?? []).reduce((sum, a) => sum + Number(a.amount), 0);
        const totalPaid = totalPayments + totalCredits;
        const creditsAgg = await prisma.customerAdvance.aggregate({
            where: { companyId, customerId: invoice.customerId },
            _sum: { amount: true, amountApplied: true },
        });
        const totalAdv = new Prisma.Decimal(creditsAgg._sum.amount ?? 0).toDecimalPlaces(2);
        const totalApplied = new Prisma.Decimal(creditsAgg._sum.amountApplied ?? 0).toDecimalPlaces(2);
        const creditsAvailable = totalAdv.sub(totalApplied).toDecimalPlaces(2);
        const journalEntries = [];
        if (invoice.status !== 'DRAFT' && invoice.journalEntry) {
            journalEntries.push({
                kind: 'INVOICE_POSTED',
                journalEntryId: invoice.journalEntry.id,
                date: invoice.journalEntry.date,
                description: invoice.journalEntry.description,
                lines: invoice.journalEntry.lines.map((l) => ({
                    account: l.account,
                    debit: l.debit.toString(),
                    credit: l.credit.toString(),
                })),
            });
        }
        for (const p of invoice.payments) {
            if (p.journalEntry) {
                journalEntries.push({
                    kind: 'PAYMENT_RECORDED',
                    paymentId: p.id,
                    journalEntryId: p.journalEntry.id,
                    date: p.journalEntry.date,
                    description: p.journalEntry.description,
                    lines: p.journalEntry.lines.map((l) => ({
                        account: l.account,
                        debit: l.debit.toString(),
                        credit: l.credit.toString(),
                    })),
                });
            }
        }
        // Note: customer advance applications have their own journal entries, but we don't
        // include them in `journalEntries` UI yet (to keep the invoice JE list focused).
        return {
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            customer: invoice.customer,
            location: invoice.location ? { id: invoice.location.id, name: invoice.location.name } : null,
            // Backward compatibility (deprecated)
            warehouse: invoice.location ? { id: invoice.location.id, name: invoice.location.name } : null,
            status: invoice.status,
            invoiceDate: invoice.invoiceDate,
            dueDate: invoice.dueDate,
            subtotal: invoice.subtotal ?? null,
            taxAmount: invoice.taxAmount ?? null,
            total: invoice.total,
            currency: invoice.currency,
            customerNotes: invoice.customerNotes ?? null,
            termsAndConditions: invoice.termsAndConditions ?? null,
            lines: invoice.lines,
            payments: invoice.payments.map((p) => ({
                id: p.id,
                paymentDate: p.paymentDate,
                amount: p.amount,
                bankAccount: {
                    id: p.bankAccount.id,
                    code: p.bankAccount.code,
                    name: p.bankAccount.name,
                },
                journalEntryId: p.journalEntry?.id ?? null,
                reversedAt: p.reversedAt ?? null,
                reversalReason: p.reversalReason ?? null,
                reversalJournalEntryId: p.reversalJournalEntryId ?? null,
            })),
            creditsApplied: (invoice.customerAdvanceApplications ?? []).map((a) => ({
                id: a.id,
                appliedDate: a.appliedDate,
                amount: a.amount,
                customerAdvanceId: a.customerAdvanceId,
            })),
            creditsAvailable: creditsAvailable.toString(),
            totalPaid: totalPaid,
            remainingBalance: Number(invoice.total) - totalPaid,
            journalEntries,
        };
    });
    fastify.post('/companies/:companyId/invoices', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const body = request.body;
        if (!body.customerId || !body.lines || body.lines.length === 0) {
            reply.status(400);
            return { error: 'customerId and at least one line are required' };
        }
        // Validate customer belongs to company (tenant-safe).
        const customer = await prisma.customer.findFirst({
            where: { id: body.customerId, companyId },
        });
        // Currency policy (single-currency per company if baseCurrency is set)
        const company = await prisma.company.findUnique({
            where: { id: companyId },
            select: { baseCurrency: true },
        });
        const baseCurrency = normalizeCurrencyOrNull(company?.baseCurrency ?? null);
        const requestedCurrency = normalizeCurrencyOrNull(body.currency ?? null);
        const customerCurrency = normalizeCurrencyOrNull(customer.currency ?? null);
        // If baseCurrency is set, invoice currency must match it (no multi-currency yet).
        const invoiceCurrency = baseCurrency ?? requestedCurrency ?? customerCurrency;
        enforceSingleCurrency(baseCurrency, invoiceCurrency);
        if (!customer) {
            reply.status(400);
            return { error: 'customerId not found in this company' };
        }
        // Optional location tagging: validate tenant safety.
        const locationId = (body.locationId ?? body.warehouseId) ? Number(body.locationId ?? body.warehouseId) : null;
        if (locationId) {
            const loc = await prisma.location.findFirst({ where: { id: locationId, companyId }, select: { id: true } });
            if (!loc) {
                reply.status(400);
                return { error: 'locationId not found in this company' };
            }
        }
        // Validate and load items (tenant-safe). Custom lines may not have itemId.
        const itemIds = body.lines
            .map((l) => Number(l.itemId ?? 0))
            .filter((x) => x > 0);
        const items = await prisma.item.findMany({
            where: { companyId, id: { in: itemIds } },
        });
        const itemById = new Map(items.map((i) => [i.id, i]));
        for (const line of body.lines) {
            if (!line.quantity || line.quantity <= 0) {
                reply.status(400);
                return { error: 'each line must have quantity > 0' };
            }
            const itemId = Number(line.itemId ?? 0);
            if (itemId > 0) {
                if (!itemById.get(itemId)) {
                    reply.status(400);
                    return { error: `itemId ${itemId} not found in this company` };
                }
            }
            else {
                // Custom/free-text line must have a description and explicit unitPrice.
                if (!line.description || !String(line.description).trim()) {
                    reply.status(400);
                    return { error: 'custom invoice line must include description' };
                }
                if (!line.unitPrice || Number(line.unitPrice) <= 0) {
                    reply.status(400);
                    return { error: 'custom invoice line must include unitPrice > 0' };
                }
            }
        }
        const invoiceDate = parseDateInput(body.invoiceDate) ?? new Date();
        const dueDate = body.dueDate ? parseDateInput(body.dueDate) : null;
        // Validate optional income accounts (tenant-safe) and determine Sales Income default.
        const requestedIncomeAccountIds = Array.from(new Set((body.lines ?? []).map((l) => Number(l.incomeAccountId ?? 0)).filter((x) => x > 0)));
        const incomeAccounts = requestedIncomeAccountIds.length === 0
            ? []
            : await prisma.account.findMany({
                where: { companyId, id: { in: requestedIncomeAccountIds }, type: AccountType.INCOME },
                select: { id: true },
            });
        const incomeIdSet = new Set(incomeAccounts.map((a) => a.id));
        for (const id of requestedIncomeAccountIds) {
            if (!incomeIdSet.has(id)) {
                reply.status(400);
                return { error: `incomeAccountId ${id} must be an INCOME account in this company` };
            }
        }
        const salesIncomeAccountId = await prisma.$transaction(async (tx) => ensureSalesIncomeAccount(tx, companyId));
        // Compute totals using Decimal (money-safe).
        let subtotal = new Prisma.Decimal(0);
        let taxAmount = new Prisma.Decimal(0);
        let total = new Prisma.Decimal(0);
        const computedLines = body.lines.map((line) => {
            const itemId = Number(line.itemId ?? 0);
            const item = itemId > 0 ? itemById.get(itemId) : null;
            const qty = toMoneyDecimal(line.quantity);
            const unit = toMoneyDecimal(line.unitPrice ?? (item ? Number(item.sellingPrice) : 0));
            if (unit.lessThanOrEqualTo(0)) {
                throw Object.assign(new Error('unitPrice must be > 0'), { statusCode: 400 });
            }
            const lineSubtotal = qty.mul(unit).toDecimalPlaces(2);
            const discount = toMoneyDecimal(line.discountAmount ?? 0).toDecimalPlaces(2);
            if (discount.lessThan(0) || discount.greaterThan(lineSubtotal)) {
                throw Object.assign(new Error(`invalid discountAmount: must be between 0 and line subtotal`), { statusCode: 400 });
            }
            const netSubtotal = lineSubtotal.sub(discount).toDecimalPlaces(2);
            const rate = new Prisma.Decimal(Number(line.taxRate ?? 0)).toDecimalPlaces(4);
            if (rate.lessThan(0) || rate.greaterThan(1)) {
                throw Object.assign(new Error(`invalid taxRate for itemId ${line.itemId}: must be between 0 and 1`), {
                    statusCode: 400,
                });
            }
            const lineTax = netSubtotal.mul(rate).toDecimalPlaces(2);
            const lineTotal = netSubtotal.add(lineTax).toDecimalPlaces(2);
            subtotal = subtotal.add(netSubtotal);
            taxAmount = taxAmount.add(lineTax);
            total = total.add(lineTotal);
            return {
                companyId,
                itemId: item ? item.id : null,
                description: line.description ?? (item ? item.name : null),
                quantity: qty,
                unitPrice: unit,
                discountAmount: discount,
                lineTotal: netSubtotal, // store net subtotal (after discount) for backwards compatibility
                taxRate: rate,
                taxAmount: lineTax,
                incomeAccountId: Number(line.incomeAccountId ?? 0) || salesIncomeAccountId,
            };
        });
        const invoice = await prisma.invoice.create({
            data: {
                companyId,
                customerId: customer.id,
                locationId,
                invoiceNumber: generateInvoiceNumber(),
                status: 'DRAFT',
                invoiceDate,
                dueDate,
                currency: invoiceCurrency,
                subtotal: subtotal.toDecimalPlaces(2),
                taxAmount: taxAmount.toDecimalPlaces(2),
                total: total.toDecimalPlaces(2), // stored but will be recomputed when posted
                customerNotes: body.customerNotes !== undefined && body.customerNotes !== null
                    ? String(body.customerNotes)
                    : null,
                termsAndConditions: body.termsAndConditions !== undefined && body.termsAndConditions !== null
                    ? String(body.termsAndConditions)
                    : null,
                lines: { create: computedLines },
            },
            include: {
                customer: true,
                lines: invoiceLinesIncludeWithIncomeAccount,
            },
        });
        return invoice;
    });
    // Create a public customer view link (no-login) for an invoice.
    // Returns a signed token that can be used with GET /public/invoices/:token.
    fastify.post('/companies/:companyId/invoices/:invoiceId/public-link', async (request, reply) => {
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT, Roles.CLERK, Roles.VIEWER]);
        const companyId = requireCompanyIdParam(request, reply);
        const invoiceId = Number(request.params?.invoiceId ?? 0);
        if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
            reply.status(400);
            return { error: 'invalid invoiceId' };
        }
        const inv = await prisma.invoice.findFirst({
            where: { id: invoiceId, companyId },
            select: { id: true },
        });
        if (!inv) {
            reply.status(404);
            return { error: 'invoice not found' };
        }
        // Signed link, avoids DB schema changes. Rotates automatically when expired.
        const token = fastify.jwt.sign({ typ: 'invoice_public', companyId, invoiceId, nonce: randomUUID() }, { expiresIn: process.env.PUBLIC_INVOICE_LINK_EXPIRES_IN ?? '180d' });
        return { token };
    });
    // Update invoice (DRAFT only)
    fastify.put('/companies/:companyId/invoices/:invoiceId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const invoiceId = Number(request.params?.invoiceId);
        if (!companyId || Number.isNaN(invoiceId)) {
            reply.status(400);
            return { error: 'invalid companyId or invoiceId' };
        }
        const body = request.body;
        if (!body.customerId || !body.lines || body.lines.length === 0) {
            reply.status(400);
            return { error: 'customerId and at least one line are required' };
        }
        const invoiceDate = parseDateInput(body.invoiceDate) ?? new Date();
        const dueDate = body.dueDate ? parseDateInput(body.dueDate) : null;
        if (body.invoiceDate && isNaN(invoiceDate.getTime())) {
            reply.status(400);
            return { error: 'invalid invoiceDate' };
        }
        if (body.dueDate && dueDate && isNaN(dueDate.getTime())) {
            reply.status(400);
            return { error: 'invalid dueDate' };
        }
        const customer = await prisma.customer.findFirst({
            where: { id: Number(body.customerId), companyId },
        });
        if (!customer) {
            reply.status(400);
            return { error: 'customerId not found in this company' };
        }
        // Optional location tagging: validate tenant safety.
        const locationId = (body.locationId ?? body.warehouseId) ? Number(body.locationId ?? body.warehouseId) : null;
        if (locationId) {
            const loc = await prisma.location.findFirst({ where: { id: locationId, companyId }, select: { id: true } });
            if (!loc) {
                reply.status(400);
                return { error: 'locationId not found in this company' };
            }
        }
        // Currency policy (single-currency per company if baseCurrency is set)
        const company = await prisma.company.findUnique({
            where: { id: companyId },
            select: { baseCurrency: true },
        });
        const baseCurrency = normalizeCurrencyOrNull(company?.baseCurrency ?? null);
        const requestedCurrency = normalizeCurrencyOrNull(body.currency ?? null);
        const customerCurrency = normalizeCurrencyOrNull(customer.currency ?? null);
        const invoiceCurrency = baseCurrency ?? requestedCurrency ?? customerCurrency;
        enforceSingleCurrency(baseCurrency, invoiceCurrency);
        // Validate and load items (tenant-safe). Custom lines may not have itemId.
        const itemIds = body.lines
            .map((l) => Number(l.itemId ?? 0))
            .filter((x) => x > 0);
        const items = await prisma.item.findMany({
            where: { companyId, id: { in: itemIds } },
        });
        const itemById = new Map(items.map((i) => [i.id, i]));
        for (const line of body.lines) {
            if (!line.quantity || line.quantity <= 0) {
                reply.status(400);
                return { error: 'each line must have quantity > 0' };
            }
            const itemId = Number(line.itemId ?? 0);
            if (itemId > 0) {
                if (!itemById.get(itemId)) {
                    reply.status(400);
                    return { error: `itemId ${itemId} not found in this company` };
                }
            }
            else {
                // Custom/free-text line must have a description and explicit unitPrice.
                if (!line.description || !String(line.description).trim()) {
                    reply.status(400);
                    return { error: 'custom invoice line must include description' };
                }
                if (!line.unitPrice || Number(line.unitPrice) <= 0) {
                    reply.status(400);
                    return { error: 'custom invoice line must include unitPrice > 0' };
                }
            }
        }
        // Validate optional income accounts (tenant-safe) and determine Sales Income default.
        const requestedIncomeAccountIds = Array.from(new Set((body.lines ?? []).map((l) => Number(l.incomeAccountId ?? 0)).filter((x) => x > 0)));
        const incomeAccounts = requestedIncomeAccountIds.length === 0
            ? []
            : await prisma.account.findMany({
                where: { companyId, id: { in: requestedIncomeAccountIds }, type: AccountType.INCOME },
                select: { id: true },
            });
        const incomeIdSet = new Set(incomeAccounts.map((a) => a.id));
        for (const id of requestedIncomeAccountIds) {
            if (!incomeIdSet.has(id)) {
                reply.status(400);
                return { error: `incomeAccountId ${id} must be an INCOME account in this company` };
            }
        }
        const salesIncomeAccountId = await prisma.$transaction(async (tx) => ensureSalesIncomeAccount(tx, companyId));
        // Compute totals using Decimal (money-safe).
        let subtotal = new Prisma.Decimal(0);
        let taxAmount = new Prisma.Decimal(0);
        let total = new Prisma.Decimal(0);
        const computedLines = body.lines.map((line) => {
            const itemId = Number(line.itemId ?? 0);
            const item = itemId > 0 ? itemById.get(itemId) : null;
            const qty = toMoneyDecimal(line.quantity);
            const unit = toMoneyDecimal(line.unitPrice ?? (item ? Number(item.sellingPrice) : 0));
            if (unit.lessThanOrEqualTo(0)) {
                throw Object.assign(new Error('unitPrice must be > 0'), { statusCode: 400 });
            }
            const lineSubtotal = qty.mul(unit).toDecimalPlaces(2);
            const discount = toMoneyDecimal(line.discountAmount ?? 0).toDecimalPlaces(2);
            if (discount.lessThan(0) || discount.greaterThan(lineSubtotal)) {
                throw Object.assign(new Error(`invalid discountAmount: must be between 0 and line subtotal`), { statusCode: 400 });
            }
            const netSubtotal = lineSubtotal.sub(discount).toDecimalPlaces(2);
            const rate = new Prisma.Decimal(Number(line.taxRate ?? 0)).toDecimalPlaces(4);
            if (rate.lessThan(0) || rate.greaterThan(1)) {
                throw Object.assign(new Error(`invalid taxRate: must be between 0 and 1`), {
                    statusCode: 400,
                });
            }
            const lineTax = netSubtotal.mul(rate).toDecimalPlaces(2);
            const lineTotal = netSubtotal.add(lineTax).toDecimalPlaces(2);
            subtotal = subtotal.add(netSubtotal);
            taxAmount = taxAmount.add(lineTax);
            total = total.add(lineTotal);
            return {
                companyId,
                itemId: item ? item.id : null,
                description: line.description ?? (item ? item.name : null),
                quantity: qty,
                unitPrice: unit,
                discountAmount: discount,
                lineTotal: netSubtotal, // store net subtotal (after discount) for backwards compatibility
                taxRate: rate,
                taxAmount: lineTax,
                incomeAccountId: Number(line.incomeAccountId ?? 0) || salesIncomeAccountId,
            };
        });
        const updated = await prisma.$transaction(async (tx) => {
            // Lock invoice row so concurrent edits don't race, and also block edits after post.
            await tx.$queryRaw `
        SELECT id FROM Invoice
        WHERE id = ${invoiceId} AND companyId = ${companyId}
        FOR UPDATE
      `;
            const existing = await tx.invoice.findFirst({
                where: { id: invoiceId, companyId },
                select: { id: true, status: true, journalEntryId: true },
            });
            if (!existing) {
                throw Object.assign(new Error('invoice not found'), { statusCode: 404 });
            }
            if (existing.status !== 'DRAFT' || existing.journalEntryId) {
                throw Object.assign(new Error('only DRAFT invoices can be edited'), { statusCode: 400 });
            }
            return await tx.invoice.update({
                where: { id: invoiceId, companyId },
                data: {
                    customerId: customer.id,
                    locationId,
                    invoiceDate,
                    dueDate: dueDate ?? null,
                    currency: invoiceCurrency,
                    subtotal: subtotal.toDecimalPlaces(2),
                    taxAmount: taxAmount.toDecimalPlaces(2),
                    total: total.toDecimalPlaces(2),
                    customerNotes: body.customerNotes !== undefined && body.customerNotes !== null ? String(body.customerNotes) : null,
                    termsAndConditions: body.termsAndConditions !== undefined && body.termsAndConditions !== null
                        ? String(body.termsAndConditions)
                        : null,
                    lines: {
                        deleteMany: {}, // all invoice lines
                        create: computedLines,
                    },
                },
                include: { customer: true, lines: invoiceLinesIncludeWithIncomeAccount },
            });
        });
        return updated;
    });
    // Delete invoice (DRAFT/APPROVED only)
    fastify.delete('/companies/:companyId/invoices/:invoiceId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const invoiceId = Number(request.params?.invoiceId);
        if (!companyId || Number.isNaN(invoiceId)) {
            reply.status(400);
            return { error: 'invalid companyId or invoiceId' };
        }
        const idempotencyKey = request.headers?.['idempotency-key'];
        if (!idempotencyKey) {
            reply.status(400);
            return { error: 'Idempotency-Key header is required' };
        }
        const correlationId = randomUUID();
        const occurredAt = isoNow();
        const lockKey = `lock:invoice:delete:${companyId}:${invoiceId}`;
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
                        select: { id: true, status: true, invoiceNumber: true, journalEntryId: true },
                    });
                    if (!inv)
                        throw Object.assign(new Error('invoice not found'), { statusCode: 404 });
                    if (inv.status !== 'DRAFT' && inv.status !== 'APPROVED') {
                        throw Object.assign(new Error('only DRAFT/APPROVED invoices can be deleted'), { statusCode: 400 });
                    }
                    if (inv.journalEntryId) {
                        throw Object.assign(new Error('cannot delete an invoice that already has a journal entry'), { statusCode: 400 });
                    }
                    const payCount = await tx.payment.count({ where: { companyId, invoiceId: inv.id } });
                    if (payCount > 0) {
                        throw Object.assign(new Error('cannot delete an invoice that has payments'), { statusCode: 400 });
                    }
                    await tx.invoiceLine.deleteMany({ where: { companyId, invoiceId: inv.id } });
                    await tx.invoice.delete({ where: { id: inv.id } });
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
                        action: 'invoice.delete_unposted',
                        entityType: 'Invoice',
                        entityId: inv.id,
                        idempotencyKey,
                        correlationId,
                        metadata: { invoiceNumber: inv.invoiceNumber, status: inv.status, occurredAt },
                    });
                    return { invoiceId: inv.id, deleted: true };
                });
                return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
            }, redis));
            return { invoiceId: result.invoiceId, deleted: true };
        }
        catch (err) {
            if (err?.statusCode) {
                reply.status(err.statusCode);
                return { error: err.message };
            }
            throw err;
        }
    });
    // Approve invoice (DRAFT -> APPROVED)
    fastify.post('/companies/:companyId/invoices/:invoiceId/approve', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const invoiceId = Number(request.params?.invoiceId);
        if (!companyId || Number.isNaN(invoiceId)) {
            reply.status(400);
            return { error: 'invalid companyId or invoiceId' };
        }
        const correlationId = randomUUID();
        const occurredAt = isoNow();
        const updated = await prisma.$transaction(async (tx) => {
            await tx.$queryRaw `
        SELECT id FROM Invoice
        WHERE id = ${invoiceId} AND companyId = ${companyId}
        FOR UPDATE
      `;
            const inv = await tx.invoice.findFirst({
                where: { id: invoiceId, companyId },
                select: { id: true, status: true, journalEntryId: true, invoiceNumber: true },
            });
            if (!inv)
                throw Object.assign(new Error('invoice not found'), { statusCode: 404 });
            if (inv.status !== 'DRAFT')
                throw Object.assign(new Error('only DRAFT invoices can be approved'), { statusCode: 400 });
            if (inv.journalEntryId)
                throw Object.assign(new Error('cannot approve an invoice that already has a journal entry'), { statusCode: 400 });
            const upd = await tx.invoice.update({
                where: { id: inv.id },
                data: { status: 'APPROVED', updatedByUserId: request.user?.userId ?? null },
                select: { id: true, status: true, invoiceNumber: true },
            });
            await writeAuditLog(tx, {
                companyId,
                userId: request.user?.userId ?? null,
                action: 'invoice.approve',
                entityType: 'Invoice',
                entityId: inv.id,
                idempotencyKey: request.headers?.['idempotency-key'] ?? null,
                correlationId,
                metadata: { invoiceNumber: inv.invoiceNumber, fromStatus: 'DRAFT', toStatus: 'APPROVED', occurredAt },
            });
            return upd;
        });
        return updated;
    });
    // Adjust posted invoice (immutable ledger): updates the document and posts an ADJUSTMENT journal entry (delta vs original posting).
    // POST /companies/:companyId/invoices/:invoiceId/adjust
    fastify.post('/companies/:companyId/invoices/:invoiceId/adjust', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const invoiceId = Number(request.params?.invoiceId);
        if (!companyId || Number.isNaN(invoiceId)) {
            reply.status(400);
            return { error: 'invalid companyId or invoiceId' };
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
        if (!body.lines?.length) {
            reply.status(400);
            return { error: 'lines is required' };
        }
        const lines = body.lines;
        const adjustmentDate = parseDateInput(body.adjustmentDate) ?? new Date();
        if (body.adjustmentDate && isNaN(adjustmentDate.getTime())) {
            reply.status(400);
            return { error: 'invalid adjustmentDate' };
        }
        const correlationId = randomUUID();
        const occurredAt = isoNow();
        const lockKey = `lock:invoice:adjust:${companyId}:${invoiceId}`;
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
                        include: {
                            company: true,
                            customer: true,
                            lines: { include: { item: true } },
                            journalEntry: { include: { lines: true } },
                        },
                    });
                    if (!inv)
                        throw Object.assign(new Error('invoice not found'), { statusCode: 404 });
                    if (inv.status !== 'POSTED') {
                        throw Object.assign(new Error('only POSTED invoices can be adjusted'), { statusCode: 400 });
                    }
                    const payCount = await tx.payment.count({
                        where: { companyId, invoiceId: inv.id, reversedAt: null },
                    });
                    if (payCount > 0) {
                        throw Object.assign(new Error('cannot adjust an invoice that has payments (reverse payments first)'), {
                            statusCode: 400,
                        });
                    }
                    const postedCreditNotes = await tx.creditNote.count({
                        where: { companyId, invoiceId: inv.id, status: 'POSTED' },
                    });
                    if (postedCreditNotes > 0) {
                        throw Object.assign(new Error('cannot adjust an invoice that has POSTED credit notes (void credit notes first)'), {
                            statusCode: 400,
                        });
                    }
                    // Safety: inventory-backed invoices require stock moves; we force void+reissue for now.
                    const hasTracked = (inv.lines ?? []).some((l) => l.item?.type === 'GOODS' && !!l.item?.trackInventory);
                    if (hasTracked) {
                        throw Object.assign(new Error('cannot adjust an inventory-tracked invoice (use credit note / void + reissue)'), { statusCode: 400 });
                    }
                    if (!inv.journalEntryId || !inv.journalEntry) {
                        throw Object.assign(new Error('invoice is POSTED but missing journal entry link'), { statusCode: 500 });
                    }
                    // Validate items and optional income accounts (tenant-safe) using the same rules as draft update.
                    const itemIds = lines.map((l) => l.itemId);
                    const items = (await tx.item.findMany({
                        where: { companyId, id: { in: itemIds } },
                        select: { id: true, name: true, sellingPrice: true },
                    }));
                    const itemById = new Map(items.map((i) => [i.id, i]));
                    for (const line of lines) {
                        if (!line.quantity || line.quantity <= 0) {
                            throw Object.assign(new Error('each line must have quantity > 0'), { statusCode: 400 });
                        }
                        if (!itemById.get(line.itemId)) {
                            throw Object.assign(new Error(`itemId ${line.itemId} not found in this company`), { statusCode: 400 });
                        }
                    }
                    const requestedIncomeAccountIds = Array.from(new Set(lines.map((l) => Number(l.incomeAccountId ?? 0)).filter((x) => x > 0)));
                    if (requestedIncomeAccountIds.length > 0) {
                        const incomeAccounts = await tx.account.findMany({
                            where: { companyId, id: { in: requestedIncomeAccountIds }, type: AccountType.INCOME },
                            select: { id: true },
                        });
                        const incomeIdSet = new Set(incomeAccounts.map((a) => a.id));
                        for (const id of requestedIncomeAccountIds) {
                            if (!incomeIdSet.has(id)) {
                                throw Object.assign(new Error(`incomeAccountId ${id} must be an INCOME account in this company`), { statusCode: 400 });
                            }
                        }
                    }
                    const salesIncomeAccountId = await ensureSalesIncomeAccount(tx, companyId);
                    // Compute totals (money-safe) and build new invoice lines.
                    let subtotal = new Prisma.Decimal(0);
                    let taxAmount = new Prisma.Decimal(0);
                    let total = new Prisma.Decimal(0);
                    const computedLines = lines.map((line) => {
                        const item = itemById.get(line.itemId);
                        const qty = toMoneyDecimal(line.quantity);
                        const unit = toMoneyDecimal(line.unitPrice ?? Number(item.sellingPrice));
                        const lineSubtotal = qty.mul(unit).toDecimalPlaces(2);
                        const rate = new Prisma.Decimal(Number(line.taxRate ?? 0)).toDecimalPlaces(4);
                        if (rate.lessThan(0) || rate.greaterThan(1)) {
                            throw Object.assign(new Error(`invalid taxRate for itemId ${line.itemId}: must be between 0 and 1`), { statusCode: 400 });
                        }
                        const lineTax = lineSubtotal.mul(rate).toDecimalPlaces(2);
                        const lineTotal = lineSubtotal.add(lineTax).toDecimalPlaces(2);
                        subtotal = subtotal.add(lineSubtotal);
                        taxAmount = taxAmount.add(lineTax);
                        total = total.add(lineTotal);
                        return {
                            companyId,
                            itemId: line.itemId,
                            description: line.description ?? null,
                            quantity: qty,
                            unitPrice: unit,
                            lineTotal: lineSubtotal, // keep backwards compat
                            taxRate: rate,
                            taxAmount: lineTax,
                            incomeAccountId: Number(line.incomeAccountId ?? 0) || salesIncomeAccountId,
                        };
                    });
                    subtotal = subtotal.toDecimalPlaces(2);
                    taxAmount = taxAmount.toDecimalPlaces(2);
                    total = total.toDecimalPlaces(2);
                    // Build "desired" posting lines (no inventory/COGS in adjustment endpoint).
                    const arId = inv.company.accountsReceivableAccountId;
                    if (!arId)
                        throw Object.assign(new Error('company.accountsReceivableAccountId is not set'), { statusCode: 400 });
                    const arAccount = await tx.account.findFirst({ where: { id: arId, companyId, type: AccountType.ASSET } });
                    if (!arAccount)
                        throw Object.assign(new Error('accountsReceivableAccountId must be an ASSET account in this company'), { statusCode: 400 });
                    const incomeBuckets = new Map();
                    for (const l of computedLines) {
                        const prev = incomeBuckets.get(l.incomeAccountId) ?? new Prisma.Decimal(0);
                        incomeBuckets.set(l.incomeAccountId, prev.add(new Prisma.Decimal(l.lineTotal)).toDecimalPlaces(2));
                    }
                    // Ensure Tax Payable exists when needed (do NOT assume code 2100; some tenants use it for Customer Advance).
                    const taxPayableAccountId = await ensureTaxPayableAccountIfNeeded(tx, companyId, taxAmount);
                    const desiredPostingLines = [
                        { accountId: arAccount.id, debit: total, credit: new Prisma.Decimal(0) },
                        ...Array.from(incomeBuckets.entries()).map(([incomeAccountId, amt]) => ({
                            accountId: incomeAccountId,
                            debit: new Prisma.Decimal(0),
                            credit: amt.toDecimalPlaces(2),
                        })),
                    ];
                    if (taxAmount.greaterThan(0)) {
                        desiredPostingLines.push({
                            accountId: taxPayableAccountId,
                            debit: new Prisma.Decimal(0),
                            credit: taxAmount,
                        });
                    }
                    const originalNet = computeNetByAccount((inv.journalEntry.lines ?? []).map((l) => ({
                        accountId: l.accountId,
                        debit: l.debit,
                        credit: l.credit,
                    })));
                    const desiredNet = computeNetByAccount(desiredPostingLines);
                    const deltaNet = diffNets(originalNet, desiredNet);
                    const adjustmentLines = buildAdjustmentLinesFromNets(deltaNet);
                    // Reverse any existing active adjustment (we keep at most 1 active adjustment per invoice).
                    const priorAdjId = Number(inv.lastAdjustmentJournalEntryId ?? 0) || null;
                    let reversedPriorAdjustmentJournalEntryId = null;
                    if (priorAdjId) {
                        const { reversal } = await createReversalJournalEntry(tx, {
                            companyId,
                            originalJournalEntryId: priorAdjId,
                            reversalDate: adjustmentDate,
                            reason: `superseded by invoice adjustment: ${String(body.reason).trim()}`,
                            createdByUserId: request.user?.userId ?? null,
                        });
                        reversedPriorAdjustmentJournalEntryId = reversal.id;
                        // Outbox events for reversal entry (and reversed semantic event)
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
                                payload: {
                                    originalJournalEntryId: priorAdjId,
                                    reversalJournalEntryId: reversal.id,
                                    companyId,
                                    reason: `superseded by invoice adjustment`,
                                },
                            },
                        });
                    }
                    let adjustmentJournalEntryId = null;
                    if (adjustmentLines.length > 0) {
                        if (adjustmentLines.length < 2) {
                            throw Object.assign(new Error('adjustment resulted in an invalid journal entry (needs >=2 lines)'), { statusCode: 400 });
                        }
                        const je = await postJournalEntry(tx, {
                            companyId,
                            date: adjustmentDate,
                            description: `ADJUSTMENT for Invoice ${inv.invoiceNumber}: ${String(body.reason).trim()}`,
                            createdByUserId: request.user?.userId ?? null,
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
                                payload: { journalEntryId: je.id, companyId, source: 'InvoiceAdjustment', invoiceId: inv.id },
                            },
                        });
                    }
                    // Update the invoice document (keeps UI consistent with correction) + track last adjustment JE.
                    const before = { subtotal: inv.subtotal?.toString?.() ?? null, taxAmount: inv.taxAmount?.toString?.() ?? null, total: inv.total?.toString?.() ?? null };
                    await tx.invoice.update({
                        where: { id: inv.id },
                        data: {
                            dueDate: body.dueDate === undefined ? inv.dueDate : body.dueDate ? parseDateInput(body.dueDate) : null,
                            customerNotes: body.customerNotes === undefined ? inv.customerNotes ?? null : body.customerNotes,
                            termsAndConditions: body.termsAndConditions === undefined ? inv.termsAndConditions ?? null : body.termsAndConditions,
                            subtotal,
                            taxAmount,
                            total,
                            lastAdjustmentJournalEntryId: adjustmentJournalEntryId,
                            updatedByUserId: request.user?.userId ?? null,
                            lines: { deleteMany: {}, create: computedLines },
                        },
                    });
                    const after = { subtotal: subtotal.toString(), taxAmount: taxAmount.toString(), total: total.toString() };
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
                        action: 'invoice.adjust_posted',
                        entityType: 'Invoice',
                        entityId: inv.id,
                        idempotencyKey,
                        correlationId,
                        metadata: {
                            invoiceNumber: inv.invoiceNumber,
                            reason: String(body.reason).trim(),
                            adjustmentDate,
                            priorAdjustmentJournalEntryId: priorAdjId,
                            reversedPriorAdjustmentJournalEntryId,
                            adjustmentJournalEntryId,
                            before,
                            after,
                        },
                    });
                    return {
                        invoiceId: inv.id,
                        status: inv.status,
                        adjustmentJournalEntryId,
                        reversedPriorAdjustmentJournalEntryId,
                        total: total.toString(),
                    };
                });
                return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
            }, redis));
            return {
                invoiceId: result.invoiceId,
                status: result.status,
                adjustmentJournalEntryId: result.adjustmentJournalEntryId ?? null,
                reversedPriorAdjustmentJournalEntryId: result.reversedPriorAdjustmentJournalEntryId ?? null,
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
    // Void posted invoice (immutable ledger): marks invoice VOID and posts a reversal journal entry.
    // POST /companies/:companyId/invoices/:invoiceId/void
    fastify.post('/companies/:companyId/invoices/:invoiceId/void', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const invoiceId = Number(request.params?.invoiceId);
        if (!companyId || Number.isNaN(invoiceId)) {
            reply.status(400);
            return { error: 'invalid companyId or invoiceId' };
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
        const lockKey = `lock:invoice:void:${companyId}:${invoiceId}`;
        try {
            // If invoice posting touched inventory, we must lock per-item stock keys during void to avoid WAC races.
            const preMoves = await prisma.stockMove.findMany({
                where: { companyId, referenceType: 'Invoice', referenceId: String(invoiceId) },
                select: { locationId: true, itemId: true },
            });
            const stockLockKeys = Array.from(new Set((preMoves ?? []).map((m) => `lock:stock:${companyId}:${m.locationId}:${m.itemId}`)));
            const wrapped = async (fn) => stockLockKeys.length > 0
                ? withLocksBestEffort(redis, stockLockKeys, 30_000, async () => withLockBestEffort(redis, lockKey, 30_000, fn))
                : withLockBestEffort(redis, lockKey, 30_000, fn);
            const { response: result } = await wrapped(async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const txResult = await prisma.$transaction(async (tx) => {
                    await tx.$queryRaw `
              SELECT id FROM Invoice
              WHERE id = ${invoiceId} AND companyId = ${companyId}
              FOR UPDATE
            `;
                    const inv = await tx.invoice.findFirst({
                        where: { id: invoiceId, companyId },
                        include: { journalEntry: { include: { lines: true } } },
                    });
                    if (!inv)
                        throw Object.assign(new Error('invoice not found'), { statusCode: 404 });
                    if (inv.status === 'VOID') {
                        return { invoiceId: inv.id, status: inv.status, voidJournalEntryId: inv.voidJournalEntryId ?? null, alreadyVoided: true };
                    }
                    if (inv.status !== 'POSTED') {
                        throw Object.assign(new Error('only POSTED invoices can be voided'), { statusCode: 400 });
                    }
                    if (!inv.journalEntryId || !inv.journalEntry) {
                        throw Object.assign(new Error('invoice is POSTED but missing journal entry link'), { statusCode: 500 });
                    }
                    const payCount = await tx.payment.count({ where: { companyId, invoiceId: inv.id, reversedAt: null } });
                    if (payCount > 0) {
                        throw Object.assign(new Error('cannot void an invoice that has payments (reverse payments first)'), { statusCode: 400 });
                    }
                    const postedCreditNotes = await tx.creditNote.count({
                        where: { companyId, invoiceId: inv.id, status: 'POSTED' },
                    });
                    if (postedCreditNotes > 0) {
                        throw Object.assign(new Error('cannot void an invoice that has POSTED credit notes (void credit notes first)'), {
                            statusCode: 400,
                        });
                    }
                    // Inventory reversal: reverse stock issues created by invoice posting.
                    const origIssueMoves = await tx.stockMove.findMany({
                        where: {
                            companyId,
                            referenceType: 'Invoice',
                            referenceId: String(inv.id),
                            type: 'SALE_ISSUE',
                            direction: 'OUT',
                        },
                        select: {
                            locationId: true,
                            itemId: true,
                            quantity: true,
                            unitCostApplied: true,
                        },
                    });
                    // Reverse active adjustment first (if any)
                    const priorAdjId = Number(inv.lastAdjustmentJournalEntryId ?? 0) || null;
                    let reversedPriorAdjustmentJournalEntryId = null;
                    if (priorAdjId) {
                        const { reversal } = await createReversalJournalEntry(tx, {
                            companyId,
                            originalJournalEntryId: priorAdjId,
                            reversalDate: voidDate,
                            reason: `void invoice: ${String(body.reason).trim()}`,
                            createdByUserId: request.user?.userId ?? null,
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
                                payload: {
                                    originalJournalEntryId: priorAdjId,
                                    reversalJournalEntryId: reversal.id,
                                    companyId,
                                    reason: `void invoice`,
                                },
                            },
                        });
                    }
                    const { reversal } = await createReversalJournalEntry(tx, {
                        companyId,
                        originalJournalEntryId: inv.journalEntryId,
                        reversalDate: voidDate,
                        reason: String(body.reason).trim(),
                        createdByUserId: request.user?.userId ?? null,
                    });
                    // Apply stock returns at the SAME unit cost applied on the original sale issue moves (audit-friendly).
                    if ((origIssueMoves ?? []).length > 0) {
                        for (const m of origIssueMoves) {
                            await applyStockMoveWac(tx, {
                                companyId,
                                locationId: m.locationId,
                                itemId: m.itemId,
                                date: voidDate,
                                type: 'SALE_RETURN',
                                direction: 'IN',
                                quantity: new Prisma.Decimal(m.quantity).toDecimalPlaces(2),
                                unitCostApplied: new Prisma.Decimal(m.unitCostApplied).toDecimalPlaces(2),
                                referenceType: 'InvoiceVoid',
                                referenceId: String(inv.id),
                                correlationId,
                                createdByUserId: request.user?.userId ?? null,
                                journalEntryId: null,
                            });
                        }
                        await tx.stockMove.updateMany({
                            where: { companyId, correlationId, journalEntryId: null, referenceType: 'InvoiceVoid', referenceId: String(inv.id) },
                            data: { journalEntryId: reversal.id },
                        });
                    }
                    // Outbox events (created + reversed semantic)
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
                            causationId: String(inv.journalEntryId),
                            aggregateType: 'JournalEntry',
                            aggregateId: String(reversal.id),
                            type: 'JournalEntryCreated',
                            payload: { journalEntryId: reversal.id, companyId, reversalOfJournalEntryId: inv.journalEntryId, source: 'InvoiceVoid', invoiceId: inv.id },
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
                            aggregateId: String(inv.journalEntryId),
                            type: 'JournalEntryReversed',
                            payload: {
                                originalJournalEntryId: inv.journalEntryId,
                                reversalJournalEntryId: reversal.id,
                                companyId,
                                reason: String(body.reason).trim(),
                            },
                        },
                    });
                    const voidedAt = new Date();
                    await tx.invoice.update({
                        where: { id: inv.id },
                        data: {
                            status: 'VOID',
                            voidedAt,
                            voidReason: String(body.reason).trim(),
                            voidedByUserId: request.user?.userId ?? null,
                            voidJournalEntryId: reversal.id,
                            lastAdjustmentJournalEntryId: null,
                            updatedByUserId: request.user?.userId ?? null,
                        },
                    });
                    await tx.journalEntry.updateMany({
                        where: { id: inv.journalEntryId, companyId },
                        data: {
                            voidedAt,
                            voidReason: String(body.reason).trim(),
                            voidedByUserId: request.user?.userId ?? null,
                            updatedByUserId: request.user?.userId ?? null,
                        },
                    });
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
                        action: 'invoice.void',
                        entityType: 'Invoice',
                        entityId: inv.id,
                        idempotencyKey,
                        correlationId,
                        metadata: {
                            reason: String(body.reason).trim(),
                            voidDate,
                            voidedAt,
                            originalJournalEntryId: inv.journalEntryId,
                            voidJournalEntryId: reversal.id,
                            priorAdjustmentJournalEntryId: priorAdjId,
                            reversedPriorAdjustmentJournalEntryId,
                        },
                    });
                    return { invoiceId: inv.id, status: 'VOID', voidJournalEntryId: reversal.id };
                });
                return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
            }, redis));
            return {
                invoiceId: result.invoiceId,
                status: result.status,
                voidJournalEntryId: result.voidJournalEntryId,
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
    // POST (confirm) an invoice: DRAFT -> POSTED creates journal entry
    fastify.post('/companies/:companyId/invoices/:invoiceId/post', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const invoiceId = Number(request.params?.invoiceId);
        if (!companyId || Number.isNaN(invoiceId)) {
            reply.status(400);
            return { error: 'invalid companyId or invoiceId' };
        }
        const idempotencyKey = request.headers?.['idempotency-key'];
        if (!idempotencyKey) {
            reply.status(400);
            return { error: 'Idempotency-Key header is required' };
        }
        const correlationId = randomUUID(); // one correlationId for the whole posting transaction
        const occurredAt = isoNow();
        const lockKey = `lock:invoice:post:${companyId}:${invoiceId}`;
        // Pre-read to compute stock lock keys (avoid concurrent oversell across invoices).
        const pre = await prisma.invoice.findFirst({
            where: { id: invoiceId, companyId },
            select: {
                id: true,
                locationId: true,
                company: { select: { defaultLocationId: true } },
                lines: {
                    select: {
                        itemId: true,
                        item: { select: { type: true, trackInventory: true, defaultLocationId: true } },
                    },
                },
            },
        });
        if (!pre) {
            reply.status(404);
            return { error: 'invoice not found' };
        }
        let fallbackLocationId = pre.locationId ?? pre.company.defaultLocationId ?? null;
        if (!fallbackLocationId) {
            const loc = await prisma.location.findFirst({ where: { companyId, isDefault: true }, select: { id: true } });
            fallbackLocationId = loc?.id ?? null;
        }
        const invoiceLocationId = pre.locationId ?? null;
        const isTrackedPreLine = (l) => {
            return Boolean(l.itemId && l.item && l.item.type === ItemType.GOODS && l.item.trackInventory);
        };
        const trackedLines = pre.lines.filter(isTrackedPreLine);
        if (trackedLines.length > 0) {
            const missingWh = trackedLines.some((l) => !resolveLocationForStockIssue({
                invoiceLocationId,
                itemDefaultLocationId: l.item.defaultLocationId ?? null,
                companyDefaultLocationId: fallbackLocationId,
            }));
            if (missingWh) {
                reply.status(400);
                return { error: 'default location is not set (set company.defaultLocationId or item.defaultLocationId)' };
            }
        }
        const stockLockKeys = trackedLines.length === 0
            ? []
            : trackedLines.map((l) => {
                const lid = resolveLocationForStockIssue({
                    invoiceLocationId,
                    itemDefaultLocationId: l.item.defaultLocationId ?? null,
                    companyDefaultLocationId: fallbackLocationId,
                });
                if (!lid)
                    throw new Error('default location is not set');
                return `lock:stock:${companyId}:${lid}:${l.itemId}`;
            });
        const { replay, response: result } = await withLocksBestEffort(redis, stockLockKeys, 30_000, async () => withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
            const txResult = await prisma.$transaction(async (tx) => {
                // DB-level serialization safety: lock the invoice row so concurrent posts
                // (with different idempotency keys) cannot double-post.
                await tx.$queryRaw `
            SELECT id FROM Invoice
            WHERE id = ${invoiceId} AND companyId = ${companyId}
            FOR UPDATE
          `;
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
                if (invoice.status !== 'DRAFT' && invoice.status !== 'APPROVED') {
                    throw Object.assign(new Error('only DRAFT/APPROVED invoices can be posted'), { statusCode: 400 });
                }
                // Currency policy: if company has baseCurrency, invoice currency must match it.
                const baseCurrency = normalizeCurrencyOrNull(invoice.company.baseCurrency ?? null);
                const invCurrency = normalizeCurrencyOrNull(invoice.currency ?? null);
                enforceSingleCurrency(baseCurrency, invCurrency ?? baseCurrency);
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
                // Recompute totals from stored lines (source of truth) and bucket revenue (net of discounts, tax excluded).
                const linesForMath = (invoice.lines ?? []).map((line) => {
                    const incomeAccountId = line.incomeAccountId ?? line.item?.incomeAccountId;
                    if (!incomeAccountId) {
                        throw Object.assign(new Error('invoice line is missing income account mapping'), { statusCode: 400 });
                    }
                    return {
                        quantity: line.quantity,
                        unitPrice: line.unitPrice,
                        discountAmount: line.discountAmount ?? 0,
                        taxRate: line.taxRate ?? 0,
                        incomeAccountId: Number(incomeAccountId),
                    };
                });
                let computed;
                try {
                    computed = computeInvoiceTotalsAndIncomeBuckets(linesForMath);
                }
                catch (e) {
                    throw Object.assign(new Error(e?.message ?? 'invalid invoice lines'), { statusCode: 400 });
                }
                const subtotal = new Prisma.Decimal(computed.subtotal);
                const taxAmount = new Prisma.Decimal(computed.taxAmount);
                const total = new Prisma.Decimal(computed.total);
                const incomeBuckets = new Map(Array.from(computed.incomeBuckets.entries()).map(([k, v]) => [k, new Prisma.Decimal(v)]));
                // Guardrail: ensure recomputed totals match stored totals to prevent any JE imbalance.
                try {
                    assertTotalsMatchStored(total, new Prisma.Decimal(invoice.total));
                }
                catch (e) {
                    throw Object.assign(new Error(e?.message ?? 'rounding mismatch'), {
                        statusCode: 400,
                        recomputedTotal: total.toString(),
                        storedTotal: new Prisma.Decimal(invoice.total).toDecimalPlaces(2).toString(),
                    });
                }
                // Ensure Tax Payable exists when needed (do NOT assume code 2100; some tenants use it for Customer Advance).
                const taxPayableAccountId = await ensureTaxPayableAccountIfNeeded(tx, companyId, taxAmount);
                // Inventory V1: deduct stock + compute COGS (WAC) at invoice post time
                const isTrackedInvoiceLine = (l) => {
                    return Boolean(l.itemId && l.item && l.item.type === 'GOODS' && l.item.trackInventory);
                };
                const tracked = invoice.lines.filter(isTrackedInvoiceLine);
                let totalCogs = new Prisma.Decimal(0);
                // Resolve default location for this invoice (location tagging).
                // Preference: invoice.locationId -> company.defaultLocationId -> company default Location row.
                const invoiceLocationId = invoice.locationId ?? null;
                let defaultLocationId = invoice.company.defaultLocationId ?? null;
                if (tracked.length > 0) {
                    // Inventory engine v1 stores only a "current" StockBalance (not a date-effective ledger),
                    // so allowing future-dated inventory documents creates confusing/incorrect current stock.
                    // Industry-standard approach is to either:
                    // - post stock on ship/delivery date (separate from invoice), or
                    // - implement reservations/available-to-promise.
                    // Until then, we disallow posting inventory-affecting invoices with a future invoiceDate.
                    const tz = invoice.company.timeZone ?? null;
                    if (isFutureBusinessDate({ date: new Date(invoice.invoiceDate), timeZone: tz })) {
                        throw Object.assign(new Error('cannot post an inventory invoice with a future invoice date. Set the invoice date to today or keep it as DRAFT and post on the shipment date.'), { statusCode: 400 });
                    }
                    const cfg = await ensureInventoryCompanyDefaults(tx, companyId);
                    defaultLocationId = defaultLocationId ?? cfg.defaultLocationId;
                    for (const line of tracked) {
                        const lid = resolveLocationForStockIssue({
                            invoiceLocationId,
                            itemDefaultLocationId: line.item.defaultLocationId ?? null,
                            companyDefaultLocationId: defaultLocationId,
                        });
                        if (!lid) {
                            throw Object.assign(new Error('default location is not set (set company.defaultLocationId or item.defaultLocationId)'), {
                                statusCode: 400,
                            });
                        }
                        const qty = new Prisma.Decimal(line.quantity).toDecimalPlaces(2);
                        const applied = await applyStockMoveWac(tx, {
                            companyId,
                            locationId: Number(lid),
                            itemId: Number(line.itemId),
                            date: invoice.invoiceDate,
                            allowBackdated: true,
                            type: 'SALE_ISSUE',
                            direction: 'OUT',
                            quantity: qty,
                            unitCostApplied: new Prisma.Decimal(0),
                            referenceType: 'Invoice',
                            referenceId: String(invoice.id),
                            correlationId,
                            createdByUserId: request.user?.userId ?? null,
                            journalEntryId: null,
                        });
                        totalCogs = totalCogs.add(new Prisma.Decimal(applied.totalCostApplied));
                    }
                    totalCogs = totalCogs.toDecimalPlaces(2);
                }
                // Build journal entry lines including tax (and optional inventory COGS).
                const invCfgForCogs = totalCogs.greaterThan(0) ? await ensureInventoryCompanyDefaults(tx, companyId) : null;
                const jeLines = buildInvoicePostingJournalLines({
                    arAccountId: arAccount.id,
                    total: total,
                    incomeBuckets: incomeBuckets,
                    taxPayableAccountId: taxAmount.greaterThan(0) ? taxPayableAccountId : null,
                    taxAmount: taxAmount,
                    totalCogs: totalCogs,
                    cogsAccountId: invCfgForCogs?.cogsAccountId ?? null,
                    inventoryAssetAccountId: invCfgForCogs?.inventoryAssetAccountId ?? null,
                });
                const journalEntry = await postJournalEntry(tx, {
                    companyId,
                    date: invoice.invoiceDate,
                    description: `Invoice ${invoice.invoiceNumber} for ${invoice.customer.name}`,
                    locationId: invoice.locationId ?? null,
                    createdByUserId: request.user?.userId ?? null,
                    lines: jeLines,
                });
                // Link inventory moves to the invoice posting JournalEntry (best-effort)
                if (totalCogs.greaterThan(0)) {
                    await tx.stockMove.updateMany({
                        where: { companyId, correlationId, journalEntryId: null },
                        data: { journalEntryId: journalEntry.id },
                    });
                }
                // Update invoice to POSTED and link journal entry (tenant-safe).
                const upd = await tx.invoice.updateMany({
                    where: { id: invoice.id, companyId },
                    data: {
                        status: 'POSTED',
                        subtotal,
                        taxAmount,
                        total,
                        amountPaid: new Prisma.Decimal(0),
                        journalEntryId: journalEntry.id,
                        // Backfill currency to baseCurrency on post if missing (single-currency mode).
                        ...(baseCurrency && !invCurrency ? { currency: baseCurrency } : {}),
                    },
                });
                if (upd.count !== 1) {
                    throw Object.assign(new Error('invoice not found'), { statusCode: 404 });
                }
                const updatedInvoice = await tx.invoice.findFirst({
                    where: { id: invoice.id, companyId },
                    select: { id: true, status: true, total: true, journalEntryId: true },
                });
                if (!updatedInvoice) {
                    throw Object.assign(new Error('invoice not found'), { statusCode: 404 });
                }
                await writeAuditLog(tx, {
                    companyId,
                    userId: request.user?.userId ?? null,
                    action: 'invoice.post',
                    entityType: 'Invoice',
                    entityId: updatedInvoice.id,
                    idempotencyKey,
                    correlationId,
                    metadata: {
                        invoiceNumber: invoice.invoiceNumber,
                        invoiceDate: invoice.invoiceDate,
                        customerId: invoice.customerId,
                        total: total.toString(),
                        totalCogs: totalCogs.toString(),
                        journalEntryId: journalEntry.id,
                    },
                });
                // --- Event 1: journal.entry.created ---
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
                        },
                    },
                });
                // --- Event 2: invoice.posted ---
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
                return { updatedInvoice, journalEntry, jeEventId, invoiceEventId };
            }, { timeout: 10_000 });
            return {
                invoiceId: txResult.updatedInvoice.id,
                status: txResult.updatedInvoice.status,
                total: txResult.updatedInvoice.total.toString(),
                journalEntryId: txResult.updatedInvoice.journalEntryId,
                // keep event ids for first execution publish step only
                _jeEventId: txResult.jeEventId,
                _invoiceEventId: txResult.invoiceEventId,
                _correlationId: correlationId,
                _occurredAt: occurredAt,
            };
        }, redis)));
        // Fast-path publish: fire-and-forget to Pub/Sub (non-blocking)
        // If this fails, the outbox publisher will pick up the events
        if (!replay && result._jeEventId) {
            const eventIds = [result._jeEventId];
            if (result._invoiceEventId)
                eventIds.push(result._invoiceEventId);
            publishEventsFastPath(eventIds);
        }
        // Always return stable business response
        return {
            invoiceId: result.invoiceId,
            status: result.status,
            total: result.total,
            journalEntryId: result.journalEntryId,
        };
    });
    // Payments: record and post to ledger (Bank/Cash Dr, AR Cr)
    fastify.post('/companies/:companyId/invoices/:invoiceId/payments', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const invoiceId = Number(request.params?.invoiceId);
        if (!companyId || Number.isNaN(invoiceId)) {
            reply.status(400);
            return { error: 'invalid companyId or invoiceId' };
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
        // After validation, treat amount as a required number.
        const amountNumber = body.amount;
        const occurredAt = isoNow();
        const correlationId = randomUUID();
        try {
            const lockKey = `lock:invoice:payment:${companyId}:${invoiceId}`;
            const { replay, response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const txResult = await prisma.$transaction(async (tx) => {
                    // DB-level serialization safety: lock the invoice row so concurrent payments can't overspend.
                    await tx.$queryRaw `
                  SELECT id FROM Invoice
                  WHERE id = ${invoiceId} AND companyId = ${companyId}
                  FOR UPDATE
                `;
                    const invoice = await tx.invoice.findFirst({
                        where: { id: invoiceId, companyId },
                        include: { company: { select: { accountsReceivableAccountId: true, baseCurrency: true } } },
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
                    // Currency policy: if company has baseCurrency, invoice currency must match it.
                    const baseCurrency = normalizeCurrencyOrNull(invoice.company.baseCurrency ?? null);
                    const invCurrency = normalizeCurrencyOrNull(invoice.currency ?? null);
                    enforceSingleCurrency(baseCurrency, invCurrency ?? baseCurrency);
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
                    // Enforce "Deposit To" must be a BankingAccount (created via Banking module)
                    const banking = await tx.bankingAccount.findFirst({
                        where: { companyId, accountId: bankAccount.id },
                        select: { kind: true },
                    });
                    if (!banking) {
                        throw Object.assign(new Error('Deposit To must be a banking account (create it under Banking first)'), { statusCode: 400 });
                    }
                    if (banking.kind === BankingAccountKind.CREDIT_CARD) {
                        throw Object.assign(new Error('cannot deposit to a credit card account'), {
                            statusCode: 400,
                        });
                    }
                    // Optional: if UI sends paymentMode, enforce kind matches
                    if (body.paymentMode) {
                        const expected = body.paymentMode === 'CASH'
                            ? BankingAccountKind.CASH
                            : body.paymentMode === 'BANK'
                                ? BankingAccountKind.BANK
                                : BankingAccountKind.E_WALLET;
                        if (banking.kind !== expected) {
                            throw Object.assign(new Error(`Deposit To account kind must be ${expected} for paymentMode ${body.paymentMode}`), { statusCode: 400 });
                        }
                    }
                    const paymentDate = parseDateInput(body.paymentDate) ?? new Date();
                    const amount = toMoneyDecimal(amountNumber);
                    // Prevent overpayment based on source-of-truth payments sum (non-reversed).
                    const sumBefore = await tx.payment.aggregate({
                        where: { invoiceId: invoice.id, companyId, reversedAt: null },
                        _sum: { amount: true },
                    });
                    const totalPaidBefore = (sumBefore._sum.amount ?? new Prisma.Decimal(0)).toDecimalPlaces(2);
                    const remainingBefore = new Prisma.Decimal(invoice.total)
                        .sub(totalPaidBefore)
                        .toDecimalPlaces(2);
                    if (amount.greaterThan(remainingBefore)) {
                        throw Object.assign(new Error(`amount cannot exceed remaining balance of ${remainingBefore.toString()}`), { statusCode: 400 });
                    }
                    const journalEntry = await postJournalEntry(tx, {
                        companyId,
                        date: paymentDate,
                        description: `Payment for Invoice ${invoice.invoiceNumber}`,
                        locationId: invoice.locationId ?? null,
                        createdByUserId: request.user?.userId ?? null,
                        skipAccountValidation: true,
                        lines: [
                            { accountId: bankAccount.id, debit: amount, credit: new Prisma.Decimal(0) },
                            { accountId: arAccount.id, debit: new Prisma.Decimal(0), credit: amount },
                        ],
                    });
                    const payment = await tx.payment.create({
                        data: {
                            companyId,
                            invoiceId: invoice.id,
                            paymentDate,
                            amount,
                            bankAccountId: bankAccount.id,
                            journalEntryId: journalEntry.id,
                        },
                    });
                    // Guardrail: compute paid from source-of-truth (non-reversed payments) to prevent drift.
                    const sumAgg = await tx.payment.aggregate({
                        where: { invoiceId: invoice.id, companyId, reversedAt: null },
                        _sum: { amount: true },
                    });
                    const totalPaid = (sumAgg._sum.amount ?? new Prisma.Decimal(0)).toDecimalPlaces(2);
                    const newStatus = totalPaid.greaterThanOrEqualTo(invoice.total) ? 'PAID' : 'PARTIAL';
                    const updInv = await tx.invoice.updateMany({
                        where: { id: invoice.id, companyId },
                        data: { amountPaid: totalPaid, status: newStatus },
                    });
                    if (updInv.count !== 1) {
                        throw Object.assign(new Error('invoice not found'), { statusCode: 404 });
                    }
                    const updatedInvoice = { id: invoice.id, status: newStatus };
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
                        action: 'invoice.payment.create',
                        entityType: 'Payment',
                        entityId: payment.id,
                        idempotencyKey,
                        correlationId,
                        metadata: {
                            invoiceId: invoice.id,
                            invoiceNumber: invoice.invoiceNumber,
                            locationId: invoice.locationId ?? null,
                            paymentDate,
                            amount: amount.toString(),
                            bankAccountId: bankAccount.id,
                            journalEntryId: journalEntry.id,
                            newInvoiceStatus: updatedInvoice.status,
                            newAmountPaid: totalPaid.toString(),
                        },
                    });
                    // Event: journal.entry.created (so worker updates AccountBalance/DailySummary)
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
                            aggregateId: String(payment.id),
                            type: 'PaymentRecorded',
                            payload: {
                                paymentId: payment.id,
                                invoiceId: invoice.id,
                                journalEntryId: journalEntry.id,
                                amount: amount.toString(),
                                bankAccountId: bankAccount.id,
                            },
                        },
                    });
                    return { updatedInvoice, payment, journalEntry, jeEventId, paymentEventId };
                }, { timeout: 10_000 });
                return {
                    invoiceId: txResult.updatedInvoice.id,
                    invoiceStatus: txResult.updatedInvoice.status,
                    paymentId: txResult.payment.id,
                    journalEntryId: txResult.payment.journalEntryId,
                    _jeEventId: txResult.jeEventId,
                    _paymentEventId: txResult.paymentEventId,
                    _correlationId: correlationId,
                    _occurredAt: occurredAt,
                };
            }, redis));
            // Fast-path publish: fire-and-forget to Pub/Sub (non-blocking)
            if (!replay && result._jeEventId) {
                const eventIds = [result._jeEventId];
                if (result._paymentEventId)
                    eventIds.push(result._paymentEventId);
                publishEventsFastPath(eventIds);
            }
            return {
                invoiceId: result.invoiceId,
                invoiceStatus: result.invoiceStatus,
                paymentId: result.paymentId,
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
    // Reverse a payment (immutable): creates a reversing journal entry and updates invoice totals.
    // POST /companies/:companyId/invoices/:invoiceId/payments/:paymentId/reverse
    fastify.post('/companies/:companyId/invoices/:invoiceId/payments/:paymentId/reverse', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const invoiceId = Number(request.params?.invoiceId);
        const paymentId = Number(request.params?.paymentId);
        if (!companyId || Number.isNaN(invoiceId) || Number.isNaN(paymentId)) {
            reply.status(400);
            return { error: 'invalid companyId, invoiceId, or paymentId' };
        }
        const idempotencyKey = request.headers?.['idempotency-key'];
        if (!idempotencyKey) {
            reply.status(400);
            return { error: 'Idempotency-Key header is required' };
        }
        const body = (request.body ?? {});
        const reversalDate = parseDateInput(body.date) ?? new Date();
        if (body.date && isNaN(reversalDate.getTime())) {
            reply.status(400);
            return { error: 'invalid date (must be ISO string)' };
        }
        const occurredAt = isoNow();
        const correlationId = randomUUID();
        try {
            const lockKey = `lock:payment:reverse:${companyId}:${paymentId}`;
            const { replay, response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const txResult = await prisma.$transaction(async (tx) => {
                    const payment = await tx.payment.findFirst({
                        where: { id: paymentId, companyId, invoiceId },
                        include: {
                            invoice: { select: { id: true, total: true, amountPaid: true, status: true, invoiceNumber: true } },
                            journalEntry: { include: { lines: true } },
                        },
                    });
                    if (!payment) {
                        throw Object.assign(new Error('payment not found'), { statusCode: 404 });
                    }
                    if (!payment.journalEntry) {
                        throw Object.assign(new Error('payment has no journal entry to reverse'), { statusCode: 400 });
                    }
                    if (payment.reversedAt) {
                        throw Object.assign(new Error('payment already reversed'), { statusCode: 400 });
                    }
                    const originalJeId = payment.journalEntry.id;
                    const existingReversal = await tx.journalEntry.findFirst({
                        where: { companyId, reversalOfJournalEntryId: originalJeId },
                        select: { id: true },
                    });
                    if (existingReversal) {
                        throw Object.assign(new Error('payment journal entry already reversed'), { statusCode: 400 });
                    }
                    const reversalLines = payment.journalEntry.lines.map((l) => ({
                        accountId: l.accountId,
                        debit: new Prisma.Decimal(l.credit).toDecimalPlaces(2),
                        credit: new Prisma.Decimal(l.debit).toDecimalPlaces(2),
                    }));
                    const reversalEntry = await postJournalEntry(tx, {
                        companyId,
                        date: reversalDate,
                        description: `REVERSAL of Payment ${payment.id} (Invoice ${payment.invoice.invoiceNumber})`,
                        createdByUserId: request.user?.userId ?? null,
                        reversalOfJournalEntryId: originalJeId,
                        reversalReason: body.reason ?? null,
                        skipAccountValidation: true,
                        lines: reversalLines,
                    });
                    // Recompute paid-after-refund from Payments table (source of truth) to avoid negative drift.
                    // We exclude the payment being reversed and any payments already reversed.
                    const sumAfter = await tx.payment.aggregate({
                        where: {
                            companyId,
                            invoiceId,
                            reversedAt: null,
                            id: { not: payment.id },
                        },
                        _sum: { amount: true },
                    });
                    const newPaid = (sumAfter._sum.amount ?? new Prisma.Decimal(0)).toDecimalPlaces(2);
                    const newStatus = newPaid.equals(0)
                        ? 'POSTED'
                        : newPaid.greaterThanOrEqualTo(payment.invoice.total)
                            ? 'PAID'
                            : 'PARTIAL';
                    const updInv2 = await tx.invoice.updateMany({
                        where: { id: invoiceId, companyId },
                        data: { amountPaid: newPaid, status: newStatus },
                    });
                    if (updInv2.count !== 1) {
                        throw Object.assign(new Error('invoice not found'), { statusCode: 404 });
                    }
                    const updatedInvoice = { id: invoiceId, status: newStatus };
                    // Mark payment as reversed (document audit)
                    const updPay = await tx.payment.updateMany({
                        where: { id: payment.id, companyId },
                        data: {
                            reversedAt: new Date(occurredAt),
                            reversalReason: body.reason ?? null,
                            reversalJournalEntryId: reversalEntry.id,
                            reversedByUserId: request.user?.userId ?? null,
                        },
                    });
                    if (updPay.count !== 1) {
                        throw Object.assign(new Error('payment not found'), { statusCode: 404 });
                    }
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
                        action: 'invoice.payment.reverse',
                        entityType: 'Payment',
                        entityId: payment.id,
                        idempotencyKey,
                        correlationId,
                        metadata: {
                            invoiceId: payment.invoice.id,
                            invoiceNumber: payment.invoice.invoiceNumber,
                            reversalDate,
                            reason: body.reason ?? null,
                            reversalJournalEntryId: reversalEntry.id,
                            newInvoiceStatus: updatedInvoice.status,
                            newAmountPaid: newPaid.toString(),
                        },
                    });
                    // Outbox events (ledger consistency + document semantics)
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
                            aggregateType: 'JournalEntry',
                            aggregateId: String(reversalEntry.id),
                            type: 'JournalEntryCreated',
                            payload: {
                                journalEntryId: reversalEntry.id,
                                companyId,
                                reversalOfJournalEntryId: originalJeId,
                            },
                        },
                    });
                    const reversedEventId = randomUUID();
                    await tx.event.create({
                        data: {
                            companyId,
                            eventId: reversedEventId,
                            eventType: 'journal.entry.reversed',
                            schemaVersion: 'v1',
                            occurredAt: new Date(occurredAt),
                            source: 'cashflow-api',
                            partitionKey: String(companyId),
                            correlationId,
                            aggregateType: 'JournalEntry',
                            aggregateId: String(originalJeId),
                            type: 'JournalEntryReversed',
                            payload: {
                                originalJournalEntryId: originalJeId,
                                reversalJournalEntryId: reversalEntry.id,
                                companyId,
                                reason: body.reason ?? null,
                            },
                        },
                    });
                    const paymentReversedEventId = randomUUID();
                    await tx.event.create({
                        data: {
                            companyId,
                            eventId: paymentReversedEventId,
                            eventType: 'payment.reversed',
                            schemaVersion: 'v1',
                            occurredAt: new Date(occurredAt),
                            source: 'cashflow-api',
                            partitionKey: String(companyId),
                            correlationId,
                            aggregateType: 'Payment',
                            aggregateId: String(payment.id),
                            type: 'PaymentReversed',
                            payload: {
                                paymentId: payment.id,
                                invoiceId,
                                originalJournalEntryId: originalJeId,
                                reversalJournalEntryId: reversalEntry.id,
                                amount: payment.amount.toString(),
                                reason: body.reason ?? null,
                            },
                        },
                    });
                    return {
                        paymentId: payment.id,
                        invoiceId,
                        invoiceStatus: updatedInvoice.status,
                        originalJournalEntryId: originalJeId,
                        reversalJournalEntryId: reversalEntry.id,
                        _createdEventId: createdEventId,
                        _reversedEventId: reversedEventId,
                        _paymentReversedEventId: paymentReversedEventId,
                        _correlationId: correlationId,
                        _occurredAt: occurredAt,
                    };
                }, { timeout: 10_000 });
                return txResult;
            }, redis));
            return {
                paymentId: result.paymentId,
                invoiceId: result.invoiceId,
                invoiceStatus: result.invoiceStatus,
                reversalJournalEntryId: result.reversalJournalEntryId,
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
    // --- Credit Notes (Sales returns / AR reduction) ---
    // Credit note V1:
    // - Draft creation (lines based on Items)
    // - Post: creates JE that reverses revenue: Dr INCOME, Cr AR
    // - Inventory restock is NOT applied in v1 (can be added later).
    // --- Payments list (for UI) ---
    // Sales: Payments received (customer payments against invoices)
    fastify.get('/companies/:companyId/sales/payments', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const rows = await prisma.payment.findMany({
            where: { companyId },
            orderBy: [{ paymentDate: 'desc' }, { id: 'desc' }],
            take: 200,
            include: {
                invoice: { select: { id: true, invoiceNumber: true, customer: { select: { id: true, name: true } } } },
                bankAccount: { select: { id: true, code: true, name: true } },
            },
        });
        return rows.map((p) => ({
            id: p.id,
            paymentDate: p.paymentDate,
            amount: p.amount.toString(),
            invoiceId: p.invoiceId,
            invoiceNumber: p.invoice?.invoiceNumber ?? null,
            customerId: p.invoice?.customer?.id ?? null,
            customerName: p.invoice?.customer?.name ?? null,
            bankAccountId: p.bankAccountId,
            bankAccountName: p.bankAccount ? `${p.bankAccount.code} - ${p.bankAccount.name}` : null,
            journalEntryId: p.journalEntryId ?? null,
            reversedAt: p.reversedAt ?? null,
        }));
    });
    fastify.get('/companies/:companyId/sales/payments/:paymentId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const paymentId = Number(request.params?.paymentId);
        if (Number.isNaN(paymentId)) {
            reply.status(400);
            return { error: 'invalid paymentId' };
        }
        const p = await prisma.payment.findFirst({
            where: { id: paymentId, companyId },
            include: {
                invoice: { include: { customer: true } },
                bankAccount: true,
                journalEntry: { include: { lines: { include: { account: { select: { id: true, code: true, name: true, type: true } } } } } },
                reversalJournalEntry: { include: { lines: { include: { account: { select: { id: true, code: true, name: true, type: true } } } } } },
            },
        });
        if (!p) {
            reply.status(404);
            return { error: 'payment not found' };
        }
        return p;
    });
    // Purchases: Payments made (vendor payments against Expenses and Purchase Bills)
    fastify.get('/companies/:companyId/purchases/payments', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const [expensePays, pbPays] = await Promise.all([
            prisma.expensePayment.findMany({
                where: { companyId },
                orderBy: [{ paymentDate: 'desc' }, { id: 'desc' }],
                take: 200,
                include: {
                    expense: { include: { vendor: true } },
                    bankAccount: { select: { id: true, code: true, name: true } },
                },
            }),
            prisma.purchaseBillPayment.findMany({
                where: { companyId },
                orderBy: [{ paymentDate: 'desc' }, { id: 'desc' }],
                take: 200,
                include: {
                    purchaseBill: { include: { vendor: true } },
                    bankAccount: { select: { id: true, code: true, name: true } },
                },
            }),
        ]);
        const mapped = [
            ...(expensePays ?? []).map((p) => ({
                type: 'expense',
                id: p.id,
                paymentDate: p.paymentDate,
                amount: p.amount?.toString?.() ?? String(p.amount ?? '0'),
                bankAccountId: p.bankAccountId,
                bankAccountName: p.bankAccount ? `${p.bankAccount.code} - ${p.bankAccount.name}` : null,
                referenceId: p.expenseId,
                referenceNumber: p.expense?.expenseNumber ?? null,
                vendorName: p.expense?.vendor?.name ?? null,
                journalEntryId: p.journalEntryId ?? null,
                reversedAt: p.reversedAt ?? null,
            })),
            ...(pbPays ?? []).map((p) => ({
                type: 'purchase-bill',
                id: p.id,
                paymentDate: p.paymentDate,
                amount: p.amount?.toString?.() ?? String(p.amount ?? '0'),
                bankAccountId: p.bankAccountId,
                bankAccountName: p.bankAccount ? `${p.bankAccount.code} - ${p.bankAccount.name}` : null,
                referenceId: p.purchaseBillId,
                referenceNumber: p.purchaseBill?.billNumber ?? null,
                vendorName: p.purchaseBill?.vendor?.name ?? null,
                journalEntryId: p.journalEntryId ?? null,
                reversedAt: p.reversedAt ?? null,
            })),
        ];
        mapped.sort((a, b) => {
            const ad = new Date(a.paymentDate).getTime();
            const bd = new Date(b.paymentDate).getTime();
            if (bd !== ad)
                return bd - ad;
            return Number(b.id) - Number(a.id);
        });
        return mapped.slice(0, 200);
    });
    fastify.get('/companies/:companyId/purchases/payments/:paymentType/:paymentId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const paymentType = String(request.params?.paymentType ?? '').toLowerCase();
        const paymentId = Number(request.params?.paymentId);
        if (Number.isNaN(paymentId)) {
            reply.status(400);
            return { error: 'invalid paymentId' };
        }
        if (paymentType === 'expense') {
            const p = await prisma.expensePayment.findFirst({
                where: { id: paymentId, companyId },
                include: {
                    expense: { include: { vendor: true } },
                    bankAccount: true,
                    journalEntry: { include: { lines: { include: { account: { select: { id: true, code: true, name: true, type: true } } } } } },
                    reversalJournalEntry: { include: { lines: { include: { account: { select: { id: true, code: true, name: true, type: true } } } } } },
                },
            });
            if (!p) {
                reply.status(404);
                return { error: 'payment not found' };
            }
            return { type: 'expense', payment: p };
        }
        if (paymentType === 'purchase-bill') {
            const p = await prisma.purchaseBillPayment.findFirst({
                where: { id: paymentId, companyId },
                include: {
                    purchaseBill: { include: { vendor: true, warehouse: true } },
                    bankAccount: true,
                    journalEntry: { include: { lines: { include: { account: { select: { id: true, code: true, name: true, type: true } } } } } },
                    reversalJournalEntry: { include: { lines: { include: { account: { select: { id: true, code: true, name: true, type: true } } } } } },
                },
            });
            if (!p) {
                reply.status(404);
                return { error: 'payment not found' };
            }
            return { type: 'purchase-bill', payment: p };
        }
        reply.status(400);
        return { error: 'invalid paymentType (use expense or purchase-bill)' };
    });
    // List credit notes
    fastify.get('/companies/:companyId/credit-notes', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const rows = await prisma.creditNote.findMany({
            where: { companyId },
            orderBy: [{ creditNoteDate: 'desc' }, { id: 'desc' }],
            include: { customer: true },
        });
        return rows.map((cn) => ({
            id: cn.id,
            creditNoteNumber: cn.creditNoteNumber,
            status: cn.status,
            creditNoteDate: cn.creditNoteDate,
            customerName: cn.customer?.name ?? null,
            total: cn.total?.toString?.() ?? String(cn.total ?? '0'),
            journalEntryId: cn.journalEntryId ?? null,
            createdAt: cn.createdAt,
        }));
    });
    // Create credit note (DRAFT)
    fastify.post('/companies/:companyId/credit-notes', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const body = request.body;
        if (!body.customerId) {
            reply.status(400);
            return { error: 'customerId is required' };
        }
        if (!body.lines?.length) {
            reply.status(400);
            return { error: 'lines is required' };
        }
        const creditNoteDate = parseDateInput(body.creditNoteDate) ?? new Date();
        if (body.creditNoteDate && isNaN(creditNoteDate.getTime())) {
            reply.status(400);
            return { error: 'invalid creditNoteDate' };
        }
        const customer = await prisma.customer.findFirst({ where: { id: Number(body.customerId), companyId } });
        if (!customer) {
            reply.status(400);
            return { error: 'customerId not found in this company' };
        }
        // Validate items and compute totals using Decimal
        const itemIds = Array.from(new Set((body.lines ?? []).map((l) => Number(l.itemId)).filter(Boolean)));
        const items = await prisma.item.findMany({
            where: { companyId, id: { in: itemIds } },
            select: { id: true, name: true, incomeAccountId: true, sellingPrice: true },
        });
        const itemById = new Map(items.map((i) => [i.id, i]));
        const requestedIncomeAccountIds = Array.from(new Set((body.lines ?? []).map((l) => Number(l.incomeAccountId ?? 0)).filter((x) => x > 0)));
        const incomeAccounts = requestedIncomeAccountIds.length === 0
            ? []
            : await prisma.account.findMany({
                where: { companyId, id: { in: requestedIncomeAccountIds }, type: AccountType.INCOME },
                select: { id: true },
            });
        const incomeIdSet = new Set(incomeAccounts.map((a) => a.id));
        for (const id of requestedIncomeAccountIds) {
            if (!incomeIdSet.has(id)) {
                reply.status(400);
                return { error: `incomeAccountId ${id} must be an INCOME account in this company` };
            }
        }
        let subtotal = new Prisma.Decimal(0);
        let taxAmount = new Prisma.Decimal(0);
        let total = new Prisma.Decimal(0);
        const computedLines = [];
        for (const [idx, l] of (body.lines ?? []).entries()) {
            const itemId = Number(l.itemId);
            if (!itemId || Number.isNaN(itemId)) {
                reply.status(400);
                return { error: `lines[${idx}].itemId is required` };
            }
            const item = itemById.get(itemId);
            if (!item) {
                reply.status(400);
                return { error: `lines[${idx}].itemId not found in this company` };
            }
            const qty = toMoneyDecimal(l.quantity ?? 0);
            if (qty.lessThanOrEqualTo(0)) {
                reply.status(400);
                return { error: `lines[${idx}].quantity must be > 0` };
            }
            const unit = toMoneyDecimal(l.unitPrice ?? Number(item.sellingPrice ?? 0));
            if (unit.lessThanOrEqualTo(0)) {
                reply.status(400);
                return { error: `lines[${idx}].unitPrice must be > 0` };
            }
            const lineSubtotal = qty.mul(unit).toDecimalPlaces(2);
            const discount = toMoneyDecimal(l.discountAmount ?? 0).toDecimalPlaces(2);
            if (discount.lessThan(0) || discount.greaterThan(lineSubtotal)) {
                reply.status(400);
                return { error: `lines[${idx}].discountAmount must be between 0 and line subtotal` };
            }
            const netSubtotal = lineSubtotal.sub(discount).toDecimalPlaces(2);
            const rate = new Prisma.Decimal(Number(l.taxRate ?? 0)).toDecimalPlaces(4);
            if (rate.lessThan(0) || rate.greaterThan(1)) {
                reply.status(400);
                return { error: `lines[${idx}].taxRate must be between 0 and 1 (e.g., 0.07 for 7%)` };
            }
            const lineTax = netSubtotal.mul(rate).toDecimalPlaces(2);
            const lineTotal = netSubtotal.add(lineTax).toDecimalPlaces(2);
            subtotal = subtotal.add(netSubtotal);
            taxAmount = taxAmount.add(lineTax);
            total = total.add(lineTotal);
            computedLines.push({
                companyId,
                itemId: item.id,
                description: l.description ?? item.name ?? null,
                quantity: qty,
                unitPrice: unit,
                discountAmount: discount,
                lineTotal: netSubtotal, // store net subtotal (after discount), tax is stored separately
                taxRate: rate,
                taxAmount: lineTax,
                incomeAccountId: Number(l.incomeAccountId ?? 0) || null,
            });
        }
        subtotal = subtotal.toDecimalPlaces(2);
        taxAmount = taxAmount.toDecimalPlaces(2);
        total = total.toDecimalPlaces(2);
        const created = await prisma.$transaction(async (tx) => {
            const salesIncomeAccountId = await ensureSalesIncomeAccount(tx, companyId);
            const creditNoteNumber = await nextCreditNoteNumber(tx, companyId);
            return await tx.creditNote.create({
                data: {
                    companyId,
                    invoiceId: body.invoiceId ? Number(body.invoiceId) : null,
                    customerId: customer.id,
                    creditNoteNumber,
                    status: 'DRAFT',
                    creditNoteDate,
                    currency: body.currency ?? null,
                    subtotal,
                    taxAmount,
                    total,
                    customerNotes: body.customerNotes !== undefined && body.customerNotes !== null ? String(body.customerNotes) : null,
                    termsAndConditions: body.termsAndConditions !== undefined && body.termsAndConditions !== null
                        ? String(body.termsAndConditions)
                        : null,
                    lines: {
                        create: computedLines.map((l, idx) => ({
                            ...l,
                            invoiceLineId: Number((body.lines ?? [])[idx]?.invoiceLineId ?? 0) || null,
                            incomeAccountId: l.incomeAccountId ?? salesIncomeAccountId,
                        })),
                    },
                },
                include: { customer: true, lines: creditNoteLinesIncludeWithIncomeAccount },
            });
        });
        return created;
    });
    // Update credit note (DRAFT only)
    fastify.put('/companies/:companyId/credit-notes/:creditNoteId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const creditNoteId = Number(request.params?.creditNoteId);
        if (!companyId || Number.isNaN(creditNoteId)) {
            reply.status(400);
            return { error: 'invalid companyId or creditNoteId' };
        }
        const body = request.body;
        if (!body.customerId) {
            reply.status(400);
            return { error: 'customerId is required' };
        }
        if (!body.lines?.length) {
            reply.status(400);
            return { error: 'lines is required' };
        }
        const creditNoteDate = parseDateInput(body.creditNoteDate) ?? new Date();
        if (body.creditNoteDate && isNaN(creditNoteDate.getTime())) {
            reply.status(400);
            return { error: 'invalid creditNoteDate' };
        }
        const customer = await prisma.customer.findFirst({ where: { id: Number(body.customerId), companyId } });
        if (!customer) {
            reply.status(400);
            return { error: 'customerId not found in this company' };
        }
        // Validate items and compute totals using Decimal (same as create).
        const itemIds = Array.from(new Set((body.lines ?? []).map((l) => Number(l.itemId)).filter(Boolean)));
        const items = await prisma.item.findMany({
            where: { companyId, id: { in: itemIds } },
            select: { id: true, name: true, incomeAccountId: true, sellingPrice: true },
        });
        const itemById = new Map(items.map((i) => [i.id, i]));
        const requestedIncomeAccountIds = Array.from(new Set((body.lines ?? []).map((l) => Number(l.incomeAccountId ?? 0)).filter((x) => x > 0)));
        const incomeAccounts = requestedIncomeAccountIds.length === 0
            ? []
            : await prisma.account.findMany({
                where: { companyId, id: { in: requestedIncomeAccountIds }, type: AccountType.INCOME },
                select: { id: true },
            });
        const incomeIdSet = new Set(incomeAccounts.map((a) => a.id));
        for (const id of requestedIncomeAccountIds) {
            if (!incomeIdSet.has(id)) {
                reply.status(400);
                return { error: `incomeAccountId ${id} must be an INCOME account in this company` };
            }
        }
        let subtotal = new Prisma.Decimal(0);
        let taxAmount = new Prisma.Decimal(0);
        let total = new Prisma.Decimal(0);
        const computedLines = [];
        for (const [idx, l] of (body.lines ?? []).entries()) {
            const itemId = Number(l.itemId);
            if (!itemId || Number.isNaN(itemId)) {
                reply.status(400);
                return { error: `lines[${idx}].itemId is required` };
            }
            const item = itemById.get(itemId);
            if (!item) {
                reply.status(400);
                return { error: `lines[${idx}].itemId not found in this company` };
            }
            const qty = toMoneyDecimal(l.quantity ?? 0);
            if (qty.lessThanOrEqualTo(0)) {
                reply.status(400);
                return { error: `lines[${idx}].quantity must be > 0` };
            }
            const unit = toMoneyDecimal(l.unitPrice ?? Number(item.sellingPrice ?? 0));
            if (unit.lessThanOrEqualTo(0)) {
                reply.status(400);
                return { error: `lines[${idx}].unitPrice must be > 0` };
            }
            const lineSubtotal = qty.mul(unit).toDecimalPlaces(2);
            const discount = toMoneyDecimal(l.discountAmount ?? 0).toDecimalPlaces(2);
            if (discount.lessThan(0) || discount.greaterThan(lineSubtotal)) {
                reply.status(400);
                return { error: `lines[${idx}].discountAmount must be between 0 and line subtotal` };
            }
            const netSubtotal = lineSubtotal.sub(discount).toDecimalPlaces(2);
            const rate = new Prisma.Decimal(Number(l.taxRate ?? 0)).toDecimalPlaces(4);
            if (rate.lessThan(0) || rate.greaterThan(1)) {
                reply.status(400);
                return { error: `lines[${idx}].taxRate must be between 0 and 1 (e.g., 0.07 for 7%)` };
            }
            const lineTax = netSubtotal.mul(rate).toDecimalPlaces(2);
            const lineTotal = netSubtotal.add(lineTax).toDecimalPlaces(2);
            subtotal = subtotal.add(netSubtotal);
            taxAmount = taxAmount.add(lineTax);
            total = total.add(lineTotal);
            computedLines.push({
                companyId,
                itemId: item.id,
                description: l.description ?? item.name ?? null,
                quantity: qty,
                unitPrice: unit,
                discountAmount: discount,
                lineTotal: netSubtotal, // store net subtotal; tax stored separately
                taxRate: rate,
                taxAmount: lineTax,
                invoiceLineId: Number(l.invoiceLineId ?? 0) || null,
                incomeAccountId: Number(l.incomeAccountId ?? 0) || null,
            });
        }
        subtotal = subtotal.toDecimalPlaces(2);
        taxAmount = taxAmount.toDecimalPlaces(2);
        total = total.toDecimalPlaces(2);
        const updated = await prisma.$transaction(async (tx) => {
            const salesIncomeAccountId = await ensureSalesIncomeAccount(tx, companyId);
            await tx.$queryRaw `
        SELECT id FROM CreditNote
        WHERE id = ${creditNoteId} AND companyId = ${companyId}
        FOR UPDATE
      `;
            const existing = await tx.creditNote.findFirst({
                where: { id: creditNoteId, companyId },
                select: { id: true, status: true, journalEntryId: true, invoiceId: true },
            });
            if (!existing) {
                throw Object.assign(new Error('credit note not found'), { statusCode: 404 });
            }
            if (existing.status !== 'DRAFT' || existing.journalEntryId) {
                throw Object.assign(new Error('only DRAFT credit notes can be edited'), { statusCode: 400 });
            }
            // Keep invoice linkage stable (switching linkage changes inventory return semantics).
            const requestedInvoiceId = body.invoiceId ? Number(body.invoiceId) : null;
            const existingInvoiceId = existing.invoiceId ? Number(existing.invoiceId) : null;
            if (requestedInvoiceId !== existingInvoiceId) {
                throw Object.assign(new Error('invoiceId cannot be changed once credit note is created'), { statusCode: 400 });
            }
            return await tx.creditNote.update({
                where: { id: creditNoteId, companyId },
                data: {
                    customerId: customer.id,
                    creditNoteDate,
                    currency: body.currency ?? null,
                    subtotal,
                    taxAmount,
                    total,
                    customerNotes: body.customerNotes !== undefined && body.customerNotes !== null ? String(body.customerNotes) : null,
                    termsAndConditions: body.termsAndConditions !== undefined && body.termsAndConditions !== null
                        ? String(body.termsAndConditions)
                        : null,
                    lines: {
                        deleteMany: {},
                        create: computedLines.map((l) => ({
                            ...l,
                            incomeAccountId: l.incomeAccountId ?? salesIncomeAccountId,
                        })),
                    },
                },
                include: { customer: true, lines: creditNoteLinesIncludeWithIncomeAccount },
            });
        });
        return updated;
    });
    // Delete credit note (DRAFT/APPROVED only)
    fastify.delete('/companies/:companyId/credit-notes/:creditNoteId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const creditNoteId = Number(request.params?.creditNoteId);
        if (!companyId || Number.isNaN(creditNoteId)) {
            reply.status(400);
            return { error: 'invalid companyId or creditNoteId' };
        }
        const idempotencyKey = request.headers?.['idempotency-key'];
        if (!idempotencyKey) {
            reply.status(400);
            return { error: 'Idempotency-Key header is required' };
        }
        const correlationId = randomUUID();
        const occurredAt = isoNow();
        const lockKey = `lock:credit-note:delete:${companyId}:${creditNoteId}`;
        try {
            const { response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const txResult = await prisma.$transaction(async (tx) => {
                    await tx.$queryRaw `
              SELECT id FROM CreditNote
              WHERE id = ${creditNoteId} AND companyId = ${companyId}
              FOR UPDATE
            `;
                    const cn = await tx.creditNote.findFirst({
                        where: { id: creditNoteId, companyId },
                        select: { id: true, status: true, creditNoteNumber: true, journalEntryId: true },
                    });
                    if (!cn)
                        throw Object.assign(new Error('credit note not found'), { statusCode: 404 });
                    if (cn.status !== 'DRAFT' && cn.status !== 'APPROVED') {
                        throw Object.assign(new Error('only DRAFT/APPROVED credit notes can be deleted'), { statusCode: 400 });
                    }
                    if (cn.journalEntryId) {
                        throw Object.assign(new Error('cannot delete a credit note that already has a journal entry'), { statusCode: 400 });
                    }
                    await tx.creditNoteLine.deleteMany({ where: { companyId, creditNoteId: cn.id } });
                    // Tenant-safe delete (enforced by our tenant isolation rules)
                    await tx.creditNote.deleteMany({ where: { id: cn.id, companyId } });
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
                        action: 'credit_note.delete_unposted',
                        entityType: 'CreditNote',
                        entityId: cn.id,
                        idempotencyKey,
                        correlationId,
                        metadata: { creditNoteNumber: cn.creditNoteNumber, status: cn.status, occurredAt },
                    });
                    return { creditNoteId: cn.id, deleted: true };
                });
                return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
            }, redis));
            return { creditNoteId: result.creditNoteId, deleted: true };
        }
        catch (err) {
            if (err?.statusCode) {
                reply.status(err.statusCode);
                return { error: err.message };
            }
            throw err;
        }
    });
    // Approve credit note (DRAFT -> APPROVED)
    fastify.post('/companies/:companyId/credit-notes/:creditNoteId/approve', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const creditNoteId = Number(request.params?.creditNoteId);
        if (!companyId || Number.isNaN(creditNoteId)) {
            reply.status(400);
            return { error: 'invalid companyId or creditNoteId' };
        }
        const correlationId = randomUUID();
        const occurredAt = isoNow();
        const updated = await prisma.$transaction(async (tx) => {
            await tx.$queryRaw `
        SELECT id FROM CreditNote
        WHERE id = ${creditNoteId} AND companyId = ${companyId}
        FOR UPDATE
      `;
            const cn = await tx.creditNote.findFirst({
                where: { id: creditNoteId, companyId },
                select: { id: true, status: true, journalEntryId: true, creditNoteNumber: true },
            });
            if (!cn)
                throw Object.assign(new Error('credit note not found'), { statusCode: 404 });
            if (cn.status !== 'DRAFT')
                throw Object.assign(new Error('only DRAFT credit notes can be approved'), { statusCode: 400 });
            if (cn.journalEntryId)
                throw Object.assign(new Error('cannot approve a credit note that already has a journal entry'), { statusCode: 400 });
            const upd = await tx.creditNote.update({
                where: { id: cn.id },
                data: { status: 'APPROVED', updatedByUserId: request.user?.userId ?? null },
                select: { id: true, status: true, creditNoteNumber: true },
            });
            await writeAuditLog(tx, {
                companyId,
                userId: request.user?.userId ?? null,
                action: 'credit_note.approve',
                entityType: 'CreditNote',
                entityId: cn.id,
                idempotencyKey: request.headers?.['idempotency-key'] ?? null,
                correlationId,
                metadata: { creditNoteNumber: cn.creditNoteNumber, fromStatus: 'DRAFT', toStatus: 'APPROVED', occurredAt },
            });
            return upd;
        });
        return updated;
    });
    // Adjust posted credit note (immutable ledger): updates the document and posts an ADJUSTMENT journal entry (delta vs original posting).
    // POST /companies/:companyId/credit-notes/:creditNoteId/adjust
    fastify.post('/companies/:companyId/credit-notes/:creditNoteId/adjust', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const creditNoteId = Number(request.params?.creditNoteId);
        if (!companyId || Number.isNaN(creditNoteId)) {
            reply.status(400);
            return { error: 'invalid companyId or creditNoteId' };
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
        if (!body.lines?.length) {
            reply.status(400);
            return { error: 'lines is required' };
        }
        const lines = body.lines;
        const adjustmentDate = parseDateInput(body.adjustmentDate) ?? new Date();
        if (body.adjustmentDate && isNaN(adjustmentDate.getTime())) {
            reply.status(400);
            return { error: 'invalid adjustmentDate' };
        }
        const correlationId = randomUUID();
        const occurredAt = isoNow();
        const lockKey = `lock:credit-note:adjust:${companyId}:${creditNoteId}`;
        try {
            const preMoves = await prisma.stockMove.findMany({
                where: { companyId, referenceType: 'CreditNote', referenceId: String(creditNoteId) },
                select: { locationId: true, itemId: true },
            });
            if ((preMoves ?? []).length > 0) {
                reply.status(400);
                return { error: 'cannot adjust an inventory-affecting credit note (void + recreate)' };
            }
            const { response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const txResult = await prisma.$transaction(async (tx) => {
                    await tx.$queryRaw `
              SELECT id FROM CreditNote
              WHERE id = ${creditNoteId} AND companyId = ${companyId}
              FOR UPDATE
            `;
                    const cn = await tx.creditNote.findFirst({
                        where: { id: creditNoteId, companyId },
                        include: { company: true, customer: true, journalEntry: { include: { lines: true } } },
                    });
                    if (!cn)
                        throw Object.assign(new Error('credit note not found'), { statusCode: 404 });
                    if (cn.status !== 'POSTED')
                        throw Object.assign(new Error('only POSTED credit notes can be adjusted'), { statusCode: 400 });
                    if (!cn.journalEntryId || !cn.journalEntry) {
                        throw Object.assign(new Error('credit note is POSTED but missing journal entry link'), { statusCode: 500 });
                    }
                    // Validate items and optional income accounts (tenant-safe)
                    const itemIds = Array.from(new Set(lines.map((l) => Number(l.itemId)).filter(Boolean)));
                    const items = (await tx.item.findMany({
                        where: { companyId, id: { in: itemIds } },
                        select: { id: true, name: true },
                    }));
                    const itemById = new Map(items.map((i) => [i.id, i]));
                    for (const [idx, l] of lines.entries()) {
                        const itemId = Number(l.itemId);
                        if (!itemId || Number.isNaN(itemId))
                            throw Object.assign(new Error(`lines[${idx}].itemId is required`), { statusCode: 400 });
                        if (!itemById.get(itemId))
                            throw Object.assign(new Error(`lines[${idx}].itemId not found in this company`), { statusCode: 400 });
                        const qty = Number(l.quantity ?? 0);
                        if (!qty || qty <= 0)
                            throw Object.assign(new Error(`lines[${idx}].quantity must be > 0`), { statusCode: 400 });
                        const unit = Number(l.unitPrice ?? 0);
                        if (!unit || unit <= 0)
                            throw Object.assign(new Error(`lines[${idx}].unitPrice must be > 0`), { statusCode: 400 });
                    }
                    const requestedIncomeAccountIds = Array.from(new Set(lines.map((l) => Number(l.incomeAccountId ?? 0)).filter((x) => x > 0)));
                    if (requestedIncomeAccountIds.length > 0) {
                        const incomeAccounts = await tx.account.findMany({
                            where: { companyId, id: { in: requestedIncomeAccountIds }, type: AccountType.INCOME },
                            select: { id: true },
                        });
                        const incomeIdSet = new Set(incomeAccounts.map((a) => a.id));
                        for (const id of requestedIncomeAccountIds) {
                            if (!incomeIdSet.has(id)) {
                                throw Object.assign(new Error(`incomeAccountId ${id} must be an INCOME account in this company`), { statusCode: 400 });
                            }
                        }
                    }
                    const salesIncomeAccountId = await ensureSalesIncomeAccount(tx, companyId);
                    let subtotal = new Prisma.Decimal(0);
                    let taxAmount = new Prisma.Decimal(0);
                    let total = new Prisma.Decimal(0);
                    const computedLines = [];
                    const incomeBuckets = new Map();
                    for (const [idx, l] of lines.entries()) {
                        const itemId = Number(l.itemId);
                        const item = itemById.get(itemId);
                        const qty = toMoneyDecimal(Number(l.quantity ?? 0));
                        const unit = toMoneyDecimal(Number(l.unitPrice ?? 0));
                        const lineSubtotal = qty.mul(unit).toDecimalPlaces(2);
                        const rate = new Prisma.Decimal(Number(l.taxRate ?? 0)).toDecimalPlaces(4);
                        if (rate.lessThan(0) || rate.greaterThan(1)) {
                            throw Object.assign(new Error(`lines[${idx}].taxRate must be between 0 and 1`), { statusCode: 400 });
                        }
                        const lineTax = lineSubtotal.mul(rate).toDecimalPlaces(2);
                        const lineTotal = lineSubtotal.add(lineTax).toDecimalPlaces(2);
                        subtotal = subtotal.add(lineSubtotal);
                        taxAmount = taxAmount.add(lineTax);
                        total = total.add(lineTotal);
                        const incomeAccountId = Number(l.incomeAccountId ?? 0) || salesIncomeAccountId;
                        const prev = incomeBuckets.get(incomeAccountId) ?? new Prisma.Decimal(0);
                        incomeBuckets.set(incomeAccountId, prev.add(lineSubtotal).toDecimalPlaces(2)); // subtotal only (exclude tax)
                        computedLines.push({
                            companyId,
                            itemId,
                            invoiceLineId: Number(l.invoiceLineId ?? 0) || null,
                            description: l.description ?? item?.name ?? null,
                            quantity: qty,
                            unitPrice: unit,
                            lineTotal, // credit note stores subtotal+tax
                            taxRate: rate,
                            taxAmount: lineTax,
                            incomeAccountId,
                        });
                    }
                    subtotal = subtotal.toDecimalPlaces(2);
                    taxAmount = taxAmount.toDecimalPlaces(2);
                    total = total.toDecimalPlaces(2);
                    const arId = cn.company.accountsReceivableAccountId;
                    if (!arId)
                        throw Object.assign(new Error('company.accountsReceivableAccountId is not set'), { statusCode: 400 });
                    const arAccount = await tx.account.findFirst({ where: { id: arId, companyId, type: AccountType.ASSET } });
                    if (!arAccount)
                        throw Object.assign(new Error('accountsReceivableAccountId must be an ASSET account in this company'), { statusCode: 400 });
                    const taxPayableAccountId = await ensureTaxPayableAccountIfNeeded(tx, companyId, taxAmount);
                    // Desired posting JE for credit note: Dr Income(subtotal), Dr Tax Payable(tax), Cr AR(total)
                    const desiredPostingLines = [
                        ...Array.from(incomeBuckets.entries()).map(([incomeAccountId, amt]) => ({
                            accountId: incomeAccountId,
                            debit: amt.toDecimalPlaces(2),
                            credit: new Prisma.Decimal(0),
                        })),
                        ...(taxAmount.greaterThan(0)
                            ? [{ accountId: taxPayableAccountId, debit: taxAmount, credit: new Prisma.Decimal(0) }]
                            : []),
                        { accountId: arAccount.id, debit: new Prisma.Decimal(0), credit: total },
                    ];
                    const originalNet = computeNetByAccount((cn.journalEntry.lines ?? []).map((l) => ({
                        accountId: l.accountId,
                        debit: l.debit,
                        credit: l.credit,
                    })));
                    const desiredNet = computeNetByAccount(desiredPostingLines);
                    const deltaNet = diffNets(originalNet, desiredNet);
                    const adjustmentLines = buildAdjustmentLinesFromNets(deltaNet);
                    const priorAdjId = Number(cn.lastAdjustmentJournalEntryId ?? 0) || null;
                    let reversedPriorAdjustmentJournalEntryId = null;
                    if (priorAdjId) {
                        const { reversal } = await createReversalJournalEntry(tx, {
                            companyId,
                            originalJournalEntryId: priorAdjId,
                            reversalDate: adjustmentDate,
                            reason: `superseded by credit note adjustment: ${String(body.reason).trim()}`,
                            createdByUserId: request.user?.userId ?? null,
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
                    let adjustmentJournalEntryId = null;
                    if (adjustmentLines.length > 0) {
                        if (adjustmentLines.length < 2) {
                            throw Object.assign(new Error('adjustment resulted in an invalid journal entry (needs >=2 lines)'), { statusCode: 400 });
                        }
                        const je = await postJournalEntry(tx, {
                            companyId,
                            date: adjustmentDate,
                            description: `ADJUSTMENT for Credit Note ${cn.creditNoteNumber}: ${String(body.reason).trim()}`,
                            createdByUserId: request.user?.userId ?? null,
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
                                payload: { journalEntryId: je.id, companyId, source: 'CreditNoteAdjustment', creditNoteId: cn.id },
                            },
                        });
                    }
                    const before = { subtotal: cn.subtotal?.toString?.() ?? null, taxAmount: cn.taxAmount?.toString?.() ?? null, total: cn.total?.toString?.() ?? null };
                    await tx.creditNote.update({
                        where: { id: cn.id },
                        data: {
                            customerNotes: body.customerNotes === undefined ? cn.customerNotes ?? null : body.customerNotes,
                            termsAndConditions: body.termsAndConditions === undefined ? cn.termsAndConditions ?? null : body.termsAndConditions,
                            subtotal,
                            taxAmount,
                            total,
                            lastAdjustmentJournalEntryId: adjustmentJournalEntryId,
                            updatedByUserId: request.user?.userId ?? null,
                            lines: { deleteMany: {}, create: computedLines },
                        },
                    });
                    const after = { subtotal: subtotal.toString(), taxAmount: taxAmount.toString(), total: total.toString() };
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
                        action: 'credit_note.adjust_posted',
                        entityType: 'CreditNote',
                        entityId: cn.id,
                        idempotencyKey,
                        correlationId,
                        metadata: {
                            creditNoteNumber: cn.creditNoteNumber,
                            reason: String(body.reason).trim(),
                            adjustmentDate,
                            priorAdjustmentJournalEntryId: priorAdjId,
                            reversedPriorAdjustmentJournalEntryId,
                            adjustmentJournalEntryId,
                            before,
                            after,
                        },
                    });
                    return {
                        creditNoteId: cn.id,
                        status: cn.status,
                        adjustmentJournalEntryId,
                        reversedPriorAdjustmentJournalEntryId,
                        total: total.toString(),
                    };
                });
                return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
            }, redis));
            return {
                creditNoteId: result.creditNoteId,
                status: result.status,
                adjustmentJournalEntryId: result.adjustmentJournalEntryId ?? null,
                reversedPriorAdjustmentJournalEntryId: result.reversedPriorAdjustmentJournalEntryId ?? null,
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
    // Void posted credit note (immutable ledger): marks credit note VOID and posts a reversal journal entry.
    // Also reverses any inventory moves created by posting the credit note.
    // POST /companies/:companyId/credit-notes/:creditNoteId/void
    fastify.post('/companies/:companyId/credit-notes/:creditNoteId/void', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const creditNoteId = Number(request.params?.creditNoteId);
        if (!companyId || Number.isNaN(creditNoteId)) {
            reply.status(400);
            return { error: 'invalid companyId or creditNoteId' };
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
        const lockKey = `lock:credit-note:void:${companyId}:${creditNoteId}`;
        try {
            const preMoves = await prisma.stockMove.findMany({
                where: { companyId, referenceType: 'CreditNote', referenceId: String(creditNoteId) },
                select: { locationId: true, itemId: true },
            });
            const stockLockKeys = Array.from(new Set((preMoves ?? []).map((m) => `lock:stock:${companyId}:${m.locationId}:${m.itemId}`)));
            const wrapped = async (fn) => stockLockKeys.length > 0
                ? withLocksBestEffort(redis, stockLockKeys, 30_000, async () => withLockBestEffort(redis, lockKey, 30_000, fn))
                : withLockBestEffort(redis, lockKey, 30_000, fn);
            const { response: result } = await wrapped(async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const txResult = await prisma.$transaction(async (tx) => {
                    await tx.$queryRaw `
              SELECT id FROM CreditNote
              WHERE id = ${creditNoteId} AND companyId = ${companyId}
              FOR UPDATE
            `;
                    const cn = await tx.creditNote.findFirst({
                        where: { id: creditNoteId, companyId },
                        include: { journalEntry: { include: { lines: true } } },
                    });
                    if (!cn)
                        throw Object.assign(new Error('credit note not found'), { statusCode: 404 });
                    if (cn.status === 'VOID') {
                        return { creditNoteId: cn.id, status: cn.status, voidJournalEntryId: cn.voidJournalEntryId ?? null, alreadyVoided: true };
                    }
                    if (cn.status !== 'POSTED')
                        throw Object.assign(new Error('only POSTED credit notes can be voided'), { statusCode: 400 });
                    if (!cn.journalEntryId || !cn.journalEntry) {
                        throw Object.assign(new Error('credit note is POSTED but missing journal entry link'), { statusCode: 500 });
                    }
                    // Reverse active adjustment first (if any)
                    const priorAdjId = Number(cn.lastAdjustmentJournalEntryId ?? 0) || null;
                    let reversedPriorAdjustmentJournalEntryId = null;
                    if (priorAdjId) {
                        const { reversal } = await createReversalJournalEntry(tx, {
                            companyId,
                            originalJournalEntryId: priorAdjId,
                            reversalDate: voidDate,
                            reason: `void credit note: ${String(body.reason).trim()}`,
                            createdByUserId: request.user?.userId ?? null,
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
                                payload: { originalJournalEntryId: priorAdjId, reversalJournalEntryId: reversal.id, companyId, reason: 'void credit note' },
                            },
                        });
                    }
                    // Capture original inventory moves (if any) before we post reversal JE.
                    const origMoves = await tx.stockMove.findMany({
                        where: { companyId, referenceType: 'CreditNote', referenceId: String(cn.id) },
                        select: { locationId: true, itemId: true, quantity: true, totalCostApplied: true },
                    });
                    const { reversal } = await createReversalJournalEntry(tx, {
                        companyId,
                        originalJournalEntryId: cn.journalEntryId,
                        reversalDate: voidDate,
                        reason: String(body.reason).trim(),
                        createdByUserId: request.user?.userId ?? null,
                    });
                    // Reverse inventory moves exactly (same totalCostApplied) using OUT overrides.
                    if ((origMoves ?? []).length > 0) {
                        for (const m of origMoves) {
                            await applyStockMoveWac(tx, {
                                companyId,
                                locationId: m.locationId,
                                itemId: m.itemId,
                                date: voidDate,
                                type: 'ADJUSTMENT',
                                direction: 'OUT',
                                quantity: new Prisma.Decimal(m.quantity).toDecimalPlaces(2),
                                unitCostApplied: new Prisma.Decimal(0),
                                totalCostApplied: new Prisma.Decimal(m.totalCostApplied).toDecimalPlaces(2),
                                referenceType: 'CreditNoteVoid',
                                referenceId: String(cn.id),
                                correlationId,
                                createdByUserId: request.user?.userId ?? null,
                                journalEntryId: null,
                            });
                        }
                        await tx.stockMove.updateMany({
                            where: { companyId, correlationId, journalEntryId: null, referenceType: 'CreditNoteVoid', referenceId: String(cn.id) },
                            data: { journalEntryId: reversal.id },
                        });
                    }
                    // Outbox events (created + reversed semantic)
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
                            causationId: String(cn.journalEntryId),
                            aggregateType: 'JournalEntry',
                            aggregateId: String(reversal.id),
                            type: 'JournalEntryCreated',
                            payload: { journalEntryId: reversal.id, companyId, reversalOfJournalEntryId: cn.journalEntryId, source: 'CreditNoteVoid', creditNoteId: cn.id },
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
                            aggregateId: String(cn.journalEntryId),
                            type: 'JournalEntryReversed',
                            payload: { originalJournalEntryId: cn.journalEntryId, reversalJournalEntryId: reversal.id, companyId, reason: String(body.reason).trim() },
                        },
                    });
                    const voidedAt = new Date();
                    await tx.creditNote.update({
                        where: { id: cn.id },
                        data: {
                            status: 'VOID',
                            voidedAt,
                            voidReason: String(body.reason).trim(),
                            voidedByUserId: request.user?.userId ?? null,
                            voidJournalEntryId: reversal.id,
                            lastAdjustmentJournalEntryId: null,
                            updatedByUserId: request.user?.userId ?? null,
                        },
                    });
                    await tx.journalEntry.updateMany({
                        where: { id: cn.journalEntryId, companyId },
                        data: {
                            voidedAt,
                            voidReason: String(body.reason).trim(),
                            voidedByUserId: request.user?.userId ?? null,
                            updatedByUserId: request.user?.userId ?? null,
                        },
                    });
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
                        action: 'credit_note.void',
                        entityType: 'CreditNote',
                        entityId: cn.id,
                        idempotencyKey,
                        correlationId,
                        metadata: {
                            reason: String(body.reason).trim(),
                            voidDate,
                            voidedAt,
                            originalJournalEntryId: cn.journalEntryId,
                            voidJournalEntryId: reversal.id,
                            priorAdjustmentJournalEntryId: priorAdjId,
                            reversedPriorAdjustmentJournalEntryId,
                            inventoryMovesReversed: (origMoves ?? []).length,
                        },
                    });
                    return { creditNoteId: cn.id, status: 'VOID', voidJournalEntryId: reversal.id };
                });
                return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
            }, redis));
            return { creditNoteId: result.creditNoteId, status: result.status, voidJournalEntryId: result.voidJournalEntryId };
        }
        catch (err) {
            if (err?.statusCode) {
                reply.status(err.statusCode);
                return { error: err.message };
            }
            throw err;
        }
    });
    // Cleanest returns: create credit note directly from an invoice.
    // POST /companies/:companyId/invoices/:invoiceId/credit-notes
    // Body: { creditNoteDate?, lines: [{ invoiceLineId, quantity }] }
    fastify.post('/companies/:companyId/invoices/:invoiceId/credit-notes', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const invoiceId = Number(request.params?.invoiceId);
        if (!companyId || Number.isNaN(invoiceId)) {
            reply.status(400);
            return { error: 'invalid companyId or invoiceId' };
        }
        const body = request.body;
        if (!body.lines?.length) {
            reply.status(400);
            return { error: 'lines is required' };
        }
        const creditNoteDate = parseDateInput(body.creditNoteDate) ?? new Date();
        if (body.creditNoteDate && isNaN(creditNoteDate.getTime())) {
            reply.status(400);
            return { error: 'invalid creditNoteDate' };
        }
        const inv = await prisma.invoice.findFirst({
            where: { id: invoiceId, companyId },
            include: { customer: true, lines: invoiceLinesIncludeWithIncomeAccount, company: true },
        });
        if (!inv) {
            reply.status(404);
            return { error: 'invoice not found' };
        }
        if (inv.status === 'DRAFT') {
            reply.status(400);
            return { error: 'cannot create credit note from a DRAFT invoice' };
        }
        // Build return lines from invoice lines and validate quantities (prevent over-return).
        const lineById = new Map((inv.lines ?? []).map((l) => [l.id, l]));
        const requested = (body.lines ?? []).map((l, idx) => {
            const invoiceLineId = Number(l.invoiceLineId);
            const qtyNum = Number(l.quantity ?? 0);
            if (!invoiceLineId || Number.isNaN(invoiceLineId)) {
                throw Object.assign(new Error(`lines[${idx}].invoiceLineId is required`), { statusCode: 400 });
            }
            if (!qtyNum || qtyNum <= 0) {
                throw Object.assign(new Error(`lines[${idx}].quantity must be > 0`), { statusCode: 400 });
            }
            const invoiceLine = lineById.get(invoiceLineId);
            if (!invoiceLine) {
                throw Object.assign(new Error(`invoiceLineId ${invoiceLineId} not found on this invoice`), { statusCode: 400 });
            }
            return { invoiceLineId, qty: toMoneyDecimal(qtyNum), invoiceLine };
        });
        // Calculate already returned quantities for this invoice (posted credit notes only)
        const returnedAgg = await prisma.creditNoteLine.groupBy({
            by: ['invoiceLineId'],
            where: {
                companyId,
                invoiceLineId: { in: requested.map((r) => r.invoiceLineId) },
                creditNote: { invoiceId: inv.id, status: 'POSTED' },
            },
            _sum: { quantity: true },
        });
        const returnedByInvoiceLineId = new Map((returnedAgg ?? []).map((r) => [
            Number(r.invoiceLineId),
            new Prisma.Decimal(r._sum.quantity ?? 0).toDecimalPlaces(2),
        ]));
        // Build computed lines using invoice unit price (cleanest) and enforce qty <= remaining.
        // IMPORTANT: Invoices DO store discount + tax per line, so returns must reverse both discount and tax
        // to keep AR and customer balance summary correct (especially for full returns).
        let subtotal = new Prisma.Decimal(0);
        let taxAmount = new Prisma.Decimal(0);
        let total = new Prisma.Decimal(0);
        const computedLines = [];
        for (const r of requested) {
            const soldQty = new Prisma.Decimal(r.invoiceLine.quantity).toDecimalPlaces(2);
            const alreadyReturned = returnedByInvoiceLineId.get(r.invoiceLineId) ?? new Prisma.Decimal(0);
            const remaining = soldQty.sub(alreadyReturned).toDecimalPlaces(2);
            if (r.qty.greaterThan(remaining)) {
                throw Object.assign(new Error(`return qty exceeds remaining qty for invoiceLineId ${r.invoiceLineId} (remaining ${remaining.toString()})`), { statusCode: 400 });
            }
            const unit = new Prisma.Decimal(r.invoiceLine.unitPrice).toDecimalPlaces(2);
            const lineSubtotal = r.qty.mul(unit).toDecimalPlaces(2);
            // Pro-rate discount by quantity (line-level absolute discount).
            const invDiscount = new Prisma.Decimal(r.invoiceLine.discountAmount ?? 0).toDecimalPlaces(2);
            const ratio = soldQty.greaterThan(0) ? r.qty.div(soldQty) : new Prisma.Decimal(0);
            const discount = invDiscount.mul(ratio).toDecimalPlaces(2);
            if (discount.lessThan(0) || discount.greaterThan(lineSubtotal)) {
                throw Object.assign(new Error(`computed discountAmount is invalid for invoiceLineId ${r.invoiceLineId}`), {
                    statusCode: 400,
                });
            }
            const netSubtotal = lineSubtotal.sub(discount).toDecimalPlaces(2);
            const rate = new Prisma.Decimal(r.invoiceLine.taxRate ?? 0).toDecimalPlaces(4);
            if (rate.lessThan(0) || rate.greaterThan(1)) {
                throw Object.assign(new Error(`invalid taxRate on invoiceLineId ${r.invoiceLineId}`), { statusCode: 400 });
            }
            // Recompute tax from net subtotal to keep consistent with stored taxRate.
            const lineTax = netSubtotal.mul(rate).toDecimalPlaces(2);
            const docLineTotal = netSubtotal.add(lineTax).toDecimalPlaces(2);
            subtotal = subtotal.add(netSubtotal);
            taxAmount = taxAmount.add(lineTax);
            total = total.add(docLineTotal);
            computedLines.push({
                companyId,
                invoiceLineId: r.invoiceLineId,
                itemId: r.invoiceLine.itemId,
                description: r.invoiceLine.description ?? r.invoiceLine.item?.name ?? null,
                quantity: r.qty,
                unitPrice: unit,
                discountAmount: discount,
                lineTotal: netSubtotal, // store tax-exclusive net subtotal; tax stored separately
                taxRate: rate,
                taxAmount: lineTax,
                incomeAccountId: Number(r.invoiceLine.incomeAccountId ?? 0) || null,
            });
        }
        subtotal = subtotal.toDecimalPlaces(2);
        taxAmount = taxAmount.toDecimalPlaces(2);
        total = total.toDecimalPlaces(2);
        const created = await prisma.$transaction(async (tx) => {
            const salesIncomeAccountId = await ensureSalesIncomeAccount(tx, companyId);
            const creditNoteNumber = await nextCreditNoteNumber(tx, companyId);
            return await tx.creditNote.create({
                data: {
                    companyId,
                    invoiceId: inv.id,
                    customerId: inv.customerId,
                    creditNoteNumber,
                    status: 'DRAFT',
                    creditNoteDate,
                    currency: inv.currency ?? null,
                    subtotal,
                    taxAmount,
                    total,
                    lines: {
                        create: computedLines.map((l) => ({
                            ...l,
                            incomeAccountId: l.incomeAccountId ?? salesIncomeAccountId,
                        })),
                    },
                },
                include: { customer: true, lines: creditNoteLinesIncludeWithIncomeAccount },
            });
        });
        return created;
    });
    // Credit note detail
    fastify.get('/companies/:companyId/credit-notes/:creditNoteId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const creditNoteId = Number(request.params?.creditNoteId);
        if (Number.isNaN(creditNoteId)) {
            reply.status(400);
            return { error: 'invalid creditNoteId' };
        }
        const cn = await prisma.creditNote.findFirst({
            where: { id: creditNoteId, companyId },
            include: {
                customer: true,
                lines: creditNoteLinesIncludeWithIncomeAccount,
                journalEntry: { include: { lines: { include: { account: { select: { id: true, code: true, name: true, type: true } } } } } },
            },
        });
        if (!cn) {
            reply.status(404);
            return { error: 'credit note not found' };
        }
        return cn;
    });
    // Post credit note: DRAFT -> POSTED (creates JE Dr INCOME / Cr AR)
    fastify.post('/companies/:companyId/credit-notes/:creditNoteId/post', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const creditNoteId = Number(request.params?.creditNoteId);
        if (!companyId || Number.isNaN(creditNoteId)) {
            reply.status(400);
            return { error: 'invalid companyId or creditNoteId' };
        }
        const idempotencyKey = request.headers?.['idempotency-key'];
        if (!idempotencyKey) {
            reply.status(400);
            return { error: 'Idempotency-Key header is required' };
        }
        const occurredAt = isoNow();
        const correlationId = randomUUID();
        const lockKey = `lock:credit-note:post:${companyId}:${creditNoteId}`;
        try {
            // Pre-read to compute stock lock keys (avoid concurrent WAC distortions under heavy return load).
            const pre = await prisma.creditNote.findFirst({
                where: { id: creditNoteId, companyId },
                select: {
                    id: true,
                    company: { select: { defaultLocationId: true } },
                    lines: {
                        select: {
                            itemId: true,
                            item: { select: { type: true, trackInventory: true, defaultLocationId: true } },
                        },
                    },
                },
            });
            if (!pre) {
                reply.status(404);
                return { error: 'credit note not found' };
            }
            let fallbackLocationId = pre.company.defaultLocationId ?? null;
            if (!fallbackLocationId) {
                const loc = await prisma.location.findFirst({ where: { companyId, isDefault: true }, select: { id: true } });
                fallbackLocationId = loc?.id ?? null;
            }
            const trackedLines = (pre.lines ?? []).filter((l) => l.item.type === 'GOODS' && l.item.trackInventory);
            if (trackedLines.length > 0) {
                const missingWh = trackedLines.some((l) => !(l.item.defaultLocationId ?? fallbackLocationId));
                if (missingWh) {
                    reply.status(400);
                    return { error: 'default location is not set (set company.defaultLocationId or item.defaultLocationId)' };
                }
            }
            const stockLockKeys = trackedLines.length === 0
                ? []
                : trackedLines.map((l) => {
                    const lid = (l.item.defaultLocationId ?? fallbackLocationId);
                    return `lock:stock:${companyId}:${lid}:${l.itemId}`;
                });
            const { response: result } = await withLocksBestEffort(redis, stockLockKeys, 30_000, async () => withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const txResult = await prisma.$transaction(async (tx) => {
                    // DB-level serialization safety
                    await tx.$queryRaw `
                SELECT id FROM CreditNote
                WHERE id = ${creditNoteId} AND companyId = ${companyId}
                FOR UPDATE
              `;
                    const cn = await tx.creditNote.findFirst({
                        where: { id: creditNoteId, companyId },
                        include: { company: true, customer: true, lines: { include: { item: true } } },
                    });
                    if (!cn)
                        throw Object.assign(new Error('credit note not found'), { statusCode: 404 });
                    if (cn.status !== 'DRAFT' && cn.status !== 'APPROVED') {
                        throw Object.assign(new Error('only DRAFT/APPROVED credit notes can be posted'), { statusCode: 400 });
                    }
                    // CRITICAL FIX #1: Currency validation - ensure credit note currency matches company baseCurrency
                    const baseCurrency = (cn.company.baseCurrency ?? '').trim().toUpperCase() || null;
                    const cnCurrency = (cn.currency ?? '').trim().toUpperCase() || null;
                    if (baseCurrency && cnCurrency && baseCurrency !== cnCurrency) {
                        throw Object.assign(new Error(`currency mismatch: credit note currency ${cnCurrency} must match company baseCurrency ${baseCurrency}`), { statusCode: 400 });
                    }
                    const arId = cn.company.accountsReceivableAccountId;
                    if (!arId) {
                        throw Object.assign(new Error('company.accountsReceivableAccountId is not set'), { statusCode: 400 });
                    }
                    const arAccount = await tx.account.findFirst({ where: { id: arId, companyId, type: AccountType.ASSET } });
                    if (!arAccount) {
                        throw Object.assign(new Error('accountsReceivableAccountId must be an ASSET account in this company'), { statusCode: 400 });
                    }
                    // Clean returns require invoice linkage for tracked inventory items (to restock at original cost/warehouse).
                    // If there is no invoice linkage, we still allow posting the credit note for financial purposes,
                    // but we treat tracked items as "credit-only" (no stock moves, no COGS reversal).
                    const sourceInvoiceId = cn.invoiceId ? Number(cn.invoiceId) : null;
                    // Inventory config for COGS reversal when we restock tracked items.
                    const invCfg = await ensureInventoryCompanyDefaults(tx, companyId);
                    const invAssetId = invCfg.inventoryAssetAccountId ?? null;
                    const cogsId = invCfg.cogsAccountId ?? null;
                    // Recompute totals + bucket by income account + compute return cost for tracked lines.
                    // Tax-aware credit notes:
                    // - revenue reversal uses subtotal (qty*unitPrice)
                    // - tax liability reversal uses sum(taxAmount)
                    // - AR reduction uses total = subtotal + tax
                    let subtotal = new Prisma.Decimal(0);
                    let taxAmount = new Prisma.Decimal(0);
                    let total = new Prisma.Decimal(0);
                    const incomeBuckets = new Map();
                    let totalReturnCost = new Prisma.Decimal(0);
                    for (const line of cn.lines ?? []) {
                        const qty = new Prisma.Decimal(line.quantity);
                        const unit = new Prisma.Decimal(line.unitPrice);
                        const lineSubtotal = qty.mul(unit).toDecimalPlaces(2);
                        const discount = new Prisma.Decimal(line.discountAmount ?? 0).toDecimalPlaces(2);
                        if (discount.lessThan(0) || discount.greaterThan(lineSubtotal)) {
                            throw Object.assign(new Error('credit note line discountAmount must be between 0 and line subtotal'), { statusCode: 400 });
                        }
                        const netSubtotal = lineSubtotal.sub(discount).toDecimalPlaces(2);
                        const lineTax = new Prisma.Decimal(line.taxAmount ?? 0).toDecimalPlaces(2);
                        const lineTotal = netSubtotal.add(lineTax).toDecimalPlaces(2);
                        subtotal = subtotal.add(netSubtotal);
                        taxAmount = taxAmount.add(lineTax);
                        total = total.add(lineTotal);
                        const incomeAccountId = line.incomeAccountId ?? line.item?.incomeAccountId;
                        if (!incomeAccountId) {
                            throw Object.assign(new Error('credit note line is missing income account mapping'), { statusCode: 400 });
                        }
                        const prev = incomeBuckets.get(incomeAccountId) ?? new Prisma.Decimal(0);
                        incomeBuckets.set(incomeAccountId, prev.add(netSubtotal));
                        const item = line.item;
                        const isTracked = item?.type === 'GOODS' && !!item?.trackInventory;
                        const hasInvoiceLink = !!sourceInvoiceId && !!line.invoiceLineId;
                        if (isTracked && hasInvoiceLink) {
                            if (!invAssetId || !cogsId) {
                                throw Object.assign(new Error('company inventory accounts not configured (inventoryAssetAccountId/cogsAccountId)'), { statusCode: 400 });
                            }
                            await ensureInventoryItem(tx, companyId, line.itemId);
                            // Clean cost + location allocation:
                            // Allocate return quantity across the original SALE_ISSUE StockMoves for this invoice+item.
                            // This guarantees the return uses the same cost basis and location(s) as the original sale.
                            const saleMoves = (await tx.stockMove.findMany({
                                where: {
                                    companyId,
                                    itemId: line.itemId,
                                    type: 'SALE_ISSUE',
                                    direction: 'OUT',
                                    referenceType: 'Invoice',
                                    referenceId: String(sourceInvoiceId),
                                },
                                orderBy: [{ locationId: 'asc' }, { id: 'asc' }],
                                select: { id: true, locationId: true, quantity: true, unitCostApplied: true },
                            }));
                            if (!saleMoves.length) {
                                throw Object.assign(new Error('cannot locate original sale stock moves for return (invoice linkage missing or inventory not tracked at sale time)'), {
                                    statusCode: 400,
                                    invoiceId: sourceInvoiceId,
                                    itemId: line.itemId,
                                });
                            }
                            // Returned qty for this invoice+item by location (posted credit notes only)
                            const returnedByLocation = (await tx.$queryRaw `
                    SELECT sm.warehouseId as locationId, SUM(sm.quantity) as qty
                    FROM StockMove sm
                    JOIN CreditNote cn2
                      ON cn2.id = CAST(sm.referenceId AS SIGNED)
                    WHERE sm.companyId = ${companyId}
                      AND sm.itemId = ${line.itemId}
                      AND sm.type = 'SALE_RETURN'
                      AND sm.direction = 'IN'
                      AND sm.referenceType = 'CreditNote'
                      AND cn2.companyId = ${companyId}
                      AND cn2.invoiceId = ${sourceInvoiceId}
                      AND cn2.status = 'POSTED'
                    GROUP BY sm.warehouseId
                  `);
                            const returnedWhMap = new Map((returnedByLocation ?? []).map((r) => [Number(r.locationId), new Prisma.Decimal(r.qty ?? 0).toDecimalPlaces(2)]));
                            // Compute remaining quantities per sale move after previous returns (FIFO per location)
                            const movesByLocation = new Map();
                            for (const m of saleMoves) {
                                const lid = Number(m.locationId);
                                const list = movesByLocation.get(lid) ?? [];
                                list.push(m);
                                movesByLocation.set(lid, list);
                            }
                            // Allocate return qty across warehouses/moves
                            let remainingToReturn = qty.toDecimalPlaces(2);
                            for (const [lid, moves] of movesByLocation.entries()) {
                                if (remainingToReturn.lessThanOrEqualTo(0))
                                    break;
                                let returnedToConsume = returnedWhMap.get(lid) ?? new Prisma.Decimal(0);
                                for (const m of moves) {
                                    if (remainingToReturn.lessThanOrEqualTo(0))
                                        break;
                                    const moveQty = new Prisma.Decimal(m.quantity).toDecimalPlaces(2);
                                    const alreadyReturnedFromThisMove = returnedToConsume.greaterThan(0)
                                        ? (returnedToConsume.lessThan(moveQty) ? returnedToConsume : moveQty)
                                        : new Prisma.Decimal(0);
                                    returnedToConsume = returnedToConsume.sub(alreadyReturnedFromThisMove).toDecimalPlaces(2);
                                    const available = moveQty.sub(alreadyReturnedFromThisMove).toDecimalPlaces(2);
                                    if (available.lessThanOrEqualTo(0))
                                        continue;
                                    const allocQty = new Prisma.Decimal(Math.min(Number(available), Number(remainingToReturn))).toDecimalPlaces(2);
                                    const unitCost = new Prisma.Decimal(m.unitCostApplied).toDecimalPlaces(2);
                                    const applied = await applyStockMoveWac(tx, {
                                        companyId,
                                        locationId: lid,
                                        itemId: line.itemId,
                                        date: cn.creditNoteDate,
                                        type: 'SALE_RETURN',
                                        direction: 'IN',
                                        quantity: allocQty,
                                        unitCostApplied: unitCost,
                                        referenceType: 'CreditNote',
                                        referenceId: String(cn.id),
                                        correlationId,
                                        createdByUserId: request.user?.userId ?? null,
                                        journalEntryId: null,
                                    });
                                    totalReturnCost = totalReturnCost
                                        .add(new Prisma.Decimal(applied.totalCostApplied))
                                        .toDecimalPlaces(2);
                                    remainingToReturn = remainingToReturn.sub(allocQty).toDecimalPlaces(2);
                                }
                            }
                            if (remainingToReturn.greaterThan(0)) {
                                throw Object.assign(new Error('return quantity exceeds remaining sold quantity for this invoice (after previous returns)'), {
                                    statusCode: 400,
                                    invoiceId: sourceInvoiceId,
                                    itemId: line.itemId,
                                    qtyRequested: qty.toString(),
                                    qtyUnallocated: remainingToReturn.toString(),
                                });
                            }
                        }
                        else if (isTracked && !hasInvoiceLink) {
                            // Credit-only for tracked goods when not linked to an invoice line.
                            // This keeps ledger correct but does NOT restock inventory. If there is a physical return,
                            // user must do an inventory adjustment or create the credit note from the original invoice.
                            // (No-op here on inventory.)
                        }
                    }
                    subtotal = subtotal.toDecimalPlaces(2);
                    taxAmount = taxAmount.toDecimalPlaces(2);
                    total = total.toDecimalPlaces(2);
                    // Ensure Tax Payable exists when needed (do NOT assume code 2100; some tenants use it for Customer Advance).
                    const taxPayableAccountId = await ensureTaxPayableAccountIfNeeded(tx, companyId, taxAmount);
                    const jeLines = [
                        // Dr Income (reduce revenue)
                        ...Array.from(incomeBuckets.entries()).map(([incomeAccountId, amount]) => ({
                            accountId: incomeAccountId,
                            debit: amount.toDecimalPlaces(2),
                            credit: new Prisma.Decimal(0),
                        })),
                        ...(taxAmount.greaterThan(0)
                            ? [
                                // Dr Tax Payable (reduce liability)
                                { accountId: taxPayableAccountId, debit: taxAmount, credit: new Prisma.Decimal(0) },
                            ]
                            : []),
                        // Cr AR (reduce receivable)
                        { accountId: arAccount.id, debit: new Prisma.Decimal(0), credit: total },
                    ];
                    // Reverse COGS if we restocked anything: Dr Inventory / Cr COGS
                    if (totalReturnCost.greaterThan(0)) {
                        jeLines.push({ accountId: invAssetId, debit: totalReturnCost, credit: new Prisma.Decimal(0) }, { accountId: cogsId, debit: new Prisma.Decimal(0), credit: totalReturnCost });
                    }
                    const je = await postJournalEntry(tx, {
                        companyId,
                        date: cn.creditNoteDate,
                        description: `Credit Note ${cn.creditNoteNumber} for ${cn.customer?.name ?? 'Customer'}`,
                        createdByUserId: request.user?.userId ?? null,
                        skipAccountValidation: true,
                        lines: jeLines,
                    });
                    // Link inventory moves to the posting JournalEntry (best-effort)
                    if (totalReturnCost.greaterThan(0)) {
                        await tx.stockMove.updateMany({
                            where: { companyId, correlationId, journalEntryId: null },
                            data: { journalEntryId: je.id },
                        });
                    }
                    const updCn = await tx.creditNote.updateMany({
                        where: { id: cn.id, companyId },
                        data: { status: 'POSTED', subtotal, taxAmount, total, journalEntryId: je.id },
                    });
                    if (updCn.count !== 1) {
                        throw Object.assign(new Error('credit note not found'), { statusCode: 404 });
                    }
                    const updated = { id: cn.id, status: 'POSTED' };
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
                    const cnPostedEventId = randomUUID();
                    await tx.event.create({
                        data: {
                            companyId,
                            eventId: cnPostedEventId,
                            eventType: 'credit_note.posted',
                            schemaVersion: 'v1',
                            occurredAt: new Date(occurredAt),
                            source: 'cashflow-api',
                            partitionKey: String(companyId),
                            correlationId,
                            aggregateType: 'CreditNote',
                            aggregateId: String(cn.id),
                            type: 'CreditNotePosted',
                            payload: { creditNoteId: cn.id, journalEntryId: je.id, total: total.toString() },
                        },
                    });
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
                        action: 'credit_note.post',
                        entityType: 'CreditNote',
                        entityId: cn.id,
                        idempotencyKey,
                        correlationId,
                        metadata: {
                            creditNoteNumber: cn.creditNoteNumber,
                            creditNoteDate: cn.creditNoteDate,
                            total: total.toString(),
                            totalReturnCost: totalReturnCost.toString(),
                            journalEntryId: je.id,
                        },
                    });
                    return {
                        creditNoteId: updated.id,
                        status: updated.status,
                        journalEntryId: je.id,
                        total: total.toString(),
                        totalReturnCost: totalReturnCost.toString(),
                    };
                });
                return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
            }, redis)));
            return result;
        }
        catch (err) {
            if (err?.statusCode) {
                reply.status(err.statusCode);
                return { error: err.message };
            }
            throw err;
        }
    });
    // --- Books: Bills / Expenses (Accounts Payable flow) ---
    // List bills
    fastify.get('/companies/:companyId/expenses', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const bills = await prisma.expense.findMany({
            where: { companyId },
            orderBy: { expenseDate: 'desc' },
            include: { vendor: true },
        });
        return bills.map((b) => ({
            id: b.id,
            expenseNumber: b.expenseNumber,
            vendorName: b.vendor?.name ?? null,
            status: b.status,
            amount: b.amount,
            amountPaid: b.amountPaid ?? 0,
            expenseDate: b.expenseDate,
            dueDate: b.dueDate ?? null,
            createdAt: b.createdAt,
        }));
    });
    // Get single bill with payments and journal entries (similar to invoice detail)
    fastify.get('/companies/:companyId/expenses/:expenseId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const expenseId = Number(request.params?.expenseId);
        if (Number.isNaN(expenseId)) {
            reply.status(400);
            return { error: 'invalid expenseId' };
        }
        const expense = await prisma.expense.findFirst({
            where: { id: expenseId, companyId },
            include: {
                vendor: true,
                expenseAccount: true,
                journalEntry: {
                    include: {
                        lines: {
                            include: {
                                account: { select: { id: true, code: true, name: true, type: true } },
                            },
                        },
                    },
                },
                payments: {
                    include: {
                        bankAccount: true,
                        journalEntry: {
                            include: {
                                lines: {
                                    include: {
                                        account: { select: { id: true, code: true, name: true, type: true } },
                                    },
                                },
                            },
                        },
                    },
                    orderBy: { paymentDate: 'desc' },
                },
            },
        });
        if (!expense) {
            reply.status(404);
            return { error: 'expense not found' };
        }
        const totalPaid = (expense.payments ?? [])
            .filter((p) => !p.reversedAt)
            .reduce((sum, p) => sum + Number(p.amount), 0);
        const journalEntries = [];
        if (expense.status !== 'DRAFT' && expense.journalEntry) {
            journalEntries.push({
                kind: 'BILL_POSTED',
                journalEntryId: expense.journalEntry.id,
                date: expense.journalEntry.date,
                description: expense.journalEntry.description,
                lines: expense.journalEntry.lines.map((l) => ({
                    account: l.account,
                    debit: l.debit.toString(),
                    credit: l.credit.toString(),
                })),
            });
        }
        for (const p of expense.payments ?? []) {
            if (p.journalEntry) {
                // If this payment reuses the same JournalEntry as the posting (paid immediately),
                // avoid showing duplicate entries in the UI.
                if (expense.journalEntry && p.journalEntry.id === expense.journalEntry.id)
                    continue;
                journalEntries.push({
                    kind: 'BILL_PAYMENT_RECORDED',
                    paymentId: p.id,
                    journalEntryId: p.journalEntry.id,
                    date: p.journalEntry.date,
                    description: p.journalEntry.description,
                    lines: p.journalEntry.lines.map((l) => ({
                        account: l.account,
                        debit: l.debit.toString(),
                        credit: l.credit.toString(),
                    })),
                });
            }
        }
        return {
            id: expense.id,
            expenseNumber: expense.expenseNumber,
            vendor: expense.vendor,
            status: expense.status,
            expenseDate: expense.expenseDate,
            dueDate: expense.dueDate ?? null,
            amount: expense.amount,
            currency: expense.currency,
            description: expense.description,
            expenseAccount: expense.expenseAccount
                ? {
                    id: expense.expenseAccount.id,
                    code: expense.expenseAccount.code,
                    name: expense.expenseAccount.name,
                    type: expense.expenseAccount.type,
                }
                : null,
            payments: (expense.payments ?? []).map((p) => ({
                id: p.id,
                paymentDate: p.paymentDate,
                amount: p.amount,
                bankAccount: {
                    id: p.bankAccount.id,
                    code: p.bankAccount.code,
                    name: p.bankAccount.name,
                },
                journalEntryId: p.journalEntry?.id ?? null,
                reversedAt: p.reversedAt ?? null,
                reversalReason: p.reversalReason ?? null,
                reversalJournalEntryId: p.reversalJournalEntryId ?? null,
            })),
            totalPaid,
            remainingBalance: Number(expense.amount) - totalPaid,
            journalEntries,
        };
    });
    // Update bill (DRAFT only): allow editing all fields before posting.
    // PUT /companies/:companyId/expenses/:expenseId
    fastify.put('/companies/:companyId/expenses/:expenseId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT, Roles.CLERK], 'OWNER, ACCOUNTANT, or CLERK');
        const expenseId = Number(request.params?.expenseId);
        if (Number.isNaN(expenseId)) {
            reply.status(400);
            return { error: 'invalid expenseId' };
        }
        const body = (request.body ?? {});
        if (!body.description || typeof body.description !== 'string' || !body.description.trim()) {
            reply.status(400);
            return { error: 'description is required' };
        }
        if (body.amount === undefined || body.amount === null || Number(body.amount) <= 0) {
            reply.status(400);
            return { error: 'amount (>0) is required' };
        }
        const expenseDate = parseDateInput(body.expenseDate) ?? new Date();
        const dueDate = body.dueDate === undefined ? undefined : body.dueDate === null ? null : parseDateInput(body.dueDate);
        if (body.expenseDate && isNaN(expenseDate.getTime())) {
            reply.status(400);
            return { error: 'invalid expenseDate' };
        }
        if (body.dueDate && dueDate && isNaN(dueDate.getTime())) {
            reply.status(400);
            return { error: 'invalid dueDate' };
        }
        // Tenant-safe validations for referenced entities.
        if (body.vendorId) {
            const vendor = await prisma.vendor.findFirst({ where: { id: body.vendorId, companyId } });
            if (!vendor) {
                reply.status(400);
                return { error: 'vendorId not found in this company' };
            }
        }
        if (body.expenseAccountId) {
            const expAcc = await prisma.account.findFirst({
                where: { id: body.expenseAccountId, companyId, type: AccountType.EXPENSE },
            });
            if (!expAcc) {
                reply.status(400);
                return { error: 'expenseAccountId must be an EXPENSE account in this company' };
            }
        }
        // Currency policy: if company has baseCurrency, document currency must match it.
        const company = await prisma.company.findFirst({
            where: { id: companyId },
            select: { baseCurrency: true },
        });
        const baseCurrency = normalizeCurrencyOrNull(company?.baseCurrency ?? null);
        const docCurrency = normalizeCurrencyOrNull(body.currency ?? null);
        if (baseCurrency) {
            // In single-currency mode, require and enforce exact match.
            enforceSingleCurrency(baseCurrency, docCurrency ?? baseCurrency);
        }
        const occurredAt = isoNow();
        const correlationId = randomUUID();
        const idempotencyKey = request.headers?.['idempotency-key'];
        try {
            const updated = await prisma.$transaction(async (tx) => {
                // Serialize draft edits to prevent lost updates.
                await tx.$queryRaw `
          SELECT id FROM Expense
          WHERE id = ${expenseId} AND companyId = ${companyId}
          FOR UPDATE
        `;
                const existing = await tx.expense.findFirst({
                    where: { id: expenseId, companyId },
                    select: { id: true, status: true, journalEntryId: true },
                });
                if (!existing) {
                    throw Object.assign(new Error('expense not found'), { statusCode: 404 });
                }
                if (existing.status !== 'DRAFT') {
                    throw Object.assign(new Error('only DRAFT expenses can be edited'), { statusCode: 400 });
                }
                if (existing.journalEntryId) {
                    throw Object.assign(new Error('cannot edit an expense that already has a journal entry'), { statusCode: 400 });
                }
                const upd = await tx.expense.updateMany({
                    where: { id: expenseId, companyId, status: 'DRAFT' },
                    data: {
                        vendorId: body.vendorId ?? null,
                        expenseDate,
                        dueDate: dueDate === undefined ? null : dueDate,
                        description: body.description.trim(),
                        amount: toMoneyDecimal(Number(body.amount)),
                        currency: body.currency === undefined ? null : docCurrency,
                        expenseAccountId: body.expenseAccountId ?? null,
                    },
                });
                if (upd.count !== 1) {
                    throw Object.assign(new Error('expense not found'), { statusCode: 404 });
                }
                const refreshed = await tx.expense.findFirst({
                    where: { id: expenseId, companyId },
                    include: { vendor: true, expenseAccount: true },
                });
                if (!refreshed) {
                    throw Object.assign(new Error('expense not found'), { statusCode: 404 });
                }
                await writeAuditLog(tx, {
                    companyId,
                    userId: request.user?.userId ?? null,
                    action: 'expense.update_draft',
                    entityType: 'Expense',
                    entityId: expenseId,
                    idempotencyKey: idempotencyKey ?? null,
                    correlationId,
                    metadata: {
                        expenseDate,
                        dueDate: dueDate === undefined ? null : dueDate,
                        vendorId: body.vendorId ?? null,
                        expenseAccountId: body.expenseAccountId ?? null,
                        amount: Number(body.amount),
                        currency: docCurrency ?? null,
                        occurredAt,
                    },
                });
                return refreshed;
            });
            return {
                id: updated.id,
                expenseNumber: updated.expenseNumber,
                status: updated.status,
                vendor: updated.vendor ?? null,
                expenseDate: updated.expenseDate,
                dueDate: updated.dueDate ?? null,
                amount: updated.amount,
                currency: updated.currency,
                description: updated.description,
                expenseAccount: updated.expenseAccount
                    ? {
                        id: updated.expenseAccount.id,
                        code: updated.expenseAccount.code,
                        name: updated.expenseAccount.name,
                        type: updated.expenseAccount.type,
                    }
                    : null,
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
    // Delete expense (DRAFT/APPROVED only)
    fastify.delete('/companies/:companyId/expenses/:expenseId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const expenseId = Number(request.params?.expenseId);
        if (Number.isNaN(expenseId)) {
            reply.status(400);
            return { error: 'invalid expenseId' };
        }
        const idempotencyKey = request.headers?.['idempotency-key'];
        if (!idempotencyKey) {
            reply.status(400);
            return { error: 'Idempotency-Key header is required' };
        }
        const correlationId = randomUUID();
        const occurredAt = isoNow();
        const lockKey = `lock:expense:delete:${companyId}:${expenseId}`;
        try {
            const { response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const txResult = await prisma.$transaction(async (tx) => {
                    await tx.$queryRaw `
              SELECT id FROM Expense
              WHERE id = ${expenseId} AND companyId = ${companyId}
              FOR UPDATE
            `;
                    const ex = await tx.expense.findFirst({
                        where: { id: expenseId, companyId },
                        select: { id: true, status: true, expenseNumber: true, journalEntryId: true },
                    });
                    if (!ex)
                        throw Object.assign(new Error('expense not found'), { statusCode: 404 });
                    if (ex.status !== 'DRAFT' && ex.status !== 'APPROVED') {
                        throw Object.assign(new Error('only DRAFT/APPROVED expenses can be deleted'), { statusCode: 400 });
                    }
                    if (ex.journalEntryId) {
                        throw Object.assign(new Error('cannot delete an expense that already has a journal entry'), { statusCode: 400 });
                    }
                    const payCount = await tx.expensePayment.count({ where: { companyId, expenseId: ex.id } });
                    if (payCount > 0)
                        throw Object.assign(new Error('cannot delete an expense that has payments'), { statusCode: 400 });
                    await tx.expense.delete({ where: { id: ex.id } });
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
                        action: 'expense.delete_unposted',
                        entityType: 'Expense',
                        entityId: ex.id,
                        idempotencyKey,
                        correlationId,
                        metadata: { expenseNumber: ex.expenseNumber, status: ex.status, occurredAt },
                    });
                    return { expenseId: ex.id, deleted: true };
                });
                return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
            }, redis));
            return { expenseId: result.expenseId, deleted: true };
        }
        catch (err) {
            if (err?.statusCode) {
                reply.status(err.statusCode);
                return { error: err.message };
            }
            throw err;
        }
    });
    // Approve expense (DRAFT -> APPROVED)
    fastify.post('/companies/:companyId/expenses/:expenseId/approve', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const expenseId = Number(request.params?.expenseId);
        if (Number.isNaN(expenseId)) {
            reply.status(400);
            return { error: 'invalid expenseId' };
        }
        const correlationId = randomUUID();
        const occurredAt = isoNow();
        const updated = await prisma.$transaction(async (tx) => {
            await tx.$queryRaw `
        SELECT id FROM Expense
        WHERE id = ${expenseId} AND companyId = ${companyId}
        FOR UPDATE
      `;
            const ex = await tx.expense.findFirst({
                where: { id: expenseId, companyId },
                select: { id: true, status: true, journalEntryId: true, expenseNumber: true },
            });
            if (!ex)
                throw Object.assign(new Error('expense not found'), { statusCode: 404 });
            if (ex.status !== 'DRAFT')
                throw Object.assign(new Error('only DRAFT expenses can be approved'), { statusCode: 400 });
            if (ex.journalEntryId)
                throw Object.assign(new Error('cannot approve an expense that already has a journal entry'), { statusCode: 400 });
            const upd = await tx.expense.update({
                where: { id: ex.id },
                data: { status: 'APPROVED', updatedByUserId: request.user?.userId ?? null },
                select: { id: true, status: true, expenseNumber: true },
            });
            await writeAuditLog(tx, {
                companyId,
                userId: request.user?.userId ?? null,
                action: 'expense.approve',
                entityType: 'Expense',
                entityId: ex.id,
                idempotencyKey: request.headers?.['idempotency-key'] ?? null,
                correlationId,
                metadata: { expenseNumber: ex.expenseNumber, fromStatus: 'DRAFT', toStatus: 'APPROVED', occurredAt },
            });
            return upd;
        });
        return updated;
    });
    // Adjust posted expense (immutable ledger): updates the document and posts an ADJUSTMENT journal entry (delta vs original posting).
    // POST /companies/:companyId/expenses/:expenseId/adjust
    fastify.post('/companies/:companyId/expenses/:expenseId/adjust', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const expenseId = Number(request.params?.expenseId);
        if (Number.isNaN(expenseId)) {
            reply.status(400);
            return { error: 'invalid expenseId' };
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
        if (body.amount === undefined || body.amount === null || Number(body.amount) <= 0) {
            reply.status(400);
            return { error: 'amount (>0) is required' };
        }
        if (!body.description || !String(body.description).trim()) {
            reply.status(400);
            return { error: 'description is required' };
        }
        const adjustmentDate = parseDateInput(body.adjustmentDate) ?? new Date();
        if (body.adjustmentDate && isNaN(adjustmentDate.getTime())) {
            reply.status(400);
            return { error: 'invalid adjustmentDate' };
        }
        const dueDate = body.dueDate === undefined ? undefined : body.dueDate === null ? null : parseDateInput(body.dueDate);
        if (body.dueDate && dueDate && isNaN(dueDate.getTime())) {
            reply.status(400);
            return { error: 'invalid dueDate' };
        }
        const correlationId = randomUUID();
        const occurredAt = isoNow();
        const lockKey = `lock:expense:adjust:${companyId}:${expenseId}`;
        try {
            const { response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const txResult = await prisma.$transaction(async (tx) => {
                    await tx.$queryRaw `
              SELECT id FROM Expense
              WHERE id = ${expenseId} AND companyId = ${companyId}
              FOR UPDATE
            `;
                    const ex = await tx.expense.findFirst({
                        where: { id: expenseId, companyId },
                        include: { company: true, journalEntry: { include: { lines: true } } },
                    });
                    if (!ex)
                        throw Object.assign(new Error('expense not found'), { statusCode: 404 });
                    if (ex.status !== 'POSTED') {
                        throw Object.assign(new Error('only POSTED expenses can be adjusted'), { statusCode: 400 });
                    }
                    if (!ex.journalEntryId || !ex.journalEntry) {
                        throw Object.assign(new Error('expense is POSTED but missing journal entry link'), { statusCode: 500 });
                    }
                    const payCount = await tx.expensePayment.count({ where: { companyId, expenseId: ex.id, reversedAt: null } });
                    if (payCount > 0) {
                        throw Object.assign(new Error('cannot adjust an expense that has payments (reverse payments first)'), { statusCode: 400 });
                    }
                    // Tenant-safe validations for referenced entities.
                    if (body.vendorId) {
                        const vendor = await tx.vendor.findFirst({ where: { id: body.vendorId, companyId } });
                        if (!vendor)
                            throw Object.assign(new Error('vendorId not found in this company'), { statusCode: 400 });
                    }
                    if (body.expenseAccountId) {
                        const expAcc = await tx.account.findFirst({
                            where: { id: body.expenseAccountId, companyId, type: AccountType.EXPENSE },
                        });
                        if (!expAcc)
                            throw Object.assign(new Error('expenseAccountId must be an EXPENSE account in this company'), { statusCode: 400 });
                    }
                    // Only support AP-style posting for adjustment (Dr Expense / Cr AP). If this was paid immediately (Cr Bank),
                    // require void + recreate (keeps cash audit clean).
                    const apId = ex.company.accountsPayableAccountId;
                    if (!apId)
                        throw Object.assign(new Error('company.accountsPayableAccountId is not set'), { statusCode: 400 });
                    const apLine = (ex.journalEntry.lines ?? []).find((l) => l.accountId === apId);
                    if (!apLine) {
                        throw Object.assign(new Error('cannot adjust a cash-paid expense (void + recreate)'), { statusCode: 400 });
                    }
                    const desiredAmount = toMoneyDecimal(Number(body.amount));
                    const desiredExpenseAccountId = Number(body.expenseAccountId ?? ex.expenseAccountId ?? 0) || null;
                    if (!desiredExpenseAccountId) {
                        throw Object.assign(new Error('expenseAccountId is required to adjust a posted expense'), { statusCode: 400 });
                    }
                    const desiredPostingLines = [
                        { accountId: desiredExpenseAccountId, debit: desiredAmount, credit: new Prisma.Decimal(0) },
                        { accountId: apId, debit: new Prisma.Decimal(0), credit: desiredAmount },
                    ];
                    const originalNet = computeNetByAccount((ex.journalEntry.lines ?? []).map((l) => ({
                        accountId: l.accountId,
                        debit: l.debit,
                        credit: l.credit,
                    })));
                    const desiredNet = computeNetByAccount(desiredPostingLines);
                    const deltaNet = diffNets(originalNet, desiredNet);
                    const adjustmentLines = buildAdjustmentLinesFromNets(deltaNet);
                    const priorAdjId = Number(ex.lastAdjustmentJournalEntryId ?? 0) || null;
                    let reversedPriorAdjustmentJournalEntryId = null;
                    if (priorAdjId) {
                        const { reversal } = await createReversalJournalEntry(tx, {
                            companyId,
                            originalJournalEntryId: priorAdjId,
                            reversalDate: adjustmentDate,
                            reason: `superseded by expense adjustment: ${String(body.reason).trim()}`,
                            createdByUserId: request.user?.userId ?? null,
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
                    let adjustmentJournalEntryId = null;
                    if (adjustmentLines.length > 0) {
                        if (adjustmentLines.length < 2) {
                            throw Object.assign(new Error('adjustment resulted in an invalid journal entry (needs >=2 lines)'), { statusCode: 400 });
                        }
                        const je = await postJournalEntry(tx, {
                            companyId,
                            date: adjustmentDate,
                            description: `ADJUSTMENT for Expense ${ex.expenseNumber}: ${String(body.reason).trim()}`,
                            createdByUserId: request.user?.userId ?? null,
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
                                payload: { journalEntryId: je.id, companyId, source: 'ExpenseAdjustment', expenseId: ex.id },
                            },
                        });
                    }
                    const before = { amount: new Prisma.Decimal(ex.amount).toDecimalPlaces(2).toString(), expenseAccountId: ex.expenseAccountId ?? null };
                    await tx.expense.update({
                        where: { id: ex.id },
                        data: {
                            vendorId: body.vendorId === undefined ? ex.vendorId ?? null : body.vendorId ?? null,
                            dueDate: dueDate === undefined ? ex.dueDate ?? null : dueDate,
                            description: String(body.description).trim(),
                            amount: desiredAmount,
                            expenseAccountId: desiredExpenseAccountId,
                            lastAdjustmentJournalEntryId: adjustmentJournalEntryId,
                            updatedByUserId: request.user?.userId ?? null,
                        },
                    });
                    const after = { amount: desiredAmount.toString(), expenseAccountId: desiredExpenseAccountId };
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
                        action: 'expense.adjust_posted',
                        entityType: 'Expense',
                        entityId: ex.id,
                        idempotencyKey,
                        correlationId,
                        metadata: {
                            expenseNumber: ex.expenseNumber,
                            reason: String(body.reason).trim(),
                            adjustmentDate,
                            priorAdjustmentJournalEntryId: priorAdjId,
                            reversedPriorAdjustmentJournalEntryId,
                            adjustmentJournalEntryId,
                            before,
                            after,
                        },
                    });
                    return { expenseId: ex.id, status: ex.status, adjustmentJournalEntryId, reversedPriorAdjustmentJournalEntryId, amount: desiredAmount.toString() };
                });
                return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
            }, redis));
            return {
                expenseId: result.expenseId,
                status: result.status,
                adjustmentJournalEntryId: result.adjustmentJournalEntryId ?? null,
                reversedPriorAdjustmentJournalEntryId: result.reversedPriorAdjustmentJournalEntryId ?? null,
                amount: result.amount,
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
    // Void posted expense (immutable ledger): marks expense VOID and posts a reversal journal entry.
    // POST /companies/:companyId/expenses/:expenseId/void
    fastify.post('/companies/:companyId/expenses/:expenseId/void', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const expenseId = Number(request.params?.expenseId);
        if (Number.isNaN(expenseId)) {
            reply.status(400);
            return { error: 'invalid expenseId' };
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
        const lockKey = `lock:expense:void:${companyId}:${expenseId}`;
        try {
            const { response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const txResult = await prisma.$transaction(async (tx) => {
                    await tx.$queryRaw `
              SELECT id FROM Expense
              WHERE id = ${expenseId} AND companyId = ${companyId}
              FOR UPDATE
            `;
                    const ex = await tx.expense.findFirst({
                        where: { id: expenseId, companyId },
                        include: { journalEntry: { include: { lines: true } } },
                    });
                    if (!ex)
                        throw Object.assign(new Error('expense not found'), { statusCode: 404 });
                    if (ex.status === 'VOID') {
                        return { expenseId: ex.id, status: ex.status, voidJournalEntryId: ex.voidJournalEntryId ?? null, alreadyVoided: true };
                    }
                    if (ex.status !== 'POSTED')
                        throw Object.assign(new Error('only POSTED expenses can be voided'), { statusCode: 400 });
                    if (!ex.journalEntryId || !ex.journalEntry)
                        throw Object.assign(new Error('expense is POSTED but missing journal entry link'), { statusCode: 500 });
                    const payCount = await tx.expensePayment.count({ where: { companyId, expenseId: ex.id, reversedAt: null } });
                    if (payCount > 0)
                        throw Object.assign(new Error('cannot void an expense that has payments (reverse payments first)'), { statusCode: 400 });
                    const priorAdjId = Number(ex.lastAdjustmentJournalEntryId ?? 0) || null;
                    let reversedPriorAdjustmentJournalEntryId = null;
                    if (priorAdjId) {
                        const { reversal } = await createReversalJournalEntry(tx, {
                            companyId,
                            originalJournalEntryId: priorAdjId,
                            reversalDate: voidDate,
                            reason: `void expense: ${String(body.reason).trim()}`,
                            createdByUserId: request.user?.userId ?? null,
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
                                payload: { originalJournalEntryId: priorAdjId, reversalJournalEntryId: reversal.id, companyId, reason: 'void expense' },
                            },
                        });
                    }
                    const { reversal } = await createReversalJournalEntry(tx, {
                        companyId,
                        originalJournalEntryId: ex.journalEntryId,
                        reversalDate: voidDate,
                        reason: String(body.reason).trim(),
                        createdByUserId: request.user?.userId ?? null,
                    });
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
                            causationId: String(ex.journalEntryId),
                            aggregateType: 'JournalEntry',
                            aggregateId: String(reversal.id),
                            type: 'JournalEntryCreated',
                            payload: { journalEntryId: reversal.id, companyId, reversalOfJournalEntryId: ex.journalEntryId, source: 'ExpenseVoid', expenseId: ex.id },
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
                            aggregateId: String(ex.journalEntryId),
                            type: 'JournalEntryReversed',
                            payload: { originalJournalEntryId: ex.journalEntryId, reversalJournalEntryId: reversal.id, companyId, reason: String(body.reason).trim() },
                        },
                    });
                    const voidedAt = new Date();
                    await tx.expense.update({
                        where: { id: ex.id },
                        data: {
                            status: 'VOID',
                            voidedAt,
                            voidReason: String(body.reason).trim(),
                            voidedByUserId: request.user?.userId ?? null,
                            voidJournalEntryId: reversal.id,
                            lastAdjustmentJournalEntryId: null,
                            updatedByUserId: request.user?.userId ?? null,
                        },
                    });
                    await tx.journalEntry.updateMany({
                        where: { id: ex.journalEntryId, companyId },
                        data: {
                            voidedAt,
                            voidReason: String(body.reason).trim(),
                            voidedByUserId: request.user?.userId ?? null,
                            updatedByUserId: request.user?.userId ?? null,
                        },
                    });
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
                        action: 'expense.void',
                        entityType: 'Expense',
                        entityId: ex.id,
                        idempotencyKey,
                        correlationId,
                        metadata: {
                            reason: String(body.reason).trim(),
                            voidDate,
                            voidedAt,
                            originalJournalEntryId: ex.journalEntryId,
                            voidJournalEntryId: reversal.id,
                            priorAdjustmentJournalEntryId: priorAdjId,
                            reversedPriorAdjustmentJournalEntryId,
                        },
                    });
                    return { expenseId: ex.id, status: 'VOID', voidJournalEntryId: reversal.id };
                });
                return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
            }, redis));
            return { expenseId: result.expenseId, status: result.status, voidJournalEntryId: result.voidJournalEntryId };
        }
        catch (err) {
            if (err?.statusCode) {
                reply.status(err.statusCode);
                return { error: err.message };
            }
            throw err;
        }
    });
    // Create bill (DRAFT)
    fastify.post('/companies/:companyId/expenses', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const body = request.body;
        if (!body.description || !body.amount || body.amount <= 0) {
            reply.status(400);
            return { error: 'description and amount (>0) are required' };
        }
        if (body.vendorId) {
            const vendor = await prisma.vendor.findFirst({ where: { id: body.vendorId, companyId } });
            if (!vendor) {
                reply.status(400);
                return { error: 'vendorId not found in this company' };
            }
        }
        if (body.expenseAccountId) {
            const expAcc = await prisma.account.findFirst({
                where: { id: body.expenseAccountId, companyId, type: AccountType.EXPENSE },
            });
            if (!expAcc) {
                reply.status(400);
                return { error: 'expenseAccountId must be an EXPENSE account in this company' };
            }
        }
        const expenseDate = parseDateInput(body.expenseDate) ?? new Date();
        const dueDate = body.dueDate ? parseDateInput(body.dueDate) : null;
        if (body.expenseDate && isNaN(expenseDate.getTime())) {
            reply.status(400);
            return { error: 'invalid expenseDate' };
        }
        if (body.dueDate && dueDate && isNaN(dueDate.getTime())) {
            reply.status(400);
            return { error: 'invalid dueDate' };
        }
        const bill = await prisma.expense.create({
            data: {
                companyId,
                vendorId: body.vendorId ?? null,
                expenseNumber: generateExpenseNumber(),
                status: 'DRAFT',
                expenseDate,
                dueDate: dueDate ?? null,
                description: body.description,
                amount: toMoneyDecimal(body.amount),
                amountPaid: new Prisma.Decimal(0),
                currency: body.currency ?? null,
                expenseAccountId: body.expenseAccountId ?? null,
            },
            include: { vendor: true, expenseAccount: true },
        });
        return bill;
    });
    // Post bill: DRAFT -> POSTED (creates JE: Dr Expense / Cr Accounts Payable)
    fastify.post('/companies/:companyId/expenses/:expenseId/post', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const expenseId = Number(request.params?.expenseId);
        if (!companyId || Number.isNaN(expenseId)) {
            reply.status(400);
            return { error: 'invalid companyId or expenseId' };
        }
        const idempotencyKey = request.headers?.['idempotency-key'];
        if (!idempotencyKey) {
            reply.status(400);
            return { error: 'Idempotency-Key header is required' };
        }
        const occurredAt = isoNow();
        const correlationId = randomUUID();
        const lockKey = `lock:bill:post:${companyId}:${expenseId}`;
        const body = (request.body ?? {});
        try {
            const { replay, response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const txResult = await prisma.$transaction(async (tx) => {
                    // DB-level serialization safety: lock the expense row so concurrent posts
                    // (with different idempotency keys) cannot double-post.
                    await tx.$queryRaw `
                SELECT id FROM Expense
                WHERE id = ${expenseId} AND companyId = ${companyId}
                FOR UPDATE
              `;
                    const bill = await tx.expense.findFirst({
                        where: { id: expenseId, companyId },
                        include: { company: true, vendor: true },
                    });
                    if (!bill)
                        throw Object.assign(new Error('expense not found'), { statusCode: 404 });
                    if (bill.status !== 'DRAFT' && bill.status !== 'APPROVED') {
                        throw Object.assign(new Error('only DRAFT/APPROVED bills can be posted'), { statusCode: 400 });
                    }
                    if (!bill.expenseAccountId) {
                        throw Object.assign(new Error('expenseAccountId is required to post a bill'), { statusCode: 400 });
                    }
                    const expAcc = await tx.account.findFirst({
                        where: { id: bill.expenseAccountId, companyId, type: AccountType.EXPENSE },
                    });
                    if (!expAcc) {
                        throw Object.assign(new Error('expenseAccountId must be an EXPENSE account in this company'), {
                            statusCode: 400,
                        });
                    }
                    const amount = new Prisma.Decimal(bill.amount).toDecimalPlaces(2);
                    const bankAccountId = Number(body.bankAccountId ?? 0) || null;
                    // Paid immediately: Dr Expense / Cr Bank (no Accounts Payable)
                    if (bankAccountId) {
                        const bankAccount = await tx.account.findFirst({
                            where: { id: bankAccountId, companyId, type: AccountType.ASSET },
                        });
                        if (!bankAccount) {
                            throw Object.assign(new Error('bankAccountId must be an ASSET account in this company'), {
                                statusCode: 400,
                            });
                        }
                        const banking = await tx.bankingAccount.findFirst({
                            where: { companyId, accountId: bankAccount.id },
                            select: { kind: true },
                        });
                        if (!banking) {
                            throw Object.assign(new Error('Paid Through must be a banking account (create it under Banking first)'), { statusCode: 400 });
                        }
                        if (banking.kind === BankingAccountKind.CREDIT_CARD) {
                            throw Object.assign(new Error('cannot pay from a credit card account'), { statusCode: 400 });
                        }
                        const je = await postJournalEntry(tx, {
                            companyId,
                            date: bill.expenseDate,
                            description: `Expense ${bill.expenseNumber}${bill.vendor ? ` for ${bill.vendor.name}` : ''}: ${bill.description}`,
                            createdByUserId: request.user?.userId ?? null,
                            skipAccountValidation: true,
                            lines: [
                                { accountId: expAcc.id, debit: amount, credit: new Prisma.Decimal(0) },
                                { accountId: bankAccount.id, debit: new Prisma.Decimal(0), credit: amount },
                            ],
                        });
                        const updBill = await tx.expense.updateMany({
                            where: { id: bill.id, companyId },
                            data: { status: 'PAID', journalEntryId: je.id, amountPaid: amount },
                        });
                        if (updBill.count !== 1) {
                            throw Object.assign(new Error('bill not found'), { statusCode: 404 });
                        }
                        const updated = { id: bill.id, status: 'PAID' };
                        await writeAuditLog(tx, {
                            companyId,
                            userId: request.user?.userId ?? null,
                            action: 'bill.post',
                            entityType: 'Expense',
                            entityId: bill.id,
                            idempotencyKey,
                            correlationId,
                            metadata: {
                                expenseNumber: bill.expenseNumber,
                                expenseDate: bill.expenseDate,
                                amount: amount.toString(),
                                paidImmediately: true,
                                bankAccountId: bankAccount.id,
                                journalEntryId: je.id,
                                newStatus: updated.status,
                            },
                        });
                        await tx.expensePayment.create({
                            data: {
                                companyId,
                                expenseId: bill.id,
                                paymentDate: bill.expenseDate,
                                amount,
                                bankAccountId: bankAccount.id,
                                journalEntryId: je.id,
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
                                aggregateType: 'JournalEntry',
                                aggregateId: String(je.id),
                                type: 'JournalEntryCreated',
                                payload: { journalEntryId: je.id, companyId },
                            },
                        });
                        const billPostedEventId = randomUUID();
                        await tx.event.create({
                            data: {
                                companyId,
                                eventId: billPostedEventId,
                                eventType: 'bill.posted',
                                schemaVersion: 'v1',
                                occurredAt: new Date(occurredAt),
                                source: 'cashflow-api',
                                partitionKey: String(companyId),
                                correlationId,
                                aggregateType: 'Expense',
                                aggregateId: String(bill.id),
                                type: 'BillPosted',
                                payload: { expenseId: bill.id, journalEntryId: je.id, amount: amount.toString() },
                            },
                        });
                        return { updated, je, jeEventId, billPostedEventId };
                    }
                    const apId = bill.company.accountsPayableAccountId;
                    if (!apId) {
                        throw Object.assign(new Error('company.accountsPayableAccountId is not set'), { statusCode: 400 });
                    }
                    const apAcc = await tx.account.findFirst({
                        where: { id: apId, companyId, type: AccountType.LIABILITY },
                    });
                    if (!apAcc) {
                        throw Object.assign(new Error('accountsPayableAccountId must be a LIABILITY account in this company'), {
                            statusCode: 400,
                        });
                    }
                    const je = await postJournalEntry(tx, {
                        companyId,
                        date: bill.expenseDate,
                        description: `Bill ${bill.expenseNumber}${bill.vendor ? ` for ${bill.vendor.name}` : ''}: ${bill.description}`,
                        createdByUserId: request.user?.userId ?? null,
                        lines: [
                            { accountId: expAcc.id, debit: amount, credit: new Prisma.Decimal(0) },
                            { accountId: apAcc.id, debit: new Prisma.Decimal(0), credit: amount },
                        ],
                    });
                    const updBill2 = await tx.expense.updateMany({
                        where: { id: bill.id, companyId },
                        data: { status: 'POSTED', journalEntryId: je.id },
                    });
                    if (updBill2.count !== 1) {
                        throw Object.assign(new Error('bill not found'), { statusCode: 404 });
                    }
                    const updated = { id: bill.id, status: 'POSTED' };
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
                        action: 'bill.post',
                        entityType: 'Expense',
                        entityId: bill.id,
                        idempotencyKey,
                        correlationId,
                        metadata: {
                            expenseNumber: bill.expenseNumber,
                            expenseDate: bill.expenseDate,
                            amount: amount.toString(),
                            paidImmediately: false,
                            journalEntryId: je.id,
                            newStatus: updated.status,
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
                            aggregateType: 'JournalEntry',
                            aggregateId: String(je.id),
                            type: 'JournalEntryCreated',
                            payload: { journalEntryId: je.id, companyId },
                        },
                    });
                    const billPostedEventId = randomUUID();
                    await tx.event.create({
                        data: {
                            companyId,
                            eventId: billPostedEventId,
                            eventType: 'bill.posted',
                            schemaVersion: 'v1',
                            occurredAt: new Date(occurredAt),
                            source: 'cashflow-api',
                            partitionKey: String(companyId),
                            correlationId,
                            aggregateType: 'Expense',
                            aggregateId: String(bill.id),
                            type: 'BillPosted',
                            payload: { expenseId: bill.id, journalEntryId: je.id, amount: amount.toString() },
                        },
                    });
                    return { updated, je, jeEventId, billPostedEventId };
                });
                return {
                    expenseId: txResult.updated.id,
                    status: txResult.updated.status,
                    journalEntryId: txResult.je.id,
                    _jeEventId: txResult.jeEventId,
                    _billPostedEventId: txResult.billPostedEventId,
                    _correlationId: correlationId,
                    _occurredAt: occurredAt,
                };
            }, redis));
            return { expenseId: result.expenseId, status: result.status, journalEntryId: result.journalEntryId };
        }
        catch (err) {
            if (err?.statusCode) {
                reply.status(err.statusCode);
                return { error: err.message };
            }
            throw err;
        }
    });
    // Record bill payment: Dr AP / Cr Cash-Bank
    fastify.post('/companies/:companyId/expenses/:expenseId/payments', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const expenseId = Number(request.params?.expenseId);
        if (!companyId || Number.isNaN(expenseId)) {
            reply.status(400);
            return { error: 'invalid companyId or expenseId' };
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
        const amountNumber = body.amount;
        const occurredAt = isoNow();
        const correlationId = randomUUID();
        const lockKey = `lock:bill:payment:${companyId}:${expenseId}`;
        try {
            const { replay, response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () => runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const txResult = await prisma.$transaction(async (tx) => {
                    // DB-level serialization safety: lock the expense row so concurrent payments
                    // cannot overspend remaining balance even if Redis is unavailable.
                    await tx.$queryRaw `
                SELECT id FROM Expense
                WHERE id = ${expenseId} AND companyId = ${companyId}
                FOR UPDATE
              `;
                    const bill = await tx.expense.findFirst({
                        where: { id: expenseId, companyId },
                        include: { company: true },
                    });
                    if (!bill)
                        throw Object.assign(new Error('expense not found'), { statusCode: 404 });
                    if (bill.status !== 'POSTED' && bill.status !== 'PARTIAL') {
                        throw Object.assign(new Error('payments allowed only for POSTED or PARTIAL bills'), { statusCode: 400 });
                    }
                    // CRITICAL FIX #1: Currency validation - ensure expense currency matches company baseCurrency
                    const baseCurrency = (bill.company.baseCurrency ?? '').trim().toUpperCase() || null;
                    const billCurrency = (bill.currency ?? '').trim().toUpperCase() || null;
                    if (baseCurrency && billCurrency && baseCurrency !== billCurrency) {
                        throw Object.assign(new Error(`currency mismatch: expense currency ${billCurrency} must match company baseCurrency ${baseCurrency}`), { statusCode: 400 });
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
                    const paymentDate = parseDateInput(body.paymentDate) ?? new Date();
                    const amount = toMoneyDecimal(amountNumber);
                    const je = await postJournalEntry(tx, {
                        companyId,
                        date: paymentDate,
                        description: `Payment for Bill ${bill.expenseNumber}`,
                        createdByUserId: request.user?.userId ?? null,
                        skipAccountValidation: true,
                        lines: [
                            { accountId: apAcc.id, debit: amount, credit: new Prisma.Decimal(0) },
                            { accountId: bankAccount.id, debit: new Prisma.Decimal(0), credit: amount },
                        ],
                    });
                    const pay = await tx.expensePayment.create({
                        data: {
                            companyId,
                            expenseId: bill.id,
                            paymentDate,
                            amount,
                            bankAccountId: bankAccount.id,
                            journalEntryId: je.id,
                        },
                    });
                    const sumAgg = await tx.expensePayment.aggregate({
                        where: { expenseId: bill.id, companyId, reversedAt: null },
                        _sum: { amount: true },
                    });
                    const totalPaid = (sumAgg._sum.amount ?? new Prisma.Decimal(0)).toDecimalPlaces(2);
                    const newStatus = totalPaid.greaterThanOrEqualTo(bill.amount) ? 'PAID' : 'PARTIAL';
                    const updBill3 = await tx.expense.updateMany({
                        where: { id: bill.id, companyId },
                        data: { amountPaid: totalPaid, status: newStatus },
                    });
                    if (updBill3.count !== 1) {
                        throw Object.assign(new Error('bill not found'), { statusCode: 404 });
                    }
                    await writeAuditLog(tx, {
                        companyId,
                        userId: request.user?.userId ?? null,
                        action: 'bill.payment.create',
                        entityType: 'ExpensePayment',
                        entityId: pay.id,
                        idempotencyKey,
                        correlationId,
                        metadata: {
                            expenseId: bill.id,
                            expenseNumber: bill.expenseNumber,
                            paymentDate,
                            amount: amount.toString(),
                            bankAccountId: bankAccount.id,
                            journalEntryId: je.id,
                            newStatus,
                            newAmountPaid: totalPaid.toString(),
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
                            aggregateType: 'JournalEntry',
                            aggregateId: String(je.id),
                            type: 'JournalEntryCreated',
                            payload: { journalEntryId: je.id, companyId },
                        },
                    });
                    const paymentEventId = randomUUID();
                    await tx.event.create({
                        data: {
                            companyId,
                            eventId: paymentEventId,
                            eventType: 'bill.payment.recorded',
                            schemaVersion: 'v1',
                            occurredAt: new Date(occurredAt),
                            source: 'cashflow-api',
                            partitionKey: String(companyId),
                            correlationId,
                            aggregateType: 'ExpensePayment',
                            aggregateId: String(pay.id),
                            type: 'BillPaymentRecorded',
                            payload: { expensePaymentId: pay.id, expenseId: bill.id, journalEntryId: je.id, amount: amount.toString() },
                        },
                    });
                    return { pay, je, jeEventId, paymentEventId };
                });
                return {
                    expenseId,
                    expensePaymentId: txResult.pay.id,
                    journalEntryId: txResult.je.id,
                    _jeEventId: txResult.jeEventId,
                    _paymentEventId: txResult.paymentEventId,
                    _correlationId: correlationId,
                    _occurredAt: occurredAt,
                };
            }, redis));
            return { expenseId: result.expenseId, expensePaymentId: result.expensePaymentId, journalEntryId: result.journalEntryId };
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
//# sourceMappingURL=books.routes.js.map