import { Prisma } from '@prisma/client';
function padNumber(n, width) {
    const s = String(n);
    return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}
/**
 * Atomically allocates a sequence number for a given (companyId, key).
 * Stores nextNumber as the next value to allocate.
 */
export async function nextCompanySequenceNumber(tx, companyId, key) {
    const seq = await tx.documentSequence.upsert({
        where: { companyId_key: { companyId, key } },
        create: { companyId, key, nextNumber: 1 },
        update: {},
        select: { id: true },
    });
    const updated = await tx.documentSequence.update({
        where: { id: seq.id },
        data: { nextNumber: { increment: 1 } },
        select: { nextNumber: true },
    });
    return Number(updated.nextNumber) - 1;
}
export async function nextPurchaseBillNumber(tx, companyId) {
    const n = await nextCompanySequenceNumber(tx, companyId, 'PURCHASE_BILL');
    return `PB-${padNumber(n, 6)}`;
}
//# sourceMappingURL=sequence.service.js.map