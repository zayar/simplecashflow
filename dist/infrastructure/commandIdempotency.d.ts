import type { Redis } from 'ioredis';
type IdempotentResult<T> = {
    replay: boolean;
    response: T;
};
/**
 * Command-level idempotency for HTTP writes.
 * Uses IdempotentRequest(companyId, key) unique constraint to guarantee at-most-once execution per key.
 * Optionally caches responses in Redis for fast replay under retries.
 */
export declare function runIdempotentRequest<T>(prisma: any, companyId: number, key: string, work: () => Promise<T>, redis?: Redis, redisTtlMs?: number): Promise<IdempotentResult<T>>;
export {};
//# sourceMappingURL=commandIdempotency.d.ts.map