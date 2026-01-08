import { Prisma } from '@prisma/client';
import type { PrismaTx } from '../modules/ledger/posting.service.js';
import { normalizeToDay } from './date.js';

export function dayAfter(d: Date): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + 1);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

export async function getClosedThroughDate(tx: PrismaTx, companyId: number): Promise<Date | null> {
  const agg = await (tx as any).periodClose.aggregate({
    where: { companyId },
    _max: { toDate: true },
  });
  const to = (agg as any)?._max?.toDate ? new Date((agg as any)._max.toDate) : null;
  if (!to || isNaN(to.getTime())) return null;
  return normalizeToDay(to);
}

/**
 * Business rule:
 * - Backdating is allowed only if transactionDate is within an OPEN period.
 * - If transactionDate falls on/before the latest closed PeriodClose.toDate, block.
 *
 * We treat PeriodClose.toDate as inclusive at the day granularity (normalized to day).
 */
export async function assertOpenPeriodOrThrow(
  tx: PrismaTx,
  args: { companyId: number; transactionDate: Date; action: string }
): Promise<{ closedThroughDate: Date | null }> {
  const closedThroughDate = await getClosedThroughDate(tx, args.companyId);
  if (!closedThroughDate) return { closedThroughDate: null };

  const txDay = normalizeToDay(new Date(args.transactionDate));
  if (isNaN(txDay.getTime())) {
    throw Object.assign(new Error('invalid transaction date'), { statusCode: 400 });
  }

  if (txDay.getTime() <= closedThroughDate.getTime()) {
    throw Object.assign(
      new Error(
        `${args.action}: transaction date ${txDay.toISOString().slice(0, 10)} is in a CLOSED period (closed through ${closedThroughDate
          .toISOString()
          .slice(0, 10)}).`
      ),
      {
        statusCode: 400,
        code: 'PERIOD_CLOSED',
        transactionDate: txDay.toISOString(),
        closedThroughDate: closedThroughDate.toISOString(),
      }
    );
  }

  return { closedThroughDate };
}

