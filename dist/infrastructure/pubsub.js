import { PubSub } from '@google-cloud/pubsub';
import { prisma } from './db.js';
import { runWithoutPerf } from './perf.js';
const pubsub = new PubSub();
const PUBSUB_TOPIC = process.env.PUBSUB_TOPIC || 'cashflow-events';
export async function publishDomainEvent(event) {
    try {
        const dataBuffer = Buffer.from(JSON.stringify(event));
        const attributes = {
            eventId: event.eventId,
            eventType: event.eventType,
            companyId: event.companyId.toString(),
            schemaVersion: event.schemaVersion,
            correlationId: event.correlationId,
            aggregateType: event.aggregateType,
            aggregateId: event.aggregateId,
        };
        await pubsub.topic(PUBSUB_TOPIC).publishMessage({
            data: dataBuffer,
            attributes,
            orderingKey: event.partitionKey,
        });
        return true;
    }
    catch (err) {
        console.error('Failed to publish Pub/Sub event', err);
        return false;
    }
}
// ============================================================================
// Fast-Path Publishing (Fire-and-Forget)
// ============================================================================
//
// This is called AFTER a DB transaction commits to optimistically publish
// events immediately. If it fails, the outbox publisher will pick them up.
//
// Key properties:
// - Non-blocking: Does not delay API response
// - Best-effort: Failures are logged but don't affect the caller
// - Safe: Outbox pattern is the reliable fallback
// ============================================================================
/**
 * Build a domain event envelope from an outbox Event row.
 * Reusable by both publisher and fast-path.
 */
export function buildEventEnvelope(eventRow) {
    const companyId = Number(eventRow.companyId);
    if (!Number.isInteger(companyId) || companyId <= 0) {
        throw new Error('Event is missing a valid companyId');
    }
    const payload = (eventRow.payload ?? {});
    // Fallback aggregateId to journalEntryId in payload if not set
    const aggregateId = eventRow.aggregateId ??
        (typeof payload?.journalEntryId === 'number'
            ? String(payload.journalEntryId)
            : typeof payload?.journalEntryId === 'string'
                ? payload.journalEntryId
                : eventRow.eventId);
    const envelope = {
        eventId: eventRow.eventId,
        eventType: eventRow.eventType,
        schemaVersion: (eventRow.schemaVersion ?? 'v1'),
        occurredAt: eventRow.occurredAt.toISOString(),
        companyId,
        partitionKey: eventRow.partitionKey ?? String(companyId),
        correlationId: eventRow.correlationId ?? eventRow.eventId,
        aggregateType: eventRow.aggregateType ?? 'Unknown',
        aggregateId,
        source: eventRow.source ?? 'cashflow-api',
        payload,
    };
    // Only include causationId if it's defined (avoid undefined in the envelope)
    if (eventRow.causationId) {
        envelope.causationId = eventRow.causationId;
    }
    return envelope;
}
/**
 * Fire-and-forget: Publish an event to Pub/Sub and mark it as published.
 *
 * Call this AFTER your DB transaction commits. It runs in the background
 * and does not block the caller. If it fails, the outbox publisher will retry.
 *
 * @param eventId - The eventId to publish (must exist in the Event table)
 */
export function publishEventFastPath(eventId) {
    // Fire and forget - don't await.
    // Detach perf context so request timings measure only synchronous work.
    runWithoutPerf(() => {
        void publishEventFastPathAsync(eventId);
    });
}
/**
 * Fire-and-forget: Publish multiple events to Pub/Sub.
 *
 * @param eventIds - Array of eventIds to publish
 */
export function publishEventsFastPath(eventIds) {
    runWithoutPerf(() => {
        for (const eventId of eventIds) {
            void publishEventFastPathAsync(eventId);
        }
    });
}
/**
 * Internal async implementation of fast-path publish.
 * Loads event from DB, publishes to Pub/Sub, marks as published.
 */
async function publishEventFastPathAsync(eventId) {
    try {
        // Load the event from the outbox
        const event = await prisma.event.findUnique({
            where: { eventId },
        });
        if (!event) {
            console.warn('[FastPath] Event not found, skipping', { eventId });
            return;
        }
        // Already published (race with publisher or duplicate call)
        if (event.publishedAt) {
            return;
        }
        // Build envelope
        const envelope = buildEventEnvelope({
            eventId: event.eventId,
            eventType: event.eventType,
            schemaVersion: event.schemaVersion,
            occurredAt: event.occurredAt,
            companyId: event.companyId,
            partitionKey: event.partitionKey,
            correlationId: event.correlationId,
            causationId: event.causationId,
            aggregateType: event.aggregateType,
            aggregateId: event.aggregateId,
            source: event.source,
            payload: event.payload,
        });
        // Publish to Pub/Sub
        const ok = await publishDomainEvent(envelope);
        if (!ok) {
            console.warn('[FastPath] Pub/Sub publish returned false, outbox will retry', { eventId });
            return;
        }
        // Mark as published (best-effort - if this fails, publisher will re-send and worker is idempotent)
        await prisma.event.update({
            where: { eventId },
            data: {
                publishedAt: new Date(),
                nextPublishAttemptAt: null,
                lastPublishError: null,
            },
        });
        console.log('[FastPath] Event published successfully', { eventId, eventType: event.eventType });
    }
    catch (err) {
        // Log but don't throw - outbox publisher will handle it
        console.warn('[FastPath] Failed to publish event, outbox will retry', { eventId, err });
    }
}
//# sourceMappingURL=pubsub.js.map