import type { Redis } from 'ioredis';

const DEFAULT_TTL_MS = 30_000;

/**
 * Acquire a simple Redis-based distributed lock (SET NX PX).
 * Returns a release function. If lock not acquired, returns null.
 */
export async function acquireLock(
  redis: Redis,
  key: string,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<null | (() => Promise<void>)> {
  const value = cryptoRandom();
  const ok = await redis.set(key, value, 'PX', ttlMs, 'NX');
  if (ok !== 'OK') return null;

  return async () => {
    const lua = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      end
      return 0
    `;
    try {
      await redis.eval(lua, 1, key, value);
    } catch {
      /* swallow */
    }
  };
}

export async function withLock<T>(
  redis: Redis,
  key: string,
  ttlMs: number,
  work: () => Promise<T>
): Promise<T> {
  const release = await acquireLock(redis, key, ttlMs);
  if (!release) {
    throw Object.assign(new Error('resource is locked'), { statusCode: 409 });
  }
  try {
    return await work();
  } finally {
    await release();
  }
}

/**
 * Best-effort lock:
 * - If Redis is down/unreachable, runs work without a lock (DB idempotency is still required).
 * - If Redis is up but lock is held, throws 409.
 */
export async function withLockBestEffort<T>(
  redis: Redis | undefined,
  key: string,
  ttlMs: number,
  work: () => Promise<T>
): Promise<T> {
  if (!redis) return await work();

  let release: null | (() => Promise<void>) | undefined;
  try {
    release = await acquireLock(redis, key, ttlMs);
  } catch {
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
  } finally {
    await release();
  }
}

function cryptoRandom(): string {
  return (
    Math.random().toString(16).slice(2) +
    Math.random().toString(16).slice(2) +
    Date.now().toString(16)
  );
}
