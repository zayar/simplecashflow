import { PrismaClient } from '@prisma/client';

// Helper type to represent the transaction client
type PrismaTx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

export async function runIdempotent(
  prisma: PrismaClient,
  companyId: number,
  eventId: string,
  work: (tx: PrismaTx) => Promise<void>
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      // 1. Idempotency check: insert ProcessedEvent
      // If eventId exists, this throws P2002
      await tx.processedEvent.create({
        data: { eventId, companyId },
      });

      // 2. Perform the actual work
      await work(tx as PrismaTx);
    });
  } catch (err: any) {
    // If ProcessedEvent unique constraint fails, it means we already processed this eventId
    if (err.code === 'P2002') {
      // We can log this in the caller if needed, or re-throw a specific IdempotencyError
      // For now, we swallow it as "success" (idempotent no-op) but let the caller know via log if they want
      // Since this function returns void, we just return.
      return;
    }
    throw err;
  }
}

