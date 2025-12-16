import type { FastifyInstance } from 'fastify';
import { prisma } from '../../infrastructure/db.js';
import { toMoneyDecimal } from '../../utils/money.js';
import { isoNow } from '../../utils/date.js';
import { publishDomainEvent } from '../../infrastructure/pubsub.js';
import { markEventPublished } from '../../infrastructure/events.js';
import { randomUUID } from 'node:crypto';
import { AccountType, ItemType, Prisma } from '@prisma/client';
import { postJournalEntry } from '../ledger/posting.service.js';
import { runIdempotentRequest } from '../../infrastructure/commandIdempotency.js';
import { requireCompanyIdParam } from '../../utils/tenant.js';
import { BankingAccountKind } from '@prisma/client';
import { getRedis } from '../../infrastructure/redis.js';
import { withLockBestEffort, withLocksBestEffort } from '../../infrastructure/locks.js';
import { applyStockMoveWac } from '../inventory/stock.service.js';
import { ensureInventoryCompanyDefaults } from '../inventory/stock.service.js';

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
        lines: { include: { item: true } },
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
      total: invoice.total,
      currency: invoice.currency,
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
      lines?: { itemId: number; description?: string; quantity: number; unitPrice?: number }[];
    };

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
      const item = itemById.get(line.itemId)!;
      const qty = toMoneyDecimal(line.quantity);
      const unit = toMoneyDecimal(line.unitPrice ?? Number(item.sellingPrice));
      const lineTotal = qty.mul(unit).toDecimalPlaces(2);
      total = total.add(lineTotal);

      return {
        companyId,
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
    const companyId = requireCompanyIdParam(request, reply);
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
          const incomeBuckets = new Map<number, Prisma.Decimal>();

          for (const line of invoice.lines) {
            const qty = new Prisma.Decimal(line.quantity);
            const unit = new Prisma.Decimal(line.unitPrice);
            const lineTotal = qty.mul(unit).toDecimalPlaces(2);
            total = total.add(lineTotal);

            const incomeAccountId = line.item.incomeAccountId;
            const prev = incomeBuckets.get(incomeAccountId) ?? new Prisma.Decimal(0);
            incomeBuckets.set(incomeAccountId, prev.add(lineTotal));
          }

          total = total.toDecimalPlaces(2);

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

          const journalEntry = await postJournalEntry(tx, {
            companyId,
            date: invoice.invoiceDate,
            description: `Invoice ${invoice.invoiceNumber} for ${invoice.customer.name}`,
            createdByUserId: (request as any).user?.userId ?? null,
            lines: [
              { accountId: arAccount.id, debit: total, credit: new Prisma.Decimal(0) },
              ...Array.from(incomeBuckets.entries()).map(([incomeAccountId, amount]) => ({
                accountId: incomeAccountId,
                debit: new Prisma.Decimal(0),
                credit: amount.toDecimalPlaces(2),
              })),
              ...(totalCogs.greaterThan(0)
                ? [
                    {
                      accountId: ((invoice.company as any).cogsAccountId ?? (await ensureInventoryCompanyDefaults(tx as any, companyId)).cogsAccountId)!,
                      debit: totalCogs,
                      credit: new Prisma.Decimal(0),
                    },
                    {
                      accountId: ((invoice.company as any).inventoryAssetAccountId ?? (await ensureInventoryCompanyDefaults(tx as any, companyId)).inventoryAssetAccountId)!,
                      debit: new Prisma.Decimal(0),
                      credit: totalCogs,
                    },
                  ]
                : []),
            ],
          });

          // Link inventory moves to the invoice posting JournalEntry (best-effort)
          if (totalCogs.greaterThan(0)) {
            await (tx as any).stockMove.updateMany({
              where: { companyId, correlationId, journalEntryId: null },
              data: { journalEntryId: journalEntry.id },
            });
          }

          // Update invoice to POSTED and link journal entry.
          const updatedInvoice = await tx.invoice.update({
            where: { id: invoice.id },
            data: {
              status: 'POSTED',
              total,
              amountPaid: new Prisma.Decimal(0),
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

    // First execution: attempt publish now (still safe if it fails; outbox publisher will deliver later).
    if (!replay) {
      const publishJeOk = await publishDomainEvent({
        eventId: (result as any)._jeEventId,
        eventType: 'journal.entry.created',
        schemaVersion: 'v1',
        occurredAt: (result as any)._occurredAt,
        companyId,
        partitionKey: String(companyId),
        correlationId: (result as any)._correlationId,
        aggregateType: 'JournalEntry',
        aggregateId: String(result.journalEntryId),
        source: 'cashflow-api',
        payload: {
          journalEntryId: result.journalEntryId,
          companyId,
        },
      });
      if (publishJeOk) await markEventPublished((result as any)._jeEventId);

      const publishInvoiceOk = await publishDomainEvent({
        eventId: (result as any)._invoiceEventId,
        eventType: 'invoice.posted',
        schemaVersion: 'v1',
        occurredAt: (result as any)._occurredAt,
        companyId,
        partitionKey: String(companyId),
        correlationId: (result as any)._correlationId,
        aggregateType: 'Invoice',
        aggregateId: String(result.invoiceId),
        source: 'cashflow-api',
        payload: {
          invoiceId: result.invoiceId,
          journalEntryId: result.journalEntryId,
          total: result.total,
        },
      });
      if (publishInvoiceOk) await markEventPublished((result as any)._invoiceEventId);
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
                const invoice = await tx.invoice.findFirst({
                  where: { id: invoiceId, companyId },
                  include: { company: { select: { accountsReceivableAccountId: true } } },
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

                const paymentDate = body.paymentDate ? new Date(body.paymentDate) : new Date();
                const amount = toMoneyDecimal(amountNumber);

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

                const updatedInvoice = await tx.invoice.update({
                  where: { id: invoice.id },
                  data: { amountPaid: totalPaid, status: newStatus },
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

      if (!replay) {
        const publishJeOk = await publishDomainEvent({
          eventId: (result as any)._jeEventId,
          eventType: 'journal.entry.created',
          schemaVersion: 'v1',
          occurredAt: (result as any)._occurredAt,
          companyId,
          partitionKey: String(companyId),
          correlationId: (result as any)._correlationId,
          aggregateType: 'JournalEntry',
          aggregateId: String(result.journalEntryId),
          source: 'cashflow-api',
          payload: {
            journalEntryId: result.journalEntryId,
            companyId,
          },
        });
        if (publishJeOk) await markEventPublished((result as any)._jeEventId);

        const publishPaymentOk = await publishDomainEvent({
          eventId: (result as any)._paymentEventId,
          eventType: 'payment.recorded',
          schemaVersion: 'v1',
          occurredAt: (result as any)._occurredAt,
          companyId,
          partitionKey: String(companyId),
          correlationId: (result as any)._correlationId,
          aggregateType: 'Payment',
          aggregateId: String(result.paymentId),
          source: 'cashflow-api',
          payload: {
            paymentId: result.paymentId,
            invoiceId,
            journalEntryId: result.journalEntryId,
            amount: (body.amount ?? 0).toFixed(2),
            bankAccountId: body.bankAccountId,
          },
        });
        if (publishPaymentOk) await markEventPublished((result as any)._paymentEventId);
      }

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
    const reversalDate = body.date ? new Date(body.date) : new Date();
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

              const updatedInvoice = await tx.invoice.update({
                where: { id: invoiceId },
                data: { amountPaid: newPaid, status: newStatus },
              });

              // Mark payment as reversed (document audit)
              await tx.payment.update({
                where: { id: payment.id },
                data: {
                  reversedAt: new Date(occurredAt),
                  reversalReason: body.reason ?? null,
                  reversalJournalEntryId: reversalEntry.id,
                  reversedByUserId: (request as any).user?.userId ?? null,
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

      if (!replay) {
        const createdOk = await publishDomainEvent({
          eventId: (result as any)._createdEventId,
          eventType: 'journal.entry.created',
          schemaVersion: 'v1',
          occurredAt: (result as any)._occurredAt,
          companyId,
          partitionKey: String(companyId),
          correlationId: (result as any)._correlationId,
          aggregateType: 'JournalEntry',
          aggregateId: String(result.reversalJournalEntryId),
          source: 'cashflow-api',
          payload: {
            journalEntryId: result.reversalJournalEntryId,
            companyId,
            reversalOfJournalEntryId: result.originalJournalEntryId,
          },
        });
        if (createdOk) await markEventPublished((result as any)._createdEventId);

        const reversedOk = await publishDomainEvent({
          eventId: (result as any)._reversedEventId,
          eventType: 'journal.entry.reversed',
          schemaVersion: 'v1',
          occurredAt: (result as any)._occurredAt,
          companyId,
          partitionKey: String(companyId),
          correlationId: (result as any)._correlationId,
          aggregateType: 'JournalEntry',
          aggregateId: String(result.originalJournalEntryId),
          source: 'cashflow-api',
          payload: {
            companyId,
            originalJournalEntryId: result.originalJournalEntryId,
            reversalJournalEntryId: result.reversalJournalEntryId,
          },
        });
        if (reversedOk) await markEventPublished((result as any)._reversedEventId);

        const paymentRevOk = await publishDomainEvent({
          eventId: (result as any)._paymentReversedEventId,
          eventType: 'payment.reversed',
          schemaVersion: 'v1',
          occurredAt: (result as any)._occurredAt,
          companyId,
          partitionKey: String(companyId),
          correlationId: (result as any)._correlationId,
          aggregateType: 'Payment',
          aggregateId: String(result.paymentId),
          source: 'cashflow-api',
          payload: {
            paymentId: result.paymentId,
            invoiceId: result.invoiceId,
            reversalJournalEntryId: result.reversalJournalEntryId,
          },
        });
        if (paymentRevOk) await markEventPublished((result as any)._paymentReversedEventId);
      }

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

    const expenseDate = body.expenseDate ? new Date(body.expenseDate) : new Date();
    const dueDate = body.dueDate ? new Date(body.dueDate) : null;
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

    try {
      const { replay, response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () =>
        runIdempotentRequest(
          prisma,
          companyId,
          idempotencyKey,
          async () => {
            const txResult = await prisma.$transaction(async (tx) => {
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

              const amount = new Prisma.Decimal(bill.amount).toDecimalPlaces(2);
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

              const updated = await tx.expense.update({
                where: { id: bill.id },
                data: { status: 'POSTED', journalEntryId: je.id },
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

      if (!replay) {
        const jeOk = await publishDomainEvent({
          eventId: (result as any)._jeEventId,
          eventType: 'journal.entry.created',
          schemaVersion: 'v1',
          occurredAt: (result as any)._occurredAt,
          companyId,
          partitionKey: String(companyId),
          correlationId: (result as any)._correlationId,
          aggregateType: 'JournalEntry',
          aggregateId: String(result.journalEntryId),
          source: 'cashflow-api',
          payload: { journalEntryId: result.journalEntryId, companyId },
        });
        if (jeOk) await markEventPublished((result as any)._jeEventId);

        const billOk = await publishDomainEvent({
          eventId: (result as any)._billPostedEventId,
          eventType: 'bill.posted',
          schemaVersion: 'v1',
          occurredAt: (result as any)._occurredAt,
          companyId,
          partitionKey: String(companyId),
          correlationId: (result as any)._correlationId,
          aggregateType: 'Expense',
          aggregateId: String(result.expenseId),
          source: 'cashflow-api',
          payload: { expenseId: result.expenseId, journalEntryId: result.journalEntryId },
        });
        if (billOk) await markEventPublished((result as any)._billPostedEventId);
      }

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
              const bill = await tx.expense.findFirst({
                where: { id: expenseId, companyId },
                include: { company: true },
              });
              if (!bill) throw Object.assign(new Error('expense not found'), { statusCode: 404 });
              if (bill.status !== 'POSTED' && bill.status !== 'PARTIAL') {
                throw Object.assign(new Error('payments allowed only for POSTED or PARTIAL bills'), { statusCode: 400 });
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

              const paymentDate = body.paymentDate ? new Date(body.paymentDate) : new Date();
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

              await tx.expense.update({
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

      if (!replay) {
        const jeOk = await publishDomainEvent({
          eventId: (result as any)._jeEventId,
          eventType: 'journal.entry.created',
          schemaVersion: 'v1',
          occurredAt: (result as any)._occurredAt,
          companyId,
          partitionKey: String(companyId),
          correlationId: (result as any)._correlationId,
          aggregateType: 'JournalEntry',
          aggregateId: String(result.journalEntryId),
          source: 'cashflow-api',
          payload: { journalEntryId: result.journalEntryId, companyId },
        });
        if (jeOk) await markEventPublished((result as any)._jeEventId);

        const payOk = await publishDomainEvent({
          eventId: (result as any)._paymentEventId,
          eventType: 'bill.payment.recorded',
          schemaVersion: 'v1',
          occurredAt: (result as any)._occurredAt,
          companyId,
          partitionKey: String(companyId),
          correlationId: (result as any)._correlationId,
          aggregateType: 'ExpensePayment',
          aggregateId: String(result.expensePaymentId),
          source: 'cashflow-api',
          payload: { expensePaymentId: result.expensePaymentId, expenseId: result.expenseId, journalEntryId: result.journalEntryId },
        });
        if (payOk) await markEventPublished((result as any)._paymentEventId);
      }

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

