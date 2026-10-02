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
    beginAttempt() { return 1; },
    finishAttempt() {},
    commitCaptureAttempt(userId, id, snapshot) { saved.push({ userId, snapshot }); return { contractCount: 1 }; },
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

function auditStore() {
  const events = [];
  return { events, beginAttempt(user, trigger, requestedAt) { events.push({ type: 'begin', user, trigger, requestedAt }); return events.length; },
    finishAttempt(user, id, detail) { events.push({ type: 'finish', user, id, ...detail }); },
    commitCaptureAttempt(user, id, snapshot, detail) { events.push({ type: 'save', user, id, snapshot, detail }); return { contractCount: 2 }; },
    markAttempt() {}, enabledUsers() { return []; }, recoverAttempts() {} };
}

test('collector audits successful request and preserves request and provider times separately', async () => {
  const store = auditStore();
  const snapshot = { capturedAt: '2026-09-22T13:45:00Z', source: 'test', timestampOrigin: 'provider' };
  const collector = createYoloCollector({ store, quotes: { async getQqqOptionChains() { return snapshot; } },
    now: () => new Date('2026-09-22T14:00:00Z') });
  const result = await collector.captureNow('a');
  assert.equal(result.savedContracts, 2);
  assert.equal(store.events[0].trigger, 'manual');
  assert.equal(store.events[1].snapshot.receivedAt, '2026-09-22T14:00:00.000Z');
  assert.equal(store.events[1].detail.lagMs, 15 * 60 * 1000);
});

test('stale, off-session and fallback-time snapshots are audited without becoming intraday quotes', async () => {
  for (const [capturedAt, timestampOrigin, expected] of [
    ['2026-09-22T13:00:00Z', 'provider', 'stale'],
    ['2026-09-22T13:29:00Z', 'provider', 'off-session'],
    ['2026-09-22T13:40:00Z', 'received-fallback', 'invalid-time']
  ]) {
    const store = auditStore();
    const collector = createYoloCollector({ store, quotes: { async getQqqOptionChains() { return { capturedAt, timestampOrigin }; } },
      now: () => new Date('2026-09-22T13:45:00Z') });
    const result = await collector.captureNow('a');
    assert.equal(result.collectionStatus, expected);
    assert.equal(store.events.at(-1).status, expected);
    assert.ok(!store.events.some((event) => event.type === 'save'));
  }
});

test('network failure is persisted and manual overlapping requests do not report false success', async () => {
  const store = auditStore();
  let reject;
  const pending = new Promise((resolve, fail) => { reject = fail; });
  const collector = createYoloCollector({ store, quotes: { getQqqOptionChains() { return pending; } } });
  const run = collector.captureNow('a');
  await assert.rejects(collector.captureNow('a'), /正在运行/);
  reject(new Error('network timeout'));
  await assert.rejects(run, /network timeout/);
  assert.equal(store.events.at(-1).status, 'error');
  assert.equal(store.events.at(-1).error, 'network timeout');
});
