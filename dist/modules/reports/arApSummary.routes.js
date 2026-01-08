import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/db.js';
import { requireCompanyIdParam } from '../../utils/tenant.js';
import { normalizeToDay } from '../../utils/date.js';
function d2(x) {
    const v = x === null || x === undefined ? new Prisma.Decimal(0) : x instanceof Prisma.Decimal ? x : new Prisma.Decimal(x);
    return v.toDecimalPlaces(2);
}
function parseRangeOrThrow(reply, query) {
    const fromStr = String(query?.from ?? '').trim();
    const toStr = String(query?.to ?? '').trim();
    if (!fromStr || !toStr) {
        reply.status(400);
        reply.send({ error: 'from and to are required (YYYY-MM-DD)' });
        return null;
    }
    const fromDate = normalizeToDay(new Date(fromStr));
    const toDate = normalizeToDay(new Date(toStr));
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
        reply.status(400);
        reply.send({ error: 'invalid from/to dates' });
        return null;
    }
    if (fromDate.getTime() > toDate.getTime()) {
        reply.status(400);
        reply.send({ error: 'from must be <= to' });
        return null;
    }
    return { fromDate, toDate };
}
function asMoneyString(x) {
    return d2(x).toString();
}
export async function arApSummaryRoutes(fastify) {
    fastify.addHook('preHandler', fastify.authenticate);
    // --- Vendor Balance Summary ---
    // GET /companies/:companyId/reports/vendor-balance-summary?from=YYYY-MM-DD&to=YYYY-MM-DD
    fastify.get('/companies/:companyId/reports/vendor-balance-summary', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const range = parseRangeOrThrow(reply, request.query);
        if (!range)
            return;
        const { fromDate, toDate } = range;
        const vendors = (await prisma.vendor.findMany({
            where: { companyId },
            select: { id: true, name: true, openingBalance: true },
            orderBy: { name: 'asc' },
        }));
        // Bills (PurchaseBill + Expense)
        const pbBilledInRange = (await prisma.purchaseBill.groupBy({
            by: ['vendorId'],
            where: { companyId, status: { in: ['POSTED', 'PARTIAL', 'PAID'] }, billDate: { gte: fromDate, lte: toDate } },
            _sum: { total: true },
        }));
        const expBilledInRange = (await prisma.expense.groupBy({
            by: ['vendorId'],
            where: { companyId, status: { in: ['POSTED', 'PARTIAL', 'PAID'] }, expenseDate: { gte: fromDate, lte: toDate } },
            _sum: { amount: true },
        }));
        const pbBilledToDate = (await prisma.purchaseBill.groupBy({
            by: ['vendorId'],
            where: { companyId, status: { in: ['POSTED', 'PARTIAL', 'PAID'] }, billDate: { lte: toDate } },
            _sum: { total: true },
        }));
        const expBilledToDate = (await prisma.expense.groupBy({
            by: ['vendorId'],
            where: { companyId, status: { in: ['POSTED', 'PARTIAL', 'PAID'] }, expenseDate: { lte: toDate } },
            _sum: { amount: true },
        }));
        // Payments in range / toDate (source-of-truth, exclude reversals)
        const pbPaidInRange = (await prisma.$queryRaw `
      SELECT pb.vendorId as vendorId, SUM(pbp.amount) as amount
      FROM PurchaseBillPayment pbp
      JOIN PurchaseBill pb ON pb.id = pbp.purchaseBillId
      WHERE pbp.companyId = ${companyId}
        AND pb.companyId = ${companyId}
        AND pbp.reversedAt IS NULL
        AND pbp.paymentDate >= ${fromDate}
        AND pbp.paymentDate <= ${toDate}
      GROUP BY pb.vendorId
    `);
        const pbPaidToDate = (await prisma.$queryRaw `
      SELECT pb.vendorId as vendorId, SUM(pbp.amount) as amount
      FROM PurchaseBillPayment pbp
      JOIN PurchaseBill pb ON pb.id = pbp.purchaseBillId
      WHERE pbp.companyId = ${companyId}
        AND pb.companyId = ${companyId}
        AND pbp.reversedAt IS NULL
        AND pbp.paymentDate <= ${toDate}
      GROUP BY pb.vendorId
    `);
        const expPaidInRange = (await prisma.$queryRaw `
      SELECT e.vendorId as vendorId, SUM(ep.amount) as amount
      FROM ExpensePayment ep
      JOIN Expense e ON e.id = ep.expenseId
      WHERE ep.companyId = ${companyId}
        AND e.companyId = ${companyId}
        AND ep.reversedAt IS NULL
        AND ep.paymentDate >= ${fromDate}
        AND ep.paymentDate <= ${toDate}
      GROUP BY e.vendorId
    `);
        const expPaidToDate = (await prisma.$queryRaw `
      SELECT e.vendorId as vendorId, SUM(ep.amount) as amount
      FROM ExpensePayment ep
      JOIN Expense e ON e.id = ep.expenseId
      WHERE ep.companyId = ${companyId}
        AND e.companyId = ${companyId}
        AND ep.reversedAt IS NULL
        AND ep.paymentDate <= ${toDate}
      GROUP BY e.vendorId
    `);
        // Vendor credits reduce payables when they are POSTED (GL impact). Application is a sub-ledger link and
        // should not be double-counted here. We treat POSTED vendor credits as non-cash settlement ("Credit").
        const vcPostedInRange = (await prisma.vendorCredit.groupBy({
            by: ['vendorId'],
            where: { companyId, status: 'POSTED', creditDate: { gte: fromDate, lte: toDate } },
            _sum: { total: true },
        }));
        const vcPostedToDate = (await prisma.vendorCredit.groupBy({
            by: ['vendorId'],
            where: { companyId, status: 'POSTED', creditDate: { lte: toDate } },
            _sum: { total: true },
        }));
        // Vendor advances applied to bills reduce payables at application time. Treat as non-cash settlement ("Credit").
        const vaAppliedInRange = (await prisma.$queryRaw `
      SELECT va.vendorId as vendorId, SUM(vaa.amount) as amount
      FROM VendorAdvanceApplication vaa
      JOIN VendorAdvance va ON va.id = vaa.vendorAdvanceId
      WHERE vaa.companyId = ${companyId}
        AND va.companyId = ${companyId}
        AND vaa.appliedDate >= ${fromDate}
        AND vaa.appliedDate <= ${toDate}
      GROUP BY va.vendorId
    `);
        const vaAppliedToDate = (await prisma.$queryRaw `
      SELECT va.vendorId as vendorId, SUM(vaa.amount) as amount
      FROM VendorAdvanceApplication vaa
      JOIN VendorAdvance va ON va.id = vaa.vendorAdvanceId
      WHERE vaa.companyId = ${companyId}
        AND va.companyId = ${companyId}
        AND vaa.appliedDate <= ${toDate}
      GROUP BY va.vendorId
    `);
        const mapSum = (rows, key, val) => {
            const m = new Map();
            for (const r of rows ?? []) {
                const k = String(r[key] ?? 'null');
                const v = d2(r[val]);
                m.set(k, d2((m.get(k) ?? d2(0)).add(v)));
            }
            return m;
        };
        const billedInRangeMap = new Map();
        for (const r of pbBilledInRange) {
            const k = String(r.vendorId ?? 'null');
            billedInRangeMap.set(k, d2((billedInRangeMap.get(k) ?? d2(0)).add(d2(r._sum.total ?? 0))));
        }
        for (const r of expBilledInRange) {
            const k = String(r.vendorId ?? 'null');
            billedInRangeMap.set(k, d2((billedInRangeMap.get(k) ?? d2(0)).add(d2(r._sum.amount ?? 0))));
        }
        const billedToDateMap = new Map();
        for (const r of pbBilledToDate) {
            const k = String(r.vendorId ?? 'null');
            billedToDateMap.set(k, d2((billedToDateMap.get(k) ?? d2(0)).add(d2(r._sum.total ?? 0))));
        }
        for (const r of expBilledToDate) {
            const k = String(r.vendorId ?? 'null');
            billedToDateMap.set(k, d2((billedToDateMap.get(k) ?? d2(0)).add(d2(r._sum.amount ?? 0))));
        }
        const paidInRangeMap = new Map(); // cash payments only
        for (const m of [pbPaidInRange, expPaidInRange]) {
            for (const r of m) {
                const k = String(r.vendorId ?? 'null');
                paidInRangeMap.set(k, d2((paidInRangeMap.get(k) ?? d2(0)).add(d2(r.amount ?? 0))));
            }
        }
        const creditInRangeMap = new Map(); // vendor credits + applied advances (non-cash)
        for (const r of vcPostedInRange) {
            const k = String(r.vendorId ?? 'null');
            creditInRangeMap.set(k, d2((creditInRangeMap.get(k) ?? d2(0)).add(d2(r._sum?.total ?? 0))));
        }
        for (const r of vaAppliedInRange) {
            const k = String(r.vendorId ?? 'null');
            creditInRangeMap.set(k, d2((creditInRangeMap.get(k) ?? d2(0)).add(d2(r.amount ?? 0))));
        }
        const paidToDateMap = new Map(); // cash payments only
        for (const m of [pbPaidToDate, expPaidToDate]) {
            for (const r of m) {
                const k = String(r.vendorId ?? 'null');
                paidToDateMap.set(k, d2((paidToDateMap.get(k) ?? d2(0)).add(d2(r.amount ?? 0))));
            }
        }
        const creditToDateMap = new Map(); // vendor credits + applied advances (non-cash)
        for (const r of vcPostedToDate) {
            const k = String(r.vendorId ?? 'null');
            creditToDateMap.set(k, d2((creditToDateMap.get(k) ?? d2(0)).add(d2(r._sum?.total ?? 0))));
        }
        for (const r of vaAppliedToDate) {
            const k = String(r.vendorId ?? 'null');
            creditToDateMap.set(k, d2((creditToDateMap.get(k) ?? d2(0)).add(d2(r.amount ?? 0))));
        }
        // Detect "No Vendor" rows if any doc exists with vendorId null
        const hasNullVendor = billedInRangeMap.has('null') ||
            billedToDateMap.has('null') ||
            paidInRangeMap.has('null') ||
            paidToDateMap.has('null') ||
            creditInRangeMap.has('null') ||
            creditToDateMap.has('null');
        const vendorRows = [
            ...(hasNullVendor ? [{ id: -1, name: 'No Vendor' }] : []),
            ...vendors,
        ].map((v) => {
            const key = v.id === -1 ? 'null' : String(v.id);
            const opening = v.id === -1 ? d2(0) : d2(v.openingBalance ?? 0);
            const billedAmount = billedInRangeMap.get(key) ?? d2(0);
            const amountPaid = paidInRangeMap.get(key) ?? d2(0);
            const credit = creditInRangeMap.get(key) ?? d2(0);
            const billedToDate = billedToDateMap.get(key) ?? d2(0);
            const paidToDate = paidToDateMap.get(key) ?? d2(0);
            const creditToDate = creditToDateMap.get(key) ?? d2(0);
            const closingBalance = d2(opening.add(billedToDate).sub(d2(paidToDate.add(creditToDate))));
            return {
                vendorId: v.id === -1 ? null : v.id,
                vendorName: v.name,
                openingBalance: asMoneyString(opening),
                billedAmount: asMoneyString(billedAmount),
                amountPaid: asMoneyString(amountPaid),
                credit: asMoneyString(credit),
                closingBalance: asMoneyString(closingBalance),
            };
        });
        const totals = vendorRows.reduce((acc, r) => {
            acc.opening = d2(acc.opening.add(d2(r.openingBalance)));
            acc.billed = d2(acc.billed.add(d2(r.billedAmount)));
            acc.paid = d2(acc.paid.add(d2(r.amountPaid)));
            acc.credit = d2(acc.credit.add(d2(r.credit)));
            acc.closing = d2(acc.closing.add(d2(r.closingBalance)));
            return acc;
        }, { opening: d2(0), billed: d2(0), paid: d2(0), credit: d2(0), closing: d2(0) });
        return {
            companyId,
            from: fromDate.toISOString().slice(0, 10),
            to: toDate.toISOString().slice(0, 10),
            totals: {
                openingBalance: asMoneyString(totals.opening),
                billedAmount: asMoneyString(totals.billed),
                amountPaid: asMoneyString(totals.paid),
                credit: asMoneyString(totals.credit),
                closingBalance: asMoneyString(totals.closing),
            },
            rows: vendorRows,
        };
    });
    // --- Customer Balance Summary ---
    // GET /companies/:companyId/reports/customer-balance-summary?from=YYYY-MM-DD&to=YYYY-MM-DD
    fastify.get('/companies/:companyId/reports/customer-balance-summary', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const range = parseRangeOrThrow(reply, request.query);
        if (!range)
            return;
        const { fromDate, toDate } = range;
        const customers = (await prisma.customer.findMany({
            where: { companyId },
            select: { id: true, name: true, openingBalance: true },
            orderBy: { name: 'asc' },
        }));
        const invoiceStatuses = ['POSTED', 'PARTIAL', 'PAID'];
        const creditStatuses = ['POSTED'];
        const invInRange = (await prisma.invoice.groupBy({
            by: ['customerId'],
            where: { companyId, status: { in: invoiceStatuses }, invoiceDate: { gte: fromDate, lte: toDate } },
            _sum: { total: true },
        }));
        const invToDate = (await prisma.invoice.groupBy({
            by: ['customerId'],
            where: { companyId, status: { in: invoiceStatuses }, invoiceDate: { lte: toDate } },
            _sum: { total: true },
        }));
        // Payments (cash receipts)
        const payInRange = (await prisma.$queryRaw `
      SELECT inv.customerId as customerId, SUM(p.amount) as amount
      FROM Payment p
      JOIN Invoice inv ON inv.id = p.invoiceId
      WHERE p.companyId = ${companyId}
        AND inv.companyId = ${companyId}
        AND p.reversedAt IS NULL
        AND p.paymentDate >= ${fromDate}
        AND p.paymentDate <= ${toDate}
      GROUP BY inv.customerId
    `);
        const payToDate = (await prisma.$queryRaw `
      SELECT inv.customerId as customerId, SUM(p.amount) as amount
      FROM Payment p
      JOIN Invoice inv ON inv.id = p.invoiceId
      WHERE p.companyId = ${companyId}
        AND inv.companyId = ${companyId}
        AND p.reversedAt IS NULL
        AND p.paymentDate <= ${toDate}
      GROUP BY inv.customerId
    `);
        // Customer advance applications reduce AR (treat like received)
        const advAppliedInRange = (await prisma.$queryRaw `
      SELECT ca.customerId as customerId, SUM(caa.amount) as amount
      FROM CustomerAdvanceApplication caa
      JOIN CustomerAdvance ca ON ca.id = caa.customerAdvanceId
      WHERE caa.companyId = ${companyId}
        AND ca.companyId = ${companyId}
        AND caa.appliedDate >= ${fromDate}
        AND caa.appliedDate <= ${toDate}
      GROUP BY ca.customerId
    `);
        const advAppliedToDate = (await prisma.$queryRaw `
      SELECT ca.customerId as customerId, SUM(caa.amount) as amount
      FROM CustomerAdvanceApplication caa
      JOIN CustomerAdvance ca ON ca.id = caa.customerAdvanceId
      WHERE caa.companyId = ${companyId}
        AND ca.companyId = ${companyId}
        AND caa.appliedDate <= ${toDate}
      GROUP BY ca.customerId
    `);
        // Credit notes reduce AR (treat like received)
        const cnInRange = (await prisma.creditNote.groupBy({
            by: ['customerId'],
            where: { companyId, status: { in: creditStatuses }, creditNoteDate: { gte: fromDate, lte: toDate } },
            _sum: { total: true, amountRefunded: true },
        }));
        const cnToDate = (await prisma.creditNote.groupBy({
            by: ['customerId'],
            where: { companyId, status: { in: creditStatuses }, creditNoteDate: { lte: toDate } },
            _sum: { total: true, amountRefunded: true },
        }));
        const invInRangeMap = new Map(invInRange.map((r) => [Number(r.customerId), d2(r._sum.total ?? 0)]));
        const invToDateMap = new Map(invToDate.map((r) => [Number(r.customerId), d2(r._sum.total ?? 0)]));
        const payInRangeMap = new Map(payInRange.map((r) => [Number(r.customerId), d2(r.amount ?? 0)]));
        const payToDateMap = new Map(payToDate.map((r) => [Number(r.customerId), d2(r.amount ?? 0)]));
        const advInRangeMap = new Map(advAppliedInRange.map((r) => [Number(r.customerId), d2(r.amount ?? 0)]));
        const advToDateMap = new Map(advAppliedToDate.map((r) => [Number(r.customerId), d2(r.amount ?? 0)]));
        // Net credit note impact on AR = total - refunded (refund reverses the AR reduction).
        const cnInRangeMap = new Map(cnInRange.map((r) => [Number(r.customerId), d2(d2(r._sum.total ?? 0).sub(d2(r._sum.amountRefunded ?? 0)))]));
        const cnToDateMap = new Map(cnToDate.map((r) => [Number(r.customerId), d2(d2(r._sum.total ?? 0).sub(d2(r._sum.amountRefunded ?? 0)))]));
        const rows = customers.map((c) => {
            const opening = d2(c.openingBalance ?? 0);
            const invoicedAmount = invInRangeMap.get(c.id) ?? d2(0);
            const amountReceived = d2(payInRangeMap.get(c.id) ?? d2(0)); // cash receipts only
            const credit = d2((advInRangeMap.get(c.id) ?? d2(0)).add(cnInRangeMap.get(c.id) ?? d2(0))); // advances + credit notes
            const closing = d2(opening
                .add(invToDateMap.get(c.id) ?? d2(0))
                .sub(payToDateMap.get(c.id) ?? d2(0))
                .sub(advToDateMap.get(c.id) ?? d2(0))
                .sub(cnToDateMap.get(c.id) ?? d2(0)));
            return {
                customerId: c.id,
                customerName: c.name,
                openingBalance: asMoneyString(opening),
                invoicedAmount: asMoneyString(invoicedAmount),
                amountReceived: asMoneyString(amountReceived),
                credit: asMoneyString(credit),
                closingBalance: asMoneyString(closing),
            };
        });
        const totals = rows.reduce((acc, r) => {
            acc.opening = d2(acc.opening.add(d2(r.openingBalance)));
            acc.invoiced = d2(acc.invoiced.add(d2(r.invoicedAmount)));
            acc.received = d2(acc.received.add(d2(r.amountReceived)));
            acc.credit = d2(acc.credit.add(d2(r.credit)));
            acc.closing = d2(acc.closing.add(d2(r.closingBalance)));
            return acc;
        }, { opening: d2(0), invoiced: d2(0), received: d2(0), credit: d2(0), closing: d2(0) });
        return {
            companyId,
            from: fromDate.toISOString().slice(0, 10),
            to: toDate.toISOString().slice(0, 10),
            totals: {
                openingBalance: asMoneyString(totals.opening),
                invoicedAmount: asMoneyString(totals.invoiced),
                amountReceived: asMoneyString(totals.received),
                credit: asMoneyString(totals.credit),
                closingBalance: asMoneyString(totals.closing),
            },
            rows,
        };
    });
    // --- Receivable Summary ---
    // GET /companies/:companyId/reports/receivable-summary?from=YYYY-MM-DD&to=YYYY-MM-DD
    fastify.get('/companies/:companyId/reports/receivable-summary', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const range = parseRangeOrThrow(reply, request.query);
        if (!range)
            return;
        const { fromDate, toDate } = range;
        const statuses = ['POSTED', 'PARTIAL', 'PAID'];
        const invoices = await prisma.invoice.findMany({
            where: { companyId, status: { in: statuses }, invoiceDate: { gte: fromDate, lte: toDate } },
            include: { customer: true },
            orderBy: [{ invoiceDate: 'asc' }, { id: 'asc' }],
        });
        const invoiceIds = invoices.map((i) => i.id);
        if (invoiceIds.length === 0) {
            return { companyId, from: fromDate.toISOString().slice(0, 10), to: toDate.toISOString().slice(0, 10), rows: [] };
        }
        const paymentsToDate = (await prisma.payment.groupBy({
            by: ['invoiceId'],
            where: { companyId, invoiceId: { in: invoiceIds }, reversedAt: null, paymentDate: { lte: toDate } },
            _sum: { amount: true },
        }));
        const advToDate = (await prisma.customerAdvanceApplication.groupBy({
            by: ['invoiceId'],
            where: { companyId, invoiceId: { in: invoiceIds }, appliedDate: { lte: toDate } },
            _sum: { amount: true },
        }));
        const cnToDate = (await prisma.creditNote.groupBy({
            by: ['invoiceId'],
            where: { companyId, invoiceId: { in: invoiceIds }, status: 'POSTED', creditNoteDate: { lte: toDate } },
            _sum: { total: true },
        }));
        const payMap = new Map(paymentsToDate.map((r) => [Number(r.invoiceId), d2(r._sum.amount ?? 0)]));
        const advMap = new Map(advToDate.map((r) => [Number(r.invoiceId), d2(r._sum.amount ?? 0)]));
        const cnMap = new Map(cnToDate.map((r) => [Number(r.invoiceId), d2(r._sum.total ?? 0)]));
        const rows = invoices.map((inv) => {
            const total = d2(inv.total);
            const received = d2((payMap.get(inv.id) ?? d2(0)).add(advMap.get(inv.id) ?? d2(0)).add(cnMap.get(inv.id) ?? d2(0)));
            const balance = d2(total.sub(received));
            return {
                invoiceId: inv.id,
                customerName: inv.customer?.name ?? 'Customer',
                date: inv.invoiceDate.toISOString().slice(0, 10),
                transactionNumber: inv.invoiceNumber,
                referenceNumber: null,
                status: inv.status,
                transactionType: 'Invoice',
                totalBCY: asMoneyString(total),
                totalFCY: asMoneyString(total),
                balanceBCY: asMoneyString(balance),
                balanceFCY: asMoneyString(balance),
            };
        });
        return { companyId, from: fromDate.toISOString().slice(0, 10), to: toDate.toISOString().slice(0, 10), rows };
    });
    // --- Receivable Details ---
    // GET /companies/:companyId/reports/receivable-details?from=YYYY-MM-DD&to=YYYY-MM-DD
    fastify.get('/companies/:companyId/reports/receivable-details', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const range = parseRangeOrThrow(reply, request.query);
        if (!range)
            return;
        const { fromDate, toDate } = range;
        const statuses = ['POSTED', 'PARTIAL', 'PAID'];
        const rows = (await prisma.$queryRaw `
      SELECT
        inv.id as invoiceId,
        inv.invoiceNumber as invoiceNumber,
        inv.invoiceDate as invoiceDate,
        inv.status as status,
        c.name as customerName,
        i.name as itemName,
        il.description as description,
        il.quantity as quantity,
        il.unitPrice as unitPrice,
        il.discountAmount as discountAmount,
        il.lineTotal as lineTotal,
        il.taxAmount as taxAmount
      FROM InvoiceLine il
      JOIN Invoice inv ON inv.id = il.invoiceId
      JOIN Customer c ON c.id = inv.customerId
      LEFT JOIN Item i ON i.id = il.itemId
      WHERE il.companyId = ${companyId}
        AND inv.companyId = ${companyId}
        AND inv.status IN (${Prisma.join(statuses)})
        AND inv.invoiceDate >= ${fromDate}
        AND inv.invoiceDate <= ${toDate}
      ORDER BY inv.invoiceDate ASC, inv.id ASC, il.id ASC
    `);
        const out = rows.map((r) => {
            const qty = d2(r.quantity);
            const unit = d2(r.unitPrice);
            const total = d2(d2(r.lineTotal).add(d2(r.taxAmount)));
            return {
                customerName: r.customerName,
                date: new Date(r.invoiceDate).toISOString().slice(0, 10),
                transactionNumber: r.invoiceNumber,
                referenceNumber: null,
                status: r.status,
                transactionType: 'Invoice',
                itemName: r.itemName ?? (String(r.description ?? '').trim() || '—'),
                quantityOrdered: qty.toString(),
                itemPriceBCY: unit.toString(),
                totalBCY: total.toString(),
            };
        });
        return { companyId, from: fromDate.toISOString().slice(0, 10), to: toDate.toISOString().slice(0, 10), rows: out };
    });
    // --- Payable Summary ---
    // GET /companies/:companyId/reports/payable-summary?from=YYYY-MM-DD&to=YYYY-MM-DD
    fastify.get('/companies/:companyId/reports/payable-summary', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const range = parseRangeOrThrow(reply, request.query);
        if (!range)
            return;
        const { fromDate, toDate } = range;
        const pbStatuses = ['POSTED', 'PARTIAL', 'PAID'];
        const expStatuses = ['POSTED', 'PARTIAL', 'PAID'];
        const purchaseBills = await prisma.purchaseBill.findMany({
            where: { companyId, status: { in: pbStatuses }, billDate: { gte: fromDate, lte: toDate } },
            include: { vendor: true },
            orderBy: [{ billDate: 'asc' }, { id: 'asc' }],
        });
        const expenses = await prisma.expense.findMany({
            where: { companyId, status: { in: expStatuses }, expenseDate: { gte: fromDate, lte: toDate } },
            include: { vendor: true },
            orderBy: [{ expenseDate: 'asc' }, { id: 'asc' }],
        });
        const pbIds = purchaseBills.map((b) => b.id);
        const expIds = expenses.map((e) => e.id);
        const pbPaidToDate = pbIds.length
            ? (await prisma.purchaseBillPayment.groupBy({
                by: ['purchaseBillId'],
                where: { companyId, purchaseBillId: { in: pbIds }, reversedAt: null, paymentDate: { lte: toDate } },
                _sum: { amount: true },
            }))
            : [];
        const expPaidToDate = expIds.length
            ? (await prisma.expensePayment.groupBy({
                by: ['expenseId'],
                where: { companyId, expenseId: { in: expIds }, reversedAt: null, paymentDate: { lte: toDate } },
                _sum: { amount: true },
            }))
            : [];
        const pbCreditAppliedToDate = pbIds.length
            ? (await prisma.vendorCreditApplication.groupBy({
                by: ['purchaseBillId'],
                where: { companyId, purchaseBillId: { in: pbIds }, appliedDate: { lte: toDate } },
                _sum: { amount: true },
            }))
            : [];
        const pbPaidMap = new Map(pbPaidToDate.map((r) => [Number(r.purchaseBillId), d2(r._sum.amount ?? 0)]));
        const expPaidMap = new Map(expPaidToDate.map((r) => [Number(r.expenseId), d2(r._sum.amount ?? 0)]));
        const pbCreditMap = new Map(pbCreditAppliedToDate.map((r) => [Number(r.purchaseBillId), d2(r._sum.amount ?? 0)]));
        const rows = [];
        for (const b of purchaseBills) {
            const total = d2(b.total);
            const paid = d2((pbPaidMap.get(b.id) ?? d2(0)).add(pbCreditMap.get(b.id) ?? d2(0)));
            const balance = d2(total.sub(paid));
            rows.push({
                transactionType: 'Bill',
                vendorName: b.vendor?.name ?? 'No Vendor',
                date: new Date(b.billDate).toISOString().slice(0, 10),
                transactionNumber: b.billNumber,
                referenceNumber: null,
                status: b.status,
                totalBCY: asMoneyString(total),
                totalFCY: asMoneyString(total),
                balanceBCY: asMoneyString(balance),
                balanceFCY: asMoneyString(balance),
            });
        }
        for (const e of expenses) {
            const total = d2(e.amount);
            const paid = expPaidMap.get(e.id) ?? d2(0);
            const balance = d2(total.sub(paid));
            rows.push({
                transactionType: 'Bill',
                vendorName: e.vendor?.name ?? 'No Vendor',
                date: new Date(e.expenseDate).toISOString().slice(0, 10),
                transactionNumber: e.expenseNumber,
                referenceNumber: null,
                status: e.status,
                totalBCY: asMoneyString(total),
                totalFCY: asMoneyString(total),
                balanceBCY: asMoneyString(balance),
                balanceFCY: asMoneyString(balance),
            });
        }
        rows.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        return { companyId, from: fromDate.toISOString().slice(0, 10), to: toDate.toISOString().slice(0, 10), rows };
    });
    // --- Payable Details ---
    // GET /companies/:companyId/reports/payable-details?from=YYYY-MM-DD&to=YYYY-MM-DD
    fastify.get('/companies/:companyId/reports/payable-details', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const range = parseRangeOrThrow(reply, request.query);
        if (!range)
            return;
        const { fromDate, toDate } = range;
        const pbStatuses = ['POSTED', 'PARTIAL', 'PAID'];
        const expStatuses = ['POSTED', 'PARTIAL', 'PAID'];
        const pbLines = (await prisma.$queryRaw `
      SELECT
        pb.billDate as billDate,
        pb.billNumber as billNumber,
        pb.status as status,
        v.name as vendorName,
        i.name as itemName,
        pbl.description as description,
        pbl.quantity as quantity,
        pbl.unitCost as unitCost,
        pbl.lineTotal as lineTotal
      FROM PurchaseBillLine pbl
      JOIN PurchaseBill pb ON pb.id = pbl.purchaseBillId
      LEFT JOIN Vendor v ON v.id = pb.vendorId
      LEFT JOIN Item i ON i.id = pbl.itemId
      WHERE pbl.companyId = ${companyId}
        AND pb.companyId = ${companyId}
        AND pb.status IN (${Prisma.join(pbStatuses)})
        AND pb.billDate >= ${fromDate}
        AND pb.billDate <= ${toDate}
      ORDER BY pb.billDate ASC, pb.id ASC, pbl.id ASC
    `);
        const expRows = await prisma.expense.findMany({
            where: { companyId, status: { in: expStatuses }, expenseDate: { gte: fromDate, lte: toDate } },
            include: { vendor: true, item: true },
            orderBy: [{ expenseDate: 'asc' }, { id: 'asc' }],
        });
        const rows = [];
        for (const r of pbLines) {
            const qty = d2(r.quantity);
            const unit = d2(r.unitCost);
            const total = d2(r.lineTotal);
            rows.push({
                vendorName: r.vendorName ?? 'No Vendor',
                date: new Date(r.billDate).toISOString().slice(0, 10),
                transactionNumber: r.billNumber,
                referenceNumber: null,
                status: r.status,
                transactionType: 'Bill',
                itemName: r.itemName ?? (String(r.description ?? '').trim() || '—'),
                quantityOrdered: qty.toString(),
                itemPriceBCY: unit.toString(),
                totalBCY: total.toString(),
            });
        }
        for (const e of expRows) {
            const total = d2(e.amount);
            rows.push({
                vendorName: e.vendor?.name ?? 'No Vendor',
                date: new Date(e.expenseDate).toISOString().slice(0, 10),
                transactionNumber: e.expenseNumber,
                referenceNumber: null,
                status: e.status,
                transactionType: 'Bill',
                itemName: e.item?.name ?? (String(e.description ?? '').trim() || '—'),
                quantityOrdered: d2(1).toString(),
                itemPriceBCY: total.toString(),
                totalBCY: total.toString(),
            });
        }
        rows.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        return { companyId, from: fromDate.toISOString().slice(0, 10), to: toDate.toISOString().slice(0, 10), rows };
    });
}
//# sourceMappingURL=arApSummary.routes.js.map