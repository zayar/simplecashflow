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
  // Ensure sequence row exists (race-safe).
  // We intentionally do not rely on upsert+update-by-id here because we want:
  // - tenant-safe where clauses (companyId included)
  // - deterministic row locking to support gapless numbering under concurrency
  try {
    await (tx as any).documentSequence.create({
      data: { companyId, key, nextNumber: 1 },
    select: { id: true },
  });
  } catch (err: any) {
    // P2002 = unique constraint (already exists)
    if (err?.code !== 'P2002') throw err;
  }

  // Lock the sequence row and allocate the current nextNumber.
  const rows = (await (tx as any).$queryRaw`
    SELECT id, nextNumber
    FROM DocumentSequence
    WHERE companyId = ${companyId} AND \`key\` = ${key}
    FOR UPDATE
  `) as Array<{ id: number; nextNumber: any }>;

  if (!rows?.length) {
    throw new Error('sequence row not found after create');
  }

  const row = rows[0]!;
  const current = Number(row.nextNumber);
  if (!Number.isInteger(current) || current <= 0) {
    throw new Error('invalid sequence state');
  }

  await (tx as any).$executeRaw`
    UPDATE DocumentSequence
    SET nextNumber = nextNumber + 1
    WHERE companyId = ${companyId} AND \`key\` = ${key}
  `;

  return current;
}

export async function nextPurchaseBillNumber(tx: PrismaTx, companyId: number): Promise<string> {
  const n = await nextCompanySequenceNumber(tx, companyId, 'PURCHASE_BILL');
  return `PB-${padNumber(n, 6)}`;
}

export async function nextCreditNoteNumber(tx: PrismaTx, companyId: number): Promise<string> {
  const n = await nextCompanySequenceNumber(tx, companyId, 'CREDIT_NOTE');
  return `CN-${padNumber(n, 5)}`;
}

export async function nextVendorCreditNumber(tx: PrismaTx, companyId: number): Promise<string> {
  const n = await nextCompanySequenceNumber(tx, companyId, 'VENDOR_CREDIT');
  return `VC-${padNumber(n, 6)}`;
}

export async function nextJournalEntryNumber(
  tx: PrismaTx,
  companyId: number,
  date: Date
): Promise<string> {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    throw new Error('invalid journal entry date for sequencing');
  }
  // Use the ledger date's UTC year (consistent with how dates are stored/handled server-side).
  // IMPORTANT: If your accounting policy requires company-timezone year boundaries, switch this
  // to use a timezone-aware date boundary and keep migrations consistent.
  const year = date.getUTCFullYear();
  const key = `JOURNAL_ENTRY:${year}`;

  // Self-healing allocator:
  // If the sequence row is missing (e.g., partial migration) or behind the current max JE number,
  // we catch up to (max + 1) *inside the transaction*, then allocate under FOR UPDATE.
  //
  // This prevents duplicate entryNumber and preserves "gapless on rollback" semantics.
  async function readMaxExisting(): Promise<number> {
    const rows = (await (tx as any).$queryRaw`
      SELECT MAX(CAST(SUBSTRING_INDEX(entryNumber, '-', -1) AS UNSIGNED)) AS maxN
      FROM JournalEntry
      WHERE companyId = ${companyId}
        AND entryNumber LIKE ${`JE-${year}-%`}
    `) as Array<{ maxN: any }>;
    const maxN = rows?.length ? Number(rows[0]!.maxN ?? 0) : 0;
    return Number.isFinite(maxN) && maxN > 0 ? Math.floor(maxN) : 0;
  }

  // Ensure row exists (race-safe).
  try {
    await (tx as any).documentSequence.create({
      data: { companyId, key, nextNumber: 1 },
      select: { id: true },
    });
  } catch (err: any) {
    if (err?.code !== 'P2002') throw err;
  }

  // Lock row and (if needed) bump it above max existing.
  const seqRows = (await (tx as any).$queryRaw`
    SELECT nextNumber
    FROM DocumentSequence
    WHERE companyId = ${companyId} AND \`key\` = ${key}
    FOR UPDATE
  `) as Array<{ nextNumber: any }>;

  if (!seqRows?.length) {
    // Extremely unlikely, but be defensive.
    throw new Error('sequence row not found');
  }

  let nextNumber = Number(seqRows[0]!.nextNumber);
  if (!Number.isInteger(nextNumber) || nextNumber <= 0) {
    nextNumber = 1;
  }

  const maxExisting = await readMaxExisting();
  const minNext = maxExisting + 1;
  if (nextNumber < minNext) {
    // Catch up (still inside lock).
    await (tx as any).$executeRaw`
      UPDATE DocumentSequence
      SET nextNumber = ${minNext}
      WHERE companyId = ${companyId} AND \`key\` = ${key}
    `;
    nextNumber = minNext;
  }

  // Allocate current, then increment for next caller.
  const allocated = nextNumber;
  await (tx as any).$executeRaw`
    UPDATE DocumentSequence
    SET nextNumber = nextNumber + 1
    WHERE companyId = ${companyId} AND \`key\` = ${key}
  `;

  return `JE-${year}-${padNumber(allocated, 4)}`;
}


