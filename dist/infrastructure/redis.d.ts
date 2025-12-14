import { Redis } from 'ioredis';
/**
 * Singleton Redis client for caching/idempotency/locks.
 * Uses REDIS_URL env; defaults to localhost. Lazy connects so unit tests can stub.
 */
export declare function getRedis(): Redis;
export declare function withRedis<T>(fn: (redis: Redis) => Promise<T>): Promise<T>;
//# sourceMappingURL=redis.d.ts.map