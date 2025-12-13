import type { FastifyInstance } from 'fastify';
import { prisma } from '../../infrastructure/db.js';
import { parseCompanyId } from '../../utils/request.js';
import { toMoneyDecimal } from '../../utils/money.js';
import { isoNow } from '../../utils/date.js';
import { publishDomainEvent } from '../../infrastructure/pubsub.js';
import { markEventPublished } from '../../infrastructure/events.js';
import { randomUUID } from 'node:crypto';
import { AccountType, ItemType, Prisma } from '@prisma/client';

function generateInvoiceNumber(): string {
  // Beginner-friendly and “good enough” for now.
  // Later we can make this per-company sequential numbers (INV-0001).
  return `INV-${Date.now()}`;
}

export async function booksRoutes(fastify: FastifyInstance) {
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

    const body = request.body as {
      name?: string;
      sku?: string;
      type?: ItemType;
      sellingPrice?: number;
      costPrice?: number;
      incomeAccountId?: number;
      expenseAccountId?: number;
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
    const invoiceId = Number((request.params as any)?.invoiceId);
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
      const incomeBuckets = new Map<number, Prisma.Decimal>();

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
    if (publishJeOk) await markEventPublished(result.jeEventId);

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
    if (publishInvoiceOk) await markEventPublished(result.invoiceEventId);

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
    const invoiceId = Number((request.params as any)?.invoiceId);
    if (!companyId || Number.isNaN(invoiceId)) {
      reply.status(400);
      return { error: 'invalid companyId or invoiceId' };
    }

    const body = request.body as {
      paymentDate?: string;
      amount?: number;
      bankAccountId?: number;
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
          where: { id: body.bankAccountId!, companyId, type: AccountType.ASSET },
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
      if (publishPaymentJeOk) await markEventPublished(result.jeEventId);

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
      if (publishPaymentOk) await markEventPublished(result.paymentEventId);

      return {
        invoiceId: result.updatedInvoice.id,
        invoiceStatus: result.updatedInvoice.status,
        paymentId: result.updatedPayment.id,
        journalEntryId: result.updatedPayment.journalEntryId,
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

