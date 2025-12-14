import { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
type PrismaTx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;
export declare function runIdempotent(prisma: PrismaClient, companyId: number, eventId: string, work: (tx: PrismaTx) => Promise<void>, redis?: Redis, redisTtlMs?: number): Promise<void>;
export {};
//# sourceMappingURL=idempotency.d.ts.map