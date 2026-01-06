import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function argValue(name: string): string | null {
  const idx = process.argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (idx === -1) return null;
  const a = process.argv[idx];
  if (a.includes('=')) return a.split('=').slice(1).join('=') || null;
  const next = process.argv[idx + 1];
  if (!next || next.startsWith('--')) return null;
  return next;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function d2(x: Prisma.Decimal | number | string | null | undefined): Prisma.Decimal {
  const v = x === null || x === undefined ? new Prisma.Decimal(0) : x instanceof Prisma.Decimal ? x : new Prisma.Decimal(x);
  return v.toDecimalPlaces(2);
}

function abs(x: Prisma.Decimal): Prisma.Decimal {
  return x.lessThan(0) ? x.mul(-1) : x;
}

type ExpectedLineMove = {
  itemId: number;
  quantity: Prisma.Decimal;
  expectedTotalCost: Prisma.Decimal;
  expectedUnitCost: Prisma.Decimal;
};

async function fixPurchaseBillReceiptMoves(companyId: number, dryRun: boolean) {
  console.log(`🔧 Fixing PurchaseBill receipt StockMove totals for companyId=${companyId} (dryRun=${dryRun})`);

  const bills = await prisma.purchaseBill.findMany({
    where: { companyId, status: { in: ['POSTED', 'PARTIAL', 'PAID'] as any } },
    select: {
      id: true,
      billNumber: true,
      billDate: true,
      locationId: true,
      lines: {
        select: {
          itemId: true,
          quantity: true,
          unitCost: true,
          discountAmount: true,
          item: { select: { type: true, trackInventory: true } },
        },
      },
    },
    orderBy: [{ id: 'asc' }],
  });

  let scannedBills = 0;
  let candidateMoves = 0;
  let fixedMoves = 0;

  for (const b of bills as any[]) {
    scannedBills += 1;
    const expected: ExpectedLineMove[] = [];
    for (const l of (b.lines ?? []) as any[]) {
      const isTracked = l?.item?.type === 'GOODS' && !!l?.item?.trackInventory;
      if (!isTracked) continue;
      const qty = d2(l.quantity ?? 0);
      if (qty.lessThanOrEqualTo(0)) continue;
      const unit = d2(l.unitCost ?? 0);
      const disc = d2(l.discountAmount ?? 0);
      const gross = d2(qty.mul(unit));
      const total = d2(gross.sub(disc));
      if (total.lessThan(0)) continue;
      expected.push({
        itemId: Number(l.itemId),
        quantity: qty,
        expectedTotalCost: total,
        expectedUnitCost: qty.greaterThan(0) ? d2(total.div(qty)) : unit,
      });
    }
    if (expected.length === 0) continue;

    const moves = await prisma.stockMove.findMany({
      where: {
        companyId,
        referenceType: 'PurchaseBill',
        referenceId: String(b.id),
        type: 'PURCHASE_RECEIPT' as any,
        direction: 'IN' as any,
      },
      select: {
        id: true,
        itemId: true,
        locationId: true,
        date: true,
        quantity: true,
        unitCostApplied: true,
        totalCostApplied: true,
      },
      orderBy: [{ id: 'asc' }],
    });

    if (!moves.length) continue;
    const unmatched = new Set<number>(moves.map((m) => m.id));

    for (const e of expected) {
      // Find best matching stock move for this line: same itemId + same qty (2dp).
      const candidates = (moves as any[])
        .filter((m) => unmatched.has(m.id) && Number(m.itemId) === Number(e.itemId))
        .map((m) => ({
          m,
          qtyDiff: abs(d2(m.quantity).sub(e.quantity)),
          valDiff: abs(d2(m.totalCostApplied).sub(e.expectedTotalCost)),
        }))
        .filter((x) => x.qtyDiff.lessThanOrEqualTo(new Prisma.Decimal('0.00'))); // exact 2dp match

      if (candidates.length === 0) continue;

      // Prefer smallest value diff if multiple lines same item+qty.
      candidates.sort((a, b) => a.valDiff.toNumber() - b.valDiff.toNumber());
      const pick = candidates[0].m as any;
      unmatched.delete(pick.id);
      candidateMoves += 1;

      const currentTotal = d2(pick.totalCostApplied);
      const currentUnit = d2(pick.unitCostApplied);
      const diff = abs(currentTotal.sub(e.expectedTotalCost));

      // Only update if materially different (>= 0.01).
      if (diff.lessThan(new Prisma.Decimal('0.01'))) continue;

      console.log(
        `- PB ${b.billNumber ?? b.id} move#${pick.id} itemId=${pick.itemId} qty=${d2(pick.quantity).toString()} ` +
          `total ${currentTotal.toString()} -> ${e.expectedTotalCost.toString()} (unit ${currentUnit.toString()} -> ${e.expectedUnitCost.toString()})`
      );

      if (!dryRun) {
        await prisma.stockMove.update({
          where: { id: pick.id },
          data: {
            totalCostApplied: e.expectedTotalCost,
            unitCostApplied: e.expectedUnitCost,
          } as any,
        });
      }
      fixedMoves += 1;
    }
  }

  console.log(`✅ PurchaseBill scan done. scannedBills=${scannedBills}, matchedMoves=${candidateMoves}, fixedMoves=${fixedMoves}`);
}

async function rebuildStockBalanceSnapshot(companyId: number, dryRun: boolean) {
  console.log(`🔁 Rebuilding StockBalance snapshot from StockMove for companyId=${companyId} (dryRun=${dryRun})`);

  const pairs = await prisma.stockMove.findMany({
    where: { companyId },
    distinct: ['locationId', 'itemId'] as any,
    select: { locationId: true, itemId: true },
    orderBy: [{ locationId: 'asc' }, { itemId: 'asc' }] as any,
  });

  let rebuilt = 0;
  for (const p of pairs as any[]) {
    const locationId = Number(p.locationId);
    const itemId = Number(p.itemId);
    const moves = await prisma.stockMove.findMany({
      where: { companyId, locationId, itemId },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
      select: { direction: true, quantity: true, totalCostApplied: true, unitCostApplied: true },
    });

    let Q = new Prisma.Decimal(0);
    let V = new Prisma.Decimal(0);
    let A = new Prisma.Decimal(0);

    for (const m of moves as any[]) {
      const qty = d2(m.quantity);
      const cost = d2(m.totalCostApplied);
      if ((m.direction as any) === 'IN') {
        Q = d2(Q.add(qty));
        V = d2(V.add(cost));
      } else {
        Q = d2(Q.sub(qty));
        V = d2(V.sub(cost));
      }
      A = Q.equals(0) ? d2(m.unitCostApplied ?? 0) : d2(V.div(Q));
    }

    // Skip zero rows: keep table tidy.
    if (Q.equals(0) && V.equals(0)) {
      if (!dryRun) {
        await prisma.stockBalance.deleteMany({ where: { companyId, locationId, itemId } });
      }
      continue;
    }

    if (Q.lessThan(0) || V.lessThan(0)) {
      console.warn(`⚠️  Negative state for locationId=${locationId} itemId=${itemId} qty=${Q.toString()} value=${V.toString()} (skipping)`);
      continue;
    }

    if (!dryRun) {
      await prisma.stockBalance.upsert({
        where: { companyId_locationId_itemId: { companyId, locationId, itemId } },
        update: { qtyOnHand: Q, avgUnitCost: A, inventoryValue: V },
        create: { companyId, locationId, itemId, qtyOnHand: Q, avgUnitCost: A, inventoryValue: V },
      });
    }
    rebuilt += 1;
  }

  console.log(`✅ StockBalance rebuild done. rowsUpdated=${rebuilt}`);
}

async function main() {
  const companyId = Number(argValue('--companyId') ?? process.env.COMPANY_ID ?? 0);
  const dryRun = hasFlag('--dry-run') || hasFlag('--dryRun');

  if (!Number.isInteger(companyId) || companyId <= 0) {
    console.error('Usage: npx tsx scripts/fix_backdated_purchasebill_inventory.ts --companyId <id> [--dry-run]');
    process.exit(1);
  }

  await fixPurchaseBillReceiptMoves(companyId, dryRun);
  await rebuildStockBalanceSnapshot(companyId, dryRun);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });


