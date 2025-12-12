import Fastify from 'fastify';
import { PrismaClient, AccountType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PubSub } from '@google-cloud/pubsub';

const pubsub = new PubSub();
const PUBSUB_TOPIC = process.env.PUBSUB_TOPIC || 'cashflow-events';

const fastify = Fastify({ logger: true });
const prisma = new PrismaClient();

type DomainEventEnvelope = {
  eventId: string;
  eventType: string;
  schemaVersion: string;
  occurredAt: string;
  companyId: number;
  source: string;
  payload: any;
};

async function publishDomainEvent(event: DomainEventEnvelope) {
  try {
    const dataBuffer = Buffer.from(JSON.stringify(event));

    const attributes = {
      eventId: event.eventId,
      eventType: event.eventType,
      companyId: event.companyId.toString(),
      schemaVersion: event.schemaVersion,
    };

    await pubsub.topic(PUBSUB_TOPIC).publishMessage({
      data: dataBuffer,
      attributes,
    });
  } catch (err) {
    console.error('Failed to publish Pub/Sub event', err);
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

// Create company
fastify.post('/companies', async (request, reply) => {
  const body = request.body as { name?: string };

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
  const { companyId } = request.params as { companyId: string };

  const accounts = await prisma.account.findMany({
    where: { companyId: Number(companyId) },
    orderBy: { code: 'asc' },
  });

  return accounts;
});

// Create an account
fastify.post('/accounts', async (request, reply) => {
  const body = request.body as {
    companyId?: number;
    code?: string;
    name?: string;
    type?: AccountType;
  };

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
  const occurredAt = new Date().toISOString();
  const eventType = 'journal.entry.created';
  const schemaVersion = 'v1';
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

  const envelope: DomainEventEnvelope = {
    eventId,
    eventType,
    schemaVersion,
    occurredAt,
    companyId: body.companyId!,
    source,
    payload: {
      journalEntryId: result.id,
      companyId: body.companyId!,
      totalDebit,
      totalCredit,
    },
  };

  await publishDomainEvent(envelope);

  return result;
});

// --- Piti integration: simple cash sale ---
// This simulates Piti sending a sale event to the ledger.
fastify.post('/integrations/piti/sale', async (request, reply) => {
  const body = request.body as {
    companyId?: number;
    amount?: number;
    description?: string;
  };

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
  const occurredAt = new Date().toISOString();
  const eventType = 'piti.sale.imported'; // Differentiated event type
  const schemaVersion = 'v1';
  const source = 'integration:piti';

  const entry = await prisma.$transaction(async (tx: any) => {
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
        type: 'PitiSaleImported', // Legacy field
        payload: {
          journalEntryId: journalEntry.id,
          amount,
        },
      },
    });

    return journalEntry;
  });

  const envelope: DomainEventEnvelope = {
    eventId,
    eventType,
    schemaVersion,
    occurredAt,
    companyId,
    source,
    payload: {
      journalEntryId: entry.id,
      amount,
    },
  };

  await publishDomainEvent(envelope);

  return entry;
});

// --- Simple Profit & Loss report ---
// Example: GET /reports/pnl?companyId=2&from=2025-12-01&to=2025-12-31
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

const start = async () => {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`Server running on http://localhost:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

const DEFAULT_ACCOUNTS = [
  { code: "1000", name: "Cash", type: "ASSET" as const },
  { code: "1010", name: "Bank", type: "ASSET" as const },
  { code: "2000", name: "Accounts Payable", type: "LIABILITY" as const },
  { code: "3000", name: "Owner Equity", type: "EQUITY" as const },
  { code: "4000", name: "Sales Income", type: "INCOME" as const },
  { code: "5000", name: "General Expense", type: "EXPENSE" as const },
  ];

start();
