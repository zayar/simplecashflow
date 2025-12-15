import { Prisma, PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
type PrismaTx = Prisma.TransactionClient;
export declare function runIdempotent(prisma: PrismaClient, companyId: number, eventId: string, work: (tx: PrismaTx) => Promise<void>, redis?: Redis, redisTtlMs?: number): Promise<void>;
export {};
//# sourceMappingURL=idempotency.d.ts.map