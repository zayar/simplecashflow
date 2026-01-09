import Fastify from 'fastify';
import { AccountType } from '@prisma/client';
import type { DomainEventEnvelopeV1 } from './events/domainEvent.js';
import { prisma } from './infrastructure/db.js';
import { runIdempotent } from './infrastructure/idempotency.js';
import { getRedis } from './infrastructure/redis.js';
import { runWithTenantAsync } from './infrastructure/tenantContext.js';
import { normalizeToDay } from './utils/date.js';
import { Prisma } from '@prisma/client';
import { rebuildProjectionsFromLedger, runInventoryRecalcForward } from './modules/inventory/recalc.service.js';
import { refreshCashflowSnapshotsForCompany } from './modules/cashflow/refresh.service.js';

const fastify = Fastify({ logger: true });
const redis = getRedis();

type DomainEventEnvelope = DomainEventEnvelopeV1<any>;

// --- Pub/Sub Push Auth (OIDC) ---
// Production-grade: require Pub/Sub push to include a Google-signed OIDC token and verify:
// - audience matches PUBSUB_PUSH_AUDIENCE
// - email matches PUBSUB_PUSH_SA_EMAIL (the service account configured on the subscription)
//
// Local dev: set DISABLE_PUBSUB_OIDC_AUTH=true to bypass.
async function verifyPubSubOidc(request: any, reply: any) {
  const isProd = (process.env.NODE_ENV ?? '').toLowerCase() === 'production';
  const disable = (process.env.DISABLE_PUBSUB_OIDC_AUTH ?? '').toLowerCase() === 'true';

  // Never allow bypass in production.
  if (disable) {
    if (isProd) {
      reply.status(500).send({ error: 'DISABLE_PUBSUB_OIDC_AUTH is not allowed in production' });
      return;
    }
    request.log.warn('Pub/Sub OIDC auth bypass enabled (dev only)');
    return;
  }

  const audience = process.env.PUBSUB_PUSH_AUDIENCE;
  const expectedEmail = process.env.PUBSUB_PUSH_SA_EMAIL;
  const enforce = isProd || (process.env.ENFORCE_PUBSUB_OIDC_AUTH ?? '').toLowerCase() === 'true';

  // If not configured, allow in dev but fail closed when ENFORCE is enabled.
  if (!audience || !expectedEmail) {
    if (enforce) {
      reply.status(500).send({ error: 'pubsub auth not configured (missing PUBSUB_PUSH_AUDIENCE/PUBSUB_PUSH_SA_EMAIL)' });
      return;
    }
    request.log.warn(
      { hasAudience: !!audience, hasExpectedEmail: !!expectedEmail },
      'Pub/Sub OIDC auth not configured; allowing request'
    );
    return;
  }

  const authHeader = request.headers?.authorization ?? request.headers?.Authorization;
  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    reply.status(401).send({ error: 'Missing Authorization Bearer token' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  try {
    const { OAuth2Client } = await import('google-auth-library');
    const client = new OAuth2Client();
    const ticket = await client.verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload();
    if (!payload) {
      reply.status(401).send({ error: 'Invalid OIDC token payload' });
      return;
    }

    const email = (payload as any).email as string | undefined;
    const emailVerified = (payload as any).email_verified as boolean | undefined;
    const iss = payload.iss;

    // Issuer sanity check (Google)
    if (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') {
      reply.status(401).send({ error: 'Invalid token issuer' });
      return;
    }

    if (!email || !emailVerified) {
      reply.status(401).send({ error: 'Token email not present or not verified' });
      return;
    }

    if (email !== expectedEmail) {
      reply.status(403).send({ error: 'Forbidden: service account mismatch' });
      return;
    }

    // Attach for logs/debug
    request.pubsubAuth = { email, aud: payload.aud, iss };
  } catch (err: any) {
    request.log.warn({ err }, 'Failed Pub/Sub OIDC verification');
    reply.status(401).send({ error: 'Invalid OIDC token' });
    return;
  }
}

// Pub/Sub push endpoint
fastify.post('/pubsub/push', { preHandler: verifyPubSubOidc }, async (request, reply) => {
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

    if (envelope.eventType === 'inventory.recalc.requested') {
      await handleInventoryRecalcRequested(envelope);
    }

    reply.status(204); // No Content
    return;
  } catch (err) {
    fastify.log.error({ err }, 'Failed to handle Pub/Sub message');
    reply.status(500);
    return { error: 'Internal error' };
  }
});

async function handleInventoryRecalcRequested(event: DomainEventEnvelope) {
  const { eventId, payload } = event;
  const companyIdRaw = (event as any)?.companyId ?? (payload as any)?.companyId;
  const companyId = Number(companyIdRaw);

  if (typeof eventId !== 'string' || !eventId || !Number.isInteger(companyId) || companyId <= 0) {
    fastify.log.error({ eventId, companyIdRaw }, 'Invalid inventory recalc event: missing/invalid eventId or companyId');
    return;
  }

  const fromDateStr = (payload as any)?.fromDate as string | undefined;
  const fromDate = fromDateStr ? normalizeToDay(new Date(`${fromDateStr}T00:00:00.000Z`)) : null;
  if (!fromDate || isNaN(fromDate.getTime())) {
    fastify.log.error({ eventId, fromDateStr }, 'Invalid inventory recalc payload: fromDate');
    return;
  }

  await runWithTenantAsync(companyId, async () => {
    await runIdempotent(
      prisma,
      companyId,
      eventId,
      async (tx: Prisma.TransactionClient) => {
        const outbox = await tx.event.findFirst({
          where: { eventId },
          select: { companyId: true, eventType: true },
        });
        if (!outbox) {
          fastify.log.error({ eventId }, 'Outbox event not found; refusing inventory recalc');
          return;
        }
        if (!outbox.companyId || outbox.companyId !== companyId) {
          fastify.log.error({ eventId, companyId, outboxCompanyId: outbox.companyId }, 'Tenant mismatch for inventory recalc');
          return;
        }
        if (outbox.eventType !== 'inventory.recalc.requested') {
          fastify.log.error({ eventId, outboxEventType: outbox.eventType }, 'Unexpected outbox eventType for inventory recalc');
          return;
        }

        // Coalesce requested range (min date).
        await (tx as any).$executeRaw`
          INSERT INTO InventoryRecalcState (companyId, requestedFromDate, requestedAt, updatedAt, createdAt, attempts)
          VALUES (${companyId}, ${fromDate}, NOW(), NOW(), NOW(), 0)
          ON DUPLICATE KEY UPDATE
            requestedFromDate = LEAST(COALESCE(requestedFromDate, ${fromDate}), ${fromDate}),
            requestedAt = NOW(),
            updatedAt = NOW()
        `;

        const rows = (await (tx as any).$queryRaw`
          SELECT requestedFromDate
          FROM InventoryRecalcState
          WHERE companyId = ${companyId}
          FOR UPDATE
        `) as Array<{ requestedFromDate: Date | null }>;
        const requestedFrom = rows?.[0]?.requestedFromDate ? normalizeToDay(new Date(rows[0].requestedFromDate)) : fromDate;

        await (tx as any).$executeRaw`
          UPDATE InventoryRecalcState
          SET runningAt = NOW(), lockedAt = NOW(), lockId = ${eventId}, attempts = attempts + 1, lastError = NULL, updatedAt = NOW()
          WHERE companyId = ${companyId}
        `;

        const recalc = await runInventoryRecalcForward(tx as any, { companyId, fromDate: requestedFrom });
        await rebuildProjectionsFromLedger(tx as any, {
          companyId,
          fromDate: new Date(recalc.effectiveStartDate),
          toDate: normalizeToDay(new Date()),
        });

        await (tx as any).$executeRaw`
          UPDATE InventoryRecalcState
          SET runningAt = NULL, lockedAt = NULL, lockId = NULL, updatedAt = NOW()
          WHERE companyId = ${companyId}
        `;

        fastify.log.info({ companyId, recalc }, 'Inventory recalc completed');
      },
      redis
    );
  });
}

async function handleJournalEntryCreated(event: DomainEventEnvelope) {
  const { eventId, payload } = event;

  // Backward compatibility / safety:
  // Some older messages may have companyId missing at the top-level.
  const companyIdRaw = (event as any)?.companyId ?? (payload as any)?.companyId;
  const journalEntryIdRaw = (payload as any)?.journalEntryId;

  const companyId = Number(companyIdRaw);
  const journalEntryId = Number(journalEntryIdRaw);

  // IMPORTANT: If message is malformed, do NOT throw.
  // Returning normally makes the handler reply 204 and Pub/Sub won't retry forever.
  if (
    typeof eventId !== 'string' ||
    !eventId ||
    !Number.isInteger(companyId) ||
    companyId <= 0 ||
    !Number.isInteger(journalEntryId) ||
    journalEntryId <= 0
  ) {
    fastify.log.error(
      { eventId, companyIdRaw, journalEntryIdRaw },
      'Invalid Pub/Sub event: missing/invalid eventId, companyId, or journalEntryId'
    );
    return;
  }

  // IMPORTANT: Worker code runs outside Fastify request hooks, so AsyncLocalStorage tenant context is NOT set.
  // We explicitly set it per message so Prisma's tenant isolation rails (auto-inject + fail-closed) apply here too.
  await runWithTenantAsync(companyId, async () => {
    await runIdempotent(
      prisma,
      companyId,
      eventId,
      async (tx: Prisma.TransactionClient) => {
        // 1) Strong authenticity guard: only process events that exist in our outbox table.
        // This prevents crafted Pub/Sub payloads from causing cross-tenant updates even if Pub/Sub
        // push auth is misconfigured.
        const outbox = await tx.event.findFirst({
          where: { eventId },
          select: { companyId: true, eventType: true, payload: true },
        });
        if (!outbox) {
          fastify.log.error({ eventId }, 'Outbox event not found; refusing to process Pub/Sub message');
          return;
        }
        if (!outbox.companyId || outbox.companyId !== companyId) {
          fastify.log.error(
            { eventId, eventCompanyId: companyId, outboxCompanyId: outbox.companyId },
            'Tenant mismatch: Pub/Sub companyId does not match outbox.companyId'
          );
          return;
        }
        if (outbox.eventType !== 'journal.entry.created') {
          fastify.log.error(
            { eventId, outboxEventType: outbox.eventType },
            'Unexpected outbox eventType for handler; refusing to process'
          );
          return;
        }
        const outboxJeId = Number((outbox.payload as any)?.journalEntryId);
        if (!Number.isInteger(outboxJeId) || outboxJeId !== journalEntryId) {
          fastify.log.error(
            { eventId, journalEntryId, outboxJeId },
            'Outbox payload mismatch; refusing to process'
          );
          return;
        }

        // 2) Load the journal entry with its lines and accounts, scoped to tenant
        const entry = await tx.journalEntry.findFirst({
          where: { id: journalEntryId, companyId },
          include: {
            lines: {
              include: {
                account: true,
              },
            },
          },
        });

        if (!entry) {
          fastify.log.error({ journalEntryId }, 'Journal entry not found');
          return;
        }
        if (entry.companyId !== companyId) {
          fastify.log.error(
            { eventCompanyId: companyId, entryCompanyId: entry.companyId, journalEntryId },
            'Tenant mismatch: event.companyId does not match JournalEntry.companyId'
          );
          return;
        }

        // 3) Compute how much income and expense this entry represents (Decimal-safe)
        let incomeDelta = new Prisma.Decimal(0);
        let expenseDelta = new Prisma.Decimal(0);

        for (const line of entry.lines) {
          const acc = line.account;
          const debit = new Prisma.Decimal(line.debit).toDecimalPlaces(2);
          const credit = new Prisma.Decimal(line.credit).toDecimalPlaces(2);

          if (acc.type === AccountType.INCOME) {
            // Income increases with credit
            incomeDelta = incomeDelta.add(credit.sub(debit));
          }

          if (acc.type === AccountType.EXPENSE) {
            // Expense increases with debit
            expenseDelta = expenseDelta.add(debit.sub(credit));
          }
        }

        incomeDelta = incomeDelta.toDecimalPlaces(2);
        expenseDelta = expenseDelta.toDecimalPlaces(2);

        if (incomeDelta.equals(0) && expenseDelta.equals(0)) {
          fastify.log.info(
            { journalEntryId, incomeDelta: incomeDelta.toString(), expenseDelta: expenseDelta.toString() },
            'No income/expense impact, skipping summary update'
          );
        }

        const day = normalizeToDay(entry.date);

        // 4) Upsert into DailySummary (income/expense only)
        if (!incomeDelta.equals(0) || !expenseDelta.equals(0)) {
          fastify.log.info(
            { companyId, day, incomeDelta: incomeDelta.toString(), expenseDelta: expenseDelta.toString() },
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
        }

        // 5) Upsert AccountBalance per account (daily increments)
        const byAccount = new Map<number, { debit: Prisma.Decimal; credit: Prisma.Decimal }>();
        for (const line of entry.lines) {
          const accountId = line.accountId;
          const debit = new Prisma.Decimal(line.debit);
          const credit = new Prisma.Decimal(line.credit);

          const prev = byAccount.get(accountId) ?? {
            debit: new Prisma.Decimal(0),
            credit: new Prisma.Decimal(0),
          };
          byAccount.set(accountId, {
            debit: prev.debit.add(debit),
            credit: prev.credit.add(credit),
          });
        }

        for (const [accountId, totals] of byAccount.entries()) {
          await (tx as any).accountBalance.upsert({
            where: {
              companyId_accountId_date: {
                companyId,
                accountId,
                date: day,
              },
            },
            update: {
              debitTotal: { increment: totals.debit.toDecimalPlaces(2) },
              creditTotal: { increment: totals.credit.toDecimalPlaces(2) },
            },
            create: {
              companyId,
              accountId,
              date: day,
              debitTotal: totals.debit.toDecimalPlaces(2),
              creditTotal: totals.credit.toDecimalPlaces(2),
            },
          });
        }

        // 6) Background refresh Cashflow Copilot cached forecast (13-week, all scenarios).
        // This makes the dashboard fast and keeps forecasts up-to-date after posting transactions.
        await refreshCashflowSnapshotsForCompany(tx as any, { companyId });
      },
      redis
    );
  });
}

// ---------------------------------------------------------------------------
// Nightly job: refresh cached cashflow forecasts for all companies.
// Trigger this via Cloud Scheduler hitting GET /jobs/cashflow/nightly with OIDC or token.
// ---------------------------------------------------------------------------
function requireJobToken(request: any, reply: any): boolean {
  const token = (process.env.CASHFLOW_JOB_TOKEN ?? '').trim();
  if (!token) {
    reply.status(500).send({ error: 'CASHFLOW_JOB_TOKEN is not configured' });
    return false;
  }
  const provided = String(request.headers['x-job-token'] ?? '').trim();
  if (!provided || provided !== token) {
    reply.status(401).send({ error: 'unauthorized' });
    return false;
  }
  return true;
}

fastify.get('/jobs/cashflow/nightly', async (request, reply) => {
  if (!requireJobToken(request, reply)) return;

  // Refresh in batches to avoid long locks.
  const companies = await prisma.company.findMany({ select: { id: true }, orderBy: { id: 'asc' } });

  let ok = 0;
  let fail = 0;
  for (const c of companies) {
    const companyId = Number(c.id);
    if (!Number.isFinite(companyId) || companyId <= 0) continue;
    try {
      await runWithTenantAsync(companyId, async () => {
        await prisma.$transaction(async (tx) => {
          await refreshCashflowSnapshotsForCompany(tx as any, { companyId });
        });
      });
      ok += 1;
    } catch (e: any) {
      fail += 1;
      fastify.log.error({ companyId, err: e?.message ?? String(e) }, 'Cashflow nightly refresh failed');
    }
  }

  return { status: 'ok', companies: companies.length, refreshed: ok, failed: fail };
});

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
