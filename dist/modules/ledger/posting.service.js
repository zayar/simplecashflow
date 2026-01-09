import { Prisma } from '@prisma/client';
import { nextJournalEntryNumber } from '../sequence/sequence.service.js';
function d0() {
    return new Prisma.Decimal(0);
}
function assertNonNegativeDecimal(value, field) {
    if (value.lessThan(0)) {
        throw Object.assign(new Error(`${field} cannot be negative`), { statusCode: 400 });
    }
}
/**
 * Posting Engine: creates a balanced JournalEntry + JournalLines.
 * - Enforces debit == credit using Prisma.Decimal
 * - Enforces no line has both debit and credit > 0
 * - Enforces all accounts belong to the company (multi-tenant safety)
 */
export async function postJournalEntry(tx, input) {
    const { companyId, date, description } = input;
    const rawLines = input.lines ?? [];
    if (!companyId || Number.isNaN(Number(companyId))) {
        throw Object.assign(new Error('companyId is required'), { statusCode: 400 });
    }
    if (!(date instanceof Date) || isNaN(date.getTime())) {
        throw Object.assign(new Error('date is required'), { statusCode: 400 });
    }
    if (!rawLines.length || rawLines.length < 2) {
        throw Object.assign(new Error('at least 2 lines are required'), { statusCode: 400 });
    }
    // Fintech safety: prevent posting into closed periods.
    // We compare by day (00:00) so callers can pass any time-of-day safely.
    // Can be skipped if caller already validated (avoids duplicate DB query).
    if (!input.skipPeriodCheck) {
        const day = new Date(date);
        day.setHours(0, 0, 0, 0);
        // CRITICAL FIX #4: Block posting on or before ANY closed period (not just within range).
        // This prevents backdating entries after period close, which would reopen prior periods.
        const latestClosed = await tx.periodClose.findFirst({
            where: { companyId },
            orderBy: { toDate: 'desc' },
            select: { fromDate: true, toDate: true },
        });
        if (latestClosed && day <= latestClosed.toDate) {
            throw Object.assign(new Error(`cannot post on or before closed period (latest close: ${latestClosed.fromDate.toISOString().slice(0, 10)} to ${latestClosed.toDate.toISOString().slice(0, 10)})`), { statusCode: 400 });
        }
    }
    // Allocate a gapless journal entry number inside the same DB transaction.
    // If the posting transaction rolls back, the sequence increment rolls back too (no gaps).
    const entryNumber = await nextJournalEntryNumber(tx, companyId, date);
    // Normalize + validate lines
    const lines = rawLines.map((l, idx) => {
        if (!l.accountId) {
            throw Object.assign(new Error(`line[${idx}].accountId is required`), { statusCode: 400 });
        }
        const debit = l.debit ?? d0();
        const credit = l.credit ?? d0();
        assertNonNegativeDecimal(debit, `line[${idx}].debit`);
        assertNonNegativeDecimal(credit, `line[${idx}].credit`);
        if (debit.greaterThan(0) && credit.greaterThan(0)) {
            throw Object.assign(new Error(`line[${idx}] cannot have both debit and credit > 0`), {
                statusCode: 400,
            });
        }
        if (debit.equals(0) && credit.equals(0)) {
            throw Object.assign(new Error(`line[${idx}] debit and credit cannot both be 0`), {
                statusCode: 400,
            });
        }
        return { accountId: l.accountId, debit, credit };
    });
    // Tenant-safe account validation (can be skipped for performance when caller already validated)
    if (!input.skipAccountValidation) {
        const accountIds = Array.from(new Set(lines.map((l) => l.accountId)));
        const accounts = await tx.account.findMany({
            where: { companyId, id: { in: accountIds } },
            select: { id: true },
        });
        if (accounts.length !== accountIds.length) {
            throw Object.assign(new Error('one or more accountIds do not belong to this company'), {
                statusCode: 400,
            });
        }
    }
    // Optional location tagging. Validate tenant safety (can be skipped if caller validated).
    const locationId = input.locationId ?? input.warehouseId ?? null;
    if (locationId && !input.skipLocationValidation) {
        const loc = await tx.location.findFirst({
            where: { id: locationId, companyId },
            select: { id: true },
        });
        if (!loc) {
            throw Object.assign(new Error('locationId does not belong to this company'), { statusCode: 400 });
        }
    }
    // Balance check using Decimal
    let totalDebit = d0();
    let totalCredit = d0();
    for (const l of lines) {
        totalDebit = totalDebit.add(l.debit);
        totalCredit = totalCredit.add(l.credit);
    }
    totalDebit = totalDebit.toDecimalPlaces(2);
    totalCredit = totalCredit.toDecimalPlaces(2);
    if (!totalDebit.equals(totalCredit)) {
        throw Object.assign(new Error('debits and credits must be equal'), {
            statusCode: 400,
            totalDebit: totalDebit.toString(),
            totalCredit: totalCredit.toString(),
        });
    }
    return await tx.journalEntry.create({
        data: {
            companyId,
            entryNumber,
            date,
            description,
            locationId,
            createdByUserId: input.createdByUserId ?? null,
            reversalOfJournalEntryId: input.reversalOfJournalEntryId ?? null,
            reversalReason: input.reversalReason ?? null,
            lines: {
                create: lines.map((l) => ({
                    companyId,
                    accountId: l.accountId,
                    debit: l.debit.toDecimalPlaces(2),
                    credit: l.credit.toDecimalPlaces(2),
                })),
            },
        },
        include: {
            lines: true,
        },
    });
}
//# sourceMappingURL=posting.service.js.map