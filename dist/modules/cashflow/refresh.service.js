import { Prisma } from '@prisma/client';
import { normalizeToDay } from '../../utils/date.js';
import { computeCashflowForecast } from './cashflow.service.js';
export async function refreshCashflowSnapshotsForCompany(tx, args) {
    const companyId = args.companyId;
    const asOfDate = normalizeToDay(args.asOfDate ?? new Date());
    const scenarios = (args.scenarios && args.scenarios.length ? args.scenarios : ['base', 'conservative', 'optimistic']);
    for (const scenario of scenarios) {
        const forecast = await computeCashflowForecast(tx, companyId, { weeks: 13, scenario, asOfDate });
        // Upsert snapshot. Use updateMany/create for tenant-isolation friendliness and MySQL performance.
        const where = { companyId, scenario, asOfDate };
        const updated = await tx.cashflowForecastSnapshot.updateMany({
            where,
            data: { computedAt: new Date(), payload: forecast },
        });
        if (updated?.count === 1)
            continue;
        try {
            await tx.cashflowForecastSnapshot.create({
                data: {
                    companyId,
                    scenario,
                    asOfDate,
                    computedAt: new Date(),
                    payload: forecast,
                },
            });
        }
        catch (e) {
            // Race-safe: if created by another worker concurrently, just update it.
            await tx.cashflowForecastSnapshot.updateMany({
                where,
                data: { computedAt: new Date(), payload: forecast },
            });
        }
    }
}
//# sourceMappingURL=refresh.service.js.map