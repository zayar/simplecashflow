import { PubSub } from '@google-cloud/pubsub';
import type { DomainEventEnvelopeV1 } from '../events/domainEvent.js';

const pubsub = new PubSub();
const PUBSUB_TOPIC = process.env.PUBSUB_TOPIC || 'cashflow-events';

export async function publishDomainEvent(event: DomainEventEnvelopeV1): Promise<boolean> {
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
  } catch (err) {
    console.error('Failed to publish Pub/Sub event', err);
    return false;
  }
}

