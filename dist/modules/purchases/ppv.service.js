/**
 * Ensures the company has a Purchase Price Variance (PPV) account configured.
 * Used when clearing GRNI and the vendor bill total differs from receipt total.
 */
export async function ensurePurchasePriceVarianceAccount(tx, companyId) {
    const company = await tx.company.findUnique({
        where: { id: companyId },
        select: { id: true, purchasePriceVarianceAccountId: true },
    });
    if (!company)
        throw Object.assign(new Error('company not found'), { statusCode: 404 });
    const existingId = Number(company.purchasePriceVarianceAccountId ?? 0) || null;
    if (existingId)
        return existingId;
    const found = await tx.account.findFirst({
        where: {
            companyId,
            type: 'EXPENSE',
            OR: [{ code: '5100' }, { name: 'Purchase Price Variance' }, { name: 'PPV' }],
        },
        select: { id: true },
    });
    const id = found?.id ??
        (await tx.account.create({
            data: {
                companyId,
                code: '5100',
                name: 'Purchase Price Variance',
                type: 'EXPENSE',
                normalBalance: 'DEBIT',
                reportGroup: 'OPERATING_EXPENSE',
                cashflowActivity: 'OPERATING',
            },
            select: { id: true },
        })).id;
    await tx.company.update({
        where: { id: companyId },
        data: { purchasePriceVarianceAccountId: id },
    });
    return id;
}
//# sourceMappingURL=ppv.service.js.map