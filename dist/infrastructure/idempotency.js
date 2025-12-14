import { PrismaClient } from '@prisma/client';
export async function runIdempotent(prisma, companyId, eventId, work, redis, redisTtlMs = 10 * 60 * 1000 // 10 minutes
) {
    // Safety rail: never throw for malformed ids in background processing.
    // If we can't trust the tenant id, we must not process anything.
    if (!Number.isInteger(companyId) || companyId <= 0 || typeof eventId !== 'string' || !eventId) {
        return;
    }
    const redisKey = `idemp:event:${companyId}:${eventId}`;
    let redisGuarded = false;
    // Redis is best-effort: if unavailable, we still rely on DB uniqueness for idempotency.
    if (redis) {
        try {
            const ok = await redis.set(redisKey, '1', 'PX', redisTtlMs, 'NX');
            if (ok !== 'OK') {
                // Duplicate event already in-flight or processed recently; skip work.
                return;
            }
            redisGuarded = true;
        }
        catch {
            redisGuarded = false;
        }
    }
    try {
        await prisma.$transaction(async (tx) => {
            // 1. Idempotency check: insert ProcessedEvent
            // If eventId exists, this throws P2002
            await tx.processedEvent.create({
                data: { eventId, companyId },
            });
            // 2. Perform the actual work
            await work(tx);
        });
    }
    catch (err) {
        // If ProcessedEvent unique constraint fails, it means we already processed this eventId
        if (err.code === 'P2002') {
            // We can log this in the caller if needed, or re-throw a specific IdempotencyError
            // For now, we swallow it as "success" (idempotent no-op) but let the caller know via log if they want
            // Since this function returns void, we just return.
            if (redisGuarded) {
                try {
                    await redis.set(redisKey, '1', 'PX', redisTtlMs);
                }
                catch {
                    /* best-effort */
                }
            }
            return;
        }
        if (redisGuarded) {
            // Allow retry if work failed
            try {
                await redis.del(redisKey);
            }
            catch {
                /* best-effort */
            }
        }
        throw err;
    }
}
//# sourceMappingURL=idempotency.js.map