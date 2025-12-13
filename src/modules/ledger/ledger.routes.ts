import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../infrastructure/db.js';
import { publishDomainEvent } from '../../infrastructure/pubsub.js';
import { markEventPublished } from '../../infrastructure/events.js';
import type { DomainEventEnvelopeV1 } from '../../events/domainEvent.js';

export async function ledgerRoutes(fastify: FastifyInstance) {
  // --- Journal Entry API (with debit = credit check) ---
  fastify.post('/journal-entries', async (request, reply) => {
    const body = request.body as {
      companyId?: number;
      date?: string; // ISO string
      description?: string;
      lines?: { accountId?: number; debit?: number; credit?: number }[];
    };

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
    const schemaVersion = 'v1' as const;
    const source = 'cashflow-api';

    // Wrap in a transaction so entry + event are consistent
    const result = await prisma.$transaction(async (tx: any) => {
      const entry = await tx.journalEntry.create({
        data: {
          companyId: body.companyId!,
          date,
          description: body.description ?? '',
          lines: {
            create: (body.lines ?? []).map((line) => ({
              accountId: line.accountId!,
              debit: line.debit ?? 0,
              credit: line.credit ?? 0,
            })),
          },
        },
        include: { lines: true },
      });

      await tx.event.create({
        data: {
          companyId: body.companyId!,
          eventId,
          eventType,
          schemaVersion,
          occurredAt: new Date(occurredAt),
          source,
          partitionKey: String(body.companyId!),
          correlationId,
          aggregateType: 'JournalEntry',
          aggregateId: String(entry.id),
          type: 'JournalEntryCreated', // Legacy field, keeping for now
          payload: {
            journalEntryId: entry.id,
            companyId: body.companyId!,
            totalDebit,
            totalCredit,
          },
        },
      });

      return entry;
    });

    const envelope: DomainEventEnvelopeV1 = {
      eventId,
      eventType,
      schemaVersion,
      occurredAt,
      companyId: body.companyId!,
      partitionKey: String(body.companyId!),
      correlationId,
      aggregateType: 'JournalEntry',
      aggregateId: String(result.id),
      source,
      payload: {
        journalEntryId: result.id,
        companyId: body.companyId!,
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

  // --- Simple Profit & Loss report ---
  fastify.get('/reports/pnl', async (request, reply) => {
    const query = request.query as {
      companyId?: string;
      from?: string;
      to?: string;
    };

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

    type Bucket = {
      [code: string]: {
        code: string;
        name: string;
        amount: number;
      };
    };

    const income: Bucket = {};
    const expense: Bucket = {};

    for (const line of lines) {
      const acc = line.account;

      if (acc.type === 'INCOME') {
        // For income accounts: credit increases income, debit decreases income
        const delta = Number(line.credit) - Number(line.debit);

        if (!income[acc.code]) {
          income[acc.code] = { code: acc.code, name: acc.name, amount: 0 };
        }
        income[acc.code]!.amount += delta;
      }

      if (acc.type === 'EXPENSE') {
        // For expense accounts: debit increases expense, credit decreases expense
        const delta = Number(line.debit) - Number(line.credit);

        if (!expense[acc.code]) {
          expense[acc.code] = { code: acc.code, name: acc.name, amount: 0 };
        }
        expense[acc.code]!.amount += delta;
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
}

