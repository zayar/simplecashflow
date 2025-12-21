import type { FastifyInstance } from 'fastify';
import { prisma } from '../../infrastructure/db.js';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { postJournalEntry } from '../ledger/posting.service.js';
import { forbidClientProvidedCompanyId } from '../../utils/tenant.js';
import { getRedis } from '../../infrastructure/redis.js';
import { runIdempotentRequest } from '../../infrastructure/commandIdempotency.js';

export async function pitiRoutes(fastify: FastifyInstance) {
  // Integration endpoints should be protected (JWT for now).
  // Later: switch to signed webhooks / service-to-service auth.
  fastify.addHook('preHandler', fastify.authenticate);
  const redis = getRedis();

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
    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      reply.status(400);
      return { error: 'Idempotency-Key header is required' };
    }

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

    const { response } = await runIdempotentRequest(
      prisma,
      companyId,
      idempotencyKey,
      async () => {
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
        return entry;
      },
      redis
    );
    return response as any;
  });
}

