import type { Redis } from 'ioredis';

type IdempotentResult<T> = { replay: boolean; response: T };

/**
 * Command-level idempotency for HTTP writes.
 * Uses IdempotentRequest(companyId, key) unique constraint to guarantee at-most-once execution per key.
 * Optionally caches responses in Redis for fast replay under retries.
 */
export async function runIdempotentRequest<T>(
  prisma: any,
  companyId: number,
  key: string,
  work: () => Promise<T>,
  redis?: Redis,
  redisTtlMs: number = 86_400_000 // 24h
): Promise<IdempotentResult<T>> {
  const cacheKey = `idemp:cmd:${companyId}:${key}`;

  // Fast path: check Redis cache first
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        try {
          return { replay: true, response: JSON.parse(cached) as T };
        } catch {
          // fall through to DB
        }
      }
    } catch {
      // Redis is best-effort. If unavailable, fall back to DB idempotency.
    }
  }

  const existing = await prisma.idempotentRequest.findUnique({
    where: { companyId_key: { companyId, key } },
    select: { response: true },
  });
  if (existing) {
    if (redis) {
      // backfill cache for future retries
      try {
        await redis.set(cacheKey, JSON.stringify(existing.response), 'PX', redisTtlMs);
      } catch {
        /* best-effort */
      }
    }
    return { replay: true, response: existing.response as T };
  }

  let lockedRedis = false;
  if (redis) {
    // Lightweight lock to avoid duplicate work under high retry load.
    try {
      const lock = await redis.set(`${cacheKey}:lock`, '1', 'PX', 5_000, 'NX');
      lockedRedis = lock === 'OK';
      if (!lockedRedis) {
        // Another request is in flight. Try to read cache again quickly.
        const cached = await redis.get(cacheKey);
        if (cached) {
          try {
            return { replay: true, response: JSON.parse(cached) as T };
          } catch {
            // continue to DB path
          }
        }
      }
    } catch {
      lockedRedis = false;
    }
  }

  const response = await work();

  try {
    await prisma.idempotentRequest.create({
      data: {
        companyId,
        key,
        response: response as any,
      },
    });
    if (redis) {
      try {
        await redis.set(cacheKey, JSON.stringify(response), 'PX', redisTtlMs);
        if (lockedRedis) {
          await redis.del(`${cacheKey}:lock`);
        }
      } catch {
        /* best-effort */
      }
    }
    return { replay: false, response };
  } catch (err: any) {
    // Race: another request with same key won. Fetch and return its response.
    if (err?.code === 'P2002') {
      const nowExisting = await prisma.idempotentRequest.findUnique({
        where: { companyId_key: { companyId, key } },
        select: { response: true },
      });
      if (nowExisting && redis) {
        try {
          await redis.set(cacheKey, JSON.stringify(nowExisting.response), 'PX', redisTtlMs);
          if (lockedRedis) {
            await redis.del(`${cacheKey}:lock`);
          }
        } catch {
          /* best-effort */
        }
      }
      if (nowExisting) return { replay: true, response: nowExisting.response as T };
    }
    if (redis && lockedRedis) {
      try {
        await redis.del(`${cacheKey}:lock`);
      } catch {
        /* best-effort */
      }
    }
    throw err;
  }
}


