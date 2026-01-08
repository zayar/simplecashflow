import { Prisma } from '@prisma/client';
/**
 * Ensures the company has a GRNI (Goods Received Not Invoiced) liability account configured.
 * This is used to recognize inventory at receipt time without posting AP until the bill arrives.
 */
export async function ensureGrniAccount(tx, companyId) {
    const company = await tx.company.findUnique({
        where: { id: companyId },
        select: { id: true, goodsReceivedNotInvoicedAccountId: true },
    });
    if (!company)
        throw Object.assign(new Error('company not found'), { statusCode: 404 });
    const existingId = Number(company.goodsReceivedNotInvoicedAccountId ?? 0) || null;
    if (existingId)
        return existingId;
    // Prefer an existing "GRNI" account by code or name if present.
    const found = await tx.account.findFirst({
        where: {
            companyId,
            type: 'LIABILITY',
            OR: [{ code: '2050' }, { name: 'Goods Received Not Invoiced' }, { name: 'GRNI' }],
        },
        select: { id: true },
    });
    const id = found?.id ??
        (await tx.account.create({
            data: {
                companyId,
                code: '2050',
                name: 'Goods Received Not Invoiced',
                type: 'LIABILITY',
                normalBalance: 'CREDIT',
                reportGroup: 'OTHER_CURRENT_LIABILITY',
                cashflowActivity: 'OPERATING',
            },
            select: { id: true },
        })).id;
    await tx.company.update({
        where: { id: companyId },
        data: { goodsReceivedNotInvoicedAccountId: id },
    });
    return id;
}
//# sourceMappingURL=grni.service.js.map