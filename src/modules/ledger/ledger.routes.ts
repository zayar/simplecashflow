import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../infrastructure/db.js';
import { Prisma } from '@prisma/client';
import { postJournalEntry } from './posting.service.js';
import { enforceCompanyScope, forbidClientProvidedCompanyId, requireCompanyIdParam } from '../../utils/tenant.js';
import { runIdempotentRequest } from '../../infrastructure/commandIdempotency.js';
import { getRedis } from '../../infrastructure/redis.js';
import { withLockBestEffort } from '../../infrastructure/locks.js';
import { normalizeToDay, parseDateInput } from '../../utils/date.js';
import { requireAnyRole, Roles } from '../../utils/rbac.js';
import { writeAuditLog } from '../../infrastructure/auditLog.js';

export async function ledgerRoutes(fastify: FastifyInstance) {
  // All ledger endpoints are tenant-scoped and must be authenticated.
  fastify.addHook('preHandler', fastify.authenticate);
  const redis = getRedis();

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
        entryNumber: (e as any).entryNumber ?? null,
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

  // --- Manual journal entry creation (tenant-scoped) ---
  // POST /companies/:companyId/journal-entries
  // Requires Idempotency-Key; creates an immutable JournalEntry + emits outbox event.
  fastify.post('/companies/:companyId/journal-entries', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');

    const body = request.body as {
      date?: string; // ISO or YYYY-MM-DD
      description?: string;
      locationId?: number;
      warehouseId?: number; // backward-compatible alias
      lines?: { accountId?: number; debit?: number; credit?: number }[];
    };

    if (!body.lines || body.lines.length === 0) {
      reply.status(400);
      return { error: 'at least one line is required' };
    }

    const date = parseDateInput(body.date) ?? new Date();
    if (body.date && isNaN(date.getTime())) {
      reply.status(400);
      return { error: 'invalid date (must be ISO string)' };
    }

    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      reply.status(400);
      return { error: 'Idempotency-Key header is required' };
    }

    const eventId = randomUUID();
    const correlationId = eventId;
    const occurredAt = new Date().toISOString();

    const lockKey = `lock:manual-journal:${companyId}:${date.toISOString().slice(0, 10)}`;
    const { response } = await withLockBestEffort(redis, lockKey, 30_000, async () =>
      runIdempotentRequest(
        prisma,
        companyId,
        idempotencyKey,
        async () => {
          const created = await prisma.$transaction(async (tx: any) => {
            const je = await postJournalEntry(tx, {
              companyId,
              date,
              description: body.description ?? '',
              locationId: (body.locationId ?? body.warehouseId) ? Number(body.locationId ?? body.warehouseId) : null,
              createdByUserId: (request as any).user?.userId ?? null,
              lines: (body.lines ?? []).map((line) => ({
                accountId: Number(line.accountId),
                debit: new Prisma.Decimal((line.debit ?? 0).toFixed(2)),
                credit: new Prisma.Decimal((line.credit ?? 0).toFixed(2)),
              })),
            });

            // Totals for response/event
            const totalDebit = je.lines.reduce(
              (sum: Prisma.Decimal, l: any) => sum.add(new Prisma.Decimal(l.debit)),
              new Prisma.Decimal(0)
            );
            const totalCredit = je.lines.reduce(
              (sum: Prisma.Decimal, l: any) => sum.add(new Prisma.Decimal(l.credit)),
              new Prisma.Decimal(0)
            );

            await tx.event.create({
              data: {
                companyId,
                eventId,
                eventType: 'journal.entry.created',
                schemaVersion: 'v1',
                occurredAt: new Date(occurredAt),
                source: 'cashflow-api',
                partitionKey: String(companyId),
                correlationId,
                aggregateType: 'JournalEntry',
                aggregateId: String(je.id),
                type: 'JournalEntryCreated',
                payload: {
                  journalEntryId: je.id,
                  companyId,
                  totalDebit: Number(totalDebit),
                  totalCredit: Number(totalCredit),
                },
              },
            });

            await writeAuditLog(tx as any, {
              companyId,
              userId: (request as any).user?.userId ?? null,
              action: 'journal_entry.create_manual',
              entityType: 'JournalEntry',
              entityId: je.id,
              idempotencyKey,
              correlationId,
              metadata: {
                date,
                description: body.description ?? '',
                totalDebit: Number(totalDebit),
                totalCredit: Number(totalCredit),
                linesCount: (body.lines ?? []).length,
              },
            });

            return {
              id: je.id,
              date: je.date,
              description: je.description,
              totalDebit: Number(totalDebit),
              totalCredit: Number(totalCredit),
              balanced: new Prisma.Decimal(totalDebit).toDecimalPlaces(2).equals(new Prisma.Decimal(totalCredit).toDecimalPlaces(2)),
            };
          });

          return created;
        },
        redis
      )
    );

    return response as any;
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
      entryNumber: (entry as any).entryNumber ?? null,
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
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const body = request.body as {
      companyId?: number;
      date?: string; // ISO string
      description?: string;
      locationId?: number;
      warehouseId?: number; // backward-compatible alias
      lines?: { accountId?: number; debit?: number; credit?: number }[];
    };

    if (!body.lines || body.lines.length === 0) {
      reply.status(400);
      return { error: 'at least one line is required' };
    }

    // Never trust companyId from client. We derive it from JWT (and forbid mismatches).
    const companyId = forbidClientProvidedCompanyId(request, reply, body.companyId);
    const date = parseDateInput(body.date) ?? new Date();

    // Prepare event data
    const eventId = randomUUID();
    const correlationId = eventId; // Step 1 default: correlationId = first eventId in workflow
    const occurredAt = new Date().toISOString();
    const eventType = 'journal.entry.created';
    const schemaVersion = 'v1' as const;
    const source = 'cashflow-api';

    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      reply.status(400);
      return { error: 'Idempotency-Key header is required' };
    }

    // Wrap in idempotency so retries can't duplicate journal entries.
    const { response } = await runIdempotentRequest(
      prisma,
      companyId,
      idempotencyKey,
      async () => {
        const entry = await prisma.$transaction(async (tx: any) => {
          const created = await postJournalEntry(tx, {
            companyId,
            date,
            description: body.description ?? '',
            createdByUserId: (request as any).user?.userId ?? null,
            locationId: (body.locationId ?? body.warehouseId) ? Number(body.locationId ?? body.warehouseId) : null,
            lines: (body.lines ?? []).map((line) => ({
              accountId: line.accountId!,
              debit: new Prisma.Decimal((line.debit ?? 0).toFixed(2)),
              credit: new Prisma.Decimal((line.credit ?? 0).toFixed(2)),
            })),
          });

          // Compute totals from normalized lines (Decimal-safe)
          const totalDebit = created.lines.reduce(
            (sum: Prisma.Decimal, l: any) => sum.add(new Prisma.Decimal(l.debit)),
            new Prisma.Decimal(0)
          );
          const totalCredit = created.lines.reduce(
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
              aggregateId: String(created.id),
              type: 'JournalEntryCreated', // Legacy field, keeping for now
              payload: {
                journalEntryId: created.id,
                companyId,
                totalDebit: Number(totalDebit),
                totalCredit: Number(totalCredit),
              },
            },
          });

          await writeAuditLog(tx as any, {
            companyId,
            userId: (request as any).user?.userId ?? null,
            action: 'journal_entry.create',
            entityType: 'JournalEntry',
            entityId: created.id,
            idempotencyKey,
            correlationId,
            metadata: {
              date,
              description: body.description ?? '',
              locationId: (body.locationId ?? body.warehouseId) ? Number(body.locationId ?? body.warehouseId) : null,
              totalDebit: Number(totalDebit),
              totalCredit: Number(totalCredit),
            },
          });

          return created;
        });
        return entry;
      },
      redis
    );
    return response as any;
  });

  // --- Reverse a posted journal entry (immutable ledger) ---
  // POST /companies/:companyId/journal-entries/:journalEntryId/reverse
  // Requires Idempotency-Key header to prevent duplicate reversals under retries.
  fastify.post(
    '/companies/:companyId/journal-entries/:journalEntryId/reverse',
    async (request, reply) => {
      const companyId = requireCompanyIdParam(request, reply);
      requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
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
      const reversalDate = parseDateInput(body.date) ?? new Date();
      if (body.date && isNaN(reversalDate.getTime())) {
        reply.status(400);
        return { error: 'invalid date (must be ISO string)' };
      }

      const correlationId = randomUUID();
      const occurredAt = new Date().toISOString();

      try {
        const lockKey = `lock:journal-entry:reverse:${companyId}:${journalEntryId}`;

        const { replay, response: result } = await withLockBestEffort(
          redis,
          lockKey,
          30_000,
          async () =>
            await runIdempotentRequest(
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

              await writeAuditLog(tx as any, {
                companyId,
                userId: (request as any).user?.userId ?? null,
                action: 'journal_entry.reverse',
                entityType: 'JournalEntry',
                entityId: reversalEntry.id,
                idempotencyKey,
                correlationId,
                metadata: {
                  originalJournalEntryId: original.id,
                  reversalDate,
                  reason: body.reason ?? null,
                },
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
              },
              redis
            )
        );

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

  // --- Void a posted journal entry (alias of reverse + void metadata on original) ---
  // POST /companies/:companyId/journal-entries/:journalEntryId/void
  // Body: { reason, date? }
  fastify.post('/companies/:companyId/journal-entries/:journalEntryId/void', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
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
    if (!body.reason || !String(body.reason).trim()) {
      reply.status(400);
      return { error: 'reason is required' };
    }
    const reversalDate = parseDateInput(body.date) ?? new Date();
    if (body.date && isNaN(reversalDate.getTime())) {
      reply.status(400);
      return { error: 'invalid date (must be ISO string)' };
    }

    const correlationId = randomUUID();
    const occurredAt = new Date().toISOString();
    const lockKey = `lock:journal-entry:void:${companyId}:${journalEntryId}`;

    try {
      const { response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () =>
        runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
          const txResult = await prisma.$transaction(async (tx: any) => {
            const original = await tx.journalEntry.findFirst({
              where: { id: journalEntryId, companyId },
              include: { lines: true },
            });
            if (!original) throw Object.assign(new Error('journal entry not found'), { statusCode: 404 });
            if (original.reversalOfJournalEntryId) throw Object.assign(new Error('cannot void a reversal entry'), { statusCode: 400 });

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
              description: `VOID REVERSAL of JE ${original.id}: ${original.description}`,
              createdByUserId: (request as any).user?.userId ?? null,
              reversalOfJournalEntryId: original.id,
              reversalReason: String(body.reason).trim(),
              lines: reversalLines,
            });

            // Mark original as voided (metadata only; lines remain immutable)
            const voidedAt = new Date();
            await tx.journalEntry.updateMany({
              where: { id: original.id, companyId },
              data: {
                voidedAt,
                voidReason: String(body.reason).trim(),
                voidedByUserId: (request as any).user?.userId ?? null,
                updatedByUserId: (request as any).user?.userId ?? null,
              } as any,
            });

            await writeAuditLog(tx as any, {
              companyId,
              userId: (request as any).user?.userId ?? null,
              action: 'journal_entry.void',
              entityType: 'JournalEntry',
              entityId: original.id,
              idempotencyKey,
              correlationId,
              metadata: {
                reason: String(body.reason).trim(),
                reversalDate,
                voidedAt,
                originalJournalEntryId: original.id,
                voidReversalJournalEntryId: reversalEntry.id,
              },
            });

            // Outbox events
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
                payload: { journalEntryId: reversalEntry.id, companyId, reversalOfJournalEntryId: original.id },
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
                aggregateId: String(original.id),
                type: 'JournalEntryReversed',
                payload: {
                  originalJournalEntryId: original.id,
                  reversalJournalEntryId: reversalEntry.id,
                  companyId,
                  reason: String(body.reason).trim(),
                },
              },
            });

            return { originalJournalEntryId: original.id, voidReversalJournalEntryId: reversalEntry.id };
          });

          return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
        }, redis)
      );

      return { originalJournalEntryId: (result as any).originalJournalEntryId, voidReversalJournalEntryId: (result as any).voidReversalJournalEntryId };
    } catch (err: any) {
      if (err?.statusCode) {
        reply.status(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });

  // --- Adjust a posted journal entry (immutable ledger): reverse original and post corrected entry ---
  // POST /companies/:companyId/journal-entries/:journalEntryId/adjust
  // Body: { reason, date?, description?, lines:[{accountId,debit,credit}] }
  fastify.post('/companies/:companyId/journal-entries/:journalEntryId/adjust', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
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

    const body = (request.body ?? {}) as {
      reason?: string;
      date?: string;
      description?: string;
      lines?: Array<{ accountId?: number; debit?: number; credit?: number }>;
    };
    if (!body.reason || !String(body.reason).trim()) {
      reply.status(400);
      return { error: 'reason is required' };
    }
    if (!body.lines?.length) {
      reply.status(400);
      return { error: 'lines is required' };
    }

    const newDate = parseDateInput(body.date) ?? new Date();
    if (body.date && isNaN(newDate.getTime())) {
      reply.status(400);
      return { error: 'invalid date (must be ISO string)' };
    }

    const correlationId = randomUUID();
    const occurredAt = new Date().toISOString();
    const lockKey = `lock:journal-entry:adjust:${companyId}:${journalEntryId}`;

    try {
      const { response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () =>
        runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
          const txResult = await prisma.$transaction(async (tx: any) => {
            const original = await tx.journalEntry.findFirst({
              where: { id: journalEntryId, companyId },
              include: { lines: true },
            });
            if (!original) throw Object.assign(new Error('journal entry not found'), { statusCode: 404 });
            if (original.reversalOfJournalEntryId) throw Object.assign(new Error('cannot adjust a reversal entry'), { statusCode: 400 });

            const existingReversal = await tx.journalEntry.findFirst({
              where: { companyId, reversalOfJournalEntryId: original.id },
              select: { id: true },
            });
            if (existingReversal) throw Object.assign(new Error('journal entry already reversed (cannot adjust)'), { statusCode: 400 });

            const reversalLines = original.lines.map((l: any) => ({
              accountId: l.accountId,
              debit: new Prisma.Decimal(l.credit).toDecimalPlaces(2),
              credit: new Prisma.Decimal(l.debit).toDecimalPlaces(2),
            }));

            const reversalEntry = await postJournalEntry(tx, {
              companyId,
              date: newDate,
              description: `REVERSAL (ADJUST) of JE ${original.id}: ${original.description}`,
              createdByUserId: (request as any).user?.userId ?? null,
              reversalOfJournalEntryId: original.id,
              reversalReason: String(body.reason).trim(),
              lines: reversalLines,
            });

            const correctedEntry = await postJournalEntry(tx, {
              companyId,
              date: newDate,
              description: body.description ?? `CORRECTED for JE ${original.id}: ${String(body.reason).trim()}`,
              createdByUserId: (request as any).user?.userId ?? null,
              lines: (body.lines ?? []).map((l) => ({
                accountId: Number(l.accountId),
                debit: new Prisma.Decimal((Number(l.debit ?? 0) || 0).toFixed(2)),
                credit: new Prisma.Decimal((Number(l.credit ?? 0) || 0).toFixed(2)),
              })),
            });

            await writeAuditLog(tx as any, {
              companyId,
              userId: (request as any).user?.userId ?? null,
              action: 'journal_entry.adjust',
              entityType: 'JournalEntry',
              entityId: correctedEntry.id,
              idempotencyKey,
              correlationId,
              metadata: {
                reason: String(body.reason).trim(),
                date: newDate,
                originalJournalEntryId: original.id,
                reversalJournalEntryId: reversalEntry.id,
                correctedJournalEntryId: correctedEntry.id,
                linesCount: (body.lines ?? []).length,
              },
            });

            // Outbox events: reversal created + reversed semantic, and corrected entry created
            const reversalCreatedEventId = randomUUID();
            await tx.event.create({
              data: {
                companyId,
                eventId: reversalCreatedEventId,
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
                payload: { journalEntryId: reversalEntry.id, companyId, reversalOfJournalEntryId: original.id },
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
                causationId: reversalCreatedEventId,
                aggregateType: 'JournalEntry',
                aggregateId: String(original.id),
                type: 'JournalEntryReversed',
                payload: {
                  originalJournalEntryId: original.id,
                  reversalJournalEntryId: reversalEntry.id,
                  companyId,
                  reason: String(body.reason).trim(),
                },
              },
            });
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
                causationId: String(reversalEntry.id),
                aggregateType: 'JournalEntry',
                aggregateId: String(correctedEntry.id),
                type: 'JournalEntryCreated',
                payload: { journalEntryId: correctedEntry.id, companyId, source: 'JournalEntryAdjustment', originalJournalEntryId: original.id },
              },
            });

            return {
              originalJournalEntryId: original.id,
              reversalJournalEntryId: reversalEntry.id,
              correctedJournalEntryId: correctedEntry.id,
            };
          });

          return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
        }, redis)
      );

      return {
        originalJournalEntryId: (result as any).originalJournalEntryId,
        reversalJournalEntryId: (result as any).reversalJournalEntryId,
        correctedJournalEntryId: (result as any).correctedJournalEntryId,
      };
    } catch (err: any) {
      if (err?.statusCode) {
        reply.status(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });

  // --- Period Close (Month/Year End Close) ---
  // POST /companies/:companyId/period-close?from=YYYY-MM-DD&to=YYYY-MM-DD
  //
  // Creates a closing journal entry that moves INCOME/EXPENSE balances for the period
  // into Retained Earnings (Equity), and records a PeriodClose row to prevent double-close.
  //
  // NOTE: This is a simplified close (no accrual adjustments, no depreciation, etc.).
  // It is safe because it uses immutable journal entries and is idempotent + locked.
  fastify.post('/companies/:companyId/period-close', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const query = request.query as { from?: string; to?: string };

    if (!query.from || !query.to) {
      reply.status(400);
      return { error: 'from and to are required (YYYY-MM-DD)' };
    }

    const fromDate = normalizeToDay(new Date(query.from));
    const toDate = normalizeToDay(new Date(query.to));
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      reply.status(400);
      return { error: 'invalid from/to dates' };
    }
    if (fromDate.getTime() > toDate.getTime()) {
      reply.status(400);
      return { error: 'from must be <= to' };
    }

    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      reply.status(400);
      return { error: 'Idempotency-Key header is required' };
    }

    const occurredAt = new Date().toISOString();
    const correlationId = randomUUID();

    const lockKey = `lock:period-close:${companyId}:${query.from}:${query.to}`;

    try {
      const { replay, response: result } = await withLockBestEffort(redis, lockKey, 60_000, async () =>
        runIdempotentRequest(
          prisma,
          companyId,
          idempotencyKey,
          async () => {
            const txResult = await prisma.$transaction(async (tx: any) => {
              // Prevent double-close for this period
              const existing = await tx.periodClose.findFirst({
                where: { companyId, fromDate, toDate },
                select: { id: true, journalEntryId: true },
              });
              if (existing) {
                return {
                  periodCloseId: existing.id,
                  journalEntryId: existing.journalEntryId,
                  alreadyClosed: true,
                };
              }

              // Find or create Retained Earnings equity account
              let retained = await tx.account.findFirst({
                where: { companyId, type: 'EQUITY', code: '3100' },
              });
              if (!retained) {
                retained = await tx.account.create({
                  data: {
                    companyId,
                    code: '3100',
                    name: 'Retained Earnings',
                    type: 'EQUITY',
                    normalBalance: 'CREDIT',
                    reportGroup: 'EQUITY',
                    cashflowActivity: 'FINANCING',
                  },
                });
              }

              // Sum INCOME/EXPENSE totals for the period from AccountBalance
              const grouped = await tx.accountBalance.groupBy({
                by: ['accountId'],
                where: { companyId, date: { gte: fromDate, lte: toDate } },
                _sum: { debitTotal: true, creditTotal: true },
              });
              const accountIds = grouped.map((g: any) => g.accountId);
              const accounts: any[] = await tx.account.findMany({
                where: { companyId, id: { in: accountIds }, type: { in: ['INCOME', 'EXPENSE'] } },
                select: { id: true, code: true, name: true, type: true },
              });
              const byId: Map<number, any> = new Map(accounts.map((a: any) => [a.id, a]));

              // Build closing lines that zero each INCOME/EXPENSE account
              const lines: Array<{ accountId: number; debit: Prisma.Decimal; credit: Prisma.Decimal }> = [];

              let totalIncome = new Prisma.Decimal(0);
              let totalExpense = new Prisma.Decimal(0);

              for (const g of grouped as any[]) {
                const acc: any = byId.get((g as any).accountId);
                if (!acc) continue;
                const debit = new Prisma.Decimal((g as any)._sum.debitTotal ?? 0).toDecimalPlaces(2);
                const credit = new Prisma.Decimal((g as any)._sum.creditTotal ?? 0).toDecimalPlaces(2);

                if (acc.type === 'INCOME') {
                  const net = credit.sub(debit).toDecimalPlaces(2); // positive = normal revenue
                  if (net.equals(0)) continue;
                  totalIncome = totalIncome.add(net);

                  // Close income: debit the income account for its net credit balance (or credit if net negative)
                  if (net.greaterThan(0)) {
                    lines.push({ accountId: acc.id, debit: net, credit: new Prisma.Decimal(0) });
                  } else {
                    lines.push({ accountId: acc.id, debit: new Prisma.Decimal(0), credit: net.abs() });
                  }
                } else if (acc.type === 'EXPENSE') {
                  const net = debit.sub(credit).toDecimalPlaces(2); // positive = normal expense
                  if (net.equals(0)) continue;
                  totalExpense = totalExpense.add(net);

                  // Close expense: credit the expense account for its net debit balance (or debit if net negative)
                  if (net.greaterThan(0)) {
                    lines.push({ accountId: acc.id, debit: new Prisma.Decimal(0), credit: net });
                  } else {
                    lines.push({ accountId: acc.id, debit: net.abs(), credit: new Prisma.Decimal(0) });
                  }
                }
              }

              totalIncome = totalIncome.toDecimalPlaces(2);
              totalExpense = totalExpense.toDecimalPlaces(2);
              const netProfit = totalIncome.sub(totalExpense).toDecimalPlaces(2); // positive = profit

              // Offset to Retained Earnings
              if (netProfit.greaterThan(0)) {
                // Profit: credit equity
                lines.push({ accountId: retained.id, debit: new Prisma.Decimal(0), credit: netProfit });
              } else if (netProfit.lessThan(0)) {
                // Loss: debit equity
                lines.push({ accountId: retained.id, debit: netProfit.abs(), credit: new Prisma.Decimal(0) });
              } else {
                // Zero profit: still record period close with a minimal JE? We'll block to avoid noise.
                throw Object.assign(new Error('net profit is zero for this period; nothing to close'), {
                  statusCode: 400,
                });
              }

              // Ensure balanced
              const debitSum = lines.reduce((sum, l) => sum.add(l.debit), new Prisma.Decimal(0)).toDecimalPlaces(2);
              const creditSum = lines.reduce((sum, l) => sum.add(l.credit), new Prisma.Decimal(0)).toDecimalPlaces(2);
              if (!debitSum.equals(creditSum)) {
                throw Object.assign(new Error('closing entry not balanced'), { statusCode: 500 });
              }

              const je = await postJournalEntry(tx, {
                companyId,
                date: toDate,
                description: `PERIOD CLOSE ${query.from} to ${query.to}`,
                createdByUserId: (request as any).user?.userId ?? null,
                lines,
              });

              const periodClose = await tx.periodClose.create({
                data: {
                  companyId,
                  fromDate,
                  toDate,
                  journalEntryId: je.id,
                  createdByUserId: (request as any).user?.userId ?? null,
                },
              });

              await writeAuditLog(tx as any, {
                companyId,
                userId: (request as any).user?.userId ?? null,
                action: 'period_close.create',
                entityType: 'PeriodClose',
                entityId: periodClose.id,
                idempotencyKey,
                correlationId,
                metadata: {
                  from: query.from,
                  to: query.to,
                  journalEntryId: je.id,
                  netProfit: netProfit.toString(),
                },
              });

              const eventId = randomUUID();
              await tx.event.create({
                data: {
                  companyId,
                  eventId,
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

              return {
                periodCloseId: periodClose.id,
                journalEntryId: je.id,
                alreadyClosed: false,
                netProfit: netProfit.toString(),
                _eventId: eventId,
              };
            });

            // If already closed, just return stable response
            if ((txResult as any).alreadyClosed) {
              return txResult;
            }

            return {
              ...txResult,
              _correlationId: correlationId,
              _occurredAt: occurredAt,
            };
          },
          redis
        )
      );

      return {
        companyId,
        from: query.from,
        to: query.to,
        periodCloseId: (result as any).periodCloseId,
        journalEntryId: (result as any).journalEntryId,
        alreadyClosed: (result as any).alreadyClosed ?? false,
        netProfit: (result as any).netProfit ?? null,
      };
    } catch (err: any) {
      if (err?.statusCode) {
        reply.status(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });

  // --- Trial Balance report (proof: total debits == total credits) ---
  // Example: GET /companies/2/reports/trial-balance?from=2025-12-01&to=2025-12-31
  fastify.get('/companies/:companyId/reports/trial-balance', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);

    const query = request.query as { from?: string; to?: string };
    if (!query.from || !query.to) {
      reply.status(400);
      return { error: 'from and to are required (YYYY-MM-DD)' };
    }

    const fromDate = normalizeToDay(new Date(query.from));
    const toDate = normalizeToDay(new Date(query.to));
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      reply.status(400);
      return { error: 'invalid from/to dates' };
    }

    // Aggregate from AccountBalance (daily increments) within the period (inclusive).
    const grouped = await prisma.accountBalance.groupBy({
      by: ['accountId'],
      where: {
        companyId,
        date: { gte: fromDate, lte: toDate },
      },
      _sum: { debitTotal: true, creditTotal: true },
    });

    const accountIds = grouped.map((g) => g.accountId);
    const accounts = await prisma.account.findMany({
      where: { companyId, id: { in: accountIds } },
      select: { id: true, code: true, name: true, type: true, normalBalance: true, reportGroup: true },
    });
    const accountById = new Map(accounts.map((a) => [a.id, a]));

    let totalDebit = new Prisma.Decimal(0);
    let totalCredit = new Prisma.Decimal(0);

    const rows = grouped
      .map((g) => {
        const acc = accountById.get(g.accountId);
        const debit = new Prisma.Decimal(g._sum.debitTotal ?? 0);
        const credit = new Prisma.Decimal(g._sum.creditTotal ?? 0);
        totalDebit = totalDebit.add(debit);
        totalCredit = totalCredit.add(credit);

        return {
          accountId: g.accountId,
          code: acc?.code ?? null,
          name: acc?.name ?? null,
          type: acc?.type ?? null,
          normalBalance: acc?.normalBalance ?? null,
          reportGroup: acc?.reportGroup ?? null,
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

  // --- Balance Sheet report (ASSET / LIABILITY / EQUITY) ---
  // Example: GET /companies/2/reports/balance-sheet?asOf=2025-12-31
  fastify.get('/companies/:companyId/reports/balance-sheet', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const query = request.query as { asOf?: string };

    const asOfDate = query.asOf ? new Date(query.asOf) : new Date();
    if (query.asOf && isNaN(asOfDate.getTime())) {
      reply.status(400);
      return { error: 'invalid asOf date (YYYY-MM-DD)' };
    }
    asOfDate.setHours(0, 0, 0, 0);

    // Aggregate from AccountBalance (daily increments) up to asOf (inclusive)
    const grouped = await prisma.accountBalance.groupBy({
      by: ['accountId'],
      where: {
        companyId,
        date: { lte: asOfDate },
      },
      _sum: { debitTotal: true, creditTotal: true },
    });

    // Compute current earnings (net income) up to asOf from INCOME/EXPENSE accounts.
    // This removes the confusing "Out of balance" warning in Balance Sheet before period close.
    // After a period close, INCOME/EXPENSE accounts for closed periods are zeroed by the close entry,
    // so this naturally trends toward 0 for closed periods.
    const pnlGrouped = await prisma.accountBalance.groupBy({
      by: ['accountId'],
      where: { companyId, date: { lte: asOfDate } },
      _sum: { debitTotal: true, creditTotal: true },
    });
    const pnlAccountIds = pnlGrouped.map((g) => g.accountId);
    const pnlAccounts = await prisma.account.findMany({
      where: { companyId, id: { in: pnlAccountIds }, type: { in: ['INCOME', 'EXPENSE'] } },
      select: { id: true, type: true },
    });
    const pnlById = new Map(pnlAccounts.map((a) => [a.id, a]));

    let totalIncome = new Prisma.Decimal(0);
    let totalExpense = new Prisma.Decimal(0);
    for (const g of pnlGrouped) {
      const acc = pnlById.get(g.accountId);
      if (!acc) continue;
      const debit = new Prisma.Decimal(g._sum.debitTotal ?? 0).toDecimalPlaces(2);
      const credit = new Prisma.Decimal(g._sum.creditTotal ?? 0).toDecimalPlaces(2);
      if (acc.type === 'INCOME') totalIncome = totalIncome.add(credit.sub(debit));
      if (acc.type === 'EXPENSE') totalExpense = totalExpense.add(debit.sub(credit));
    }
    totalIncome = totalIncome.toDecimalPlaces(2);
    totalExpense = totalExpense.toDecimalPlaces(2);
    const currentEarnings = totalIncome.sub(totalExpense).toDecimalPlaces(2);

    const accountIds = grouped.map((g) => g.accountId);
    const accounts = await prisma.account.findMany({
      where: {
        companyId,
        id: { in: accountIds },
        type: { in: ['ASSET', 'LIABILITY', 'EQUITY'] },
      },
      select: { id: true, code: true, name: true, type: true },
    });
    const accountById = new Map(accounts.map((a) => [a.id, a]));

    const rows = grouped
      .map((g) => {
        const acc = accountById.get(g.accountId);
        if (!acc) return null; // skip income/expense or missing

        const debit = new Prisma.Decimal(g._sum.debitTotal ?? 0).toDecimalPlaces(2);
        const credit = new Prisma.Decimal(g._sum.creditTotal ?? 0).toDecimalPlaces(2);

        // Normal balance:
        // - Assets: debit - credit
        // - Liabilities/Equity: credit - debit
        const balance =
          acc.type === 'ASSET' ? debit.sub(credit) : credit.sub(debit);

        return {
          accountId: acc.id,
          code: acc.code,
          name: acc.name,
          type: acc.type,
          debit: debit.toString(),
          credit: credit.toString(),
          balance: balance.toString(),
        };
      })
      .filter(Boolean) as Array<{
        accountId: number;
        code: string;
        name: string;
        type: string;
        debit: string;
        credit: string;
        balance: string;
      }>;

    const assets = rows.filter((r) => r.type === 'ASSET');
    const liabilities = rows.filter((r) => r.type === 'LIABILITY');
    const equity = rows.filter((r) => r.type === 'EQUITY');

    // Add synthetic equity line for current earnings so accounting equation holds without requiring period close.
    // If currentEarnings is 0, omit to reduce noise.
    if (!currentEarnings.equals(0)) {
      const credit = currentEarnings.greaterThan(0) ? currentEarnings : new Prisma.Decimal(0);
      const debit = currentEarnings.lessThan(0) ? currentEarnings.abs() : new Prisma.Decimal(0);
      equity.push({
        accountId: 0,
        code: '9999',
        name: 'Current Period Earnings',
        type: 'EQUITY',
        debit: debit.toString(),
        credit: credit.toString(),
        // For equity, normal balance is credit - debit
        balance: credit.sub(debit).toDecimalPlaces(2).toString(),
      });
    }

    const sumBalances = (items: typeof rows) =>
      items.reduce((sum, r) => sum.add(new Prisma.Decimal(r.balance)), new Prisma.Decimal(0)).toDecimalPlaces(2);

    const totalAssets = sumBalances(assets);
    const totalLiabilities = sumBalances(liabilities);
    const totalEquity = sumBalances(equity);

    return {
      companyId,
      asOf: asOfDate.toISOString().slice(0, 10),
      totals: {
        assets: totalAssets.toString(),
        liabilities: totalLiabilities.toString(),
        equity: totalEquity.toString(),
        // Accounting equation check (includes current earnings as synthetic equity line)
        balanced: totalAssets.equals(totalLiabilities.add(totalEquity)),
      },
      assets,
      liabilities,
      equity,
    };
  });

  // --- Simple Profit & Loss report ---
  // Preferred (tenant-scoped) endpoint:
  // GET /companies/:companyId/reports/profit-and-loss?from=YYYY-MM-DD&to=YYYY-MM-DD
  fastify.get('/companies/:companyId/reports/profit-and-loss', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const query = request.query as { from?: string; to?: string };

    if (!query.from || !query.to) {
      reply.status(400);
      return { error: 'from and to are required (YYYY-MM-DD)' };
    }

    const fromDate = normalizeToDay(new Date(query.from));
    const toDate = normalizeToDay(new Date(query.to));
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      reply.status(400);
      return { error: 'invalid from/to dates' };
    }

    const grouped = await prisma.accountBalance.groupBy({
      by: ['accountId'],
      where: { companyId, date: { gte: fromDate, lte: toDate } },
      _sum: { debitTotal: true, creditTotal: true },
    });

    const accountIds = grouped.map((g) => g.accountId);
    const accounts = await prisma.account.findMany({
      where: { companyId, id: { in: accountIds }, type: { in: ['INCOME', 'EXPENSE'] } },
      select: { id: true, code: true, name: true, type: true, reportGroup: true },
    });
    const accountById = new Map(accounts.map((a) => [a.id, a]));

    const incomeAccounts: Array<{
      accountId: number;
      code: string;
      name: string;
      reportGroup: string | null;
      amount: string;
    }> = [];
    const expenseAccounts: Array<{
      accountId: number;
      code: string;
      name: string;
      reportGroup: string | null;
      amount: string;
    }> = [];

    let totalIncome = new Prisma.Decimal(0);
    let totalExpense = new Prisma.Decimal(0);

    for (const g of grouped) {
      const acc = accountById.get(g.accountId);
      if (!acc) continue;

      const debit = new Prisma.Decimal(g._sum.debitTotal ?? 0).toDecimalPlaces(2);
      const credit = new Prisma.Decimal(g._sum.creditTotal ?? 0).toDecimalPlaces(2);

      if (acc.type === 'INCOME') {
        const amount = credit.sub(debit).toDecimalPlaces(2);
        totalIncome = totalIncome.add(amount);
        incomeAccounts.push({
          accountId: acc.id,
          code: acc.code,
          name: acc.name,
          reportGroup: acc.reportGroup ?? null,
          amount: amount.toString(),
        });
      } else if (acc.type === 'EXPENSE') {
        const amount = debit.sub(credit).toDecimalPlaces(2);
        totalExpense = totalExpense.add(amount);
        expenseAccounts.push({
          accountId: acc.id,
          code: acc.code,
          name: acc.name,
          reportGroup: acc.reportGroup ?? null,
          amount: amount.toString(),
        });
      }
    }

    incomeAccounts.sort((a, b) => a.code.localeCompare(b.code));
    expenseAccounts.sort((a, b) => a.code.localeCompare(b.code));

    totalIncome = totalIncome.toDecimalPlaces(2);
    totalExpense = totalExpense.toDecimalPlaces(2);
    const netProfit = totalIncome.sub(totalExpense).toDecimalPlaces(2);

    return {
      companyId,
      from: query.from,
      to: query.to,
      totalIncome: totalIncome.toString(),
      totalExpense: totalExpense.toString(),
      netProfit: netProfit.toString(),
      incomeAccounts,
      expenseAccounts,
    };
  });

  // --- Account Transactions (drill-down from reports) ---
  // GET /companies/:companyId/reports/account-transactions?accountId=123&from=YYYY-MM-DD&to=YYYY-MM-DD&take=200
  fastify.get('/companies/:companyId/reports/account-transactions', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const query = request.query as { accountId?: string; from?: string; to?: string; take?: string };

    const accountId = Number(query.accountId ?? 0);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      reply.status(400);
      return { error: 'accountId is required' };
    }
    if (!query.from || !query.to) {
      reply.status(400);
      return { error: 'from and to are required (YYYY-MM-DD)' };
    }

    const fromDate = normalizeToDay(new Date(query.from));
    const toDate = normalizeToDay(new Date(query.to));
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      reply.status(400);
      return { error: 'invalid from/to dates' };
    }
    if (fromDate.getTime() > toDate.getTime()) {
      reply.status(400);
      return { error: 'from must be <= to' };
    }

    const take = Math.min(Math.max(Number(query.take ?? 200) || 200, 1), 1000);

    const account = await prisma.account.findFirst({
      where: { companyId, id: accountId },
      select: { id: true, code: true, name: true, type: true, normalBalance: true },
    });
    if (!account) {
      reply.status(404);
      return { error: 'account not found' };
    }

    // Opening balance (source-of-truth from journal lines, independent of worker projections)
    const openingAgg = await prisma.journalLine.aggregate({
      where: {
        companyId,
        accountId,
        journalEntry: { date: { lt: fromDate } },
      } as any,
      _sum: { debit: true, credit: true },
    });
    const openingDebit = new Prisma.Decimal(openingAgg._sum.debit ?? 0).toDecimalPlaces(2);
    const openingCredit = new Prisma.Decimal(openingAgg._sum.credit ?? 0).toDecimalPlaces(2);
    const openingNet = account.normalBalance === 'DEBIT' ? openingDebit.sub(openingCredit) : openingCredit.sub(openingDebit);
    const openingAbs = openingNet.abs().toDecimalPlaces(2);
    const openingSide = openingNet.greaterThanOrEqualTo(0) ? (account.normalBalance === 'DEBIT' ? 'Dr' : 'Cr') : (account.normalBalance === 'DEBIT' ? 'Cr' : 'Dr');

    // Pull journal lines for the period, include the parent journal entry
    const lines = await prisma.journalLine.findMany({
      where: {
        companyId,
        accountId,
        journalEntry: { date: { gte: fromDate, lte: toDate } },
      } as any,
      include: {
        journalEntry: { select: { id: true, entryNumber: true, date: true, description: true } },
      },
      orderBy: [{ journalEntry: { date: 'asc' } }, { journalEntryId: 'asc' }, { id: 'asc' }] as any,
      take,
    });

    // Group by journal entry (one row per JE for this account)
    const byEntry = new Map<number, { entry: any; debit: Prisma.Decimal; credit: Prisma.Decimal }>();
    for (const l of lines as any[]) {
      const jeId = Number(l.journalEntryId);
      const prev = byEntry.get(jeId);
      const debit = new Prisma.Decimal(l.debit ?? 0).toDecimalPlaces(2);
      const credit = new Prisma.Decimal(l.credit ?? 0).toDecimalPlaces(2);
      if (!prev) {
        byEntry.set(jeId, { entry: l.journalEntry, debit, credit });
      } else {
        prev.debit = prev.debit.add(debit).toDecimalPlaces(2);
        prev.credit = prev.credit.add(credit).toDecimalPlaces(2);
      }
    }

    const entryIds = Array.from(byEntry.keys());

    // Best-effort source document inference (fast lookups by journalEntryId)
    const [invoices, creditNotes, payments, expenses, purchaseBills, vendorCredits, pbPayments, expPayments] = await Promise.all([
      prisma.invoice.findMany({ where: { companyId, journalEntryId: { in: entryIds } }, select: { journalEntryId: true, invoiceNumber: true } }),
      prisma.creditNote.findMany({ where: { companyId, journalEntryId: { in: entryIds } }, select: { journalEntryId: true, creditNoteNumber: true } } as any),
      prisma.payment.findMany({ where: { companyId, journalEntryId: { in: entryIds } }, select: { journalEntryId: true, id: true, invoiceId: true } }),
      prisma.expense.findMany({ where: { companyId, journalEntryId: { in: entryIds } }, select: { journalEntryId: true, expenseNumber: true } } as any),
      prisma.purchaseBill.findMany({ where: { companyId, journalEntryId: { in: entryIds } }, select: { journalEntryId: true, billNumber: true } } as any),
      prisma.vendorCredit.findMany({ where: { companyId, journalEntryId: { in: entryIds } }, select: { journalEntryId: true, creditNumber: true } } as any),
      prisma.purchaseBillPayment.findMany({ where: { companyId, journalEntryId: { in: entryIds } }, select: { journalEntryId: true, id: true, purchaseBillId: true } } as any),
      prisma.expensePayment.findMany({ where: { companyId, journalEntryId: { in: entryIds } }, select: { journalEntryId: true, id: true, expenseId: true } } as any),
    ]);

    const sourceByJeId = new Map<number, { transactionType: string; transactionNo: string; referenceNo: string | null }>();
    for (const i of invoices as any[]) sourceByJeId.set(Number(i.journalEntryId), { transactionType: 'Invoice', transactionNo: i.invoiceNumber, referenceNo: null });
    for (const c of creditNotes as any[]) sourceByJeId.set(Number(c.journalEntryId), { transactionType: 'Credit Note', transactionNo: (c as any).creditNoteNumber ?? String((c as any).id), referenceNo: null });
    for (const p of payments as any[]) sourceByJeId.set(Number(p.journalEntryId), { transactionType: 'Payment', transactionNo: `PAY-${p.id}`, referenceNo: p.invoiceId ? `Invoice#${p.invoiceId}` : null });
    for (const e of expenses as any[]) sourceByJeId.set(Number(e.journalEntryId), { transactionType: 'Expense', transactionNo: (e as any).expenseNumber ?? String((e as any).id), referenceNo: null });
    for (const b of purchaseBills as any[]) sourceByJeId.set(Number(b.journalEntryId), { transactionType: 'Purchase Bill', transactionNo: (b as any).billNumber ?? String((b as any).id), referenceNo: null });
    for (const v of vendorCredits as any[]) sourceByJeId.set(Number(v.journalEntryId), { transactionType: 'Vendor Credit', transactionNo: (v as any).creditNumber ?? String((v as any).id), referenceNo: null });
    for (const p of pbPayments as any[]) sourceByJeId.set(Number(p.journalEntryId), { transactionType: 'Bill Payment', transactionNo: `PB-PAY-${p.id}`, referenceNo: p.purchaseBillId ? `Bill#${p.purchaseBillId}` : null });
    for (const p of expPayments as any[]) sourceByJeId.set(Number(p.journalEntryId), { transactionType: 'Expense Payment', transactionNo: `EXP-PAY-${p.id}`, referenceNo: p.expenseId ? `Expense#${p.expenseId}` : null });

    // Build rows + running balance
    let running = openingNet.toDecimalPlaces(2);
    const rows = Array.from(byEntry.values())
      .sort((a, b) => new Date(a.entry.date).getTime() - new Date(b.entry.date).getTime() || Number(a.entry.id) - Number(b.entry.id))
      .map((g) => {
        const net = account.normalBalance === 'DEBIT' ? g.debit.sub(g.credit) : g.credit.sub(g.debit);
        running = running.add(net).toDecimalPlaces(2);
        const abs = net.abs().toDecimalPlaces(2);
        const side = net.greaterThanOrEqualTo(0) ? (account.normalBalance === 'DEBIT' ? 'Dr' : 'Cr') : (account.normalBalance === 'DEBIT' ? 'Cr' : 'Dr');
        const src = sourceByJeId.get(Number(g.entry.id)) ?? null;
        return {
          date: new Date(g.entry.date).toISOString().slice(0, 10),
          journalEntryId: g.entry.id,
          entryNumber: g.entry.entryNumber,
          description: g.entry.description,
          debit: g.debit.toString(),
          credit: g.credit.toString(),
          amount: abs.toString(),
          side,
          runningBalance: running.abs().toString(),
          runningSide: running.greaterThanOrEqualTo(0) ? (account.normalBalance === 'DEBIT' ? 'Dr' : 'Cr') : (account.normalBalance === 'DEBIT' ? 'Cr' : 'Dr'),
          transactionType: src?.transactionType ?? 'Journal Entry',
          transactionNo: src?.transactionNo ?? g.entry.entryNumber,
          referenceNo: src?.referenceNo ?? null,
        };
      });

    return {
      companyId,
      from: query.from,
      to: query.to,
      account: { id: account.id, code: account.code, name: account.name, type: account.type },
      openingBalance: { amount: openingAbs.toString(), side: openingSide },
      rows,
    };
  });

  // --- Cashflow Statement (Indirect Method) ---
  // GET /companies/:companyId/reports/cashflow?from=YYYY-MM-DD&to=YYYY-MM-DD
  fastify.get('/companies/:companyId/reports/cashflow', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const query = request.query as { from?: string; to?: string };

    if (!query.from || !query.to) {
      reply.status(400);
      return { error: 'from and to are required (YYYY-MM-DD)' };
    }

    const fromDate = normalizeToDay(new Date(query.from));
    const toDate = normalizeToDay(new Date(query.to));
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      reply.status(400);
      return { error: 'invalid from/to dates' };
    }
    if (fromDate.getTime() > toDate.getTime()) {
      reply.status(400);
      return { error: 'from must be <= to' };
    }

    const beginAsOf = new Date(fromDate);
    beginAsOf.setDate(beginAsOf.getDate() - 1);
    beginAsOf.setHours(0, 0, 0, 0);

    // 1) Net Profit for the period (from P&L)
    const pnlGrouped = await prisma.accountBalance.groupBy({
      by: ['accountId'],
      where: { companyId, date: { gte: fromDate, lte: toDate } },
      _sum: { debitTotal: true, creditTotal: true },
    });
    const pnlAccountIds = pnlGrouped.map((g) => g.accountId);
    const pnlAccounts = await prisma.account.findMany({
      where: { companyId, id: { in: pnlAccountIds }, type: { in: ['INCOME', 'EXPENSE'] } },
      select: { id: true, type: true },
    });
    const pnlById = new Map(pnlAccounts.map((a) => [a.id, a]));

    let totalIncome = new Prisma.Decimal(0);
    let totalExpense = new Prisma.Decimal(0);
    for (const g of pnlGrouped) {
      const acc = pnlById.get(g.accountId);
      if (!acc) continue;
      const debit = new Prisma.Decimal(g._sum.debitTotal ?? 0);
      const credit = new Prisma.Decimal(g._sum.creditTotal ?? 0);
      if (acc.type === 'INCOME') totalIncome = totalIncome.add(credit.sub(debit));
      if (acc.type === 'EXPENSE') totalExpense = totalExpense.add(debit.sub(credit));
    }
    totalIncome = totalIncome.toDecimalPlaces(2);
    totalExpense = totalExpense.toDecimalPlaces(2);
    const netProfit = totalIncome.sub(totalExpense).toDecimalPlaces(2);

    // 2) Balance sheet deltas (begin vs end) from AccountBalance cumulative sums
    const [endGrouped, beginGrouped] = await Promise.all([
      prisma.accountBalance.groupBy({
        by: ['accountId'],
        where: { companyId, date: { lte: toDate } },
        _sum: { debitTotal: true, creditTotal: true },
      }),
      prisma.accountBalance.groupBy({
        by: ['accountId'],
        where: { companyId, date: { lte: beginAsOf } },
        _sum: { debitTotal: true, creditTotal: true },
      }),
    ]);

    const allAccountIds = Array.from(
      new Set<number>([...endGrouped.map((g) => g.accountId), ...beginGrouped.map((g) => g.accountId)])
    );

    const bsAccounts = await prisma.account.findMany({
      where: {
        companyId,
        id: { in: allAccountIds },
        type: { in: ['ASSET', 'LIABILITY', 'EQUITY'] },
      },
      select: {
        id: true,
        code: true,
        name: true,
        type: true,
        normalBalance: true,
        reportGroup: true,
        cashflowActivity: true,
      },
    });
    const bsById = new Map(bsAccounts.map((a) => [a.id, a]));

    const endById = new Map(
      endGrouped.map((g) => [
        g.accountId,
        {
          debit: new Prisma.Decimal(g._sum.debitTotal ?? 0),
          credit: new Prisma.Decimal(g._sum.creditTotal ?? 0),
        },
      ])
    );
    const beginById = new Map(
      beginGrouped.map((g) => [
        g.accountId,
        {
          debit: new Prisma.Decimal(g._sum.debitTotal ?? 0),
          credit: new Prisma.Decimal(g._sum.creditTotal ?? 0),
        },
      ])
    );

    function balanceFrom(acc: any, debit: Prisma.Decimal, credit: Prisma.Decimal): Prisma.Decimal {
      // Use account.normalBalance to compute a signed balance.
      return acc.normalBalance === 'DEBIT' ? debit.sub(credit) : credit.sub(debit);
    }

    function cashEffectForDelta(accType: string, delta: Prisma.Decimal): Prisma.Decimal {
      // Indirect method sign conventions:
      // - Asset increase = use of cash (negative)
      // - Liability/Equity increase = source of cash (positive)
      if (accType === 'ASSET') return delta.mul(-1);
      return delta; // LIABILITY or EQUITY
    }

    function inferCashflowActivity(d: { type: string; reportGroup: string | null; cashflowActivity: string | null }): 'OPERATING' | 'INVESTING' | 'FINANCING' {
      if (d.cashflowActivity === 'OPERATING' || d.cashflowActivity === 'INVESTING' || d.cashflowActivity === 'FINANCING') {
        return d.cashflowActivity;
      }
      // Best-effort defaults to reduce manual setup:
      // - Fixed assets => Investing
      // - Long term liabilities + equity => Financing
      // - Other BS accounts => Operating
      if (d.reportGroup === 'FIXED_ASSET') return 'INVESTING';
      if (d.reportGroup === 'LONG_TERM_LIABILITY') return 'FINANCING';
      if (d.type === 'EQUITY') return 'FINANCING';
      return 'OPERATING';
    }

    const deltas: Array<{
      accountId: number;
      code: string;
      name: string;
      type: string;
      reportGroup: string | null;
      cashflowActivity: string | null;
      cashflowActivityEffective: 'OPERATING' | 'INVESTING' | 'FINANCING';
      beginBalance: Prisma.Decimal;
      endBalance: Prisma.Decimal;
      delta: Prisma.Decimal;
      cashEffect: Prisma.Decimal;
    }> = [];

    for (const id of allAccountIds) {
      const acc = bsById.get(id);
      if (!acc) continue;
      const end = endById.get(id) ?? { debit: new Prisma.Decimal(0), credit: new Prisma.Decimal(0) };
      const begin = beginById.get(id) ?? { debit: new Prisma.Decimal(0), credit: new Prisma.Decimal(0) };

      const endBal = balanceFrom(acc, end.debit, end.credit).toDecimalPlaces(2);
      const beginBal = balanceFrom(acc, begin.debit, begin.credit).toDecimalPlaces(2);
      const delta = endBal.sub(beginBal).toDecimalPlaces(2);
      const cashEffect = cashEffectForDelta(acc.type, delta).toDecimalPlaces(2);

      // Keep zero deltas out for cleaner statements.
      if (delta.equals(0)) continue;

      deltas.push({
        accountId: acc.id,
        code: acc.code,
        name: acc.name,
        type: acc.type,
        reportGroup: acc.reportGroup ?? null,
        cashflowActivity: acc.cashflowActivity ?? null,
        cashflowActivityEffective: inferCashflowActivity({
          type: acc.type,
          reportGroup: (acc.reportGroup ?? null) as any,
          cashflowActivity: (acc.cashflowActivity ?? null) as any,
        }),
        beginBalance: beginBal,
        endBalance: endBal,
        delta,
        cashEffect,
      });
    }

    const isCash = (d: any) => d.reportGroup === 'CASH_AND_CASH_EQUIVALENTS';

    // Compute cash begin/end from ALL cash accounts (not just those with non-zero delta),
    // otherwise reconciliation can be misleading for periods with no cash movement.
    const cashAccountIds = bsAccounts
      .filter((a: any) => a.reportGroup === 'CASH_AND_CASH_EQUIVALENTS')
      .map((a: any) => a.id);
    const cashBegin = cashAccountIds
      .reduce((sum: Prisma.Decimal, id: number) => {
        const acc = bsById.get(id);
        if (!acc) return sum;
        const begin = beginById.get(id) ?? { debit: new Prisma.Decimal(0), credit: new Prisma.Decimal(0) };
        return sum.add(balanceFrom(acc, begin.debit, begin.credit).toDecimalPlaces(2));
      }, new Prisma.Decimal(0))
      .toDecimalPlaces(2);
    const cashEnd = cashAccountIds
      .reduce((sum: Prisma.Decimal, id: number) => {
        const acc = bsById.get(id);
        if (!acc) return sum;
        const end = endById.get(id) ?? { debit: new Prisma.Decimal(0), credit: new Prisma.Decimal(0) };
        return sum.add(balanceFrom(acc, end.debit, end.credit).toDecimalPlaces(2));
      }, new Prisma.Decimal(0))
      .toDecimalPlaces(2);
    const netChangeInCash = cashEnd.sub(cashBegin).toDecimalPlaces(2);

    // Operating: net profit + working capital + other operating assets/liabilities (excluding cash)
    const wcGroups = new Set([
      'ACCOUNTS_RECEIVABLE',
      'INVENTORY',
      'OTHER_CURRENT_ASSET',
      'ACCOUNTS_PAYABLE',
      'OTHER_CURRENT_LIABILITY',
    ]);

    const operatingCandidates = deltas.filter(
      (d) =>
        !isCash(d) &&
        d.cashflowActivityEffective === 'OPERATING' &&
        (d.type === 'ASSET' || d.type === 'LIABILITY')
    );

    const wc = operatingCandidates.filter((d) => d.reportGroup && wcGroups.has(d.reportGroup));
    const otherOperating = operatingCandidates.filter((d) => !(d.reportGroup && wcGroups.has(d.reportGroup)));

    const wcByGroup = new Map<string, Prisma.Decimal>();
    for (const d of wc) {
      const key = d.reportGroup as string;
      const prev = wcByGroup.get(key) ?? new Prisma.Decimal(0);
      wcByGroup.set(key, prev.add(d.cashEffect));
    }

    const operatingLines: Array<{ label: string; amount: string }> = [];
    operatingLines.push({ label: 'Net Profit', amount: netProfit.toString() });

    for (const [group, amt] of Array.from(wcByGroup.entries())) {
      operatingLines.push({
        label: labelForWorkingCapitalGroup(group),
        amount: amt.toDecimalPlaces(2).toString(),
      });
    }

    // Show top other operating account changes (by absolute cash effect)
    const topOtherOperating = otherOperating
      .slice()
      .sort((a, b) => b.cashEffect.abs().comparedTo(a.cashEffect.abs()))
      .slice(0, 10);
    for (const d of topOtherOperating) {
      operatingLines.push({
        label: `${d.code} ${d.name} (Δ ${d.delta.toString()})`,
        amount: d.cashEffect.toString(),
      });
    }

    const operatingTotal = operatingLines
      .reduce((sum, l) => sum.add(new Prisma.Decimal(l.amount)), new Prisma.Decimal(0))
      .toDecimalPlaces(2);

    // Investing / Financing based on account.cashflowActivity (best-effort v1)
    const investingLines = deltas
      .filter((d) => !isCash(d) && d.cashflowActivityEffective === 'INVESTING')
      .sort((a, b) => b.cashEffect.abs().comparedTo(a.cashEffect.abs()))
      .map((d) => ({
        label: `${d.code} ${d.name} (Δ ${d.delta.toString()})`,
        amount: d.cashEffect.toString(),
      }));

    const financingLines = deltas
      .filter((d) => !isCash(d) && d.cashflowActivityEffective === 'FINANCING')
      .sort((a, b) => b.cashEffect.abs().comparedTo(a.cashEffect.abs()))
      .map((d) => ({
        label: `${d.code} ${d.name} (Δ ${d.delta.toString()})`,
        amount: d.cashEffect.toString(),
      }));

    const investingTotal = investingLines
      .reduce((sum, l) => sum.add(new Prisma.Decimal(l.amount)), new Prisma.Decimal(0))
      .toDecimalPlaces(2);
    const financingTotal = financingLines
      .reduce((sum, l) => sum.add(new Prisma.Decimal(l.amount)), new Prisma.Decimal(0))
      .toDecimalPlaces(2);

    const computedNetChange = operatingTotal.add(investingTotal).add(financingTotal).toDecimalPlaces(2);
    const autoClassifiedCount = deltas.filter((d) => !isCash(d) && !d.cashflowActivity).length;

    return {
      companyId,
      from: query.from,
      to: query.to,
      operating: {
        total: operatingTotal.toString(),
        lines: operatingLines,
      },
      investing: {
        total: investingTotal.toString(),
        lines: investingLines,
      },
      financing: {
        total: financingTotal.toString(),
        lines: financingLines,
      },
      reconciliation: {
        cashBegin: cashBegin.toString(),
        cashEnd: cashEnd.toString(),
        netChangeInCash: netChangeInCash.toString(),
        computedNetChangeInCash: computedNetChange.toString(),
        reconciled: netChangeInCash.equals(computedNetChange),
      },
      notes: [
        'Cashflow v1 uses the indirect method.',
        autoClassifiedCount > 0
          ? `Some accounts had no cashflowActivity; we auto-classified ${autoClassifiedCount} balance-sheet account(s) based on type/report group. Set cashflowActivity in Chart of Accounts to fine-tune.`
          : 'Investing/Financing sections are based on Account.cashflowActivity.',
      ],
    };

    function labelForWorkingCapitalGroup(group: string): string {
      switch (group) {
        case 'ACCOUNTS_RECEIVABLE':
          return 'Change in Accounts Receivable';
        case 'INVENTORY':
          return 'Change in Inventory';
        case 'OTHER_CURRENT_ASSET':
          return 'Change in Other Current Assets';
        case 'ACCOUNTS_PAYABLE':
          return 'Change in Accounts Payable';
        case 'OTHER_CURRENT_LIABILITY':
          return 'Change in Other Current Liabilities';
        default:
          return `Change in ${group}`;
      }
    }
  });

  // --- Diagnostics: why reports might be empty ---
  // GET /companies/:companyId/reports/diagnostics
  // This helps identify whether projections (AccountBalance/DailySummary) are missing vs. date-range/user issues.
  fastify.get('/companies/:companyId/reports/diagnostics', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');

    const [jeCount, jlCount, abCount, dsCount, peCount, outboxUnpub, outboxTotal] = await Promise.all([
      prisma.journalEntry.count({ where: { companyId } }),
      prisma.journalLine.count({ where: { companyId } }),
      prisma.accountBalance.count({ where: { companyId } }),
      prisma.dailySummary.count({ where: { companyId } }),
      prisma.processedEvent.count({ where: { companyId } }),
      prisma.event.count({ where: { companyId, publishedAt: null } }),
      prisma.event.count({ where: { companyId } }),
    ]);

    const lastJe = await prisma.journalEntry.findFirst({
      where: { companyId },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      select: { id: true, date: true, description: true, createdAt: true },
    });

    const lastOutbox = await prisma.event.findFirst({
      where: { companyId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { eventId: true, eventType: true, createdAt: true, publishedAt: true, lastPublishError: true },
    });

    const lastAb = await prisma.accountBalance.findFirst({
      where: { companyId },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      select: { date: true },
    });

    return {
      companyId,
      counts: {
        journalEntries: jeCount,
        journalLines: jlCount,
        accountBalanceRows: abCount,
        dailySummaryRows: dsCount,
        processedEvents: peCount,
        outboxTotal,
        outboxUnpublished: outboxUnpub,
      },
      latest: {
        journalEntry: lastJe
          ? {
              id: lastJe.id,
              date: lastJe.date,
              createdAt: lastJe.createdAt,
              description: lastJe.description,
            }
          : null,
        outboxEvent: lastOutbox
          ? {
              eventId: lastOutbox.eventId,
              eventType: lastOutbox.eventType,
              createdAt: lastOutbox.createdAt,
              publishedAt: lastOutbox.publishedAt,
              lastPublishError: lastOutbox.lastPublishError ?? null,
            }
          : null,
        accountBalanceDate: lastAb?.date ?? null,
      },
      hint:
        jeCount > 0 && abCount === 0
          ? 'Ledger has data but projections are empty. Ensure publisher+worker are deployed and processing events, or run the rebuild-projections admin endpoint.'
          : abCount > 0
            ? 'Projections exist. If UI shows empty, check report date ranges/timezone/companyId.'
            : 'No journal entries found for this company yet.',
    };
  });

  // --- Admin: rebuild projections from immutable ledger (backfill) ---
  // POST /companies/:companyId/admin/rebuild-projections?from=YYYY-MM-DD&to=YYYY-MM-DD
  // Recomputes AccountBalance and DailySummary for the date range from JournalEntry/JournalLine source of truth.
  // Also inserts ProcessedEvent rows for existing outbox journal.entry.created events in-range to prevent double counting
  // when the worker later processes those events.
  fastify.post('/companies/:companyId/admin/rebuild-projections', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const query = request.query as { from?: string; to?: string };
    if (!query.from || !query.to) {
      reply.status(400);
      return { error: 'from and to are required (YYYY-MM-DD)' };
    }

    const fromDate = normalizeToDay(new Date(query.from));
    const toDate = normalizeToDay(new Date(query.to));
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      reply.status(400);
      return { error: 'invalid from/to dates' };
    }
    if (fromDate.getTime() > toDate.getTime()) {
      reply.status(400);
      return { error: 'from must be <= to' };
    }

    const result = await prisma.$transaction(async (tx: any) => {
      // 1) Clear existing projections in range
      const deletedAb = await tx.accountBalance.deleteMany({
        where: { companyId, date: { gte: fromDate, lte: toDate } },
      });
      const deletedDs = await tx.dailySummary.deleteMany({
        where: { companyId, date: { gte: fromDate, lte: toDate } },
      });

      // 2) Rebuild AccountBalance (daily per-account debit/credit totals)
      const abRows = (await tx.$queryRaw`
        SELECT
          DATE(je.date) AS day,
          jl.accountId AS accountId,
          SUM(jl.debit) AS debitTotal,
          SUM(jl.credit) AS creditTotal
        FROM JournalLine jl
        JOIN JournalEntry je ON je.id = jl.journalEntryId
        WHERE jl.companyId = ${companyId}
          AND je.companyId = ${companyId}
          AND je.date >= ${fromDate}
          AND je.date <= ${toDate}
        GROUP BY day, jl.accountId
      `) as Array<{ day: Date; accountId: number; debitTotal: any; creditTotal: any }>;

      // Bulk insert in chunks (createMany)
      const abData = abRows.map((r) => ({
        companyId,
        accountId: Number(r.accountId),
        date: normalizeToDay(new Date(r.day)),
        debitTotal: new Prisma.Decimal(r.debitTotal ?? 0).toDecimalPlaces(2),
        creditTotal: new Prisma.Decimal(r.creditTotal ?? 0).toDecimalPlaces(2),
      }));

      let createdAb = 0;
      const chunkSize = 500;
      for (let i = 0; i < abData.length; i += chunkSize) {
        const chunk = abData.slice(i, i + chunkSize);
        const res = await tx.accountBalance.createMany({ data: chunk, skipDuplicates: true });
        createdAb += res.count ?? 0;
      }

      // 3) Rebuild DailySummary (income/expense only, per day)
      const dsRows = (await tx.$queryRaw`
        SELECT
          DATE(je.date) AS day,
          SUM(CASE WHEN a.type = 'INCOME' THEN (jl.credit - jl.debit) ELSE 0 END) AS totalIncome,
          SUM(CASE WHEN a.type = 'EXPENSE' THEN (jl.debit - jl.credit) ELSE 0 END) AS totalExpense
        FROM JournalLine jl
        JOIN JournalEntry je ON je.id = jl.journalEntryId
        JOIN Account a ON a.id = jl.accountId
        WHERE jl.companyId = ${companyId}
          AND je.companyId = ${companyId}
          AND a.companyId = ${companyId}
          AND je.date >= ${fromDate}
          AND je.date <= ${toDate}
        GROUP BY day
      `) as Array<{ day: Date; totalIncome: any; totalExpense: any }>;

      const dsData = dsRows
        .map((r) => ({
          companyId,
          date: normalizeToDay(new Date(r.day)),
          totalIncome: new Prisma.Decimal(r.totalIncome ?? 0).toDecimalPlaces(2),
          totalExpense: new Prisma.Decimal(r.totalExpense ?? 0).toDecimalPlaces(2),
        }))
        // Avoid creating rows with both 0 (keeps table smaller; worker behaves similarly)
        .filter((r) => !r.totalIncome.equals(0) || !r.totalExpense.equals(0));

      let createdDs = 0;
      for (let i = 0; i < dsData.length; i += chunkSize) {
        const chunk = dsData.slice(i, i + chunkSize);
        const res = await tx.dailySummary.createMany({ data: chunk, skipDuplicates: true });
        createdDs += res.count ?? 0;
      }

      // 4) Mark existing outbox journal.entry.created events as processed for this range to prevent double counting
      const eventIds = (await tx.$queryRaw`
        SELECT e.eventId AS eventId
        FROM Event e
        JOIN JournalEntry je
          ON CAST(JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.journalEntryId')) AS SIGNED) = je.id
        WHERE e.companyId = ${companyId}
          AND e.eventType = 'journal.entry.created'
          AND je.companyId = ${companyId}
          AND je.date >= ${fromDate}
          AND je.date <= ${toDate}
      `) as Array<{ eventId: string }>;

      let processedInserted = 0;
      if (eventIds.length > 0) {
        const peData = eventIds
          .map((r) => r.eventId)
          .filter((x) => typeof x === 'string' && x.length > 0)
          .map((eventId) => ({ eventId, companyId }));
        for (let i = 0; i < peData.length; i += 1000) {
          const chunk = peData.slice(i, i + 1000);
          const res = await tx.processedEvent.createMany({ data: chunk, skipDuplicates: true });
          processedInserted += res.count ?? 0;
        }
      }

      await writeAuditLog(tx as any, {
        companyId,
        userId: (request as any).user?.userId ?? null,
        action: 'projections.rebuild',
        entityType: 'Company',
        entityId: companyId,
        idempotencyKey: null,
        correlationId: null,
        metadata: {
          from: query.from,
          to: query.to,
          deleted: { accountBalance: deletedAb.count, dailySummary: deletedDs.count },
          created: { accountBalance: createdAb, dailySummary: createdDs, processedEvents: processedInserted },
        },
      });

      return {
        deleted: { accountBalance: deletedAb.count, dailySummary: deletedDs.count },
        created: { accountBalance: createdAb, dailySummary: createdDs, processedEvents: processedInserted },
      };
    });

    return { companyId, from: query.from, to: query.to, ...result };
  });

  // Legacy route kept for backward compatibility (deprecated).
  // GET /reports/pnl?companyId=...&from=...&to=...
  fastify.get('/reports/pnl', async (request, reply) => {
    const query = request.query as { companyId?: string; from?: string; to?: string };
    if (!query.companyId || !query.from || !query.to) {
      reply.status(400);
      return { error: 'companyId, from, to are required (YYYY-MM-DD)' };
    }

    const companyId = Number(query.companyId);
    if (Number.isNaN(companyId)) {
      reply.status(400);
      return { error: 'invalid companyId' };
    }
    enforceCompanyScope(request, reply, companyId);

    // Call the new logic by doing a small internal redirect style.
    const fromDate = normalizeToDay(new Date(query.from));
    const toDate = normalizeToDay(new Date(query.to));
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      reply.status(400);
      return { error: 'invalid from/to dates' };
    }

    const grouped = await prisma.accountBalance.groupBy({
      by: ['accountId'],
      where: { companyId, date: { gte: fromDate, lte: toDate } },
      _sum: { debitTotal: true, creditTotal: true },
    });

    const accountIds = grouped.map((g) => g.accountId);
    const accounts = await prisma.account.findMany({
      where: { companyId, id: { in: accountIds }, type: { in: ['INCOME', 'EXPENSE'] } },
      select: { id: true, code: true, name: true, type: true, reportGroup: true },
    });
    const accountById = new Map(accounts.map((a) => [a.id, a]));

    const incomeAccounts: Array<{ accountId: number; code: string; name: string; reportGroup: string | null; amount: string }> = [];
    const expenseAccounts: Array<{ accountId: number; code: string; name: string; reportGroup: string | null; amount: string }> = [];

    let totalIncome = new Prisma.Decimal(0);
    let totalExpense = new Prisma.Decimal(0);

    for (const g of grouped) {
      const acc = accountById.get(g.accountId);
      if (!acc) continue;
      const debit = new Prisma.Decimal(g._sum.debitTotal ?? 0).toDecimalPlaces(2);
      const credit = new Prisma.Decimal(g._sum.creditTotal ?? 0).toDecimalPlaces(2);

      if (acc.type === 'INCOME') {
        const amount = credit.sub(debit).toDecimalPlaces(2);
        totalIncome = totalIncome.add(amount);
        incomeAccounts.push({ accountId: acc.id, code: acc.code, name: acc.name, reportGroup: acc.reportGroup ?? null, amount: amount.toString() });
      } else if (acc.type === 'EXPENSE') {
        const amount = debit.sub(credit).toDecimalPlaces(2);
        totalExpense = totalExpense.add(amount);
        expenseAccounts.push({ accountId: acc.id, code: acc.code, name: acc.name, reportGroup: acc.reportGroup ?? null, amount: amount.toString() });
      }
    }

    incomeAccounts.sort((a, b) => a.code.localeCompare(b.code));
    expenseAccounts.sort((a, b) => a.code.localeCompare(b.code));
    totalIncome = totalIncome.toDecimalPlaces(2);
    totalExpense = totalExpense.toDecimalPlaces(2);
    const netProfit = totalIncome.sub(totalExpense).toDecimalPlaces(2);

    return {
      companyId,
      from: query.from,
      to: query.to,
      totalIncome: totalIncome.toString(),
      totalExpense: totalExpense.toString(),
      netProfit: netProfit.toString(),
      incomeAccounts,
      expenseAccounts,
    };
  });
}

