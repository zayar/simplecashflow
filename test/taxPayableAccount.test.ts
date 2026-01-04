import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTaxPayableAccount, pickFirstUnusedNumericCode } from '../src/utils/tax.js';

test('pickFirstUnusedNumericCode returns first free numeric code', () => {
  const used = new Set<string>(['2100', '2101', '2102']);
  assert.equal(pickFirstUnusedNumericCode(used, 2100, 2105), '2103');
});

test('ensureTaxPayableAccount prefers existing "Tax Payable" by name even if 2100 is used for another liability', async () => {
  const calls: string[] = [];
  const tx: any = {
    account: {
      findFirst: async (args: any) => {
        calls.push(`findFirst:${JSON.stringify(args.where)}`);
        // No Tax Payable by name
        return null;
      },
      findMany: async (args: any) => {
        calls.push(`findMany:${JSON.stringify(args.where)}`);
        // Liability codes already include 2100 (e.g., Customer Advance)
        return [{ code: '2100' }, { code: '2105' }];
      },
      create: async (args: any) => {
        calls.push(`create:${args.data.code}:${args.data.name}`);
        assert.equal(args.data.name, 'Tax Payable');
        assert.equal(args.data.type, 'LIABILITY');
        // Should NOT reuse 2100 since it's already taken
        assert.equal(args.data.code, '2101');
        return { id: 999 };
      },
    },
  };

  const id = await ensureTaxPayableAccount(tx, 1);
  assert.equal(id, 999);
  assert.ok(calls.some((c) => c.startsWith('create:')), 'expected Tax Payable to be created');
});

test('ensureTaxPayableAccount returns existing Tax Payable by name without creating', async () => {
  const calls: string[] = [];
  const tx: any = {
    account: {
      findFirst: async () => {
        calls.push('findFirst');
        return { id: 123 };
      },
      findMany: async () => {
        calls.push('findMany');
        return [];
      },
      create: async () => {
        calls.push('create');
        return { id: 999 };
      },
    },
  };

  const id = await ensureTaxPayableAccount(tx, 1);
  assert.equal(id, 123);
  assert.deepEqual(calls, ['findFirst']);
});


