import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import type { DomainEventEnvelopeV1 } from './events/domainEvent.js';
import { prisma } from './infrastructure/db.js';
import { publishDomainEvent } from './infrastructure/pubsub.js';

const fastify = Fastify({ logger: true });

const PUBLISH_BATCH_SIZE = Number(process.env.PUBLISH_BATCH_SIZE) || 50;
const PUBLISH_INTERVAL_MS = Number(process.env.PUBLISH_INTERVAL_MS) || 1000;
const LOCK_TIMEOUT_MS = Number(process.env.LOCK_TIMEOUT_MS) || 60_000;

function backoffMs(attempt: number): number {
  // Simple exponential backoff with cap (1s, 2s, 4s, ... up to 60s)
  const ms = 1000 * Math.pow(2, Math.max(0, attempt));
  return Math.min(ms, 60_000);
}

function buildEnvelopeFromEventRow(e: any): DomainEventEnvelopeV1 {
  const companyId = Number(e.companyId);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw Object.assign(new Error('outbox event is missing a valid companyId (tenant)'), {
      code: 'OUTBOX_TENANT_MISSING',
    });
  }
  const payload = e.payload ?? {};

  const aggregateId =
    e.aggregateId ??
    (typeof payload?.journalEntryId === 'number'
      ? String(payload.journalEntryId)
      : typeof payload?.journalEntryId === 'string'
        ? payload.journalEntryId
        : e.eventId);

  return {
    eventId: e.eventId,
    eventType: e.eventType,
    schemaVersion: (e.schemaVersion ?? 'v1') as any,
    occurredAt: new Date(e.occurredAt).toISOString(),
    companyId,
    partitionKey: e.partitionKey ?? String(companyId),
    correlationId: e.correlationId ?? e.eventId,
    causationId: e.causationId ?? undefined,
    aggregateType: e.aggregateType ?? 'Unknown',
    aggregateId,
    source: e.source ?? 'cashflow-api',
    payload,
  };
}

async function deadLetterAndUnlock(eventId: string, reason: string) {
  await prisma.event.update({
    where: { eventId },
    data: {
      // Mark as "done" so it won't be retried forever. We keep the row for audit.
      publishedAt: new Date(),
      nextPublishAttemptAt: null,
      lastPublishError: `dead-letter: ${reason}`,
      lockId: null,
      lockedAt: null,
    },
  });
}

async function claimBatch(lockId: string, now: Date) {
  const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);

  return prisma.$transaction(async (tx) => {
    // MySQL 8 supports SKIP LOCKED. This prevents multiple publisher instances
    // from claiming the same rows.
    const rows = (await tx.$queryRaw<
      Array<{ id: number }>
    >`
      SELECT id
      FROM Event
      WHERE publishedAt IS NULL
        AND (nextPublishAttemptAt IS NULL OR nextPublishAttemptAt <= ${now})
        AND (lockedAt IS NULL OR lockedAt < ${staleBefore})
      ORDER BY occurredAt ASC
      LIMIT ${PUBLISH_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    `) as Array<{ id: number }>;

    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return [];

    // Mark claimed
    await tx.event.updateMany({
      where: { id: { in: ids } },
      data: { lockId, lockedAt: now },
    });

    // Load claimed events (include needed columns)
    const events = await tx.event.findMany({
      where: { id: { in: ids } },
      orderBy: { occurredAt: 'asc' },
    });

    return events;
  });
}

async function releaseLockAndScheduleRetry(eventId: string, error: unknown) {
  const msg =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  // Increment attempts and schedule next attempt
  const current = await prisma.event.findUnique({
    where: { eventId },
    select: { publishAttempts: true },
  });

  const attempts = (current?.publishAttempts ?? 0) + 1;
  const next = new Date(Date.now() + backoffMs(attempts));

  await prisma.event.update({
    where: { eventId },
    data: {
      publishAttempts: attempts,
      lastPublishError: msg,
      nextPublishAttemptAt: next,
      lockId: null,
      lockedAt: null,
    },
  });
}

async function markPublishedAndUnlock(eventId: string) {
  await prisma.event.update({
    where: { eventId },
    data: {
      publishedAt: new Date(),
      nextPublishAttemptAt: null,
      lastPublishError: null,
      lockId: null,
      lockedAt: null,
    },
  });
}

let running = false;
async function tick() {
  if (running) return;
  running = true;

  const lockId = randomUUID();
  const now = new Date();

  try {
    const batch = await claimBatch(lockId, now);
    if (batch.length === 0) return;

    fastify.log.info(
      { count: batch.length, lockId },
      'Claimed outbox events'
    );

    for (const e of batch) {
      try {
        const envelope = buildEnvelopeFromEventRow(e);
        // Use the shared publishDomainEvent which wraps the PubSub logic
        const ok = await publishDomainEvent(envelope);
        if (!ok) {
          throw new Error('Pub/Sub publish failed (publishDomainEvent returned false)');
        }
        await markPublishedAndUnlock(e.eventId);
      } catch (err) {
        if ((err as any)?.code === 'OUTBOX_TENANT_MISSING') {
          fastify.log.error(
            { err, eventId: e.eventId, eventType: e.eventType },
            'Dead-lettering outbox event due to missing tenant'
          );
          try {
            await deadLetterAndUnlock(e.eventId, (err as Error).message);
          } catch (e2) {
            // If we can't dead-letter, fall back to retry scheduling.
            await releaseLockAndScheduleRetry(e.eventId, e2);
          }
          continue;
        }
        fastify.log.error(
          { err, eventId: e.eventId, eventType: e.eventType },
          'Failed to publish outbox event'
        );
        await releaseLockAndScheduleRetry(e.eventId, err);
      }
    }
  } finally {
    running = false;
  }
}

// Health check. Also triggers a best-effort tick so a scheduler ping can drive publishing
// even if Cloud Run CPU is throttled while idle.
fastify.get('/health', async () => {
  try {
    void tick();
  } catch {
    // best-effort
  }
  return { status: 'ok' };
});

const start = async () => {
  const port = Number(process.env.PORT) || 8080;
  await fastify.listen({ port, host: '0.0.0.0' });
  fastify.log.info({ port }, 'Publisher running');

  // Start publish loop
  setInterval(() => {
    void tick();
  }, PUBLISH_INTERVAL_MS);

  // Run immediately on startup as well
  void tick();
};

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
