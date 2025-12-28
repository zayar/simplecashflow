import { prisma } from '../../infrastructure/db.js';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { postJournalEntry } from '../ledger/posting.service.js';
import { forbidClientProvidedCompanyId } from '../../utils/tenant.js';
import { getRedis } from '../../infrastructure/redis.js';
import { runIdempotentRequest } from '../../infrastructure/commandIdempotency.js';
import { requireIntegrationKey } from './integrationAuth.js';
import { upsertPostedCreditNoteFromPitiRefund, upsertPostedInvoiceFromPitiSale } from './piti.service.js';
export async function pitiRoutes(fastify) {
    const redis = getRedis();
    // Integration auth:
    // - Prefer service-to-service `X-Integration-Key` for Piti team
    // - Allow JWT as fallback for internal testing
    fastify.addHook('preHandler', async (request, reply) => {
        const hasIntegrationKey = Boolean(request.headers?.['x-integration-key']);
        if (hasIntegrationKey) {
            const ok = requireIntegrationKey(request, reply, 'PITI_INTEGRATION_API_KEY');
            if (!ok)
                return;
            return;
        }
        // fallback to JWT
        return fastify.authenticate(request, reply);
    });
    // --- Piti integration: simple cash sale ---
    // This simulates Piti sending a sale event to the ledger.
    fastify.post('/integrations/piti/sale', async (request, reply) => {
        const body = request.body;
        if (!body.amount || body.amount <= 0) {
            reply.status(400);
            return { error: 'positive amount is required' };
        }
        const companyId = forbidClientProvidedCompanyId(request, reply, body.companyId);
        const amount = body.amount;
        const idempotencyKey = request.headers?.['idempotency-key'];
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
        const schemaVersion = 'v1';
        const source = 'integration:piti';
        const { response } = await runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
            const entry = await prisma.$transaction(async (tx) => {
                const journalEntry = await postJournalEntry(tx, {
                    companyId,
                    date,
                    description: body.description ?? 'Piti sale',
                    createdByUserId: request.user?.userId ?? null,
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
        }, redis);
        return response;
    });
    /**
     * Piti -> Cashflow: Sale Completed (Finance import)
     *
     * Creates a POSTED invoice (and optional payment) in Cashflow.
     * IMPORTANT: Items created by this endpoint will have trackInventory=false.
     */
    fastify.post('/integrations/piti/companies/:companyId/sales', async (request, reply) => {
        const companyId = Number(request.params?.companyId);
        if (!Number.isInteger(companyId) || companyId <= 0) {
            reply.status(400);
            return { error: 'invalid companyId' };
        }
        const idempotencyKey = request.headers?.['idempotency-key'];
        if (!idempotencyKey) {
            reply.status(400);
            return { error: 'Idempotency-Key header is required' };
        }
        try {
            const { replay, response } = await runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const payload = request.body;
                const result = await upsertPostedInvoiceFromPitiSale({
                    prisma,
                    companyId,
                    idempotencyKey,
                    payload,
                    userId: request.user?.userId ?? null,
                });
                return result;
            }, redis);
            // Keep response stable (ignore replay flag for now)
            return response;
        }
        catch (err) {
            reply.status(400);
            return { error: err?.message ?? 'invalid payload' };
        }
    });
    /**
     * Piti -> Cashflow: Refund/Return (Finance import)
     *
     * Creates a POSTED credit note in Cashflow and posts the required journal entry.
     * IMPORTANT: This is finance-only (no stock moves).
     */
    fastify.post('/integrations/piti/companies/:companyId/refunds', async (request, reply) => {
        const companyId = Number(request.params?.companyId);
        if (!Number.isInteger(companyId) || companyId <= 0) {
            reply.status(400);
            return { error: 'invalid companyId' };
        }
        const idempotencyKey = request.headers?.['idempotency-key'];
        if (!idempotencyKey) {
            reply.status(400);
            return { error: 'Idempotency-Key header is required' };
        }
        try {
            const { response } = await runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
                const payload = request.body;
                return await upsertPostedCreditNoteFromPitiRefund({
                    prisma,
                    companyId,
                    idempotencyKey,
                    payload,
                    userId: request.user?.userId ?? null,
                });
            }, redis);
            return response;
        }
        catch (err) {
            reply.status(400);
            return { error: err?.message ?? 'invalid payload' };
        }
    });
}
//# sourceMappingURL=piti.routes.js.map