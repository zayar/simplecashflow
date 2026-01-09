import { Prisma } from '@prisma/client';
import { normalizeToDay } from '../../utils/date.js';
function isoDay(d) {
    return normalizeToDay(d).toISOString().slice(0, 10);
}
function addDays(d, days) {
    const x = new Date(d);
    x.setDate(x.getDate() + days);
    return x;
}
function addWeeks(d, weeks) {
    return addDays(d, weeks * 7);
}
function startOfWeekBucket(asOf, eventDate) {
    const a = normalizeToDay(asOf).getTime();
    const e = normalizeToDay(eventDate).getTime();
    const diffDays = Math.floor((e - a) / (24 * 3600 * 1000));
    if (diffDays < 0)
        return -1;
    return Math.floor(diffDays / 7);
}
function d(n) {
    if (n instanceof Prisma.Decimal)
        return n;
    return new Prisma.Decimal(n);
}
function money(v) {
    return new Prisma.Decimal(v).toDecimalPlaces(2);
}
function applyScenarioDelay(baseDays, scenario, kind) {
    const b = Math.max(0, Math.floor(Number(baseDays || 0)));
    if (scenario === 'base')
        return b;
    // Conservative: assume slower collections and earlier payments.
    if (scenario === 'conservative')
        return kind === 'ar' ? b + 7 : Math.max(0, b - 3);
    // Optimistic: assume faster collections and later payments.
    return kind === 'ar' ? Math.max(0, b - 5) : b + 3;
}
function* recurringOccurrences(args) {
    const start = normalizeToDay(args.startDate);
    const end = args.endDate ? normalizeToDay(args.endDate) : null;
    const horizonEnd = normalizeToDay(args.horizonEnd);
    const interval = Math.max(1, Math.floor(args.interval || 1));
    // First occurrence: startDate itself.
    let cur = new Date(start);
    while (cur <= horizonEnd) {
        if (!end || cur <= end)
            yield new Date(cur);
        if (args.frequency === 'WEEKLY') {
            cur = addWeeks(cur, interval);
        }
        else {
            // Monthly: keep same day-of-month as best effort.
            const y = cur.getUTCFullYear();
            const m = cur.getUTCMonth();
            const day = cur.getUTCDate();
            const next = new Date(Date.UTC(y, m + interval, 1));
            // Clamp day to last day of the target month.
            const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
            next.setUTCDate(Math.min(day, lastDay));
            next.setUTCHours(0, 0, 0, 0);
            cur = next;
        }
    }
}
export async function computeCashflowForecast(tx, companyId, options = {}) {
    const asOfDate = normalizeToDay(options.asOfDate ?? new Date());
    const weeks = Math.min(26, Math.max(4, Math.floor(options.weeks ?? 13)));
    const scenario = options.scenario ?? 'base';
    const warnings = [];
    const company = await tx.company.findUnique({
        where: { id: companyId },
        select: { id: true, baseCurrency: true },
    });
    const baseCurrency = (company?.baseCurrency ?? '').trim().toUpperCase() || null;
    const settings = await tx.cashflowSettings.findUnique({
        where: { companyId },
        select: { defaultArDelayDays: true, defaultApDelayDays: true, minCashBuffer: true },
    });
    const defaultArDelayDays = settings?.defaultArDelayDays ?? 7;
    const defaultApDelayDays = settings?.defaultApDelayDays ?? 0;
    const minCashBuffer = money(d(settings?.minCashBuffer ?? 0));
    // --- Starting cash: sum balances of banking accounts (cash/bank/e-wallet). ---
    const banking = await tx.bankingAccount.findMany({
        where: { companyId, kind: { in: ['CASH', 'BANK', 'E_WALLET'] } },
        select: { id: true, kind: true, currency: true, accountId: true },
    });
    if (banking.length === 0) {
        warnings.push('No banking accounts found. Cash forecast will start at 0.');
    }
    const currencies = Array.from(new Set(banking
        .map((b) => (b?.currency ?? null ? String(b.currency).trim().toUpperCase() : null))
        .filter((c) => c)));
    const currency = baseCurrency ?? (currencies.length === 1 ? currencies[0] : null);
    if (currencies.length > 1) {
        warnings.push('Multiple banking currencies found. Forecast assumes a single currency (baseCurrency).');
    }
    if (!currency) {
        warnings.push('No base currency set. Forecast amounts are shown without currency normalization.');
    }
    const accountIds = banking.map((b) => Number(b.accountId)).filter((x) => Number.isFinite(x));
    let startingCash = d(0);
    if (accountIds.length) {
        const grouped = await tx.journalLine.groupBy({
            by: ['accountId'],
            where: { companyId, accountId: { in: accountIds } },
            _sum: { debit: true, credit: true },
        });
        const byAccount = new Map();
        for (const g of grouped) {
            byAccount.set(Number(g.accountId), {
                debit: Number(g._sum?.debit ?? 0),
                credit: Number(g._sum?.credit ?? 0),
            });
        }
        for (const accId of accountIds) {
            const sums = byAccount.get(accId) ?? { debit: 0, credit: 0 };
            startingCash = startingCash.add(d(sums.debit).sub(d(sums.credit)));
        }
    }
    startingCash = money(startingCash);
    // --- Build weekly buckets ---
    const series = [];
    const inflowByWeek = Array.from({ length: weeks }, () => d(0));
    const outflowByWeek = Array.from({ length: weeks }, () => d(0));
    const inflowDrivers = [];
    const outflowDrivers = [];
    const horizonEnd = addWeeks(asOfDate, weeks);
    // --- AR: open invoices ---
    const arDelay = applyScenarioDelay(defaultArDelayDays, scenario, 'ar');
    const invoices = await tx.invoice.findMany({
        where: {
            companyId,
            status: { in: ['APPROVED', 'POSTED', 'PARTIAL'] },
        },
        select: {
            id: true,
            invoiceNumber: true,
            invoiceDate: true,
            dueDate: true,
            total: true,
            amountPaid: true,
            customer: { select: { name: true } },
        },
        orderBy: [{ dueDate: 'asc' }, { invoiceDate: 'asc' }],
    });
    for (const inv of invoices) {
        const total = d(inv.total ?? 0);
        const paid = d(inv.amountPaid ?? 0);
        const remaining = money(total.sub(paid));
        if (!remaining.greaterThan(0))
            continue;
        const due = inv.dueDate ? new Date(inv.dueDate) : new Date(inv.invoiceDate);
        const expected = addDays(due, arDelay);
        const idx = startOfWeekBucket(asOfDate, expected);
        if (idx < 0 || idx >= weeks)
            continue;
        inflowByWeek[idx] = (inflowByWeek[idx] ?? d(0)).add(remaining);
        inflowDrivers.push({
            kind: 'invoice',
            id: inv.id,
            label: `${inv.invoiceNumber} • ${String(inv.customer?.name ?? '').trim() || 'Customer'}`,
            expectedDate: isoDay(expected),
            amount: remaining.toString(),
        });
    }
    // --- AP: open purchase bills ---
    const apDelay = applyScenarioDelay(defaultApDelayDays, scenario, 'ap');
    const bills = await tx.purchaseBill.findMany({
        where: {
            companyId,
            status: { in: ['APPROVED', 'POSTED', 'PARTIAL'] },
        },
        select: {
            id: true,
            billNumber: true,
            billDate: true,
            dueDate: true,
            total: true,
            amountPaid: true,
            vendor: { select: { name: true } },
        },
        orderBy: [{ dueDate: 'asc' }, { billDate: 'asc' }],
    });
    for (const b of bills) {
        const total = d(b.total ?? 0);
        const paid = d(b.amountPaid ?? 0);
        const remaining = money(total.sub(paid));
        if (!remaining.greaterThan(0))
            continue;
        const due = b.dueDate ? new Date(b.dueDate) : new Date(b.billDate);
        const expected = addDays(due, apDelay);
        const idx = startOfWeekBucket(asOfDate, expected);
        if (idx < 0 || idx >= weeks)
            continue;
        outflowByWeek[idx] = (outflowByWeek[idx] ?? d(0)).add(remaining);
        outflowDrivers.push({
            kind: 'purchase_bill',
            id: b.id,
            label: `${b.billNumber} • ${String(b.vendor?.name ?? '').trim() || 'Vendor'}`,
            expectedDate: isoDay(expected),
            amount: remaining.toString(),
        });
    }
    // --- AP: unpaid expenses (optional credit expenses) ---
    const expenses = await tx.expense.findMany({
        where: {
            companyId,
            status: { in: ['APPROVED', 'POSTED', 'PARTIAL'] },
        },
        select: {
            id: true,
            expenseNumber: true,
            expenseDate: true,
            dueDate: true,
            amount: true,
            amountPaid: true,
            vendor: { select: { name: true } },
        },
        orderBy: [{ dueDate: 'asc' }, { expenseDate: 'asc' }],
    });
    for (const e of expenses) {
        const total = d(e.amount ?? 0);
        const paid = d(e.amountPaid ?? 0);
        const remaining = money(total.sub(paid));
        if (!remaining.greaterThan(0))
            continue;
        const due = e.dueDate ? new Date(e.dueDate) : new Date(e.expenseDate);
        const expected = addDays(due, apDelay);
        const idx = startOfWeekBucket(asOfDate, expected);
        if (idx < 0 || idx >= weeks)
            continue;
        outflowByWeek[idx] = (outflowByWeek[idx] ?? d(0)).add(remaining);
        outflowDrivers.push({
            kind: 'expense',
            id: e.id,
            label: `${e.expenseNumber} • ${String(e.vendor?.name ?? '').trim() || 'Expense'}`,
            expectedDate: isoDay(expected),
            amount: remaining.toString(),
        });
    }
    // --- Recurring items ---
    const recurring = await tx.cashflowRecurringItem.findMany({
        where: { companyId, isActive: true },
        select: {
            id: true,
            direction: true,
            name: true,
            amount: true,
            currency: true,
            startDate: true,
            endDate: true,
            frequency: true,
            interval: true,
        },
        orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
    });
    if (recurring.length === 0) {
        warnings.push('No recurring items configured (payroll/rent/loan/tax). Forecast may be incomplete.');
    }
    for (const r of recurring) {
        const amt = money(d(r.amount ?? 0));
        if (!amt.greaterThan(0))
            continue;
        // Currency handling: for MVP, only include matching currency if company has baseCurrency.
        const cur = r.currency ? String(r.currency).trim().toUpperCase() : null;
        if (currency && cur && cur !== currency)
            continue;
        const occurrences = recurringOccurrences({
            startDate: new Date(r.startDate),
            endDate: r.endDate ? new Date(r.endDate) : null,
            frequency: r.frequency,
            interval: r.interval,
            horizonEnd,
        });
        for (const occ of occurrences) {
            const idx = startOfWeekBucket(asOfDate, occ);
            if (idx < 0 || idx >= weeks)
                continue;
            if (r.direction === 'INFLOW') {
                inflowByWeek[idx] = (inflowByWeek[idx] ?? d(0)).add(amt);
            }
            else {
                outflowByWeek[idx] = (outflowByWeek[idx] ?? d(0)).add(amt);
            }
            const driver = {
                kind: 'recurring',
                id: r.id,
                label: r.name,
                expectedDate: isoDay(occ),
                amount: amt.toString(),
            };
            if (r.direction === 'INFLOW')
                inflowDrivers.push(driver);
            else
                outflowDrivers.push(driver);
        }
    }
    // --- Compose series and alerts ---
    let running = startingCash;
    let lowest = null;
    const alerts = [];
    for (let i = 0; i < weeks; i++) {
        const weekStart = isoDay(addWeeks(asOfDate, i));
        const cashIn = money(inflowByWeek[i] ?? d(0));
        const cashOut = money(outflowByWeek[i] ?? d(0));
        const net = money(cashIn.sub(cashOut));
        running = money(running.add(net));
        if (!lowest || d(running).lessThan(d(lowest.endingCash))) {
            lowest = { weekStart, endingCash: running.toString() };
        }
        series.push({
            weekStart,
            cashIn: cashIn.toString(),
            cashOut: cashOut.toString(),
            net: net.toString(),
            endingCash: running.toString(),
        });
        if (running.lessThan(0)) {
            alerts.push({
                severity: 'high',
                code: 'CASH_NEGATIVE',
                message: `Cash is forecast to go negative by week starting ${weekStart}.`,
                weekStart,
            });
            // Only need the first negative warning to avoid spam.
            break;
        }
    }
    // Buffer breach warnings (if never negative)
    if (alerts.length === 0 && minCashBuffer.greaterThan(0)) {
        const breach = series.find((w) => d(w.endingCash).lessThan(minCashBuffer));
        if (breach) {
            alerts.push({
                severity: 'medium',
                code: 'BUFFER_BREACH',
                message: `Cash is forecast to fall below your buffer (${minCashBuffer.toString()}) by week starting ${breach.weekStart}.`,
                weekStart: breach.weekStart,
            });
        }
    }
    // Top drivers
    const topInflows = [...inflowDrivers]
        .sort((a, b) => d(b.amount).cmp(d(a.amount)))
        .slice(0, 8);
    const topOutflows = [...outflowDrivers]
        .sort((a, b) => d(b.amount).cmp(d(a.amount)))
        .slice(0, 8);
    return {
        asOfDate: isoDay(asOfDate),
        weeks,
        scenario,
        currency,
        warnings,
        startingCash: startingCash.toString(),
        minCashBuffer: minCashBuffer.toString(),
        lowestCash: lowest,
        series,
        topInflows,
        topOutflows,
        alerts,
    };
}
//# sourceMappingURL=cashflow.service.js.map