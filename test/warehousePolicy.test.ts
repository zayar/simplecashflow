import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocationForStockIssue } from '../src/modules/books/warehousePolicy.js';

test('location policy: invoice location overrides item default', () => {
  const lid = resolveLocationForStockIssue({
    invoiceLocationId: 10,
    itemDefaultLocationId: 20,
    companyDefaultLocationId: 30,
  });
  assert.equal(lid, 10);
});

test('location policy: falls back to item default when invoice location is missing', () => {
  const lid = resolveLocationForStockIssue({
    invoiceLocationId: null,
    itemDefaultLocationId: 20,
    companyDefaultLocationId: 30,
  });
  assert.equal(lid, 20);
});

test('location policy: falls back to company default when invoice and item are missing', () => {
  const lid = resolveLocationForStockIssue({
    invoiceLocationId: null,
    itemDefaultLocationId: null,
    companyDefaultLocationId: 30,
  });
  assert.equal(lid, 30);
});

test('location policy: invalid/zero values are treated as missing', () => {
  const lid = resolveLocationForStockIssue({
    invoiceLocationId: 0,
    itemDefaultLocationId: -1,
    companyDefaultLocationId: 7,
  });
  assert.equal(lid, 7);
});


