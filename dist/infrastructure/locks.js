const DEFAULT_TTL_MS = 30_000;
const HEARTBEAT_RATIO = 0.5; // renew at ttl*0.5
function startHeartbeat(redis, key, value, ttlMs) {
    const intervalMs = Math.max(250, Math.floor(ttlMs * HEARTBEAT_RATIO));
    const lua = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("pexpire", KEYS[1], ARGV[2])
    end
    return 0
  `;
    const timer = setInterval(() => {
        // best-effort renewal; swallow errors
        void redis.eval(lua, 1, key, value, String(ttlMs)).catch(() => undefined);
    }, intervalMs);
    // Prevent keeping the process alive just for heartbeats.
    timer.unref?.();
    return {
        stop: () => clearInterval(timer),
    };
}
function startMultiHeartbeat(redis, keys, values, ttlMs) {
    const intervalMs = Math.max(250, Math.floor(ttlMs * HEARTBEAT_RATIO));
    const lua = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) end return 0`;
    const timer = setInterval(() => {
        try {
            const pipeline = redis.pipeline();
            for (let i = 0; i < keys.length; i++) {
                pipeline.eval(lua, 1, keys[i], values[i], String(ttlMs));
            }
            void pipeline.exec().catch(() => undefined);
        }
        catch {
            // ignore
        }
    }, intervalMs);
    timer.unref?.();
    return {
        stop: () => clearInterval(timer),
    };
}
export function isResourceLockedError(err) {
    return Number(err?.statusCode ?? 0) === 409 && String(err?.message ?? '').toLowerCase().includes('resource is locked');
}
/**
 * Run an operation with a short retry window when a Redis lock is held.
 * This reduces user-visible 409s under normal contention (double-clicks, concurrent postings).
 */
export async function runWithResourceLockRetry(work, opts) {
    const startedAt = Date.now();
    const maxWaitMs = Math.max(0, Number(opts?.maxWaitMs ?? 8_000));
    const baseDelayMs = Math.max(0, Number(opts?.baseDelayMs ?? 200));
    const jitterMs = Math.max(0, Number(opts?.jitterMs ?? 150));
    while (true) {
        try {
            return await work();
        }
        catch (e) {
            if (!isResourceLockedError(e))
                throw e;
            if (Date.now() - startedAt > maxWaitMs)
                throw e;
            const sleepMs = baseDelayMs + Math.floor(Math.random() * (jitterMs + 1));
            await new Promise((r) => setTimeout(r, sleepMs));
        }
    }
}
/**
 * Acquire a simple Redis-based distributed lock (SET NX PX).
 * Returns a release function. If lock not acquired, returns null.
 */
export async function acquireLock(redis, key, ttlMs = DEFAULT_TTL_MS) {
    const got = await acquireLockWithValue(redis, key, ttlMs);
    return got ? got.release : null;
}
async function acquireLockWithValue(redis, key, ttlMs = DEFAULT_TTL_MS) {
    const value = cryptoRandom();
    const ok = await redis.set(key, value, 'PX', ttlMs, 'NX');
    if (ok !== 'OK')
        return null;
    return {
        value,
        release: async () => {
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
        },
    };
}
export async function withLock(redis, key, ttlMs, work) {
    const got = await acquireLockWithValue(redis, key, ttlMs);
    if (!got) {
        throw Object.assign(new Error('resource is locked'), { statusCode: 409 });
    }
    const hb = startHeartbeat(redis, key, got.value, ttlMs);
    try {
        return await work();
    }
    finally {
        hb.stop();
        await got.release();
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
    let got;
    try {
        got = await acquireLockWithValue(redis, key, ttlMs);
    }
    catch {
        // Redis error: proceed without lock.
        got = undefined;
    }
    if (got === null) {
        throw Object.assign(new Error('resource is locked'), { statusCode: 409 });
    }
    if (!got) {
        return await work();
    }
    const hb = startHeartbeat(redis, key, got.value, ttlMs);
    try {
        return await work();
    }
    finally {
        hb.stop();
        await got.release();
    }
}
/**
 * Multi-lock helper with **parallel acquisition** for better performance.
 *
 * - Locks are acquired in deterministic order (sorted unique keys).
 * - Uses best-effort semantics: if Redis is down, runs without locks.
 * - If Redis is up and any lock is held, throws 409.
 * - Uses Redis pipeline for parallel lock acquisition (single round-trip).
 */
export async function withLocksBestEffort(redis, keys, ttlMs, work) {
    const sortedUniqueKeys = Array.from(new Set(keys)).sort();
    if (sortedUniqueKeys.length === 0) {
        return await work();
    }
    if (!redis) {
        return await work();
    }
    // Generate unique values for each lock
    const lockValues = sortedUniqueKeys.map(() => cryptoRandom());
    // Use pipeline for parallel lock acquisition (single round-trip)
    let results;
    try {
        const pipeline = redis.pipeline();
        for (let i = 0; i < sortedUniqueKeys.length; i++) {
            pipeline.set(sortedUniqueKeys[i], lockValues[i], 'PX', ttlMs, 'NX');
        }
        const pipelineResults = await pipeline.exec();
        results = (pipelineResults ?? []).map((r) => (r && r[1] === 'OK' ? 'OK' : null));
    }
    catch {
        // Redis error: proceed without locks
        return await work();
    }
    // Check if all locks were acquired
    const acquiredIndices = [];
    for (let i = 0; i < results.length; i++) {
        if (results[i] === 'OK') {
            acquiredIndices.push(i);
        }
    }
    // If not all locks acquired, release what we got and throw 409
    if (acquiredIndices.length !== sortedUniqueKeys.length) {
        // Release acquired locks
        if (acquiredIndices.length > 0) {
            try {
                const releasePipeline = redis.pipeline();
                const lua = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0`;
                for (const idx of acquiredIndices) {
                    releasePipeline.eval(lua, 1, sortedUniqueKeys[idx], lockValues[idx]);
                }
                await releasePipeline.exec();
            }
            catch {
                /* swallow */
            }
        }
        throw Object.assign(new Error('resource is locked'), { statusCode: 409 });
    }
    // All locks acquired, run work
    const hb = startMultiHeartbeat(redis, sortedUniqueKeys, lockValues, ttlMs);
    try {
        return await work();
    }
    finally {
        hb.stop();
        // Release all locks in parallel
        try {
            const releasePipeline = redis.pipeline();
            const lua = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0`;
            for (let i = 0; i < sortedUniqueKeys.length; i++) {
                releasePipeline.eval(lua, 1, sortedUniqueKeys[i], lockValues[i]);
            }
            await releasePipeline.exec();
        }
        catch {
            /* swallow */
        }
    }
}
function cryptoRandom() {
    return (Math.random().toString(16).slice(2) +
        Math.random().toString(16).slice(2) +
        Date.now().toString(16));
}
//# sourceMappingURL=locks.js.map