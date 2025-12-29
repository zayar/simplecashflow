import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { _test_replayStockMovesWithBackdatedInsert } from '../src/modules/inventory/stock.service.js';

const D = (v: string | number) => new Prisma.Decimal(v);
const day = (isoDay: string) => new Date(`${isoDay}T00:00:00.000Z`);

test('stock backdating: computes inserted OUT cost at its timeline position and rebuilds final balance', () => {
  const existingMoves = [
    {
      id: 1,
      date: day('2025-12-01'),
      type: 'PURCHASE_RECEIPT' as const,
      direction: 'IN' as const,
      quantity: D('10.00'),
      unitCostApplied: D('10.00'),
      totalCostApplied: D('100.00'),
      referenceType: 'PurchaseBill',
      referenceId: '1',
    },
    {
      id: 2,
      date: day('2025-12-15'),
      type: 'SALE_ISSUE' as const,
      direction: 'OUT' as const,
      quantity: D('4.00'),
      unitCostApplied: D('10.00'),
      totalCostApplied: D('40.00'),
      referenceType: 'Invoice',
      referenceId: '10',
    },
    {
      id: 3,
      date: day('2025-12-20'),
      type: 'PURCHASE_RECEIPT' as const,
      direction: 'IN' as const,
      quantity: D('10.00'),
      unitCostApplied: D('5.00'),
      totalCostApplied: D('50.00'),
      referenceType: 'PurchaseBill',
      referenceId: '2',
    },
  ];

  const res = _test_replayStockMovesWithBackdatedInsert({
    existingMoves,
    insert: {
      companyId: 1,
      locationId: 1,
      itemId: 1,
      date: day('2025-12-10'),
      allowBackdated: true,
      type: 'SALE_ISSUE',
      direction: 'OUT',
      quantity: D('3.00'),
      unitCostApplied: D('0.00'), // ignored for OUT
      referenceType: 'Invoice',
      referenceId: '99',
    },
  });

  assert.ok(res.computedInsert.unitCostApplied.equals(D('10.00')));
  assert.ok(res.computedInsert.totalCostApplied.equals(D('30.00')));

  assert.ok(res.finalBalance.qtyOnHand.equals(D('13.00')));
  assert.ok(res.finalBalance.inventoryValue.equals(D('80.00')));
  assert.ok(res.finalBalance.avgUnitCost.equals(D('6.15')));
});

test('stock backdating: rejects when backdated insert itself would oversell at that date', () => {
  const existingMoves = [
    {
      id: 1,
      date: day('2025-12-01'),
      type: 'PURCHASE_RECEIPT' as const,
      direction: 'IN' as const,
      quantity: D('4.00'),
      unitCostApplied: D('10.00'),
      totalCostApplied: D('40.00'),
      referenceType: 'PurchaseBill',
      referenceId: '1',
    },
    {
      id: 2,
      date: day('2025-12-15'),
      type: 'SALE_ISSUE' as const,
      direction: 'OUT' as const,
      quantity: D('4.00'),
      unitCostApplied: D('10.00'),
      totalCostApplied: D('40.00'),
      referenceType: 'Invoice',
      referenceId: '10',
    },
    {
      id: 3,
      date: day('2025-12-20'),
      type: 'PURCHASE_RECEIPT' as const,
      direction: 'IN' as const,
      quantity: D('10.00'),
      unitCostApplied: D('5.00'),
      totalCostApplied: D('50.00'),
      referenceType: 'PurchaseBill',
      referenceId: '2',
    },
  ];

  assert.throws(() => {
    _test_replayStockMovesWithBackdatedInsert({
      existingMoves,
      insert: {
        companyId: 1,
        locationId: 1,
        itemId: 1,
        date: day('2025-12-10'),
        allowBackdated: true,
        type: 'SALE_ISSUE',
        direction: 'OUT',
        quantity: D('7.00'),
        unitCostApplied: D('0.00'),
      },
    });
  }, /insufficient stock \(backdated insert\)/);
});

test('stock backdating: rejects when backdated insert would make a later move oversell (timeline replay)', () => {
  const existingMoves = [
    {
      id: 1,
      date: day('2025-12-01'),
      type: 'PURCHASE_RECEIPT' as const,
      direction: 'IN' as const,
      quantity: D('10.00'),
      unitCostApplied: D('10.00'),
      totalCostApplied: D('100.00'),
      referenceType: 'PurchaseBill',
      referenceId: '1',
    },
    {
      id: 2,
      date: day('2025-12-15'),
      type: 'SALE_ISSUE' as const,
      direction: 'OUT' as const,
      quantity: D('9.00'),
      unitCostApplied: D('10.00'),
      totalCostApplied: D('90.00'),
      referenceType: 'Invoice',
      referenceId: '10',
    },
  ];

  assert.throws(() => {
    _test_replayStockMovesWithBackdatedInsert({
      existingMoves,
      insert: {
        companyId: 1,
        locationId: 1,
        itemId: 1,
        date: day('2025-12-10'),
        allowBackdated: true,
        type: 'SALE_ISSUE',
        direction: 'OUT',
        quantity: D('5.00'),
        unitCostApplied: D('0.00'),
      },
    });
  }, /insufficient stock \(timeline replay\)/);
});


