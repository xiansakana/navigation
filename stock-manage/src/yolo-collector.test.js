import test from 'node:test';
import assert from 'node:assert/strict';
import { createYoloCollector, isUsOptionMarketOpen } from './yolo-collector.js';

test('US option market schedule uses New York time', () => {
  assert.equal(isUsOptionMarketOpen(new Date('2026-09-22T14:00:00Z')), true);
  assert.equal(isUsOptionMarketOpen(new Date('2026-09-22T21:00:00Z')), false);
  assert.equal(isUsOptionMarketOpen(new Date('2026-09-26T14:00:00Z')), false);
});

test('previous-session backfill saves a daily summary without using the intraday loader', async () => {
  const saved = [];
  const store = {
    saveCapture(userId, snapshot) { saved.push({ userId, snapshot }); },
    markAttempt() {},
    enabledUsers() { return []; }
  };
  const quotes = {
    async getQqqPreviousSessionSummary() {
      return { marketDate: '2026-09-21', captureKind: 'daily-summary', contracts: [{}] };
    },
    async getQqq1dteChain() { throw new Error('intraday loader should not run'); }
  };
  const collector = createYoloCollector({ store, quotes });
  const snapshot = await collector.backfillPreviousSession('user-a');
  assert.equal(snapshot.captureKind, 'daily-summary');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].userId, 'user-a');
});
