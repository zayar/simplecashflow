import type { DomainEventEnvelopeV1 } from '../events/domainEvent.js';
export declare function publishDomainEvent(event: DomainEventEnvelopeV1): Promise<boolean>;
/**
 * Build a domain event envelope from an outbox Event row.
 * Reusable by both publisher and fast-path.
 */
export declare function buildEventEnvelope(eventRow: {
    eventId: string;
    eventType: string;
    schemaVersion?: string | null;
    occurredAt: Date;
    companyId: number | null;
    partitionKey?: string | null;
    correlationId?: string | null;
    causationId?: string | null;
    aggregateType?: string | null;
    aggregateId?: string | null;
    source?: string | null;
    payload: unknown;
}): DomainEventEnvelopeV1;
/**
 * Fire-and-forget: Publish an event to Pub/Sub and mark it as published.
 *
 * Call this AFTER your DB transaction commits. It runs in the background
 * and does not block the caller. If it fails, the outbox publisher will retry.
 *
 * @param eventId - The eventId to publish (must exist in the Event table)
 */
export declare function publishEventFastPath(eventId: string): void;
/**
 * Fire-and-forget: Publish multiple events to Pub/Sub.
 *
 * @param eventIds - Array of eventIds to publish
 */
export declare function publishEventsFastPath(eventIds: string[]): void;
//# sourceMappingURL=pubsub.d.ts.map