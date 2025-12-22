import { Prisma } from '@prisma/client';
import { postJournalEntry, type PrismaTx } from './posting.service.js';

export type MoneyLine = { accountId: number; debit: Prisma.Decimal; credit: Prisma.Decimal };

function d0() {
  return new Prisma.Decimal(0);
}

export function computeNetByAccount(lines: Array<{ accountId: number; debit: any; credit: any }>) {
  const by = new Map<number, Prisma.Decimal>();
  for (const l of lines) {
    const debit = new Prisma.Decimal(l.debit ?? 0).toDecimalPlaces(2);
    const credit = new Prisma.Decimal(l.credit ?? 0).toDecimalPlaces(2);
    const net = debit.sub(credit).toDecimalPlaces(2); // + = net debit, - = net credit
    const prev = by.get(l.accountId) ?? d0();
    by.set(l.accountId, prev.add(net).toDecimalPlaces(2));
  }
  // remove zeros for cleanliness
  for (const [k, v] of by.entries()) {
    if (v.toDecimalPlaces(2).equals(d0())) by.delete(k);
  }
  return by;
}

export function buildAdjustmentLinesFromNets(deltaNetByAccount: Map<number, Prisma.Decimal>): MoneyLine[] {
  const out: MoneyLine[] = [];
  for (const [accountId, net] of deltaNetByAccount.entries()) {
    const n = new Prisma.Decimal(net).toDecimalPlaces(2);
    if (n.equals(d0())) continue;
    if (n.greaterThan(0)) out.push({ accountId, debit: n, credit: d0() });
    else out.push({ accountId, debit: d0(), credit: n.abs() });
  }
  return out;
}

export function diffNets(
  original: Map<number, Prisma.Decimal>,
  desired: Map<number, Prisma.Decimal>
): Map<number, Prisma.Decimal> {
  const keys = new Set<number>([...original.keys(), ...desired.keys()]);
  const out = new Map<number, Prisma.Decimal>();
  for (const k of keys) {
    const o = original.get(k) ?? d0();
    const d = desired.get(k) ?? d0();
    const delta = d.sub(o).toDecimalPlaces(2);
    if (!delta.equals(d0())) out.set(k, delta);
  }
  return out;
}

export async function createReversalJournalEntry(
  tx: PrismaTx,
  input: {
    companyId: number;
    originalJournalEntryId: number;
    reversalDate: Date;
    reason?: string | null;
    createdByUserId?: number | null;
  }
) {
  const original = await tx.journalEntry.findFirst({
    where: { id: input.originalJournalEntryId, companyId: input.companyId },
    include: { lines: true },
  });
  if (!original) {
    throw Object.assign(new Error('journal entry not found'), { statusCode: 404 });
  }
  if ((original as any).reversalOfJournalEntryId) {
    throw Object.assign(new Error('cannot reverse a reversal entry'), { statusCode: 400 });
  }

  const existingReversal = await tx.journalEntry.findFirst({
    where: { companyId: input.companyId, reversalOfJournalEntryId: original.id },
    select: { id: true },
  });
  if (existingReversal) {
    throw Object.assign(new Error('journal entry already reversed'), { statusCode: 400 });
  }

  const reversalLines = (original.lines ?? []).map((l: any) => ({
    accountId: l.accountId,
    debit: new Prisma.Decimal(l.credit).toDecimalPlaces(2),
    credit: new Prisma.Decimal(l.debit).toDecimalPlaces(2),
  }));

  const reversal = await postJournalEntry(tx, {
    companyId: input.companyId,
    date: input.reversalDate,
    description: `REVERSAL of JE ${original.id}: ${original.description}`,
    createdByUserId: input.createdByUserId ?? null,
    reversalOfJournalEntryId: original.id,
    reversalReason: input.reason ?? null,
    lines: reversalLines,
  });

  return { original, reversal };
}


