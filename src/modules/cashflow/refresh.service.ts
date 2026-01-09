import { Prisma } from '@prisma/client';
import type { PrismaTx } from '../ledger/posting.service.js';
import { normalizeToDay } from '../../utils/date.js';
import { computeCashflowForecast } from './cashflow.service.js';

export type Scenario = 'base' | 'conservative' | 'optimistic';

export async function refreshCashflowSnapshotsForCompany(
  tx: PrismaTx,
  args: { companyId: number; asOfDate?: Date; scenarios?: Scenario[] }
) {
  const companyId = args.companyId;
  const asOfDate = normalizeToDay(args.asOfDate ?? new Date());
  const scenarios: Scenario[] = (args.scenarios && args.scenarios.length ? args.scenarios : ['base', 'conservative', 'optimistic']) as any;

  for (const scenario of scenarios) {
    const forecast = await computeCashflowForecast(tx, companyId, { weeks: 13, scenario, asOfDate });

    // Upsert snapshot. Use updateMany/create for tenant-isolation friendliness and MySQL performance.
    const where = { companyId, scenario, asOfDate } as any;

    const updated = await (tx as any).cashflowForecastSnapshot.updateMany({
      where,
      data: { computedAt: new Date(), payload: forecast as any },
    });
    if ((updated as any)?.count === 1) continue;

    try {
      await (tx as any).cashflowForecastSnapshot.create({
        data: {
          companyId,
          scenario,
          asOfDate,
          computedAt: new Date(),
          payload: forecast as any,
        },
      });
    } catch (e: any) {
      // Race-safe: if created by another worker concurrently, just update it.
      await (tx as any).cashflowForecastSnapshot.updateMany({
        where,
        data: { computedAt: new Date(), payload: forecast as any },
      });
    }
  }
}

