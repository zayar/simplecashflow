import type { Redis } from 'ioredis';
export declare function isResourceLockedError(err: any): boolean;
/**
 * Run an operation with a short retry window when a Redis lock is held.
 * This reduces user-visible 409s under normal contention (double-clicks, concurrent postings).
 */
export declare function runWithResourceLockRetry<T>(work: () => Promise<T>, opts?: {
    maxWaitMs?: number;
    baseDelayMs?: number;
    jitterMs?: number;
}): Promise<T>;
/**
 * Acquire a simple Redis-based distributed lock (SET NX PX).
 * Returns a release function. If lock not acquired, returns null.
 */
export declare function acquireLock(redis: Redis, key: string, ttlMs?: number): Promise<null | (() => Promise<void>)>;
export declare function withLock<T>(redis: Redis, key: string, ttlMs: number, work: () => Promise<T>): Promise<T>;
/**
 * Best-effort lock:
 * - If Redis is down/unreachable, runs work without a lock (DB idempotency is still required).
 * - If Redis is up but lock is held, throws 409.
 */
export declare function withLockBestEffort<T>(redis: Redis | undefined, key: string, ttlMs: number, work: () => Promise<T>): Promise<T>;
/**
 * Multi-lock helper with **parallel acquisition** for better performance.
 *
 * - Locks are acquired in deterministic order (sorted unique keys).
 * - Uses best-effort semantics: if Redis is down, runs without locks.
 * - If Redis is up and any lock is held, throws 409.
 * - Uses Redis pipeline for parallel lock acquisition (single round-trip).
 */
export declare function withLocksBestEffort<T>(redis: Redis | undefined, keys: string[], ttlMs: number, work: () => Promise<T>): Promise<T>;
//# sourceMappingURL=locks.d.ts.map