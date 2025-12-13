import { PrismaClient, Prisma, InvoiceStatus } from '@prisma/client';

/**
 * Backfill Invoice.amountPaid and Invoice.status from source-of-truth Payments table.
 *
 * Usage:
 *   # Local / any DB (DATABASE_URL must be set)
 *   npx tsx scripts/backfill_invoice_amount_paid.ts --companyId=1
 *
 * Options:
 *   --companyId=1   (required)
 *   --dryRun=true   (optional; default false)
 */

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

async function main() {
  const companyIdRaw = getArg('companyId');
  const dryRunRaw = getArg('dryRun');

  if (!companyIdRaw) {
    throw new Error('Missing required --companyId=<number>');
  }
  const companyId = Number(companyIdRaw);
  if (Number.isNaN(companyId)) {
    throw new Error('Invalid --companyId');
  }
  const dryRun = (dryRunRaw ?? 'false').toLowerCase() === 'true';

  const prisma = new PrismaClient();
  try {
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new Error(`Company ${companyId} not found`);

    console.log(`Backfilling Invoice.amountPaid for companyId=${companyId} dryRun=${dryRun}`);

    const pageSize = 200;
    let cursor: number | null = null;
    let processed = 0;
    let updated = 0;

    while (true) {
      const invoices = await prisma.invoice.findMany({
        where: { companyId },
        orderBy: { id: 'asc' },
        take: pageSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: { id: true, status: true, total: true },
      });

      if (invoices.length === 0) break;

      for (const inv of invoices) {
        processed += 1;

        // DRAFT invoices must have amountPaid=0 and stay DRAFT (no payments allowed by API anyway).
        if (inv.status === 'DRAFT') {
          continue;
        }

        const sumAgg = await prisma.payment.aggregate({
          where: { companyId, invoiceId: inv.id, reversedAt: null },
          _sum: { amount: true },
        });
        const paid = (sumAgg._sum.amount ?? new Prisma.Decimal(0)).toDecimalPlaces(2);

        const newStatus = paid.equals(0)
          ? 'POSTED'
          : paid.greaterThanOrEqualTo(inv.total)
            ? 'PAID'
            : 'PARTIAL';

        if (!dryRun) {
          await prisma.invoice.update({
            where: { id: inv.id },
            data: { amountPaid: paid, status: newStatus as InvoiceStatus },
          });
        }

        updated += 1;
        if (updated % 50 === 0) {
          console.log(`...updated ${updated}/${processed}`);
        }
      }

      cursor = invoices[invoices.length - 1]!.id;
    }

    console.log(`✅ Done. processed=${processed} updated=${updated} (dryRun=${dryRun})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


