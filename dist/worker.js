import Fastify from 'fastify';
import { AccountType } from '@prisma/client';
import { prisma } from './infrastructure/db.js';
import { runIdempotent } from './infrastructure/idempotency.js';
import { getRedis } from './infrastructure/redis.js';
import { normalizeToDay } from './utils/date.js';
import { Prisma } from '@prisma/client';
const fastify = Fastify({ logger: true });
const redis = getRedis();
// --- Pub/Sub Push Auth (OIDC) ---
// Production-grade: require Pub/Sub push to include a Google-signed OIDC token and verify:
// - audience matches PUBSUB_PUSH_AUDIENCE
// - email matches PUBSUB_PUSH_SA_EMAIL (the service account configured on the subscription)
//
// Local dev: set DISABLE_PUBSUB_OIDC_AUTH=true to bypass.
async function verifyPubSubOidc(request, reply) {
    if ((process.env.DISABLE_PUBSUB_OIDC_AUTH ?? '').toLowerCase() === 'true')
        return;
    const audience = process.env.PUBSUB_PUSH_AUDIENCE;
    const expectedEmail = process.env.PUBSUB_PUSH_SA_EMAIL;
    const enforce = (process.env.ENFORCE_PUBSUB_OIDC_AUTH ?? '').toLowerCase() === 'true';
    // If not configured, allow in dev but fail closed when ENFORCE is enabled.
    if (!audience || !expectedEmail) {
        if (enforce) {
            reply.status(500).send({ error: 'pubsub auth not configured (missing PUBSUB_PUSH_AUDIENCE/PUBSUB_PUSH_SA_EMAIL)' });
            return;
        }
        request.log.warn({ hasAudience: !!audience, hasExpectedEmail: !!expectedEmail }, 'Pub/Sub OIDC auth not configured; allowing request');
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
        const email = payload.email;
        const emailVerified = payload.email_verified;
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
    }
    catch (err) {
        request.log.warn({ err }, 'Failed Pub/Sub OIDC verification');
        reply.status(401).send({ error: 'Invalid OIDC token' });
        return;
    }
}
// Pub/Sub push endpoint
fastify.post('/pubsub/push', { preHandler: verifyPubSubOidc }, async (request, reply) => {
    const body = request.body;
    if (!body || !body.message || !body.message.data) {
        fastify.log.error('Invalid Pub/Sub message format', body);
        reply.status(400);
        return { error: 'Bad request' };
    }
    try {
        const dataBuffer = Buffer.from(body.message.data, 'base64');
        const decoded = dataBuffer.toString('utf8');
        const envelope = JSON.parse(decoded);
        fastify.log.info({ envelope }, 'Received Pub/Sub event');
        // Handle both regular journal entries and Piti sales (which also create journal entries)
        // Keep backward compatibility for older eventType values.
        if (envelope.eventType === 'journal.entry.created' ||
            envelope.eventType === 'integration.piti.sale.imported' ||
            envelope.eventType === 'piti.sale.imported') {
            await handleJournalEntryCreated(envelope);
        }
        reply.status(204); // No Content
        return;
    }
    catch (err) {
        fastify.log.error({ err }, 'Failed to handle Pub/Sub message');
        reply.status(500);
        return { error: 'Internal error' };
    }
});
async function handleJournalEntryCreated(event) {
    const { eventId, payload } = event;
    // Backward compatibility / safety:
    // Some older messages may have companyId missing at the top-level.
    const companyIdRaw = event?.companyId ?? payload?.companyId;
    const journalEntryIdRaw = payload?.journalEntryId;
    const companyId = Number(companyIdRaw);
    const journalEntryId = Number(journalEntryIdRaw);
    // IMPORTANT: If message is malformed, do NOT throw.
    // Returning normally makes the handler reply 204 and Pub/Sub won't retry forever.
    if (typeof eventId !== 'string' ||
        !eventId ||
        !Number.isInteger(companyId) ||
        companyId <= 0 ||
        !Number.isInteger(journalEntryId) ||
        journalEntryId <= 0) {
        fastify.log.error({ eventId, companyIdRaw, journalEntryIdRaw }, 'Invalid Pub/Sub event: missing/invalid eventId, companyId, or journalEntryId');
        return;
    }
    await runIdempotent(prisma, companyId, eventId, async (tx) => {
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
            fastify.log.error({ eventCompanyId: companyId, entryCompanyId: entry.companyId, journalEntryId }, 'Tenant mismatch: event.companyId does not match JournalEntry.companyId');
            return;
        }
        // 3) Compute how much income and expense this entry represents
        let incomeDelta = 0;
        let expenseDelta = 0;
        for (const line of entry.lines) {
            const acc = line.account;
            const debit = Number(line.debit);
            const credit = Number(line.credit);
            if (acc.type === AccountType.INCOME) {
                // Income increases with credit
                incomeDelta += credit - debit;
            }
            if (acc.type === AccountType.EXPENSE) {
                // Expense increases with debit
                expenseDelta += debit - credit;
            }
        }
        if (incomeDelta === 0 && expenseDelta === 0) {
            fastify.log.info({ journalEntryId, incomeDelta, expenseDelta }, 'No income/expense impact, skipping summary update');
        }
        const day = normalizeToDay(entry.date);
        // 4) Upsert into DailySummary (income/expense only)
        if (incomeDelta !== 0 || expenseDelta !== 0) {
            fastify.log.info({ companyId, day, incomeDelta, expenseDelta }, 'Updating DailySummary');
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
        const byAccount = new Map();
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
            await tx.accountBalance.upsert({
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
    }, redis);
}
const start = async () => {
    try {
        const port = Number(process.env.PORT) || 8080;
        await fastify.listen({ port, host: '0.0.0.0' });
        console.log(`Worker listening on port ${port} /pubsub/push`);
    }
    catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};
start();
//# sourceMappingURL=worker.js.map