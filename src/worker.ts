import Fastify from 'fastify';
import { PrismaClient, AccountType } from '@prisma/client';

const fastify = Fastify({ logger: true });
const prisma = new PrismaClient();

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
    const payload = JSON.parse(decoded) as {
      event?: string;
      data?: any;
    };

    fastify.log.info({ payload }, 'Received Pub/Sub event');

    if (payload.event === 'journal.entry.created') {
      await handleJournalEntryCreated(payload.data);
    }

    reply.status(204); // No Content
    return;
  } catch (err) {
    fastify.log.error({ err }, 'Failed to handle Pub/Sub message');
    reply.status(500);
    return { error: 'Internal error' };
  }
});

async function handleJournalEntryCreated(data: any) {
  const { companyId, journalEntryId } = data || {};
  if (!companyId || !journalEntryId) {
    fastify.log.error('Missing companyId or journalEntryId in event data', data);
    return;
  }

  // 1. Load the journal entry with its lines and accounts
  const entry = await prisma.journalEntry.findUnique({
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

  // 2. Compute how much income and expense this entry represents
  let incomeDelta = 0;
  let expenseDelta = 0;

  for (const line of entry.lines) {
    const acc = line.account;

    // Prisma Decimal -> JS number
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

  // 3. Upsert into DailySummary for that company + date
  fastify.log.info(
    { companyId, day, incomeDelta, expenseDelta },
    'Updating DailySummary'
  );

  await prisma.dailySummary.upsert({
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