import test from 'node:test';
import assert from 'node:assert/strict';
import { isUsOptionMarketOpen } from './yolo-collector.js';

test('US option market schedule uses New York time', () => {
  assert.equal(isUsOptionMarketOpen(new Date('2026-09-22T14:00:00Z')), true);
  assert.equal(isUsOptionMarketOpen(new Date('2026-09-22T21:00:00Z')), false);
  assert.equal(isUsOptionMarketOpen(new Date('2026-09-26T14:00:00Z')), false);
});
