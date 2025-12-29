import { prisma } from '../../infrastructure/db.js';
import { Prisma } from '@prisma/client';
import { requireCompanyIdParam } from '../../utils/tenant.js';
import { normalizeToDay } from '../../utils/date.js';
function addDays(d, days) {
    const x = new Date(d);
    x.setDate(x.getDate() + days);
    x.setHours(0, 0, 0, 0);
    return x;
}
function startOfMonth(d) {
    const x = new Date(d);
    x.setDate(1);
    x.setHours(0, 0, 0, 0);
    return x;
}
function endOfMonth(d) {
    const x = new Date(d);
    x.setMonth(x.getMonth() + 1, 0);
    x.setHours(0, 0, 0, 0);
    return x;
}
function fmtYmd(d) {
    return d.toISOString().slice(0, 10);
}
export async function dashboardRoutes(fastify) {
    fastify.addHook('preHandler', fastify.authenticate);
    // GET /companies/:companyId/dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD
    fastify.get('/companies/:companyId/dashboard', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const query = request.query;
        if (!query.from || !query.to) {
            reply.status(400);
            return { error: 'from and to are required (YYYY-MM-DD)' };
        }
        const fromDate = normalizeToDay(new Date(query.from));
        const toDate = normalizeToDay(new Date(query.to));
        if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
            reply.status(400);
            return { error: 'invalid from/to dates' };
        }
        if (fromDate.getTime() > toDate.getTime()) {
            reply.status(400);
            return { error: 'from must be <= to' };
        }
        const company = await prisma.company.findUnique({
            where: { id: companyId },
            select: {
                id: true,
                name: true,
                baseCurrency: true,
                timeZone: true,
                accountsReceivableAccountId: true,
                accountsPayableAccountId: true,
            },
        });
        if (!company) {
            reply.status(404);
            return { error: 'company not found' };
        }
        // --- AR / AP balances (GL-based, as-of toDate) ---
        const arId = company.accountsReceivableAccountId ?? null;
        const apId = company.accountsPayableAccountId ?? null;
        const arApAccounts = await prisma.account.findMany({
            where: { companyId, id: { in: [arId ?? -1, apId ?? -1] } },
            select: { id: true, normalBalance: true },
        });
        const accById = new Map(arApAccounts.map((a) => [a.id, a]));
        async function accountBalanceAsOf(accountId) {
            if (!accountId)
                return new Prisma.Decimal(0);
            const sums = await prisma.accountBalance.aggregate({
                where: { companyId, accountId, date: { lte: toDate } },
                _sum: { debitTotal: true, creditTotal: true },
            });
            const debit = new Prisma.Decimal(sums._sum.debitTotal ?? 0);
            const credit = new Prisma.Decimal(sums._sum.creditTotal ?? 0);
            const normal = accById.get(accountId)?.normalBalance ?? 'DEBIT';
            // Normal-balance-aware balance
            return (normal === 'DEBIT' ? debit.sub(credit) : credit.sub(debit)).toDecimalPlaces(2);
        }
        const [arBalance, apBalance] = await Promise.all([accountBalanceAsOf(arId), accountBalanceAsOf(apId)]);
        // --- Cashflow chart (simple net movement of cash accounts) ---
        // Prefer reportGroup CASH_AND_CASH_EQUIVALENTS; fallback to BankingAccount-linked accounts.
        const cashAccounts = await prisma.account.findMany({
            where: { companyId, type: 'ASSET', reportGroup: 'CASH_AND_CASH_EQUIVALENTS' },
            select: { id: true },
        });
        let cashAccountIds = cashAccounts.map((a) => a.id);
        if (cashAccountIds.length === 0) {
            const banking = await prisma.bankingAccount.findMany({
                where: { companyId },
                select: { accountId: true },
            });
            cashAccountIds = Array.from(new Set(banking.map((b) => b.accountId)));
        }
        const cashByDay = cashAccountIds.length
            ? await prisma.accountBalance.groupBy({
                by: ['date'],
                where: { companyId, accountId: { in: cashAccountIds }, date: { gte: fromDate, lte: toDate } },
                _sum: { debitTotal: true, creditTotal: true },
                orderBy: { date: 'asc' },
            })
            : [];
        const cashSeries = cashByDay.map((d) => {
            // cash accounts are ASSET/DEBIT-normal:
            // - inflow  = debit movement
            // - outflow = credit movement
            // - net     = inflow - outflow
            const inflow = new Prisma.Decimal(d._sum.debitTotal ?? 0).toDecimalPlaces(2);
            const outflow = new Prisma.Decimal(d._sum.creditTotal ?? 0).toDecimalPlaces(2);
            const net = inflow.sub(outflow).toDecimalPlaces(2);
            return { date: fmtYmd(d.date), inflow: inflow.toString(), outflow: outflow.toString(), net: net.toString() };
        });
        async function movementForAccounts(accountIds, from, to, normalBalance) {
            if (accountIds.length === 0)
                return new Prisma.Decimal(0);
            const sums = await prisma.accountBalance.aggregate({
                where: { companyId, accountId: { in: accountIds }, date: { gte: from, lte: to } },
                _sum: { debitTotal: true, creditTotal: true },
            });
            const debit = new Prisma.Decimal(sums._sum.debitTotal ?? 0);
            const credit = new Prisma.Decimal(sums._sum.creditTotal ?? 0);
            return (normalBalance === 'DEBIT' ? debit.sub(credit) : credit.sub(debit)).toDecimalPlaces(2);
        }
        async function balanceAsOfForAccounts(accountIds, asOf, normalBalance) {
            if (accountIds.length === 0)
                return new Prisma.Decimal(0);
            const sums = await prisma.accountBalance.aggregate({
                where: { companyId, accountId: { in: accountIds }, date: { lte: asOf } },
                _sum: { debitTotal: true, creditTotal: true },
            });
            const debit = new Prisma.Decimal(sums._sum.debitTotal ?? 0);
            const credit = new Prisma.Decimal(sums._sum.creditTotal ?? 0);
            return (normalBalance === 'DEBIT' ? debit.sub(credit) : credit.sub(debit)).toDecimalPlaces(2);
        }
        // --- KPI: Income / Expense / Net Profit (accrual, period movement) ---
        const [incomeAccIds, expenseAccIds] = await Promise.all([
            prisma.account.findMany({ where: { companyId, type: 'INCOME' }, select: { id: true } }),
            prisma.account.findMany({ where: { companyId, type: 'EXPENSE' }, select: { id: true } }),
        ]);
        const incomeIds = incomeAccIds.map((a) => a.id);
        const expenseIds = expenseAccIds.map((a) => a.id);
        const [incomeTotal, expenseTotal] = await Promise.all([
            movementForAccounts(incomeIds, fromDate, toDate, 'CREDIT'),
            movementForAccounts(expenseIds, fromDate, toDate, 'DEBIT'),
        ]);
        const netProfit = incomeTotal.sub(expenseTotal).toDecimalPlaces(2);
        // --- KPI: Cash balance as-of toDate ---
        const cashBalance = await balanceAsOfForAccounts(cashAccountIds, toDate, 'DEBIT');
        // Bucket into 7-day chunks like "1-7", "8-14", ...
        const buckets = [];
        let cursor = new Date(fromDate);
        cursor.setHours(0, 0, 0, 0);
        const byDate = new Map(cashSeries.map((p) => [p.date, p]));
        while (cursor.getTime() <= toDate.getTime()) {
            const bFrom = new Date(cursor);
            const bTo = addDays(bFrom, 6);
            const end = bTo.getTime() > toDate.getTime() ? new Date(toDate) : bTo;
            let inflowSum = new Prisma.Decimal(0);
            let outflowSum = new Prisma.Decimal(0);
            let netSum = new Prisma.Decimal(0);
            for (let d = new Date(bFrom); d.getTime() <= end.getTime(); d = addDays(d, 1)) {
                const row = byDate.get(fmtYmd(d));
                if (!row)
                    continue;
                inflowSum = inflowSum.add(new Prisma.Decimal(row.inflow));
                outflowSum = outflowSum.add(new Prisma.Decimal(row.outflow));
                netSum = netSum.add(new Prisma.Decimal(row.net));
            }
            const label = `${bFrom.getDate()} - ${end.getDate()}`;
            buckets.push({
                label,
                from: fmtYmd(bFrom),
                to: fmtYmd(end),
                inflow: inflowSum.toDecimalPlaces(2).toString(),
                outflow: outflowSum.toDecimalPlaces(2).toString(),
                net: netSum.toDecimalPlaces(2).toString(),
            });
            cursor = addDays(end, 1);
        }
        // --- COA movements for the month (top 6 by absolute movement) ---
        const movementAgg = await prisma.accountBalance.groupBy({
            by: ['accountId'],
            where: { companyId, date: { gte: fromDate, lte: toDate } },
            _sum: { debitTotal: true, creditTotal: true },
        });
        const movementAccountIds = movementAgg.map((m) => m.accountId);
        const movementAccounts = await prisma.account.findMany({
            where: { companyId, id: { in: movementAccountIds } },
            select: { id: true, code: true, name: true, normalBalance: true },
        });
        const movementAccById = new Map(movementAccounts.map((a) => [a.id, a]));
        const movements = movementAgg
            .map((m) => {
            const acc = movementAccById.get(m.accountId);
            if (!acc)
                return null;
            const debit = new Prisma.Decimal(m._sum.debitTotal ?? 0);
            const credit = new Prisma.Decimal(m._sum.creditTotal ?? 0);
            const net = acc.normalBalance === 'DEBIT' ? debit.sub(credit) : credit.sub(debit);
            return {
                accountId: acc.id,
                code: acc.code,
                name: acc.name,
                movement: net.toDecimalPlaces(2).toString(),
                abs: net.abs(),
            };
        })
            .filter(Boolean);
        movements.sort((a, b) => b.abs.comparedTo(a.abs));
        // --- Trend: Income vs Expense (last 12 months ending at toDate) ---
        const trendMonths = [];
        const anchor = startOfMonth(toDate);
        for (let i = 11; i >= 0; i--) {
            const m = new Date(anchor);
            m.setMonth(m.getMonth() - i);
            const mFrom = startOfMonth(m);
            const mTo = endOfMonth(m);
            const [inc, exp] = await Promise.all([
                movementForAccounts(incomeIds, mFrom, mTo, 'CREDIT'),
                movementForAccounts(expenseIds, mFrom, mTo, 'DEBIT'),
            ]);
            const label = mFrom.toLocaleString('en-US', { month: 'short' });
            trendMonths.push({ label, from: fmtYmd(mFrom), to: fmtYmd(mTo), income: inc.toString(), expense: exp.toString() });
        }
        // --- Expense breakdown (top 5 expense accounts in period) ---
        const expenseAgg = expenseIds.length
            ? await prisma.accountBalance.groupBy({
                by: ['accountId'],
                where: { companyId, accountId: { in: expenseIds }, date: { gte: fromDate, lte: toDate } },
                _sum: { debitTotal: true, creditTotal: true },
            })
            : [];
        const expenseAggIds = expenseAgg.map((e) => e.accountId);
        const expenseAccounts = expenseAggIds.length
            ? await prisma.account.findMany({
                where: { companyId, id: { in: expenseAggIds } },
                select: { id: true, code: true, name: true },
            })
            : [];
        const expAccById = new Map(expenseAccounts.map((a) => [a.id, a]));
        const expRows = expenseAgg
            .map((e) => {
            const acc = expAccById.get(e.accountId);
            if (!acc)
                return null;
            const debit = new Prisma.Decimal(e._sum.debitTotal ?? 0);
            const credit = new Prisma.Decimal(e._sum.creditTotal ?? 0);
            const amount = debit.sub(credit).toDecimalPlaces(2); // EXPENSE normal debit
            return { accountId: acc.id, code: acc.code, name: acc.name, amount };
        })
            .filter(Boolean);
        expRows.sort((a, b) => b.amount.comparedTo(a.amount));
        const top = expRows.slice(0, 5);
        const others = expRows.slice(5);
        const othersAmount = others.reduce((sum, r) => sum.add(r.amount), new Prisma.Decimal(0)).toDecimalPlaces(2);
        return {
            companyId,
            from: fmtYmd(fromDate),
            to: fmtYmd(toDate),
            company: {
                name: company.name,
                baseCurrency: company.baseCurrency ?? null,
                timeZone: company.timeZone ?? null,
            },
            kpis: {
                receivable: arBalance.toString(),
                payable: apBalance.toString(),
                income: incomeTotal.toString(),
                expense: expenseTotal.toString(),
                netProfit: netProfit.toString(),
                cashBalance: cashBalance.toString(),
            },
            cashflow: {
                series: cashSeries,
                buckets,
            },
            trend: {
                incomeVsExpense: trendMonths,
            },
            expenses: {
                top: top.map((r) => ({ accountId: r.accountId, code: r.code, name: r.name, amount: r.amount.toString() })),
                othersAmount: othersAmount.toString(),
            },
            coa: {
                topMovements: movements.slice(0, 6).map((m) => ({
                    accountId: m.accountId,
                    code: m.code,
                    name: m.name,
                    movement: m.movement,
                })),
            },
        };
    });
}
//# sourceMappingURL=dashboard.routes.js.map