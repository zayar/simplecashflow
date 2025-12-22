import { prisma } from '../src/infrastructure/db.js';
import { AccountReportGroup, AccountType, CashflowActivity, NormalBalance } from '@prisma/client';

/**
 * Seed default Fixed Asset accounts for existing companies.
 *
 * New companies get these via DEFAULT_ACCOUNTS during /register.
 * This script backfills older tenants safely (idempotent).
 */
async function seedFixedAssetDefaults() {
  console.log('🌱 Seeding fixed asset default accounts for all companies...');

  const companies = await prisma.company.findMany({
    select: { id: true, name: true },
  });

  const defaults = [
    {
      code: '1500',
      name: 'Equipment',
    },
    {
      code: '1510',
      name: 'Furniture & Fixtures',
    },
  ] as const;

  for (const c of companies) {
    console.log(`\n🏢 Company ${c.id}: ${c.name}`);

    for (const acc of defaults) {
      const existing = await prisma.account.findFirst({
        where: { companyId: c.id, code: acc.code },
        select: { id: true, code: true, name: true },
      });

      if (existing) {
        console.log(`  ⏭️  ${acc.code} already exists (${existing.name})`);
        continue;
      }

      await prisma.account.create({
        data: {
          companyId: c.id,
          code: acc.code,
          name: acc.name,
          type: AccountType.ASSET,
          normalBalance: NormalBalance.DEBIT,
          reportGroup: AccountReportGroup.FIXED_ASSET,
          cashflowActivity: CashflowActivity.INVESTING,
          isActive: true,
        },
      });

      console.log(`  ✅ Created ${acc.code}: ${acc.name}`);
    }
  }

  console.log('\n✨ Fixed asset seeding complete!');
}

seedFixedAssetDefaults()
  .catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });


