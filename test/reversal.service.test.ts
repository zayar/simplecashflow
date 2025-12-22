import test from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from '@prisma/client/runtime/library';
import { buildAdjustmentLinesFromNets, computeNetByAccount, diffNets } from '../src/modules/ledger/reversal.service.js';

test('computeNetByAccount returns debit-credit net per account and removes zeros', () => {
  const nets = computeNetByAccount([
    { accountId: 1, debit: new Decimal('10.00'), credit: new Decimal('0.00') },
    { accountId: 1, debit: new Decimal('0.00'), credit: new Decimal('3.00') },
    { accountId: 2, debit: new Decimal('0.00'), credit: new Decimal('7.00') },
    { accountId: 3, debit: new Decimal('1.00'), credit: new Decimal('1.00') },
  ]);

  assert.equal(nets.get(1)?.toString(), '7');
  assert.equal(nets.get(2)?.toString(), '-7');
  assert.equal(nets.has(3), false);
});

test('diffNets computes desired-original delta per account', () => {
  const original = new Map<number, Decimal>([
    [1, new Decimal('10.00')],
    [2, new Decimal('-10.00')],
  ]);
  const desired = new Map<number, Decimal>([
    [1, new Decimal('12.00')],
    [2, new Decimal('-12.00')],
  ]);

  const delta = diffNets(original, desired);
  assert.equal(delta.get(1)?.toString(), '2');
  assert.equal(delta.get(2)?.toString(), '-2');
});

test('buildAdjustmentLinesFromNets produces balanced lines for balanced delta nets', () => {
  const delta = new Map<number, Decimal>([
    [100, new Decimal('5.00')],
    [200, new Decimal('-5.00')],
  ]);

  const lines = buildAdjustmentLinesFromNets(delta);
  assert.equal(lines.length, 2);

  const totalDebit = lines.reduce((sum, l) => sum.add(l.debit), new Decimal(0)).toDecimalPlaces(2);
  const totalCredit = lines.reduce((sum, l) => sum.add(l.credit), new Decimal(0)).toDecimalPlaces(2);
  assert.ok(totalDebit.equals(new Decimal('5.00')));
  assert.ok(totalCredit.equals(new Decimal('5.00')));
});


