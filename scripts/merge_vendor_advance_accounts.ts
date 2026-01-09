/**
 * One-time data fix:
 * Consolidate legacy "Supplier Advance" / "Vendor Prepayments" accounts into a single "Vendor Advance" account.
 *
 * Run:
 *   npx tsx scripts/merge_vendor_advance_accounts.ts
 */
import { prisma } from '../src/infrastructure/db.js';
import { ensureVendorAdvanceAccount } from '../src/modules/purchases/vendorAdvanceAccount.js';

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // Best-effort connect with retry (Cloud SQL proxy can drop idle connections).
  let companies: Array<{ id: number; name: string }> = [];
  let lastErr: any = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      companies = await prisma.company.findMany({ select: { id: true, name: true } });
      lastErr = null;
      break;
    } catch (e: any) {
      lastErr = e;
      console.error(`Failed to load companies (attempt ${attempt}/3):`, e?.message ?? e);
      await sleep(500 * attempt);
    }
  }
  if (lastErr) throw lastErr;

  console.log(`Found ${companies.length} companies`);

  for (const c of companies) {
    const companyId = Number(c.id);
    try {
      await prisma.$transaction(async (tx: any) => {
        const id = await ensureVendorAdvanceAccount(tx, companyId);
        const acc = await tx.account.findFirst({
          where: { id, companyId },
          select: { id: true, code: true, name: true, isActive: true },
        });
        console.log(
          `Company ${companyId} (${c.name}): canonical account => ${acc?.code ?? ''} ${acc?.name ?? ''} (#${acc?.id ?? id})`
        );
      });
    } catch (e: any) {
      console.error(`Company ${companyId} (${c.name}): merge failed:`, e?.message ?? e);
      // Continue other companies.
    }
  }
}

main()
  .then(async () => {
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    prisma
      .$disconnect()
      .catch(() => {})
      .finally(() => process.exit(1));
  });

