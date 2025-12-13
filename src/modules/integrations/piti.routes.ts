import type { FastifyInstance } from 'fastify';
import { prisma } from '../../infrastructure/db.js';
import { publishDomainEvent } from '../../infrastructure/pubsub.js';
import { markEventPublished } from '../../infrastructure/events.js';
import { randomUUID } from 'node:crypto';
import type { DomainEventEnvelopeV1 } from '../../events/domainEvent.js';
import { Prisma } from '@prisma/client';
import { postJournalEntry } from '../ledger/posting.service.js';
import { forbidClientProvidedCompanyId } from '../../utils/tenant.js';

export async function pitiRoutes(fastify: FastifyInstance) {
  // Integration endpoints should be protected (JWT for now).
  // Later: switch to signed webhooks / service-to-service auth.
  fastify.addHook('preHandler', fastify.authenticate);

  // --- Piti integration: simple cash sale ---
  // This simulates Piti sending a sale event to the ledger.
  fastify.post('/integrations/piti/sale', async (request, reply) => {
    const body = request.body as {
      companyId?: number;
      amount?: number;
      description?: string;
    };

    if (!body.amount || body.amount <= 0) {
      reply.status(400);
      return { error: 'positive amount is required' };
    }

    const companyId = forbidClientProvidedCompanyId(request, reply, body.companyId);
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
    const correlationId = eventId;
    const occurredAt = new Date().toISOString();
    const eventType = 'integration.piti.sale.imported'; // Canonical dot-delimited name
    const schemaVersion = 'v1' as const;
    const source = 'integration:piti';

    const entry = await prisma.$transaction(async (tx: any) => {
      const journalEntry = await postJournalEntry(tx, {
        companyId,
        date,
        description: body.description ?? 'Piti sale',
        createdByUserId: (request as any).user?.userId ?? null,
        lines: [
          { accountId: cashAccount.id, debit: new Prisma.Decimal(amount.toFixed(2)), credit: new Prisma.Decimal(0) },
          { accountId: salesAccount.id, debit: new Prisma.Decimal(0), credit: new Prisma.Decimal(amount.toFixed(2)) },
        ],
      });

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
          aggregateId: String(journalEntry.id),
          type: 'PitiSaleImported', // Legacy field
          payload: {
            journalEntryId: journalEntry.id,
            amount,
          },
        },
      });

      return journalEntry;
    });

    const envelope: DomainEventEnvelopeV1 = {
      eventId,
      eventType,
      schemaVersion,
      occurredAt,
      companyId,
      partitionKey: String(companyId),
      correlationId,
      aggregateType: 'JournalEntry',
      aggregateId: String(entry.id),
      source,
      payload: {
        journalEntryId: entry.id,
        amount,
      },
    };

    const published = await publishDomainEvent(envelope);
    if (published) {
      await markEventPublished(eventId);
    }

    return entry;
  });
}

