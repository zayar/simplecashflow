import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { computeRemainingByPoLine } from '../src/modules/purchases/receiving.service.js';

const D = (v: string | number) => new Prisma.Decimal(v);

test('receiving: remaining qty is ordered minus received for linked PO lines', () => {
  const remaining = computeRemainingByPoLine({
    poLines: [
      { id: 1, itemId: 10, quantity: D('10.00') },
      { id: 2, itemId: 11, quantity: D('5.00') },
    ],
    receiptLines: [
      { purchaseOrderLineId: 1, quantity: D('3.00') },
      { purchaseOrderLineId: 1, quantity: D('2.00') },
      { purchaseOrderLineId: 2, quantity: D('1.50') },
      { purchaseOrderLineId: null, quantity: D('999.00') }, // ignored
    ],
  });

  assert.ok((remaining.get(1) ?? D(0)).equals(D('5.00')));
  assert.ok((remaining.get(2) ?? D(0)).equals(D('3.50')));
});

