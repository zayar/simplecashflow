import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPurchaseOrderNumber } from '../src/modules/sequence/sequence.service.js';

test('purchase order sequencing: nextPurchaseOrderNumber exists (unit smoke)', async () => {
  // This is a compile-time + import smoke test; it does not hit DB.
  assert.equal(typeof nextPurchaseOrderNumber, 'function');
});

