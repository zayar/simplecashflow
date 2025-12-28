import test from 'node:test';
import assert from 'node:assert/strict';
import { isFutureBusinessDate } from '../src/utils/docDatePolicy.js';

test('doc date policy: detects future business date in Asia/Yangon', () => {
  const now = new Date('2025-12-26T08:00:00.000Z');
  const future = new Date('2026-01-01T00:00:00.000Z');
  assert.equal(isFutureBusinessDate({ date: future, now, timeZone: 'Asia/Yangon' }), true);
});

test('doc date policy: same business date is not future', () => {
  const now = new Date('2025-12-26T08:00:00.000Z');
  // Asia/Yangon is UTC+06:30, so keep the later timestamp within the same Yangon calendar day.
  const sameDayLater = new Date('2025-12-26T10:00:00.000Z');
  assert.equal(isFutureBusinessDate({ date: sameDayLater, now, timeZone: 'Asia/Yangon' }), false);
});


