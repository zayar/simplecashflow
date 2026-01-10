const DEFAULT_TTL_MS = 30_000;
/**
 * Acquire a simple Redis-based distributed lock (SET NX PX).
 * Returns a release function. If lock not acquired, returns null.
 */
export async function acquireLock(redis, key, ttlMs = DEFAULT_TTL_MS) {
    const value = cryptoRandom();
    const ok = await redis.set(key, value, 'PX', ttlMs, 'NX');
    if (ok !== 'OK')
        return null;
    return async () => {
        const lua = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      end
      return 0
    `;
        try {
            await redis.eval(lua, 1, key, value);
        }
        catch {
            /* swallow */
        }
    };
}
export async function withLock(redis, key, ttlMs, work) {
    const release = await acquireLock(redis, key, ttlMs);
    if (!release) {
        throw Object.assign(new Error('resource is locked'), { statusCode: 409 });
    }
    try {
        return await work();
    }
    finally {
        await release();
    }
}
/**
 * Best-effort lock:
 * - If Redis is down/unreachable, runs work without a lock (DB idempotency is still required).
 * - If Redis is up but lock is held, throws 409.
 */
export async function withLockBestEffort(redis, key, ttlMs, work) {
    if (!redis)
        return await work();
    let release;
    try {
        release = await acquireLock(redis, key, ttlMs);
    }
    catch {
        // Redis error: proceed without lock.
        release = undefined;
    }
    if (release === null) {
        throw Object.assign(new Error('resource is locked'), { statusCode: 409 });
    }
    if (!release) {
        return await work();
    }
    try {
        return await work();
    }
    finally {
        await release();
    }
}
/**
 * Multi-lock helper built on `withLockBestEffort`.
 *
 * - Locks are acquired in deterministic order (sorted unique keys).
 * - Uses best-effort semantics: if Redis is down, runs without locks.
 * - If Redis is up and any lock is held, throws 409 (from `withLockBestEffort`).
 */
export async function withLocksBestEffort(redis, keys, ttlMs, work) {
    const sortedUniqueKeys = Array.from(new Set(keys)).sort();
    let run = work;
    // Compose in reverse order so the first key is acquired first.
    for (const key of sortedUniqueKeys.reverse()) {
        const prev = run;
        run = async () => await withLockBestEffort(redis, key, ttlMs, prev);
    }
    return await run();
}
function cryptoRandom() {
    return (Math.random().toString(16).slice(2) +
        Math.random().toString(16).slice(2) +
        Date.now().toString(16));
}
//# sourceMappingURL=locks.js.map