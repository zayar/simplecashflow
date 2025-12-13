export type DomainEventEnvelopeV1<TPayload = unknown> = {
  /**
   * Unique id for this event occurrence (idempotency key).
   * Must be globally unique.
   */
  eventId: string;

  /**
   * Stable, dot-delimited event name, e.g. "journal.entry.created".
   */
  eventType: string;

  /**
   * Contract version for payload interpretation, e.g. "v1".
   * Bump only when making breaking changes to payload shape/meaning.
   */
  schemaVersion: 'v1' | (string & {});

  /**
   * Business time: when the thing happened in the domain.
   */
  occurredAt: string; // ISO timestamp

  /**
   * Tenant identifier (your multi-merchant boundary).
   */
  companyId: number;

  /**
   * Partition key used for ordered processing (recommend: companyId as string).
   */
  partitionKey: string;

  /**
   * Traceability: tie multiple events to the same workflow/request.
   */
  correlationId: string;

  /**
   * Traceability: the eventId that caused this event (if any).
   */
  causationId?: string;

  /**
   * What entity "owns" this event (helps debugging + downstream models).
   */
  aggregateType: string; // e.g. "JournalEntry"
  aggregateId: string; // e.g. "123"

  /**
   * Producer identifier, e.g. "cashflow-api" or "integration:piti".
   */
  source: string;

  /**
   * Event payload (keep small; prefer IDs + essential facts).
   */
  payload: TPayload;
};

