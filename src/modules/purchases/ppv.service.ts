import type { PrismaTx } from '../ledger/posting.service.js';

/**
 * Ensures the company has a Purchase Price Variance (PPV) account configured.
 * Used when clearing GRNI and the vendor bill total differs from receipt total.
 */
export async function ensurePurchasePriceVarianceAccount(tx: PrismaTx, companyId: number): Promise<number> {
  const company = await (tx as any).company.findUnique({
    where: { id: companyId },
    select: { id: true, purchasePriceVarianceAccountId: true },
  });
  if (!company) throw Object.assign(new Error('company not found'), { statusCode: 404 });

  const existingId = Number((company as any).purchasePriceVarianceAccountId ?? 0) || null;
  if (existingId) return existingId;

  const found = await (tx as any).account.findFirst({
    where: {
      companyId,
      type: 'EXPENSE',
      OR: [{ code: '5100' }, { name: 'Purchase Price Variance' }, { name: 'PPV' }],
    },
    select: { id: true },
  });

  const id =
    found?.id ??
    (
      await (tx as any).account.create({
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
      })
    ).id;

  await (tx as any).company.update({
    where: { id: companyId },
    data: { purchasePriceVarianceAccountId: id },
  });

  return id;
}

