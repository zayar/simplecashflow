import Fastify from 'fastify';
import { PrismaClient, AccountType } from '@prisma/client';
import type { DomainEventEnvelopeV1 } from './events/domainEvent.js';

const fastify = Fastify({ logger: true });
const prisma = new PrismaClient();

type DomainEventEnvelope = DomainEventEnvelopeV1<any>;

// helper: get "day" (00:00) from a Date
function normalizeToDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Pub/Sub push endpoint
fastify.post('/pubsub/push', async (request, reply) => {
  const body = request.body as any;

  if (!body || !body.message || !body.message.data) {
    fastify.log.error('Invalid Pub/Sub message format', body);
    reply.status(400);
    return { error: 'Bad request' };
  }

  try {
    const dataBuffer = Buffer.from(body.message.data, 'base64');
    const decoded = dataBuffer.toString('utf8');
    const envelope = JSON.parse(decoded) as DomainEventEnvelope;

    fastify.log.info({ envelope }, 'Received Pub/Sub event');

    // Handle both regular journal entries and Piti sales (which also create journal entries)
    // Keep backward compatibility for older eventType values.
    if (
      envelope.eventType === 'journal.entry.created' ||
      envelope.eventType === 'integration.piti.sale.imported' ||
      envelope.eventType === 'piti.sale.imported'
    ) {
      await handleJournalEntryCreated(envelope);
    }

    reply.status(204); // No Content
    return;
  } catch (err) {
    fastify.log.error({ err }, 'Failed to handle Pub/Sub message');
    reply.status(500);
    return { error: 'Internal error' };
  }
});

async function handleJournalEntryCreated(event: DomainEventEnvelope) {
  const { eventId, companyId, payload } = event;
  const { journalEntryId } = payload || {};

  if (!eventId || !companyId || !journalEntryId) {
    fastify.log.error(
      { event },
      'Missing eventId, companyId, or journalEntryId in event payload'
    );
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      // 1) Idempotency check: insert ProcessedEvent
      // If eventId exists, this throws P2002
      await tx.processedEvent.create({
        data: { eventId },
      });

      // 2) Load the journal entry with its lines and accounts
      const entry = await tx.journalEntry.findUnique({
        where: { id: journalEntryId },
        include: {
          lines: {
            include: {
              account: true,
            },
          },
        },
      });

      if (!entry) {
        fastify.log.error('Journal entry not found for id', journalEntryId);
        return;
      }

      // 3) Compute how much income and expense this entry represents
      let incomeDelta = 0;
      let expenseDelta = 0;

      for (const line of entry.lines) {
        const acc = line.account;
        const debit = Number(line.debit);
        const credit = Number(line.credit);

        if (acc.type === AccountType.INCOME) {
          // Income increases with credit
          incomeDelta += credit - debit;
        }

        if (acc.type === AccountType.EXPENSE) {
          // Expense increases with debit
          expenseDelta += debit - credit;
        }
      }

      if (incomeDelta === 0 && expenseDelta === 0) {
        fastify.log.info(
          { journalEntryId, incomeDelta, expenseDelta },
          'No income/expense impact, skipping summary update'
        );
        return;
      }

      const day = normalizeToDay(entry.date);

      // 4) Upsert into DailySummary for that company + date
      fastify.log.info(
        { companyId, day, incomeDelta, expenseDelta },
        'Updating DailySummary'
      );

      await tx.dailySummary.upsert({
        where: {
          companyId_date: {
            companyId,
            date: day,
          },
        },
        update: {
          totalIncome: {
            increment: incomeDelta,
          },
          totalExpense: {
            increment: expenseDelta,
          },
        },
        create: {
          companyId,
          date: day,
          totalIncome: incomeDelta,
          totalExpense: expenseDelta,
        },
      });
    });
  } catch (err: any) {
    // If ProcessedEvent unique constraint fails, it means we already processed this eventId
    if (err.code === 'P2002') {
      fastify.log.warn(
        { eventId },
        'Duplicate event detected, skipping (idempotent)'
      );
      return;
    }

    fastify.log.error({ err, eventId }, 'Error handling journal entry event');
    throw err;
  }
}

const start = async () => {
  try {
    const port = Number(process.env.PORT) || 8080;
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`Worker listening on port ${port} /pubsub/push`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
