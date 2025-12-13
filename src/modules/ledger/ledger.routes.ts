import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../infrastructure/db.js';
import { publishDomainEvent } from '../../infrastructure/pubsub.js';
import { markEventPublished } from '../../infrastructure/events.js';
import type { DomainEventEnvelopeV1 } from '../../events/domainEvent.js';
import { Prisma } from '@prisma/client';
import { postJournalEntry } from './posting.service.js';
import { parseCompanyId } from '../../utils/request.js';
import { enforceCompanyScope, forbidClientProvidedCompanyId, requireCompanyIdParam } from '../../utils/tenant.js';
import { runIdempotentRequest } from '../../infrastructure/commandIdempotency.js';

export async function ledgerRoutes(fastify: FastifyInstance) {
  // All ledger endpoints are tenant-scoped and must be authenticated.
  fastify.addHook('preHandler', fastify.authenticate);

  // --- Journal Entries list (for UI) ---
  // GET /companies/:companyId/journal-entries?from=YYYY-MM-DD&to=YYYY-MM-DD&take=50
  fastify.get('/companies/:companyId/journal-entries', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const query = request.query as { from?: string; to?: string; take?: string };

    const take = Math.min(Math.max(Number(query.take ?? 50) || 50, 1), 200);

    const where: any = { companyId };
    if (query.from || query.to) {
      const from = query.from ? new Date(query.from) : null;
      const to = query.to ? new Date(query.to) : null;
      if ((from && isNaN(from.getTime())) || (to && isNaN(to.getTime()))) {
        reply.status(400);
        return { error: 'invalid from/to dates' };
      }
      if (to) to.setHours(23, 59, 59, 999);
      where.date = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      };
    }

    const entries = await prisma.journalEntry.findMany({
      where,
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take,
      include: {
        lines: {
          include: {
            account: { select: { id: true, code: true, name: true, type: true } },
          },
        },
      },
    });

    return entries.map((e) => {
      const totalDebit = e.lines.reduce((sum, l) => sum + Number(l.debit), 0);
      const totalCredit = e.lines.reduce((sum, l) => sum + Number(l.credit), 0);
      return {
        id: e.id,
        date: e.date,
        description: e.description,
        totalDebit,
        totalCredit,
        balanced: Math.abs(totalDebit - totalCredit) < 0.00001,
        reversalOfJournalEntryId: (e as any).reversalOfJournalEntryId ?? null,
        createdAt: e.createdAt,
      };
    });
  });

  // --- Journal Entry detail (for UI) ---
  fastify.get('/companies/:companyId/journal-entries/:journalEntryId', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const journalEntryId = Number((request.params as any)?.journalEntryId);
    if (Number.isNaN(journalEntryId)) {
      reply.status(400);
      return { error: 'invalid journalEntryId' };
    }

    const entry = await prisma.journalEntry.findFirst({
      where: { id: journalEntryId, companyId },
      include: {
        lines: {
          include: {
            account: { select: { id: true, code: true, name: true, type: true } },
          },
        },
      },
    });
    if (!entry) {
      reply.status(404);
      return { error: 'journal entry not found' };
    }

    const totalDebit = entry.lines.reduce((sum, l) => sum + Number(l.debit), 0);
    const totalCredit = entry.lines.reduce((sum, l) => sum + Number(l.credit), 0);

    return {
      id: entry.id,
      date: entry.date,
      description: entry.description,
      totalDebit,
      totalCredit,
      balanced: Math.abs(totalDebit - totalCredit) < 0.00001,
      lines: entry.lines.map((l) => ({
        id: l.id,
        account: l.account,
        debit: l.debit.toString(),
        credit: l.credit.toString(),
      })),
      createdAt: entry.createdAt,
    };
  });

  // --- Journal Entry API (with debit = credit check) ---
  fastify.post('/journal-entries', async (request, reply) => {
    const body = request.body as {
      companyId?: number;
      date?: string; // ISO string
      description?: string;
      lines?: { accountId?: number; debit?: number; credit?: number }[];
    };

    if (!body.lines || body.lines.length === 0) {
      reply.status(400);
      return { error: 'at least one line is required' };
    }

    // Never trust companyId from client. We derive it from JWT (and forbid mismatches).
    const companyId = forbidClientProvidedCompanyId(request, reply, body.companyId);
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
      const entry = await postJournalEntry(tx, {
        companyId,
        date,
        description: body.description ?? '',
        createdByUserId: (request as any).user?.userId ?? null,
        lines: (body.lines ?? []).map((line) => ({
          accountId: line.accountId!,
          debit: new Prisma.Decimal((line.debit ?? 0).toFixed(2)),
          credit: new Prisma.Decimal((line.credit ?? 0).toFixed(2)),
        })),
      });

      // Compute totals from normalized lines (Decimal-safe)
      const totalDebit = entry.lines.reduce(
        (sum: Prisma.Decimal, l: any) => sum.add(new Prisma.Decimal(l.debit)),
        new Prisma.Decimal(0)
      );
      const totalCredit = entry.lines.reduce(
        (sum: Prisma.Decimal, l: any) => sum.add(new Prisma.Decimal(l.credit)),
        new Prisma.Decimal(0)
      );

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
          aggregateId: String(entry.id),
          type: 'JournalEntryCreated', // Legacy field, keeping for now
          payload: {
            journalEntryId: entry.id,
            companyId,
            totalDebit: Number(totalDebit),
            totalCredit: Number(totalCredit),
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
      companyId,
      partitionKey: String(companyId),
      correlationId,
      aggregateType: 'JournalEntry',
      aggregateId: String(result.id),
      source,
      payload: {
        journalEntryId: result.id,
        companyId,
        // These totals are informational; consumers should trust the stored JournalLines.
        totalDebit: result.lines.reduce((sum: number, l: any) => sum + Number(l.debit), 0),
        totalCredit: result.lines.reduce((sum: number, l: any) => sum + Number(l.credit), 0),
      },
    };

    const published = await publishDomainEvent(envelope);
    if (published) {
      await markEventPublished(eventId);
    }

    return result;
  });

  // --- Reverse a posted journal entry (immutable ledger) ---
  // POST /companies/:companyId/journal-entries/:journalEntryId/reverse
  // Requires Idempotency-Key header to prevent duplicate reversals under retries.
  fastify.post(
    '/companies/:companyId/journal-entries/:journalEntryId/reverse',
    async (request, reply) => {
      const companyId = requireCompanyIdParam(request, reply);
      const journalEntryId = Number((request.params as any)?.journalEntryId);
      if (!companyId || Number.isNaN(journalEntryId)) {
        reply.status(400);
        return { error: 'invalid companyId or journalEntryId' };
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

      const correlationId = randomUUID();
      const occurredAt = new Date().toISOString();

      try {
        const { replay, response: result } = await runIdempotentRequest(
          prisma,
          companyId,
          idempotencyKey,
          async () => {
            const txResult = await prisma.$transaction(async (tx: any) => {
              const original = await tx.journalEntry.findFirst({
                where: { id: journalEntryId, companyId },
                include: { lines: true },
              });
              if (!original) {
                throw Object.assign(new Error('journal entry not found'), { statusCode: 404 });
              }
              if (original.reversalOfJournalEntryId) {
                throw Object.assign(new Error('cannot reverse a reversal entry'), { statusCode: 400 });
              }

              const existingReversal = await tx.journalEntry.findFirst({
                where: { companyId, reversalOfJournalEntryId: original.id },
                select: { id: true },
              });
              if (existingReversal) {
                throw Object.assign(new Error('journal entry already reversed'), { statusCode: 400 });
              }

              const reversalLines = original.lines.map((l: any) => ({
                accountId: l.accountId,
                debit: new Prisma.Decimal(l.credit).toDecimalPlaces(2),
                credit: new Prisma.Decimal(l.debit).toDecimalPlaces(2),
              }));

              const reversalEntry = await postJournalEntry(tx, {
                companyId,
                date: reversalDate,
                description: `REVERSAL of JE ${original.id}: ${original.description}`,
                createdByUserId: (request as any).user?.userId ?? null,
                reversalOfJournalEntryId: original.id,
                reversalReason: body.reason ?? null,
                lines: reversalLines,
              });

              // Event 1: journal.entry.created (for the reversal entry) => triggers summaries/reporting consumers.
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
                  causationId: String(original.id),
                  aggregateType: 'JournalEntry',
                  aggregateId: String(reversalEntry.id),
                  type: 'JournalEntryCreated',
                  payload: {
                    journalEntryId: reversalEntry.id,
                    companyId,
                    reversalOfJournalEntryId: original.id,
                  },
                },
              });

              // Event 2: journal.entry.reversed (audit/event-sourcing semantics)
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
                  causationId: createdEventId,
                  aggregateType: 'JournalEntry',
                  aggregateId: String(original.id),
                  type: 'JournalEntryReversed',
                  payload: {
                    originalJournalEntryId: original.id,
                    reversalJournalEntryId: reversalEntry.id,
                    companyId,
                    reason: body.reason ?? null,
                  },
                },
              });

              return { originalId: original.id, reversalId: reversalEntry.id, createdEventId, reversedEventId };
            });

            return {
              originalJournalEntryId: txResult.originalId,
              reversalJournalEntryId: txResult.reversalId,
              _createdEventId: txResult.createdEventId,
              _reversedEventId: txResult.reversedEventId,
              _correlationId: correlationId,
              _occurredAt: occurredAt,
            };
          }
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
              originalJournalEntryId: result.originalJournalEntryId,
              reversalJournalEntryId: result.reversalJournalEntryId,
              companyId,
              reason: body.reason ?? null,
            },
          });
          if (reversedOk) await markEventPublished((result as any)._reversedEventId);
        }

        return {
          originalJournalEntryId: result.originalJournalEntryId,
          reversalJournalEntryId: result.reversalJournalEntryId,
        };
      } catch (err: any) {
        if (err?.statusCode) {
          reply.status(err.statusCode);
          return { error: err.message };
        }
        throw err;
      }
    }
  );

  // --- Trial Balance report (proof: total debits == total credits) ---
  // Example: GET /companies/2/reports/trial-balance?from=2025-12-01&to=2025-12-31
  fastify.get('/companies/:companyId/reports/trial-balance', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);

    const query = request.query as { from?: string; to?: string };
    if (!query.from || !query.to) {
      reply.status(400);
      return { error: 'from and to are required (YYYY-MM-DD)' };
    }

    const fromDate = new Date(query.from);
    const toDate = new Date(query.to);
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      reply.status(400);
      return { error: 'invalid from/to dates' };
    }
    toDate.setHours(23, 59, 59, 999);

    const grouped = await prisma.journalLine.groupBy({
      by: ['accountId'],
      where: {
        companyId,
        journalEntry: {
          date: {
            gte: fromDate,
            lte: toDate,
          },
        },
      },
      _sum: { debit: true, credit: true },
    });

    const accountIds = grouped.map((g) => g.accountId);
    const accounts = await prisma.account.findMany({
      where: { companyId, id: { in: accountIds } },
      select: { id: true, code: true, name: true, type: true },
    });
    const accountById = new Map(accounts.map((a) => [a.id, a]));

    let totalDebit = new Prisma.Decimal(0);
    let totalCredit = new Prisma.Decimal(0);

    const rows = grouped
      .map((g) => {
        const acc = accountById.get(g.accountId);
        const debit = new Prisma.Decimal(g._sum.debit ?? 0);
        const credit = new Prisma.Decimal(g._sum.credit ?? 0);
        totalDebit = totalDebit.add(debit);
        totalCredit = totalCredit.add(credit);

        return {
          accountId: g.accountId,
          code: acc?.code ?? null,
          name: acc?.name ?? null,
          type: acc?.type ?? null,
          debit: debit.toDecimalPlaces(2).toString(),
          credit: credit.toDecimalPlaces(2).toString(),
        };
      })
      .sort((a, b) => String(a.code ?? '').localeCompare(String(b.code ?? '')));

    totalDebit = totalDebit.toDecimalPlaces(2);
    totalCredit = totalCredit.toDecimalPlaces(2);

    return {
      companyId,
      from: query.from,
      to: query.to,
      totalDebit: totalDebit.toString(),
      totalCredit: totalCredit.toString(),
      balanced: totalDebit.equals(totalCredit),
      accounts: rows,
    };
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
    // Enforce tenant boundary for reports as well.
    enforceCompanyScope(request, reply, companyId);

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

