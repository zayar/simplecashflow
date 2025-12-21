import { prisma } from '../src/infrastructure/db.js';
import { Prisma } from '@prisma/client';

/**
 * Seed default tax rates for existing companies.
 * This script creates common Myanmar tax rates and groups.
 */
async function seedTaxDefaults() {
  console.log('🌱 Seeding tax defaults for all companies...');

  const companies = await prisma.company.findMany({
    select: { id: true, name: true },
  });

  for (const company of companies) {
    console.log(`\n📊 Processing company ${company.id}: ${company.name}`);

    // Check if taxes already exist
    const existingTaxes = await prisma.taxRate.count({
      where: { companyId: company.id },
    });

    if (existingTaxes > 0) {
      console.log(`  ⏭️  Skipping (already has ${existingTaxes} tax rates)`);
      continue;
    }

    try {
      // Create common Myanmar tax rates
      const incomeTax = await prisma.taxRate.create({
        data: {
          companyId: company.id,
          name: 'Income tax',
          rate: new Prisma.Decimal(0.02), // 2%
          isCompound: false,
          isActive: true,
        },
      });
      console.log(`  ✅ Created: Income tax [2%]`);

      const commercialTax = await prisma.taxRate.create({
        data: {
          companyId: company.id,
          name: 'Commercial',
          rate: new Prisma.Decimal(0.05), // 5%
          isCompound: false,
          isActive: true,
        },
      });
      console.log(`  ✅ Created: Commercial [5%]`);

      // Create Myanmar tax group (7% = 2% + 5%)
      const myanmarGroup = await prisma.taxGroup.create({
        data: {
          companyId: company.id,
          name: 'Myanmar',
          totalRate: new Prisma.Decimal(0.07), // 7%
          isActive: true,
        },
      });
      console.log(`  ✅ Created: Myanmar tax group [7%]`);

      // Link rates to group
      await prisma.taxGroupMember.createMany({
        data: [
          { groupId: myanmarGroup.id, taxRateId: incomeTax.id },
          { groupId: myanmarGroup.id, taxRateId: commercialTax.id },
        ],
      });
      console.log(`  ✅ Linked tax rates to Myanmar group`);

    } catch (error) {
      console.error(`  ❌ Error seeding company ${company.id}:`, error);
    }
  }

  console.log('\n✨ Tax seeding complete!');
}

seedTaxDefaults()
  .catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

