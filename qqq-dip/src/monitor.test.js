import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitor } from './monitor.js';

function fixture() {
  let round = {};
  return {
    getSettings: () => ({ intervalSeconds: 30 }),
    getCash: () => ({ cashUsd: 1000, cashCny: 0, usdCnyRate: 7 }),
    getRound: () => round,
    getLots: () => [],
    getQuotes: () => ({}),
    getNotify: () => ({}),
    setQuotes: () => {},
    setRound: (value) => { round = value; },
    addAction: () => ({})
  };
}

test('monitor persists observed peaks across ticks without manufacturing sales', async () => {
  let lots = [{ id: 'deep', type: 'call', symbol: 'QQQ270115C700', cost: 1, otmClass: 'deep' }];
  let price = 6;
  const store = { ...fixture(), getLots: () => lots, saveLot: (lot) => { lots = [lot]; } };
  const monitor = createMonitor({ store, quotes: {
    parseOptionSymbol: () => ({}), getOptionSnapshot: async () => ({ price }),
    getMarketBundle: async () => ({ markets: { QQQ: { price: 100, low: 100,
      candles: [{ h: 100, c: 100 }] } }, errors: {} }), searchLeapCalls: async () => []
  } });
  await monitor.tick({ silent: true });
  assert.equal(lots[0].holdingHigh, 6);
  assert.equal(lots[0].reached3x, true);
  assert.equal(lots[0].reached5x, true);
  assert.equal(lots[0].sold5x, undefined);
  price = 3;
  const ev = await monitor.tick({ silent: true });
  assert.equal(ev.lots[0].holdingHigh, 6);
  assert.ok(ev.lots[0].alerts.some((alert) => alert.code === 'deep-5x-dd40'));
});

test('hung quotes release busy state and a subsequent tick completes', async () => {
  let requests = 0;
  const snapshots = [];
  const monitor = createMonitor({
    store: fixture(),
    stageTimeoutMs: 20,
    quotes: {
      getMarketBundle: () => ++requests === 1 ? new Promise(() => {}) : Promise.resolve({
        markets: Object.fromEntries(['QQQ', 'TQQQ', 'SOXL', 'SPY'].map((symbol) => [symbol, {
          price: 100, close: 100, high: 100, low: 100,
          candles: Array.from({ length: 40 }, (_, index) => ({ t: index * 86400, c: 100, h: 100, l: 100 }))
        }])),
        errors: {}
      }),
      searchLeapCalls: async () => []
    },
    onSnapshot: (snapshot) => snapshots.push(snapshot)
  });
  await assert.rejects(monitor.tick({ silent: true }), /marketQuotes.*超时/);
  assert.equal(monitor.status().busy, false);
  assert.equal(monitor.status().phase, 'idle');
  assert.equal(monitor.status().consecutiveFailures, 1);
  await monitor.tick({ silent: true });
  assert.equal(monitor.status().checks, 1);
  assert.equal(monitor.status().consecutiveFailures, 0);
  assert.ok(monitor.status().lastCompletedAt);
  assert.ok(snapshots.every((snapshot) => snapshot.monitor.busy === false));
});

test('overall tick budget bounds an otherwise longer stage deadline', async () => {
  const monitor = createMonitor({
    store: fixture(),
    refreshFx: () => new Promise(() => {}),
    quotes: {},
    stageTimeoutMs: 60000,
    tickTimeoutMs: 20
  });
  await assert.rejects(monitor.tick({ silent: true }), /refreshFx.*超时/);
  assert.equal(monitor.status().busy, false);
  assert.equal(monitor.status().checks, 0);
});
