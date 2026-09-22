import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../../shared/db/schema.js';
import { createYoloStore } from './yolo-store.js';

test('stores QQQ option captures per user and exposes backtest dataset', (context) => {
  let db;
  try { db = new Database(':memory:'); }
  catch { context.skip('better-sqlite3 native binding is unavailable for this Node runtime'); return; }
  initSchema(db);
  const store = createYoloStore({}, db);
  const snapshot = {
    capturedAt: '2026-09-22T13:45:00.000Z', marketDate: '2026-09-22', expiration: '2026-09-23',
    underlyingPrice: 600, source: 'test', contracts: [{
      optionSymbol: 'O:QQQ260923C00600000', right: 'C', strike: 600, expiration: '2026-09-23',
      bid: 1, ask: 1.1, bidSize: 2, askSize: 3, last: 1.05, delta: 0.45,
      gamma: 0.02, theta: -0.1, vega: 0.04, iv: 0.25, volume: 5, openInterest: 10
    }]
  };
  store.saveCapture('user-a', snapshot);
  store.saveCapture('user-a', snapshot);
  assert.equal(store.status('user-a').stats.captures, 1);
  assert.equal(store.status('user-a').stats.quoteRows, 1);
  assert.equal(store.status('user-b').stats.captures, 0);
  assert.equal(store.dataset('user-a')[0].quotes[0].bid, 1);
  db.close();
});
