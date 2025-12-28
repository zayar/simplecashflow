import test from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from '@prisma/client/runtime/library';
import {
  assertTotalsMatchStored,
  buildInvoicePostingJournalLines,
  computeInvoiceTotalsAndIncomeBuckets,
  sumDebitsCredits,
} from '../src/modules/books/invoiceAccounting.js';

test('invoice math: tax is computed on net-of-discount and JE lines balance (AR/revenue/tax)', () => {
  const lines = [
    // Line 1: gross 200, discount 10 => net 190, tax 5% => 9.50
    { quantity: 1, unitPrice: 200, discountAmount: 10, taxRate: 0.05, incomeAccountId: 4000 },
    // Line 2: gross 50, discount 0 => net 50, tax 0 => 0
    { quantity: 2, unitPrice: 25, discountAmount: 0, taxRate: 0, incomeAccountId: 4000 },
  ];

  const { subtotal, taxAmount, total, incomeBuckets } = computeInvoiceTotalsAndIncomeBuckets(lines as any);

  assert.ok(new Decimal(subtotal).toDecimalPlaces(2).equals(new Decimal('240.00'))); // 190 + 50
  assert.ok(new Decimal(taxAmount).toDecimalPlaces(2).equals(new Decimal('9.50')));
  assert.ok(new Decimal(total).toDecimalPlaces(2).equals(new Decimal('249.50')));
  assert.ok((incomeBuckets.get(4000) ?? new Decimal(0)).toDecimalPlaces(2).equals(new Decimal('240.00')));

  const je = buildInvoicePostingJournalLines({
    arAccountId: 1100,
    total: new Decimal(total),
    incomeBuckets: new Map([[4000, new Decimal('240.00')]]),
    taxPayableAccountId: 2100,
    taxAmount: new Decimal('9.50'),
  });

  const sums = sumDebitsCredits(je);
  assert.ok(sums.debit.equals(sums.credit), `JE not balanced: Dr ${sums.debit} != Cr ${sums.credit}`);
  assert.ok(sums.debit.equals(new Decimal('249.50')));
});

test('invoice rounding guardrail: stored total mismatch is rejected', () => {
  assert.throws(() => {
    assertTotalsMatchStored(new Decimal('10.00'), new Decimal('10.01'));
  }, /rounding mismatch/);
});

test('invoice payment JE is balanced (Dr deposit, Cr AR)', () => {
  const paymentJe = [
    { accountId: 1000, debit: new Decimal('50.00'), credit: new Decimal('0.00') },
    { accountId: 1100, debit: new Decimal('0.00'), credit: new Decimal('50.00') },
  ];
  const sums = sumDebitsCredits(paymentJe);
  assert.ok(sums.debit.equals(sums.credit));
  assert.ok(sums.debit.equals(new Decimal('50.00')));
});


