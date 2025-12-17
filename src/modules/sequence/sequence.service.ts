import { Prisma } from '@prisma/client';

type PrismaTx = Prisma.TransactionClient;

function padNumber(n: number, width: number): string {
  const s = String(n);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

/**
 * Atomically allocates a sequence number for a given (companyId, key).
 * Stores nextNumber as the next value to allocate.
 */
export async function nextCompanySequenceNumber(
  tx: PrismaTx,
  companyId: number,
  key: string
): Promise<number> {
  const seq = await (tx as any).documentSequence.upsert({
    where: { companyId_key: { companyId, key } },
    create: { companyId, key, nextNumber: 1 },
    update: {},
    select: { id: true },
  });

  const updated = await (tx as any).documentSequence.update({
    where: { id: seq.id },
    data: { nextNumber: { increment: 1 } },
    select: { nextNumber: true },
  });

  return Number(updated.nextNumber) - 1;
}

export async function nextPurchaseBillNumber(tx: PrismaTx, companyId: number): Promise<string> {
  const n = await nextCompanySequenceNumber(tx, companyId, 'PURCHASE_BILL');
  return `PB-${padNumber(n, 6)}`;
}


