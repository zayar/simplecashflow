import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { _test_applyWacReplay } from '../src/modules/inventory/recalc.service.js';
import { assertOpenPeriodOrThrow } from '../src/utils/periodClosePolicy.js';

const D = (v: string | number) => new Prisma.Decimal(v);
const day = (isoDay: string) => new Date(`${isoDay}T00:00:00.000Z`);

test('inventory recalc: backdated receipt changes later SALE_ISSUE WAC cost and yields deterministic delta per JE', () => {
  // Baseline before 2025-12-10: 10 units @ 10.00 = 100.00
  const baseline = new Map<string, { qty: Prisma.Decimal; value: Prisma.Decimal }>();
  baseline.set('1:1', { qty: D('10.00'), value: D('100.00') });

  const moves = [
    // Backdated receipt inserted at 2025-12-10: 10 units @ 1.00 = 10.00
    {
      id: 10,
      date: day('2025-12-10'),
      locationId: 1,
      itemId: 1,
      direction: 'IN' as const,
      quantity: D('10.00'),
      unitCostApplied: D('1.00'),
      totalCostApplied: D('10.00'),
      referenceType: 'PurchaseBill',
      journalEntryId: null,
    },
    // Existing sale issue posted earlier with old cost 10.00 => 40.00 (should become 5.50 => 22.00)
    {
      id: 11,
      date: day('2025-12-15'),
      locationId: 1,
      itemId: 1,
      direction: 'OUT' as const,
      quantity: D('4.00'),
      unitCostApplied: D('10.00'),
      totalCostApplied: D('40.00'),
      referenceType: 'Invoice',
      journalEntryId: 101,
    },
    // Later receipt (doesn't affect the 12-15 average for the sale issue)
    {
      id: 12,
      date: day('2025-12-20'),
      locationId: 1,
      itemId: 1,
      direction: 'IN' as const,
      quantity: D('10.00'),
      unitCostApplied: D('5.00'),
      totalCostApplied: D('50.00'),
      referenceType: 'PurchaseBill',
      journalEntryId: null,
    },
  ];

  const res = _test_applyWacReplay({ baselineByKey: baseline, moves });

  assert.equal(res.updatedOutMoves.length, 1);
  assert.equal(res.updatedOutMoves[0]!.id, 11);
  assert.ok(res.updatedOutMoves[0]!.unitCostApplied.equals(D('5.50')));
  assert.ok(res.updatedOutMoves[0]!.totalCostApplied.equals(D('22.00')));

  const delta = res.deltaByJournalEntryId.get(101);
  assert.ok(delta, 'expected delta for JE 101');
  assert.ok(delta!.equals(D('-18.00')), `expected delta -18.00, got ${delta!.toString()}`);
});

test('period close policy: rejects transaction dated on/before closedThroughDate', async () => {
  const fakeTx = {
    periodClose: {
      aggregate: async () => ({ _max: { toDate: new Date('2025-12-31T00:00:00.000Z') } }),
    },
  };

  await assert.rejects(
    () =>
      assertOpenPeriodOrThrow(fakeTx as any, {
        companyId: 1,
        transactionDate: new Date('2025-12-31T12:00:00.000Z'),
        action: 'test.post',
      }),
    /CLOSED period/
  );
});

