import type { FastifyInstance } from 'fastify';
import { prisma } from '../../infrastructure/db.js';
import { toMoneyDecimal } from '../../utils/money.js';
import { isoNow, parseDateInput } from '../../utils/date.js';
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

function generateInvoiceNumber(): string {
  // Beginner-friendly and “good enough” for now.
  // Later we can make this per-company sequential numbers (INV-0001).
  return `INV-${Date.now()}`;
}

function generateExpenseNumber(): string {
  // Beginner-friendly and “good enough” for now.
  // Later we can make this per-company sequential numbers (BILL-0001).
  return `BILL-${Date.now()}`;
}

export async function booksRoutes(fastify: FastifyInstance) {
  // All Books endpoints are tenant-scoped and must be authenticated.
  fastify.addHook('preHandler', fastify.authenticate);
  const redis = getRedis();

  function normalizeCurrencyOrNull(input: unknown): string | null {
    if (input === undefined || input === null) return null;
    const s = String(input).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(s)) {
      throw Object.assign(new Error('currency must be a 3-letter code (e.g. MMK, USD)'), {
        statusCode: 400,
      });
    }
    return s;
  }

  function enforceSingleCurrency(companyBaseCurrency: string | null, docCurrency: string | null) {
    if (!companyBaseCurrency) return;
    if (!docCurrency) {
      throw Object.assign(new Error('currency is required when company baseCurrency is set'), {
        statusCode: 400,
      });
    }
    if (docCurrency !== companyBaseCurrency) {
      throw Object.assign(
        new Error(`currency mismatch: document currency ${docCurrency} must equal company baseCurrency ${companyBaseCurrency}`),
        { statusCode: 400 }
      );
    }
  }

  async function ensureSalesIncomeAccount(tx: any, companyId: number): Promise<number> {
    // Default revenue mapping for invoices when user doesn't care about accounting.
    // Code 4000 is our canonical "Sales Income" (seeded at company creation, but we also self-heal here).
    const existing = await tx.account.findFirst({
      where: { companyId, code: '4000', type: AccountType.INCOME },
      select: { id: true },
    });
    if (existing?.id) return existing.id;

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
  const invoiceLinesIncludeWithIncomeAccount: any = {
    include: { item: true, incomeAccount: { select: { id: true, code: true, name: true, type: true } } },
  };

  const creditNoteLinesIncludeWithIncomeAccount: any = {
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

  fastify.post('/companies/:companyId/customers', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);

    const body = request.body as {
      name?: string;
      email?: string;
      phone?: string;
      currency?: string;
      openingBalance?: number;
    };

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
        openingBalance:
          body.openingBalance === undefined ? null : toMoneyDecimal(body.openingBalance),
      },
    });

    return customer;
  });

  // --- Books: Vendors (for Accounts Payable / Bills) ---
  fastify.get('/companies/:companyId/vendors', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    return await prisma.vendor.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
    });
  });

  fastify.post('/companies/:companyId/vendors', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const body = request.body as { name?: string; email?: string; phone?: string };
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
    const itemId = Number((request.params as any)?.itemId);
    if (Number.isNaN(itemId)) {
      reply.status(400);
      return { error: 'invalid itemId' };
    }

    const item = await prisma.item.findFirst({
      where: { id: itemId, companyId },
      include: {
        incomeAccount: { select: { id: true, code: true, name: true, type: true } },
        expenseAccount: { select: { id: true, code: true, name: true, type: true } },
        defaultWarehouse: { select: { id: true, name: true, isDefault: true } },
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

    const body = request.body as {
      name?: string;
      sku?: string;
      type?: ItemType;
      sellingPrice?: number;
      costPrice?: number;
      incomeAccountId?: number;
      expenseAccountId?: number;
      trackInventory?: boolean;
      defaultWarehouseId?: number | null;
    };

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

    if (body.trackInventory && body.type !== ItemType.GOODS) {
      reply.status(400);
      return { error: 'trackInventory can only be enabled for GOODS' };
    }

    if (body.defaultWarehouseId !== undefined && body.defaultWarehouseId !== null) {
      const wh = await prisma.warehouse.findFirst({
        where: { id: body.defaultWarehouseId, companyId },
        select: { id: true },
      });
      if (!wh) {
        reply.status(400);
        return { error: 'defaultWarehouseId must be a warehouse in this company' };
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
        trackInventory: body.trackInventory ?? false,
        defaultWarehouseId: body.defaultWarehouseId ?? null,
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
    const invoiceId = Number((request.params as any)?.invoiceId);
    if (Number.isNaN(invoiceId)) {
      reply.status(400);
      return { error: 'invalid invoiceId' };
    }

    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
      include: {
        customer: true,
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
      },
    });

    if (!invoice) {
      reply.status(404);
      return { error: 'invoice not found' };
    }

    // Calculate total paid from payments (source of truth), excluding reversed payments.
    // This keeps UI correct even if Invoice.amountPaid wasn't backfilled for older invoices.
    const totalPaid = invoice.payments
      .filter((p: any) => !p.reversedAt)
      .reduce((sum, p) => sum + Number(p.amount), 0);

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

    return {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      customer: invoice.customer,
      status: invoice.status,
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      subtotal: (invoice as any).subtotal ?? null,
      taxAmount: (invoice as any).taxAmount ?? null,
      total: invoice.total,
      currency: invoice.currency,
      customerNotes: (invoice as any).customerNotes ?? null,
      termsAndConditions: (invoice as any).termsAndConditions ?? null,
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
        reversedAt: (p as any).reversedAt ?? null,
        reversalReason: (p as any).reversalReason ?? null,
        reversalJournalEntryId: (p as any).reversalJournalEntryId ?? null,
      })),
      totalPaid: totalPaid,
      remainingBalance: Number(invoice.total) - totalPaid,
      journalEntries,
    };
  });

  fastify.post('/companies/:companyId/invoices', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);

    const body = request.body as {
      customerId?: number;
      invoiceDate?: string;
      dueDate?: string;
      currency?: string;
      customerNotes?: string;
      termsAndConditions?: string;
      lines?: {
        itemId: number;
        description?: string;
        quantity: number;
        unitPrice?: number;
        // taxRate is decimal (e.g., 0.07 for 7%)
        taxRate?: number;
        // Optional per-line income account mapping (INCOME). Default UX uses Sales Income (4000).
        incomeAccountId?: number;
      }[];
    };

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
    const customerCurrency = normalizeCurrencyOrNull((customer as any).currency ?? null);

    // If baseCurrency is set, invoice currency must match it (no multi-currency yet).
    const invoiceCurrency = baseCurrency ?? requestedCurrency ?? customerCurrency;
    enforceSingleCurrency(baseCurrency, invoiceCurrency);

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

    const invoiceDate = parseDateInput(body.invoiceDate) ?? new Date();
    const dueDate = body.dueDate ? parseDateInput(body.dueDate) : null;

    // Validate optional income accounts (tenant-safe) and determine Sales Income default.
    const requestedIncomeAccountIds = Array.from(
      new Set((body.lines ?? []).map((l) => Number((l as any).incomeAccountId ?? 0)).filter((x) => x > 0))
    );
    const incomeAccounts =
      requestedIncomeAccountIds.length === 0
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
      const item = itemById.get(line.itemId)!;
      const qty = toMoneyDecimal(line.quantity);
      const unit = toMoneyDecimal(line.unitPrice ?? Number(item.sellingPrice));
      const lineSubtotal = qty.mul(unit).toDecimalPlaces(2);
      const rate = new Prisma.Decimal(Number((line as any).taxRate ?? 0)).toDecimalPlaces(4);
      if (rate.lessThan(0) || rate.greaterThan(1)) {
        throw Object.assign(new Error(`invalid taxRate for itemId ${line.itemId}: must be between 0 and 1`), {
          statusCode: 400,
        });
      }
      const lineTax = lineSubtotal.mul(rate).toDecimalPlaces(2);
      const lineTotal = lineSubtotal.add(lineTax).toDecimalPlaces(2);
      subtotal = subtotal.add(lineSubtotal);
      taxAmount = taxAmount.add(lineTax);
      total = total.add(lineTotal);

      return {
        companyId,
        itemId: item.id,
        description: line.description ?? null,
        quantity: qty,
        unitPrice: unit,
        lineTotal: lineSubtotal, // store subtotal in lineTotal for backwards compatibility
        taxRate: rate,
        taxAmount: lineTax,
        incomeAccountId: Number((line as any).incomeAccountId ?? 0) || salesIncomeAccountId,
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
        currency: invoiceCurrency,
        subtotal: subtotal.toDecimalPlaces(2),
        taxAmount: taxAmount.toDecimalPlaces(2),
        total: total.toDecimalPlaces(2), // stored but will be recomputed when posted
        customerNotes:
          body.customerNotes !== undefined && body.customerNotes !== null
            ? String(body.customerNotes)
            : null,
        termsAndConditions:
          body.termsAndConditions !== undefined && body.termsAndConditions !== null
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

  // Update invoice (DRAFT only)
  fastify.put('/companies/:companyId/invoices/:invoiceId', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const invoiceId = Number((request.params as any)?.invoiceId);
    if (!companyId || Number.isNaN(invoiceId)) {
      reply.status(400);
      return { error: 'invalid companyId or invoiceId' };
    }

    const body = request.body as {
      customerId?: number;
      invoiceDate?: string;
      dueDate?: string | null;
      currency?: string | null;
      customerNotes?: string | null;
      termsAndConditions?: string | null;
      lines?: {
        itemId: number;
        description?: string;
        quantity: number;
        unitPrice?: number;
        taxRate?: number;
        incomeAccountId?: number;
      }[];
    };

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

    // Currency policy (single-currency per company if baseCurrency is set)
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { baseCurrency: true },
    });
    const baseCurrency = normalizeCurrencyOrNull(company?.baseCurrency ?? null);
    const requestedCurrency = normalizeCurrencyOrNull((body as any).currency ?? null);
    const customerCurrency = normalizeCurrencyOrNull((customer as any).currency ?? null);
    const invoiceCurrency = baseCurrency ?? requestedCurrency ?? customerCurrency;
    enforceSingleCurrency(baseCurrency, invoiceCurrency);

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

    // Validate optional income accounts (tenant-safe) and determine Sales Income default.
    const requestedIncomeAccountIds = Array.from(
      new Set((body.lines ?? []).map((l) => Number((l as any).incomeAccountId ?? 0)).filter((x) => x > 0))
    );
    const incomeAccounts =
      requestedIncomeAccountIds.length === 0
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
      const item = itemById.get(line.itemId)!;
      const qty = toMoneyDecimal(line.quantity);
      const unit = toMoneyDecimal(line.unitPrice ?? Number((item as any).sellingPrice));
      const lineSubtotal = qty.mul(unit).toDecimalPlaces(2);
      const rate = new Prisma.Decimal(Number((line as any).taxRate ?? 0)).toDecimalPlaces(4);
      if (rate.lessThan(0) || rate.greaterThan(1)) {
        throw Object.assign(new Error(`invalid taxRate for itemId ${line.itemId}: must be between 0 and 1`), {
          statusCode: 400,
        });
      }
      const lineTax = lineSubtotal.mul(rate).toDecimalPlaces(2);
      const lineTotal = lineSubtotal.add(lineTax).toDecimalPlaces(2);
      subtotal = subtotal.add(lineSubtotal);
      taxAmount = taxAmount.add(lineTax);
      total = total.add(lineTotal);

      return {
        companyId,
        itemId: item.id,
        description: line.description ?? null,
        quantity: qty,
        unitPrice: unit,
        lineTotal: lineSubtotal, // store subtotal in lineTotal for backwards compatibility
        taxRate: rate,
        taxAmount: lineTax,
        incomeAccountId: Number((line as any).incomeAccountId ?? 0) || salesIncomeAccountId,
      };
    });

    const updated = await prisma.$transaction(async (tx) => {
      // Lock invoice row so concurrent edits don't race, and also block edits after post.
      await (tx as any).$queryRaw`
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
          invoiceDate,
          dueDate: dueDate ?? null,
          currency: invoiceCurrency,
          subtotal: subtotal.toDecimalPlaces(2),
          taxAmount: taxAmount.toDecimalPlaces(2),
          total: total.toDecimalPlaces(2),
          customerNotes:
            body.customerNotes !== undefined && body.customerNotes !== null ? String(body.customerNotes) : null,
          termsAndConditions:
            body.termsAndConditions !== undefined && body.termsAndConditions !== null
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

  // POST (confirm) an invoice: DRAFT -> POSTED creates journal entry
  fastify.post('/companies/:companyId/invoices/:invoiceId/post', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const invoiceId = Number((request.params as any)?.invoiceId);
    if (!companyId || Number.isNaN(invoiceId)) {
      reply.status(400);
      return { error: 'invalid companyId or invoiceId' };
    }

    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
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
        company: { select: { defaultWarehouseId: true } },
        lines: {
          select: {
            itemId: true,
            item: { select: { type: true, trackInventory: true, defaultWarehouseId: true } },
          },
        },
      },
    });
    if (!pre) {
      reply.status(404);
      return { error: 'invoice not found' };
    }

    let fallbackWarehouseId = pre.company.defaultWarehouseId ?? null;
    if (!fallbackWarehouseId) {
      const wh = await prisma.warehouse.findFirst({ where: { companyId, isDefault: true }, select: { id: true } });
      fallbackWarehouseId = wh?.id ?? null;
    }

    const trackedLines = pre.lines.filter((l) => l.item.type === 'GOODS' && l.item.trackInventory);
    if (trackedLines.length > 0) {
      const missingWh = trackedLines.some((l) => !(l.item.defaultWarehouseId ?? fallbackWarehouseId));
      if (missingWh) {
        reply.status(400);
        return { error: 'default warehouse is not set (set company.defaultWarehouseId or item.defaultWarehouseId)' };
      }
    }

    const stockLockKeys =
      trackedLines.length === 0
        ? []
        : trackedLines.map((l) => {
            const wid = (l.item.defaultWarehouseId ?? fallbackWarehouseId) as number;
            return `lock:stock:${companyId}:${wid}:${l.itemId}`;
          });

    const { replay, response: result } = await withLocksBestEffort(redis, stockLockKeys, 30_000, async () =>
      withLockBestEffort(redis, lockKey, 30_000, async () =>
        runIdempotentRequest(
          prisma,
          companyId,
          idempotencyKey,
          async () => {
            const txResult = await prisma.$transaction(
              async (tx) => {
          // DB-level serialization safety: lock the invoice row so concurrent posts
          // (with different idempotency keys) cannot double-post.
          await (tx as any).$queryRaw`
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
          if (invoice.status !== 'DRAFT') {
            throw Object.assign(new Error('only DRAFT invoices can be posted'), { statusCode: 400 });
          }

          // Currency policy: if company has baseCurrency, invoice currency must match it.
          const baseCurrency = normalizeCurrencyOrNull((invoice.company as any).baseCurrency ?? null);
          const invCurrency = normalizeCurrencyOrNull((invoice as any).currency ?? null);
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

          // Recompute totals from stored lines (source of truth).
          let subtotal = new Prisma.Decimal(0);
          let taxAmount = new Prisma.Decimal(0);
          const incomeBuckets = new Map<number, Prisma.Decimal>();

          for (const line of invoice.lines) {
            const qty = new Prisma.Decimal(line.quantity);
            const unit = new Prisma.Decimal(line.unitPrice);
            const lineSubtotal = qty.mul(unit).toDecimalPlaces(2);
            subtotal = subtotal.add(lineSubtotal);

            const taxRate = new Prisma.Decimal((line as any).taxRate ?? 0).toDecimalPlaces(4);
            if (taxRate.lessThan(0) || taxRate.greaterThan(1)) {
              throw Object.assign(new Error('invoice line taxRate must be between 0 and 1'), { statusCode: 400 });
            }
            const lineTax = lineSubtotal.mul(taxRate).toDecimalPlaces(2);
            taxAmount = taxAmount.add(lineTax);

            const incomeAccountId = (line as any).incomeAccountId ?? (line as any).item?.incomeAccountId;
            if (!incomeAccountId) {
              throw Object.assign(new Error('invoice line is missing income account mapping'), { statusCode: 400 });
            }
            const prev = incomeBuckets.get(incomeAccountId) ?? new Prisma.Decimal(0);
            incomeBuckets.set(incomeAccountId, prev.add(lineSubtotal)); // Revenue excludes tax
          }

          subtotal = subtotal.toDecimalPlaces(2);
          taxAmount = taxAmount.toDecimalPlaces(2);
          const total = subtotal.add(taxAmount).toDecimalPlaces(2); // Total = subtotal + tax

          // CRITICAL FIX #3: Rounding validation - ensure recomputed total matches stored total.
          // This prevents debit != credit if line-level rounding drifted from sum-then-round.
          const storedTotal = new Prisma.Decimal(invoice.total).toDecimalPlaces(2);
          if (!total.equals(storedTotal)) {
            throw Object.assign(
              new Error(
                `rounding mismatch: recomputed total ${total.toString()} != stored total ${storedTotal.toString()}. Invoice may have been corrupted.`
              ),
              { statusCode: 400, recomputedTotal: total.toString(), storedTotal: storedTotal.toString() }
            );
          }

          // Ensure Tax Payable account exists when needed (code 2100, LIABILITY).
          let taxPayableAccountId: number | null = null;
          if (taxAmount.greaterThan(0)) {
            const existing = await tx.account.findFirst({
              where: { companyId, type: AccountType.LIABILITY, code: '2100' },
              select: { id: true },
            });
            if (existing?.id) {
              taxPayableAccountId = existing.id;
            } else {
              const created = await tx.account.create({
                data: {
                  companyId,
                  code: '2100',
                  name: 'Tax Payable',
                  type: AccountType.LIABILITY,
                  normalBalance: 'CREDIT',
                  reportGroup: 'OTHER_CURRENT_LIABILITY',
                  cashflowActivity: 'OPERATING',
                },
                select: { id: true },
              });
              taxPayableAccountId = created.id;
            }
          }

          // Inventory V1: deduct stock + compute COGS (WAC) at invoice post time
          const tracked = invoice.lines.filter((l) => l.item.type === 'GOODS' && (l.item as any).trackInventory);
          let totalCogs = new Prisma.Decimal(0);

          // Resolve default warehouse for this company (required if any tracked items exist).
          let defaultWarehouseId: number | null = (invoice.company as any).defaultWarehouseId ?? null;

          if (tracked.length > 0) {
            const cfg = await ensureInventoryCompanyDefaults(tx as any, companyId);
            defaultWarehouseId = defaultWarehouseId ?? cfg.defaultWarehouseId;

            for (const line of tracked) {
              const wid = (line.item as any).defaultWarehouseId ?? defaultWarehouseId;
              const qty = new Prisma.Decimal(line.quantity).toDecimalPlaces(2);
              const applied = await applyStockMoveWac(tx as any, {
                companyId,
                warehouseId: wid,
                itemId: line.itemId,
                date: invoice.invoiceDate,
                type: 'SALE_ISSUE',
                direction: 'OUT',
                quantity: qty,
                unitCostApplied: new Prisma.Decimal(0),
                referenceType: 'Invoice',
                referenceId: String(invoice.id),
                correlationId,
                createdByUserId: (request as any).user?.userId ?? null,
                journalEntryId: null,
              });
              totalCogs = totalCogs.add(new Prisma.Decimal(applied.totalCostApplied));
            }

            totalCogs = totalCogs.toDecimalPlaces(2);
          }

          // CRITICAL FIX #5: Build journal entry lines including tax
          // Tax entry: Dr AR (total), Cr Revenue (subtotal), Cr Tax Payable (taxAmount)
          const jeLines: Array<{ accountId: number; debit: Prisma.Decimal; credit: Prisma.Decimal }> = [
            // Debit: Accounts Receivable (full amount including tax)
            { accountId: arAccount.id, debit: total, credit: new Prisma.Decimal(0) },
            // Credit: Revenue accounts (subtotal, excluding tax)
            ...Array.from(incomeBuckets.entries()).map(([incomeAccountId, amount]) => ({
              accountId: incomeAccountId,
              debit: new Prisma.Decimal(0),
              credit: amount.toDecimalPlaces(2),
            })),
          ];

          // Tax Payable (credit) when tax exists
          if (taxAmount.greaterThan(0)) {
            jeLines.push({
              accountId: taxPayableAccountId!,
              debit: new Prisma.Decimal(0),
              credit: taxAmount,
            });
          }

          // Add COGS entries for inventory-tracked items
          if (totalCogs.greaterThan(0)) {
            const invCfg = await ensureInventoryCompanyDefaults(tx as any, companyId);
            jeLines.push(
              {
                accountId: invCfg.cogsAccountId!,
                debit: totalCogs,
                credit: new Prisma.Decimal(0),
              },
              {
                accountId: invCfg.inventoryAssetAccountId!,
                debit: new Prisma.Decimal(0),
                credit: totalCogs,
              }
            );
          }

          const journalEntry = await postJournalEntry(tx, {
            companyId,
            date: invoice.invoiceDate,
            description: `Invoice ${invoice.invoiceNumber} for ${invoice.customer.name}`,
            createdByUserId: (request as any).user?.userId ?? null,
            lines: jeLines,
          });

          // Link inventory moves to the invoice posting JournalEntry (best-effort)
          if (totalCogs.greaterThan(0)) {
            await (tx as any).stockMove.updateMany({
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
          if ((upd as any).count !== 1) {
            throw Object.assign(new Error('invoice not found'), { statusCode: 404 });
          }
          const updatedInvoice = await tx.invoice.findFirst({
            where: { id: invoice.id, companyId },
            select: { id: true, status: true, total: true, journalEntryId: true },
          });
          if (!updatedInvoice) {
            throw Object.assign(new Error('invoice not found'), { statusCode: 404 });
          }

          await writeAuditLog(tx as any, {
            companyId,
            userId: (request as any).user?.userId ?? null,
            action: 'invoice.post',
            entityType: 'Invoice',
            entityId: updatedInvoice.id,
            idempotencyKey,
            correlationId,
            metadata: {
              invoiceNumber: (invoice as any).invoiceNumber,
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
              },
              { timeout: 10_000 }
            );

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
          },
          redis
        )
      )
    );

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
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const invoiceId = Number((request.params as any)?.invoiceId);
    if (!companyId || Number.isNaN(invoiceId)) {
      reply.status(400);
      return { error: 'invalid companyId or invoiceId' };
    }

    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      reply.status(400);
      return { error: 'Idempotency-Key header is required' };
    }

    const body = request.body as {
      paymentDate?: string;
      amount?: number;
      bankAccountId?: number;
      paymentMode?: 'CASH' | 'BANK' | 'E_WALLET';
    };

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

      const { replay, response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () =>
        runIdempotentRequest(
          prisma,
          companyId,
          idempotencyKey,
          async () => {
            const txResult = await prisma.$transaction(
              async (tx) => {
                // DB-level serialization safety: lock the invoice row so concurrent payments can't overspend.
                await tx.$queryRaw`
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
                const baseCurrency = normalizeCurrencyOrNull((invoice.company as any).baseCurrency ?? null);
                const invCurrency = normalizeCurrencyOrNull((invoice as any).currency ?? null);
                enforceSingleCurrency(baseCurrency, invCurrency ?? baseCurrency);

                const arAccount = await tx.account.findFirst({
                  where: {
                    id: invoice.company.accountsReceivableAccountId,
                    companyId,
                    type: AccountType.ASSET,
                  },
                });
                if (!arAccount) {
                  throw Object.assign(
                    new Error('accountsReceivableAccountId must be an ASSET account in this company'),
                    {
                      statusCode: 400,
                    }
                  );
                }

                const bankAccount = await tx.account.findFirst({
                  where: { id: body.bankAccountId!, companyId, type: AccountType.ASSET },
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
                  throw Object.assign(
                    new Error('Deposit To must be a banking account (create it under Banking first)'),
                    { statusCode: 400 }
                  );
                }
                if (banking.kind === BankingAccountKind.CREDIT_CARD) {
                  throw Object.assign(new Error('cannot deposit to a credit card account'), {
                    statusCode: 400,
                  });
                }
                // Optional: if UI sends paymentMode, enforce kind matches
                if (body.paymentMode) {
                  const expected =
                    body.paymentMode === 'CASH'
                      ? BankingAccountKind.CASH
                      : body.paymentMode === 'BANK'
                        ? BankingAccountKind.BANK
                        : BankingAccountKind.E_WALLET;
                  if (banking.kind !== expected) {
                    throw Object.assign(
                      new Error(
                        `Deposit To account kind must be ${expected} for paymentMode ${body.paymentMode}`
                      ),
                      { statusCode: 400 }
                    );
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
                  throw Object.assign(
                    new Error(`amount cannot exceed remaining balance of ${remainingBefore.toString()}`),
                    { statusCode: 400 }
                  );
                }

                const journalEntry = await postJournalEntry(tx, {
                  companyId,
                  date: paymentDate,
                  description: `Payment for Invoice ${invoice.invoiceNumber}`,
                  createdByUserId: (request as any).user?.userId ?? null,
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
                if ((updInv as any).count !== 1) {
                  throw Object.assign(new Error('invoice not found'), { statusCode: 404 });
                }
                const updatedInvoice = { id: invoice.id, status: newStatus };

                await writeAuditLog(tx as any, {
                  companyId,
                  userId: (request as any).user?.userId ?? null,
                  action: 'invoice.payment.create',
                  entityType: 'Payment',
                  entityId: payment.id,
                  idempotencyKey,
                  correlationId,
                  metadata: {
                    invoiceId: invoice.id,
                    invoiceNumber: (invoice as any).invoiceNumber,
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
              },
              { timeout: 10_000 }
            );

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
          },
          redis
        )
      );

      return {
        invoiceId: result.invoiceId,
        invoiceStatus: result.invoiceStatus,
        paymentId: result.paymentId,
        journalEntryId: result.journalEntryId,
      };
    } catch (err: any) {
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
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const invoiceId = Number((request.params as any)?.invoiceId);
    const paymentId = Number((request.params as any)?.paymentId);
    if (!companyId || Number.isNaN(invoiceId) || Number.isNaN(paymentId)) {
      reply.status(400);
      return { error: 'invalid companyId, invoiceId, or paymentId' };
    }

    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      reply.status(400);
      return { error: 'Idempotency-Key header is required' };
    }

    const body = (request.body ?? {}) as { reason?: string; date?: string };
    const reversalDate = parseDateInput(body.date) ?? new Date();
    if (body.date && isNaN(reversalDate.getTime())) {
      reply.status(400);
      return { error: 'invalid date (must be ISO string)' };
    }

    const occurredAt = isoNow();
    const correlationId = randomUUID();

    try {
      const lockKey = `lock:payment:reverse:${companyId}:${paymentId}`;

      const { replay, response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () =>
        runIdempotentRequest(
          prisma,
          companyId,
          idempotencyKey,
          async () => {
            const txResult = await prisma.$transaction(
              async (tx) => {
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
              if ((payment as any).reversedAt) {
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

              const reversalLines = payment.journalEntry.lines.map((l: any) => ({
                accountId: l.accountId,
                debit: new Prisma.Decimal(l.credit).toDecimalPlaces(2),
                credit: new Prisma.Decimal(l.debit).toDecimalPlaces(2),
              }));

              const reversalEntry = await postJournalEntry(tx, {
                companyId,
                date: reversalDate,
                description: `REVERSAL of Payment ${payment.id} (Invoice ${payment.invoice.invoiceNumber})`,
                createdByUserId: (request as any).user?.userId ?? null,
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
              if ((updInv2 as any).count !== 1) {
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
                  reversedByUserId: (request as any).user?.userId ?? null,
                },
              });
              if ((updPay as any).count !== 1) {
                throw Object.assign(new Error('payment not found'), { statusCode: 404 });
              }

              await writeAuditLog(tx as any, {
                companyId,
                userId: (request as any).user?.userId ?? null,
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
              },
              { timeout: 10_000 }
            );

            return txResult;
          },
          redis
        )
      );

      return {
        paymentId: result.paymentId,
        invoiceId: result.invoiceId,
        invoiceStatus: result.invoiceStatus,
        reversalJournalEntryId: result.reversalJournalEntryId,
      };
    } catch (err: any) {
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
      invoiceNumber: (p as any).invoice?.invoiceNumber ?? null,
      customerId: (p as any).invoice?.customer?.id ?? null,
      customerName: (p as any).invoice?.customer?.name ?? null,
      bankAccountId: p.bankAccountId,
      bankAccountName: (p as any).bankAccount ? `${(p as any).bankAccount.code} - ${(p as any).bankAccount.name}` : null,
      journalEntryId: p.journalEntryId ?? null,
      reversedAt: p.reversedAt ?? null,
    }));
  });

  fastify.get('/companies/:companyId/sales/payments/:paymentId', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const paymentId = Number((request.params as any)?.paymentId);
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
      } as any,
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
      (prisma as any).expensePayment.findMany({
        where: { companyId },
        orderBy: [{ paymentDate: 'desc' }, { id: 'desc' }],
        take: 200,
        include: {
          expense: { include: { vendor: true } },
          bankAccount: { select: { id: true, code: true, name: true } },
        },
      }),
      (prisma as any).purchaseBillPayment.findMany({
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
      ...(expensePays ?? []).map((p: any) => ({
        type: 'expense' as const,
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
      ...(pbPays ?? []).map((p: any) => ({
        type: 'purchase-bill' as const,
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
      if (bd !== ad) return bd - ad;
      return Number(b.id) - Number(a.id);
    });

    return mapped.slice(0, 200);
  });

  fastify.get('/companies/:companyId/purchases/payments/:paymentType/:paymentId', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const paymentType = String((request.params as any)?.paymentType ?? '').toLowerCase();
    const paymentId = Number((request.params as any)?.paymentId);
    if (Number.isNaN(paymentId)) {
      reply.status(400);
      return { error: 'invalid paymentId' };
    }
    if (paymentType === 'expense') {
      const p = await (prisma as any).expensePayment.findFirst({
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
      const p = await (prisma as any).purchaseBillPayment.findFirst({
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
    const rows = await (prisma as any).creditNote.findMany({
      where: { companyId },
      orderBy: [{ creditNoteDate: 'desc' }, { id: 'desc' }],
      include: { customer: true },
    });
    return rows.map((cn: any) => ({
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
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');

    const body = request.body as {
      invoiceId?: number | null;
      customerId?: number;
      creditNoteDate?: string;
      currency?: string;
      customerNotes?: string;
      termsAndConditions?: string;
      lines?: {
        itemId?: number;
        invoiceLineId?: number | null;
        description?: string;
        quantity?: number;
        unitPrice?: number;
        // taxRate is decimal (e.g., 0.0700 for 7%). UI can send 0.07.
        taxRate?: number;
        incomeAccountId?: number;
      }[];
    };

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

    const requestedIncomeAccountIds = Array.from(
      new Set((body.lines ?? []).map((l) => Number((l as any).incomeAccountId ?? 0)).filter((x) => x > 0))
    );
    const incomeAccounts =
      requestedIncomeAccountIds.length === 0
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
    const computedLines: any[] = [];
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
      const rate = new Prisma.Decimal(Number(l.taxRate ?? 0)).toDecimalPlaces(4);
      if (rate.lessThan(0) || rate.greaterThan(1)) {
        reply.status(400);
        return { error: `lines[${idx}].taxRate must be between 0 and 1 (e.g., 0.07 for 7%)` };
      }
      const lineTax = lineSubtotal.mul(rate).toDecimalPlaces(2);
      const lineTotal = lineSubtotal.add(lineTax).toDecimalPlaces(2);

      subtotal = subtotal.add(lineSubtotal);
      taxAmount = taxAmount.add(lineTax);
      total = total.add(lineTotal);

      computedLines.push({
        companyId,
        itemId: item.id,
        description: l.description ?? item.name ?? null,
        quantity: qty,
        unitPrice: unit,
        lineTotal, // subtotal + tax
        taxRate: rate,
        taxAmount: lineTax,
        incomeAccountId: Number((l as any).incomeAccountId ?? 0) || null,
      });
    }
    subtotal = subtotal.toDecimalPlaces(2);
    taxAmount = taxAmount.toDecimalPlaces(2);
    total = total.toDecimalPlaces(2);

    const created = await prisma.$transaction(async (tx: any) => {
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
          customerNotes:
            body.customerNotes !== undefined && body.customerNotes !== null ? String(body.customerNotes) : null,
          termsAndConditions:
            body.termsAndConditions !== undefined && body.termsAndConditions !== null
              ? String(body.termsAndConditions)
              : null,
          lines: {
            create: computedLines.map((l: any, idx: number) => ({
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
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const creditNoteId = Number((request.params as any)?.creditNoteId);
    if (!companyId || Number.isNaN(creditNoteId)) {
      reply.status(400);
      return { error: 'invalid companyId or creditNoteId' };
    }

    const body = request.body as {
      customerId?: number;
      creditNoteDate?: string;
      currency?: string | null;
      customerNotes?: string | null;
      termsAndConditions?: string | null;
      invoiceId?: number | null;
      lines?: {
        itemId?: number;
        invoiceLineId?: number | null;
        description?: string;
        quantity?: number;
        unitPrice?: number;
        taxRate?: number;
        incomeAccountId?: number;
      }[];
    };

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

    const requestedIncomeAccountIds = Array.from(
      new Set((body.lines ?? []).map((l) => Number((l as any).incomeAccountId ?? 0)).filter((x) => x > 0))
    );
    const incomeAccounts =
      requestedIncomeAccountIds.length === 0
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
    const computedLines: any[] = [];
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
      const rate = new Prisma.Decimal(Number(l.taxRate ?? 0)).toDecimalPlaces(4);
      if (rate.lessThan(0) || rate.greaterThan(1)) {
        reply.status(400);
        return { error: `lines[${idx}].taxRate must be between 0 and 1 (e.g., 0.07 for 7%)` };
      }
      const lineTax = lineSubtotal.mul(rate).toDecimalPlaces(2);
      const lineTotal = lineSubtotal.add(lineTax).toDecimalPlaces(2);

      subtotal = subtotal.add(lineSubtotal);
      taxAmount = taxAmount.add(lineTax);
      total = total.add(lineTotal);

      computedLines.push({
        companyId,
        itemId: item.id,
        description: l.description ?? item.name ?? null,
        quantity: qty,
        unitPrice: unit,
        lineTotal, // subtotal + tax
        taxRate: rate,
        taxAmount: lineTax,
        invoiceLineId: Number(l.invoiceLineId ?? 0) || null,
        incomeAccountId: Number((l as any).incomeAccountId ?? 0) || null,
      });
    }
    subtotal = subtotal.toDecimalPlaces(2);
    taxAmount = taxAmount.toDecimalPlaces(2);
    total = total.toDecimalPlaces(2);

    const updated = await prisma.$transaction(async (tx: any) => {
      const salesIncomeAccountId = await ensureSalesIncomeAccount(tx, companyId);
      await tx.$queryRaw`
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
          customerNotes:
            body.customerNotes !== undefined && body.customerNotes !== null ? String(body.customerNotes) : null,
          termsAndConditions:
            body.termsAndConditions !== undefined && body.termsAndConditions !== null
              ? String(body.termsAndConditions)
              : null,
          lines: {
            deleteMany: {},
            create: computedLines.map((l: any) => ({
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

  // Cleanest returns: create credit note directly from an invoice.
  // POST /companies/:companyId/invoices/:invoiceId/credit-notes
  // Body: { creditNoteDate?, lines: [{ invoiceLineId, quantity }] }
  fastify.post('/companies/:companyId/invoices/:invoiceId/credit-notes', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const invoiceId = Number((request.params as any)?.invoiceId);
    if (!companyId || Number.isNaN(invoiceId)) {
      reply.status(400);
      return { error: 'invalid companyId or invoiceId' };
    }

    const body = request.body as {
      creditNoteDate?: string;
      lines?: { invoiceLineId?: number; quantity?: number }[];
    };
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
    const lineById = new Map((inv.lines ?? []).map((l: any) => [l.id, l]));
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
    const returnedAgg = await (prisma as any).creditNoteLine.groupBy({
      by: ['invoiceLineId'],
      where: {
        companyId,
        invoiceLineId: { in: requested.map((r) => r.invoiceLineId) },
        creditNote: { invoiceId: inv.id, status: 'POSTED' },
      },
      _sum: { quantity: true },
    });
    const returnedByInvoiceLineId = new Map<number, Prisma.Decimal>(
      (returnedAgg ?? []).map((r: any) => [
        Number(r.invoiceLineId),
        new Prisma.Decimal(r._sum.quantity ?? 0).toDecimalPlaces(2),
      ])
    );

    // Build computed lines using invoice unit price (cleanest) and enforce qty <= remaining
    // Note: invoice-based credit notes (this endpoint) currently default tax to 0 because invoices v1 do not store tax.
    // If you want tax-aware returns, use the generic /companies/:companyId/credit-notes endpoint (UI-driven) which accepts taxRate.
    let subtotal = new Prisma.Decimal(0);
    let taxAmount = new Prisma.Decimal(0);
    let total = new Prisma.Decimal(0);
    const computedLines: any[] = [];
    for (const r of requested) {
      const soldQty = new Prisma.Decimal(r.invoiceLine.quantity).toDecimalPlaces(2);
      const alreadyReturned = returnedByInvoiceLineId.get(r.invoiceLineId) ?? new Prisma.Decimal(0);
      const remaining = soldQty.sub(alreadyReturned).toDecimalPlaces(2);
      if (r.qty.greaterThan(remaining)) {
        throw Object.assign(
          new Error(`return qty exceeds remaining qty for invoiceLineId ${r.invoiceLineId} (remaining ${remaining.toString()})`),
          { statusCode: 400 }
        );
      }
      const unit = new Prisma.Decimal(r.invoiceLine.unitPrice).toDecimalPlaces(2);
      const lineSubtotal = r.qty.mul(unit).toDecimalPlaces(2);
      const rate = new Prisma.Decimal(0).toDecimalPlaces(4);
      const lineTax = new Prisma.Decimal(0).toDecimalPlaces(2);
      const lineTotal = lineSubtotal.add(lineTax).toDecimalPlaces(2);
      subtotal = subtotal.add(lineSubtotal);
      taxAmount = taxAmount.add(lineTax);
      total = total.add(lineTotal);
      computedLines.push({
        companyId,
        invoiceLineId: r.invoiceLineId,
        itemId: r.invoiceLine.itemId,
        description: r.invoiceLine.description ?? r.invoiceLine.item?.name ?? null,
        quantity: r.qty,
        unitPrice: unit,
        lineTotal,
        taxRate: rate,
        taxAmount: lineTax,
        incomeAccountId: Number((r.invoiceLine as any).incomeAccountId ?? 0) || null,
      });
    }
    subtotal = subtotal.toDecimalPlaces(2);
    taxAmount = taxAmount.toDecimalPlaces(2);
    total = total.toDecimalPlaces(2);

    const created = await prisma.$transaction(async (tx: any) => {
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
            create: computedLines.map((l: any) => ({
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
    const creditNoteId = Number((request.params as any)?.creditNoteId);
    if (Number.isNaN(creditNoteId)) {
      reply.status(400);
      return { error: 'invalid creditNoteId' };
    }
    const cn = await (prisma as any).creditNote.findFirst({
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
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const creditNoteId = Number((request.params as any)?.creditNoteId);
    if (!companyId || Number.isNaN(creditNoteId)) {
      reply.status(400);
      return { error: 'invalid companyId or creditNoteId' };
    }

    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      reply.status(400);
      return { error: 'Idempotency-Key header is required' };
    }

    const occurredAt = isoNow();
    const correlationId = randomUUID();
    const lockKey = `lock:credit-note:post:${companyId}:${creditNoteId}`;

    try {
      // Pre-read to compute stock lock keys (avoid concurrent WAC distortions under heavy return load).
      const pre = await (prisma as any).creditNote.findFirst({
        where: { id: creditNoteId, companyId },
        select: {
          id: true,
          company: { select: { defaultWarehouseId: true } },
          lines: {
            select: {
              itemId: true,
              item: { select: { type: true, trackInventory: true, defaultWarehouseId: true } },
            },
          },
        },
      });
      if (!pre) {
        reply.status(404);
        return { error: 'credit note not found' };
      }

      let fallbackWarehouseId = pre.company.defaultWarehouseId ?? null;
      if (!fallbackWarehouseId) {
        const wh = await prisma.warehouse.findFirst({ where: { companyId, isDefault: true }, select: { id: true } });
        fallbackWarehouseId = wh?.id ?? null;
      }

      const trackedLines = (pre.lines ?? []).filter((l: any) => l.item.type === 'GOODS' && l.item.trackInventory);
      if (trackedLines.length > 0) {
        const missingWh = trackedLines.some((l: any) => !(l.item.defaultWarehouseId ?? fallbackWarehouseId));
        if (missingWh) {
          reply.status(400);
          return { error: 'default warehouse is not set (set company.defaultWarehouseId or item.defaultWarehouseId)' };
        }
      }

      const stockLockKeys =
        trackedLines.length === 0
          ? []
          : trackedLines.map((l: any) => {
              const wid = (l.item.defaultWarehouseId ?? fallbackWarehouseId) as number;
              return `lock:stock:${companyId}:${wid}:${l.itemId}`;
            });

      const { response: result } = await withLocksBestEffort(redis, stockLockKeys, 30_000, async () =>
        withLockBestEffort(redis, lockKey, 30_000, async () =>
          runIdempotentRequest(
            prisma,
            companyId,
            idempotencyKey,
            async () => {
              const txResult = await prisma.$transaction(async (tx: any) => {
              // DB-level serialization safety
              await tx.$queryRaw`
                SELECT id FROM CreditNote
                WHERE id = ${creditNoteId} AND companyId = ${companyId}
                FOR UPDATE
              `;

              const cn = await tx.creditNote.findFirst({
                where: { id: creditNoteId, companyId },
                include: { company: true, customer: true, lines: { include: { item: true } } },
              });
              if (!cn) throw Object.assign(new Error('credit note not found'), { statusCode: 404 });
              if (cn.status !== 'DRAFT') {
                throw Object.assign(new Error('only DRAFT credit notes can be posted'), { statusCode: 400 });
              }

              // CRITICAL FIX #1: Currency validation - ensure credit note currency matches company baseCurrency
              const baseCurrency = ((cn.company as any).baseCurrency ?? '').trim().toUpperCase() || null;
              const cnCurrency = ((cn as any).currency ?? '').trim().toUpperCase() || null;
              if (baseCurrency && cnCurrency && baseCurrency !== cnCurrency) {
                throw Object.assign(
                  new Error(`currency mismatch: credit note currency ${cnCurrency} must match company baseCurrency ${baseCurrency}`),
                  { statusCode: 400 }
                );
              }

              const arId = (cn.company as any).accountsReceivableAccountId;
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
              const sourceInvoiceId = (cn as any).invoiceId ? Number((cn as any).invoiceId) : null;

              // Inventory config for COGS reversal when we restock tracked items.
              const invCfg = await ensureInventoryCompanyDefaults(tx as any, companyId);
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
              const incomeBuckets = new Map<number, Prisma.Decimal>();
              let totalReturnCost = new Prisma.Decimal(0);

              for (const line of cn.lines ?? []) {
                const qty = new Prisma.Decimal(line.quantity);
                const unit = new Prisma.Decimal(line.unitPrice);
                const lineSubtotal = qty.mul(unit).toDecimalPlaces(2);
                const lineTax = new Prisma.Decimal((line as any).taxAmount ?? 0).toDecimalPlaces(2);
                const lineTotal = lineSubtotal.add(lineTax).toDecimalPlaces(2);
                subtotal = subtotal.add(lineSubtotal);
                taxAmount = taxAmount.add(lineTax);
                total = total.add(lineTotal);
                const incomeAccountId = (line as any).incomeAccountId ?? (line as any).item?.incomeAccountId;
                if (!incomeAccountId) {
                  throw Object.assign(new Error('credit note line is missing income account mapping'), { statusCode: 400 });
                }
                const prev = incomeBuckets.get(incomeAccountId) ?? new Prisma.Decimal(0);
                incomeBuckets.set(incomeAccountId, prev.add(lineSubtotal));

                const item = (line as any).item;
                const isTracked = item?.type === 'GOODS' && !!item?.trackInventory;
                const hasInvoiceLink = !!sourceInvoiceId && !!(line as any).invoiceLineId;

                if (isTracked && hasInvoiceLink) {
                  if (!invAssetId || !cogsId) {
                    throw Object.assign(
                      new Error('company inventory accounts not configured (inventoryAssetAccountId/cogsAccountId)'),
                      { statusCode: 400 }
                    );
                  }

                  await ensureInventoryItem(tx as any, companyId, line.itemId);

                  // Clean cost + warehouse allocation:
                  // Allocate return quantity across the original SALE_ISSUE StockMoves for this invoice+item.
                  // This guarantees the return uses the same cost basis and warehouse(s) as the original sale.
                  const saleMoves = (await tx.stockMove.findMany({
                    where: {
                      companyId,
                      itemId: line.itemId,
                      type: 'SALE_ISSUE',
                      direction: 'OUT',
                      referenceType: 'Invoice',
                      referenceId: String(sourceInvoiceId),
                    },
                    orderBy: [{ warehouseId: 'asc' }, { id: 'asc' }],
                    select: { id: true, warehouseId: true, quantity: true, unitCostApplied: true },
                  })) as any[];
                  if (!saleMoves.length) {
                    throw Object.assign(new Error('cannot locate original sale stock moves for return (invoice linkage missing or inventory not tracked at sale time)'), {
                      statusCode: 400,
                      invoiceId: sourceInvoiceId,
                      itemId: line.itemId,
                    });
                  }

                  // Returned qty for this invoice+item by warehouse (posted credit notes only)
                  const returnedByWh = (await tx.$queryRaw<
                    Array<{ warehouseId: number; qty: any }>
                  >`
                    SELECT sm.warehouseId as warehouseId, SUM(sm.quantity) as qty
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
                  `) as Array<{ warehouseId: number; qty: any }>;
                  const returnedWhMap = new Map<number, Prisma.Decimal>(
                    (returnedByWh ?? []).map((r) => [Number(r.warehouseId), new Prisma.Decimal(r.qty ?? 0).toDecimalPlaces(2)])
                  );

                  // Compute remaining quantities per sale move after previous returns (FIFO per warehouse)
                  const movesByWarehouse = new Map<number, any[]>();
                  for (const m of saleMoves) {
                    const wid = Number(m.warehouseId);
                    const list = movesByWarehouse.get(wid) ?? [];
                    list.push(m);
                    movesByWarehouse.set(wid, list);
                  }

                  // Allocate return qty across warehouses/moves
                  let remainingToReturn = qty.toDecimalPlaces(2);
                  for (const [wid, moves] of movesByWarehouse.entries()) {
                    if (remainingToReturn.lessThanOrEqualTo(0)) break;
                    let returnedToConsume = returnedWhMap.get(wid) ?? new Prisma.Decimal(0);

                    for (const m of moves) {
                      if (remainingToReturn.lessThanOrEqualTo(0)) break;
                      const moveQty = new Prisma.Decimal(m.quantity).toDecimalPlaces(2);
                      const alreadyReturnedFromThisMove = returnedToConsume.greaterThan(0)
                        ? (returnedToConsume.lessThan(moveQty) ? returnedToConsume : moveQty)
                        : new Prisma.Decimal(0);
                      returnedToConsume = returnedToConsume.sub(alreadyReturnedFromThisMove).toDecimalPlaces(2);
                      const available = moveQty.sub(alreadyReturnedFromThisMove).toDecimalPlaces(2);
                      if (available.lessThanOrEqualTo(0)) continue;

                      const allocQty = new Prisma.Decimal(Math.min(Number(available), Number(remainingToReturn))).toDecimalPlaces(2);
                      const unitCost = new Prisma.Decimal(m.unitCostApplied).toDecimalPlaces(2);

                      const applied = await applyStockMoveWac(tx as any, {
                        companyId,
                        warehouseId: wid,
                        itemId: line.itemId,
                        date: cn.creditNoteDate,
                        type: 'SALE_RETURN',
                        direction: 'IN',
                        quantity: allocQty,
                        unitCostApplied: unitCost,
                        referenceType: 'CreditNote',
                        referenceId: String(cn.id),
                        correlationId,
                        createdByUserId: (request as any).user?.userId ?? null,
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
                } else if (isTracked && !hasInvoiceLink) {
                  // Credit-only for tracked goods when not linked to an invoice line.
                  // This keeps ledger correct but does NOT restock inventory. If there is a physical return,
                  // user must do an inventory adjustment or create the credit note from the original invoice.
                  // (No-op here on inventory.)
                }
              }
              subtotal = subtotal.toDecimalPlaces(2);
              taxAmount = taxAmount.toDecimalPlaces(2);
              total = total.toDecimalPlaces(2);

              // Ensure Tax Payable account exists when needed (code 2100, LIABILITY).
              let taxPayableAccountId: number | null = null;
              if (taxAmount.greaterThan(0)) {
                const existing = await tx.account.findFirst({
                  where: { companyId, type: AccountType.LIABILITY, code: '2100' },
                  select: { id: true },
                });
                if (existing?.id) {
                  taxPayableAccountId = existing.id;
                } else {
                  const created = await tx.account.create({
                    data: {
                      companyId,
                      code: '2100',
                      name: 'Tax Payable',
                      type: AccountType.LIABILITY,
                      normalBalance: 'CREDIT',
                      reportGroup: 'OTHER_CURRENT_LIABILITY',
                      cashflowActivity: 'OPERATING',
                    },
                    select: { id: true },
                  });
                  taxPayableAccountId = created.id;
                }
              }

              const jeLines: any[] = [
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
                jeLines.push(
                  { accountId: invAssetId!, debit: totalReturnCost, credit: new Prisma.Decimal(0) },
                  { accountId: cogsId!, debit: new Prisma.Decimal(0), credit: totalReturnCost }
                );
              }

              const je = await postJournalEntry(tx, {
                companyId,
                date: cn.creditNoteDate,
                description: `Credit Note ${cn.creditNoteNumber} for ${(cn.customer as any)?.name ?? 'Customer'}`,
                createdByUserId: (request as any).user?.userId ?? null,
                skipAccountValidation: true,
                lines: jeLines,
              });

              // Link inventory moves to the posting JournalEntry (best-effort)
              if (totalReturnCost.greaterThan(0)) {
                await (tx as any).stockMove.updateMany({
                  where: { companyId, correlationId, journalEntryId: null },
                  data: { journalEntryId: je.id },
                });
              }

              const updCn = await tx.creditNote.updateMany({
                where: { id: cn.id, companyId },
                data: { status: 'POSTED', subtotal, taxAmount, total, journalEntryId: je.id },
              });
              if ((updCn as any).count !== 1) {
                throw Object.assign(new Error('credit note not found'), { statusCode: 404 });
              }
              const updated = { id: cn.id, status: 'POSTED' as const };

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

              await writeAuditLog(tx as any, {
                companyId,
                userId: (request as any).user?.userId ?? null,
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
          },
          redis
          )
        )
      );

      return result as any;
    } catch (err: any) {
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
      amountPaid: (b as any).amountPaid ?? 0,
      expenseDate: b.expenseDate,
      dueDate: (b as any).dueDate ?? null,
      createdAt: b.createdAt,
    }));
  });

  // Get single bill with payments and journal entries (similar to invoice detail)
  fastify.get('/companies/:companyId/expenses/:expenseId', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const expenseId = Number((request.params as any)?.expenseId);
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
      .filter((p: any) => !p.reversedAt)
      .reduce((sum: number, p: any) => sum + Number(p.amount), 0);

    const journalEntries: any[] = [];
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
        if (expense.journalEntry && p.journalEntry.id === expense.journalEntry.id) continue;
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
      dueDate: (expense as any).dueDate ?? null,
      amount: expense.amount,
      currency: expense.currency,
      description: expense.description,
      expenseAccount: (expense as any).expenseAccount
        ? {
            id: (expense as any).expenseAccount.id,
            code: (expense as any).expenseAccount.code,
            name: (expense as any).expenseAccount.name,
            type: (expense as any).expenseAccount.type,
          }
        : null,
      payments: (expense.payments ?? []).map((p: any) => ({
        id: p.id,
        paymentDate: p.paymentDate,
        amount: p.amount,
        bankAccount: {
          id: p.bankAccount.id,
          code: p.bankAccount.code,
          name: p.bankAccount.name,
        },
        journalEntryId: p.journalEntry?.id ?? null,
        reversedAt: (p as any).reversedAt ?? null,
        reversalReason: (p as any).reversalReason ?? null,
        reversalJournalEntryId: (p as any).reversalJournalEntryId ?? null,
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
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT, Roles.CLERK], 'OWNER, ACCOUNTANT, or CLERK');
    const expenseId = Number((request.params as any)?.expenseId);
    if (Number.isNaN(expenseId)) {
      reply.status(400);
      return { error: 'invalid expenseId' };
    }

    const body = (request.body ?? {}) as {
      vendorId?: number | null;
      expenseDate?: string;
      dueDate?: string | null;
      description?: string;
      amount?: number;
      currency?: string | null;
      expenseAccountId?: number | null;
    };

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
    const baseCurrency = normalizeCurrencyOrNull((company as any)?.baseCurrency ?? null);
    const docCurrency = normalizeCurrencyOrNull(body.currency ?? null);
    if (baseCurrency) {
      // In single-currency mode, require and enforce exact match.
      enforceSingleCurrency(baseCurrency, docCurrency ?? baseCurrency);
    }

    const occurredAt = isoNow();
    const correlationId = randomUUID();
    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;

    try {
      const updated = await prisma.$transaction(async (tx) => {
        // Serialize draft edits to prevent lost updates.
        await (tx as any).$queryRaw`
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
        if ((existing as any).status !== 'DRAFT') {
          throw Object.assign(new Error('only DRAFT expenses can be edited'), { statusCode: 400 });
        }
        if ((existing as any).journalEntryId) {
          throw Object.assign(new Error('cannot edit an expense that already has a journal entry'), { statusCode: 400 });
        }

        const upd = await tx.expense.updateMany({
          where: { id: expenseId, companyId, status: 'DRAFT' },
          data: {
            vendorId: body.vendorId ?? null,
            expenseDate,
            dueDate: dueDate === undefined ? null : dueDate,
            description: body.description!.trim(),
            amount: toMoneyDecimal(Number(body.amount)),
            currency: body.currency === undefined ? null : docCurrency,
            expenseAccountId: body.expenseAccountId ?? null,
          } as any,
        });
        if ((upd as any).count !== 1) {
          throw Object.assign(new Error('expense not found'), { statusCode: 404 });
        }

        const refreshed = await tx.expense.findFirst({
          where: { id: expenseId, companyId },
          include: { vendor: true, expenseAccount: true },
        });
        if (!refreshed) {
          throw Object.assign(new Error('expense not found'), { statusCode: 404 });
        }

        await writeAuditLog(tx as any, {
          companyId,
          userId: (request as any).user?.userId ?? null,
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
        vendor: (updated as any).vendor ?? null,
        expenseDate: updated.expenseDate,
        dueDate: (updated as any).dueDate ?? null,
        amount: updated.amount,
        currency: updated.currency,
        description: updated.description,
        expenseAccount: (updated as any).expenseAccount
          ? {
              id: (updated as any).expenseAccount.id,
              code: (updated as any).expenseAccount.code,
              name: (updated as any).expenseAccount.name,
              type: (updated as any).expenseAccount.type,
            }
          : null,
      };
    } catch (err: any) {
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
    const body = request.body as {
      vendorId?: number | null;
      expenseDate?: string;
      dueDate?: string;
      description?: string;
      amount?: number;
      currency?: string;
      expenseAccountId?: number | null;
    };

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
      } as any,
      include: { vendor: true, expenseAccount: true },
    });

    return bill;
  });

  // Post bill: DRAFT -> POSTED (creates JE: Dr Expense / Cr Accounts Payable)
  fastify.post('/companies/:companyId/expenses/:expenseId/post', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const expenseId = Number((request.params as any)?.expenseId);
    if (!companyId || Number.isNaN(expenseId)) {
      reply.status(400);
      return { error: 'invalid companyId or expenseId' };
    }

    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      reply.status(400);
      return { error: 'Idempotency-Key header is required' };
    }

    const occurredAt = isoNow();
    const correlationId = randomUUID();
    const lockKey = `lock:bill:post:${companyId}:${expenseId}`;
    const body = (request.body ?? {}) as { bankAccountId?: number };

    try {
      const { replay, response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () =>
        runIdempotentRequest(
          prisma,
          companyId,
          idempotencyKey,
          async () => {
            const txResult = await prisma.$transaction(async (tx) => {
              // DB-level serialization safety: lock the expense row so concurrent posts
              // (with different idempotency keys) cannot double-post.
              await (tx as any).$queryRaw`
                SELECT id FROM Expense
                WHERE id = ${expenseId} AND companyId = ${companyId}
                FOR UPDATE
              `;

              const bill = await tx.expense.findFirst({
                where: { id: expenseId, companyId },
                include: { company: true, vendor: true },
              });
              if (!bill) throw Object.assign(new Error('expense not found'), { statusCode: 404 });
              if (bill.status !== 'DRAFT') {
                throw Object.assign(new Error('only DRAFT bills can be posted'), { statusCode: 400 });
              }
              if (!(bill as any).expenseAccountId) {
                throw Object.assign(new Error('expenseAccountId is required to post a bill'), { statusCode: 400 });
              }

              const expAcc = await tx.account.findFirst({
                where: { id: (bill as any).expenseAccountId, companyId, type: AccountType.EXPENSE },
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
                  throw Object.assign(
                    new Error('Paid Through must be a banking account (create it under Banking first)'),
                    { statusCode: 400 }
                  );
                }
                if (banking.kind === BankingAccountKind.CREDIT_CARD) {
                  throw Object.assign(new Error('cannot pay from a credit card account'), { statusCode: 400 });
                }

                const je = await postJournalEntry(tx, {
                  companyId,
                  date: bill.expenseDate,
                  description: `Expense ${bill.expenseNumber}${bill.vendor ? ` for ${bill.vendor.name}` : ''}: ${bill.description}`,
                  createdByUserId: (request as any).user?.userId ?? null,
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
                if ((updBill as any).count !== 1) {
                  throw Object.assign(new Error('bill not found'), { statusCode: 404 });
                }
                const updated = { id: bill.id, status: 'PAID' as const };

                await writeAuditLog(tx as any, {
                  companyId,
                  userId: (request as any).user?.userId ?? null,
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

                await (tx as any).expensePayment.create({
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

              const apId = (bill.company as any).accountsPayableAccountId;
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
                createdByUserId: (request as any).user?.userId ?? null,
                lines: [
                  { accountId: expAcc.id, debit: amount, credit: new Prisma.Decimal(0) },
                  { accountId: apAcc.id, debit: new Prisma.Decimal(0), credit: amount },
                ],
              });

              const updBill2 = await tx.expense.updateMany({
                where: { id: bill.id, companyId },
                data: { status: 'POSTED', journalEntryId: je.id },
              });
              if ((updBill2 as any).count !== 1) {
                throw Object.assign(new Error('bill not found'), { statusCode: 404 });
              }
              const updated = { id: bill.id, status: 'POSTED' as const };

              await writeAuditLog(tx as any, {
                companyId,
                userId: (request as any).user?.userId ?? null,
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
          },
          redis
        )
      );

      return { expenseId: result.expenseId, status: result.status, journalEntryId: result.journalEntryId };
    } catch (err: any) {
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
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const expenseId = Number((request.params as any)?.expenseId);
    if (!companyId || Number.isNaN(expenseId)) {
      reply.status(400);
      return { error: 'invalid companyId or expenseId' };
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
    const amountNumber = body.amount;

    const occurredAt = isoNow();
    const correlationId = randomUUID();
    const lockKey = `lock:bill:payment:${companyId}:${expenseId}`;

    try {
      const { replay, response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () =>
        runIdempotentRequest(
          prisma,
          companyId,
          idempotencyKey,
          async () => {
            const txResult = await prisma.$transaction(async (tx) => {
              // DB-level serialization safety: lock the expense row so concurrent payments
              // cannot overspend remaining balance even if Redis is unavailable.
              await (tx as any).$queryRaw`
                SELECT id FROM Expense
                WHERE id = ${expenseId} AND companyId = ${companyId}
                FOR UPDATE
              `;

              const bill = await tx.expense.findFirst({
                where: { id: expenseId, companyId },
                include: { company: true },
              });
              if (!bill) throw Object.assign(new Error('expense not found'), { statusCode: 404 });
              if (bill.status !== 'POSTED' && bill.status !== 'PARTIAL') {
                throw Object.assign(new Error('payments allowed only for POSTED or PARTIAL bills'), { statusCode: 400 });
              }

              // CRITICAL FIX #1: Currency validation - ensure expense currency matches company baseCurrency
              const baseCurrency = ((bill.company as any).baseCurrency ?? '').trim().toUpperCase() || null;
              const billCurrency = ((bill as any).currency ?? '').trim().toUpperCase() || null;
              if (baseCurrency && billCurrency && baseCurrency !== billCurrency) {
                throw Object.assign(
                  new Error(`currency mismatch: expense currency ${billCurrency} must match company baseCurrency ${baseCurrency}`),
                  { statusCode: 400 }
                );
              }

              const apId = (bill.company as any).accountsPayableAccountId;
              if (!apId) throw Object.assign(new Error('company.accountsPayableAccountId is not set'), { statusCode: 400 });
              const apAcc = await tx.account.findFirst({ where: { id: apId, companyId, type: AccountType.LIABILITY } });
              if (!apAcc) throw Object.assign(new Error('accountsPayableAccountId must be a LIABILITY account in this company'), { statusCode: 400 });

              const bankAccount = await tx.account.findFirst({
                where: { id: body.bankAccountId!, companyId, type: AccountType.ASSET },
              });
              if (!bankAccount) throw Object.assign(new Error('bankAccountId must be an ASSET account in this company'), { statusCode: 400 });

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
                createdByUserId: (request as any).user?.userId ?? null,
                skipAccountValidation: true,
                lines: [
                  { accountId: apAcc.id, debit: amount, credit: new Prisma.Decimal(0) },
                  { accountId: bankAccount.id, debit: new Prisma.Decimal(0), credit: amount },
                ],
              });

              const pay = await (tx as any).expensePayment.create({
                data: {
                  companyId,
                  expenseId: bill.id,
                  paymentDate,
                  amount,
                  bankAccountId: bankAccount.id,
                  journalEntryId: je.id,
                },
              });

              const sumAgg = await (tx as any).expensePayment.aggregate({
                where: { expenseId: bill.id, companyId, reversedAt: null },
                _sum: { amount: true },
              });
              const totalPaid = (sumAgg._sum.amount ?? new Prisma.Decimal(0)).toDecimalPlaces(2);
              const newStatus = totalPaid.greaterThanOrEqualTo(bill.amount) ? 'PAID' : 'PARTIAL';

              const updBill3 = await tx.expense.updateMany({
                where: { id: bill.id, companyId },
                data: { amountPaid: totalPaid, status: newStatus },
              });
              if ((updBill3 as any).count !== 1) {
                throw Object.assign(new Error('bill not found'), { statusCode: 404 });
              }

              await writeAuditLog(tx as any, {
                companyId,
                userId: (request as any).user?.userId ?? null,
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
          },
          redis
        )
      );

      return { expenseId: result.expenseId, expensePaymentId: result.expensePaymentId, journalEntryId: result.journalEntryId };
    } catch (err: any) {
      if (err?.statusCode) {
        reply.status(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });
}

