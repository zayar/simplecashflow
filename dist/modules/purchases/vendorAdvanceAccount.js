import { AccountReportGroup, AccountType, Prisma } from '@prisma/client';
import { pickFirstUnusedNumericCode } from '../../utils/tax.js';
/**
 * Ensure the company has exactly one "Vendor Advance" asset account.
 *
 * This also consolidates legacy accounts:
 * - "Supplier Advance"
 * - "Vendor Prepayments"
 *
 * into the canonical "Vendor Advance" account by:
 * - updating AccountBalance (so Balance Sheet shows one line)
 * - updating VendorAdvance.prepaymentAccountId
 *
 * Note: We do NOT rewrite JournalLine, because ledger lines are immutable.
 *
 * Safe to run multiple times.
 */
export async function ensureVendorAdvanceAccount(tx, companyId) {
    const candidates = await tx.account.findMany({
        where: {
            companyId,
            type: AccountType.ASSET,
            name: { in: ['Vendor Advance', 'Supplier Advance', 'Vendor Prepayments'] },
        },
        select: { id: true, name: true, code: true },
        orderBy: [{ id: 'asc' }],
    });
    const byName = new Map();
    for (const a of candidates ?? []) {
        byName.set(String(a.name), { id: Number(a.id), name: String(a.name), code: String(a.code ?? '') });
    }
    const existingVendorAdvance = byName.get('Vendor Advance') ?? null;
    const existingSupplierAdvance = byName.get('Supplier Advance') ?? null;
    const existingVendorPrepayments = byName.get('Vendor Prepayments') ?? null;
    // Prefer a real "Vendor Advance" if it exists, else reuse Supplier Advance, else Vendor Prepayments.
    let canonical = existingVendorAdvance ?? existingSupplierAdvance ?? existingVendorPrepayments ?? null;
    if (!canonical) {
        // Choose a safe unused ASSET code in 1400..1499 (commonly "prepaids").
        const assetCodes = await tx.account.findMany({
            where: { companyId, type: AccountType.ASSET },
            select: { code: true },
        });
        const used = new Set(assetCodes.map((a) => String(a.code ?? '').trim()).filter(Boolean));
        const desired = !used.has('1400') ? '1400' : pickFirstUnusedNumericCode(used, 1401, 1499);
        const created = await tx.account.create({
            data: {
                companyId,
                code: desired,
                name: 'Vendor Advance',
                type: AccountType.ASSET,
                normalBalance: 'DEBIT',
                reportGroup: AccountReportGroup.OTHER_CURRENT_ASSET,
                cashflowActivity: 'OPERATING',
            },
            select: { id: true, name: true, code: true },
        });
        canonical = { id: Number(created.id), name: String(created.name), code: String(created.code ?? '') };
    }
    const canonicalId = Number(canonical.id);
    // If we reused a legacy account, rename it to "Vendor Advance" (only if no conflict).
    if (canonical.name !== 'Vendor Advance' && !existingVendorAdvance) {
        await tx.account.update({
            where: { id: canonicalId },
            data: { name: 'Vendor Advance' },
        });
    }
    // Consolidate other legacy accounts into canonical (without touching immutable JournalLine).
    const legacyIds = [existingSupplierAdvance?.id, existingVendorPrepayments?.id, existingVendorAdvance?.id]
        .filter((id) => typeof id === 'number' && Number.isFinite(id))
        .map((id) => Number(id))
        .filter((id) => id !== canonicalId);
    if (legacyIds.length > 0) {
        // Merge AccountBalance daily increments so Balance Sheet / dashboard reports reflect the change.
        const grouped = await tx.accountBalance.groupBy({
            by: ['date'],
            where: { companyId, accountId: { in: legacyIds } },
            _sum: { debitTotal: true, creditTotal: true },
        });
        for (const g of grouped ?? []) {
            const debit = new Prisma.Decimal(g._sum.debitTotal ?? 0).toDecimalPlaces(2);
            const credit = new Prisma.Decimal(g._sum.creditTotal ?? 0).toDecimalPlaces(2);
            if (debit.equals(0) && credit.equals(0))
                continue;
            await tx.accountBalance.upsert({
                where: {
                    companyId_accountId_date: {
                        companyId,
                        accountId: canonicalId,
                        date: g.date,
                    },
                },
                update: {
                    debitTotal: { increment: debit },
                    creditTotal: { increment: credit },
                },
                create: {
                    companyId,
                    accountId: canonicalId,
                    date: g.date,
                    debitTotal: debit,
                    creditTotal: credit,
                },
            });
        }
        await tx.accountBalance.deleteMany({
            where: { companyId, accountId: { in: legacyIds } },
        });
        // Ensure vendor advances point to canonical account.
        await tx.vendorAdvance.updateMany({
            where: { companyId, prepaymentAccountId: { in: legacyIds } },
            data: { prepaymentAccountId: canonicalId },
        });
        // Hide legacy accounts from selection to prevent future use (best-effort).
        await tx.account.updateMany({
            where: { companyId, id: { in: legacyIds } },
            data: { isActive: false },
        });
    }
    return canonicalId;
}
//# sourceMappingURL=vendorAdvanceAccount.js.map