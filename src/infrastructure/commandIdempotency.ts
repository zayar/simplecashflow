import type { PrismaClient } from '@prisma/client';

type IdempotentResult<T> = { replay: boolean; response: T };

/**
 * Command-level idempotency for HTTP writes.
 * Uses IdempotentRequest(companyId, key) unique constraint to guarantee at-most-once execution per key.
 */
export async function runIdempotentRequest<T>(
  prisma: PrismaClient,
  companyId: number,
  key: string,
  work: () => Promise<T>
): Promise<IdempotentResult<T>> {
  const existing = await prisma.idempotentRequest.findUnique({
    where: { companyId_key: { companyId, key } },
    select: { response: true },
  });
  if (existing) {
    return { replay: true, response: existing.response as T };
  }

  const response = await work();

  try {
    await prisma.idempotentRequest.create({
      data: {
        companyId,
        key,
        response: response as any,
      },
    });
    return { replay: false, response };
  } catch (err: any) {
    // Race: another request with same key won. Fetch and return its response.
    if (err?.code === 'P2002') {
      const nowExisting = await prisma.idempotentRequest.findUnique({
        where: { companyId_key: { companyId, key } },
        select: { response: true },
      });
      if (nowExisting) return { replay: true, response: nowExisting.response as T };
    }
    throw err;
  }
}


