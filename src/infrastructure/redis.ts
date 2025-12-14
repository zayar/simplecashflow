import { Redis } from 'ioredis';

let client: Redis | null = null;

/**
 * Singleton Redis client for caching/idempotency/locks.
 * Uses REDIS_URL env; defaults to localhost. Lazy connects so unit tests can stub.
 */
export function getRedis(): Redis {
  if (!client) {
    const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });

    client.on('error', (err: unknown) => {
      // Log but do not crash; callers should degrade gracefully.
      console.error('Redis error', err);
    });

    // Fire-and-forget connect; callers can await if they need strict readiness.
    client.connect().catch((err: unknown) => {
      console.error('Redis connect failed', err);
    });
  }
  return client;
}

export async function withRedis<T>(fn: (redis: Redis) => Promise<T>): Promise<T> {
  const redis = getRedis();
  return fn(redis);
}
