import { prisma } from '../../infrastructure/db.js';
import { requireCompanyIdParam } from '../../utils/tenant.js';
import { Prisma } from '@prisma/client';
function daysBetween(a, b) {
    const ms = a.getTime() - b.getTime();
    return Math.floor(ms / (1000 * 60 * 60 * 24));
}
function bucketForDaysPastDue(d) {
    if (d <= 0)
        return 'CURRENT';
    if (d <= 30)
        return 'DUE_1_30';
    if (d <= 60)
        return 'DUE_31_60';
    if (d <= 90)
        return 'DUE_61_90';
    return 'DUE_90_PLUS';
}
export async function apAgingRoutes(fastify) {
    fastify.addHook('preHandler', fastify.authenticate);
    fastify.get('/companies/:companyId/reports/ap-aging', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const asOfStr = request.query?.asOf;
        const asOf = asOfStr ? new Date(asOfStr) : new Date();
        if (asOfStr && isNaN(asOf.getTime())) {
            reply.status(400);
            return { error: 'invalid asOf' };
        }
        // Expenses (Bills)
        const bills = await prisma.expense.findMany({
            where: { companyId, status: { in: ['POSTED', 'PARTIAL'] } },
            include: { vendor: true },
        });
        // Purchase Bills
        const purchaseBills = await prisma.purchaseBill.findMany({
            where: { companyId, status: { in: ['POSTED', 'PARTIAL'] } },
            include: { vendor: true },
        });
        const byVendor = new Map(); // key `${vendorId ?? 'null'}`
        const ensure = (vendorId, vendorName) => {
            const key = `${vendorId ?? 'null'}`;
            if (!byVendor.has(key)) {
                byVendor.set(key, {
                    vendorId,
                    vendorName,
                    current: new Prisma.Decimal(0),
                    due_1_30: new Prisma.Decimal(0),
                    due_31_60: new Prisma.Decimal(0),
                    due_61_90: new Prisma.Decimal(0),
                    due_90_plus: new Prisma.Decimal(0),
                    total: new Prisma.Decimal(0),
                });
            }
            return byVendor.get(key);
        };
        const apply = (vendorId, vendorName, dueDate, amount) => {
            const d = dueDate ?? asOf;
            const daysPastDue = daysBetween(asOf, d);
            const bucket = bucketForDaysPastDue(daysPastDue);
            const row = ensure(vendorId, vendorName);
            if (bucket === 'CURRENT')
                row.current = row.current.add(amount);
            else if (bucket === 'DUE_1_30')
                row.due_1_30 = row.due_1_30.add(amount);
            else if (bucket === 'DUE_31_60')
                row.due_31_60 = row.due_31_60.add(amount);
            else if (bucket === 'DUE_61_90')
                row.due_61_90 = row.due_61_90.add(amount);
            else
                row.due_90_plus = row.due_90_plus.add(amount);
            row.total = row.total.add(amount);
        };
        for (const b of bills) {
            const outstanding = new Prisma.Decimal(b.amount).minus(new Prisma.Decimal(b.amountPaid ?? 0)).toDecimalPlaces(2);
            if (outstanding.lessThanOrEqualTo(0))
                continue;
            apply(b.vendorId ?? null, b.vendor?.name ?? 'No Vendor', b.dueDate ?? null, outstanding);
        }
        for (const pb of purchaseBills) {
            const outstanding = new Prisma.Decimal(pb.total).minus(new Prisma.Decimal(pb.amountPaid ?? 0)).toDecimalPlaces(2);
            if (outstanding.lessThanOrEqualTo(0))
                continue;
            apply(pb.vendorId ?? null, pb.vendor?.name ?? 'No Vendor', pb.dueDate ?? null, outstanding);
        }
        const rows = Array.from(byVendor.values())
            .map((r) => ({
            vendorId: r.vendorId,
            vendorName: r.vendorName,
            current: r.current.toDecimalPlaces(2).toString(),
            due_1_30: r.due_1_30.toDecimalPlaces(2).toString(),
            due_31_60: r.due_31_60.toDecimalPlaces(2).toString(),
            due_61_90: r.due_61_90.toDecimalPlaces(2).toString(),
            due_90_plus: r.due_90_plus.toDecimalPlaces(2).toString(),
            total: r.total.toDecimalPlaces(2).toString(),
        }))
            .sort((a, b) => (a.vendorName || '').localeCompare(b.vendorName || ''));
        const totals = rows.reduce((acc, r) => {
            acc.current = acc.current.add(new Prisma.Decimal(r.current));
            acc.due_1_30 = acc.due_1_30.add(new Prisma.Decimal(r.due_1_30));
            acc.due_31_60 = acc.due_31_60.add(new Prisma.Decimal(r.due_31_60));
            acc.due_61_90 = acc.due_61_90.add(new Prisma.Decimal(r.due_61_90));
            acc.due_90_plus = acc.due_90_plus.add(new Prisma.Decimal(r.due_90_plus));
            acc.total = acc.total.add(new Prisma.Decimal(r.total));
            return acc;
        }, {
            current: new Prisma.Decimal(0),
            due_1_30: new Prisma.Decimal(0),
            due_31_60: new Prisma.Decimal(0),
            due_61_90: new Prisma.Decimal(0),
            due_90_plus: new Prisma.Decimal(0),
            total: new Prisma.Decimal(0),
        });
        return {
            companyId,
            asOf: asOf.toISOString(),
            totals: {
                current: totals.current.toDecimalPlaces(2).toString(),
                due_1_30: totals.due_1_30.toDecimalPlaces(2).toString(),
                due_31_60: totals.due_31_60.toDecimalPlaces(2).toString(),
                due_61_90: totals.due_61_90.toDecimalPlaces(2).toString(),
                due_90_plus: totals.due_90_plus.toDecimalPlaces(2).toString(),
                total: totals.total.toDecimalPlaces(2).toString(),
            },
            rows,
        };
    });
}
//# sourceMappingURL=apAging.routes.js.map