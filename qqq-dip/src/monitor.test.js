import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitor } from './monitor.js';
import { latestCompletedSession } from './market-hours.js';

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

function signalFixture(publish, extraStore = {}) {
  const actions = [];
  const store = { ...fixture(), ...extraStore, addAction: (a) => { actions.push(a); return a; } };
  const monitor = createMonitor({ store, publish: (config, event) => event.eventKey === 'openSummary'
    ? Promise.resolve({ skipped: true, reason: 'event-disabled' }) : publish(config, event), quotes: {
    getMarketBundle: async () => ({ markets: { QQQ: { price: 90, low: 90,
      candles: [{ t: Date.parse(`${latestCompletedSession()}T05:00:00Z`) / 1000, h: 100, l: 90, c: 90 }] } }, errors: {} }),
    searchLeapCalls: async () => []
  } });
  return { store, monitor, actions };
}

test('confirmed close waits through weekend and sends once after US opening', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-01T00:00:15Z') });
  const sent = [];
  const f = signalFixture(async (_, event) => { sent.push(event); return { sent: ['Slack'], errors: [] }; });
  await f.monitor.tick();
  assert.equal(sent.length, 0);
  assert.equal(f.store.getRound().marketDeliveries?.['T1:US'], undefined);
  t.mock.timers.setTime(Date.parse('2026-11-02T15:00:00Z'));
  await f.monitor.tick();
  await f.monitor.tick();
  assert.deepEqual(sent.map((s) => s.eventKey), ['T1']);
  assert.ok(f.store.getRound().marketDeliveries['T1:US']);
  assert.equal(f.actions.filter((a) => a.type === 'signal').length, 1);
});

test('silent evaluation does not consume delivery; failure retries after cooldown', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-02T15:00:00Z') });
  let calls = 0;
  const f = signalFixture(async () => {
    if (++calls === 1) throw new Error('offline');
    return { sent: ['Slack'], errors: [] };
  });
  await f.monitor.tick({ silent: true });
  assert.equal(calls, 0);
  assert.equal(f.store.getRound().marketDeliveries?.['T1:US'], undefined);
  await f.monitor.tick();
  await f.monitor.tick();
  assert.equal(calls, 1);
  t.mock.timers.tick(300001);
  await f.monitor.tick();
  assert.equal(calls, 2);
  assert.ok(f.store.getRound().firedAlerts.T1);
  assert.equal(f.actions.filter((a) => a.type === 'signal').length, 1);
});

test('a fill recorded during asynchronous notification is not overwritten by monitor persistence', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-02T15:00:00Z') });
  const f = signalFixture(async () => {
    const current = structuredClone(f.store.getRound());
    current.executed.T1 = { usd: 12, complete: false };
    current.executionPlans.T1.legs[0].spent = 12;
    f.store.setRound(current);
    return { sent: ['Slack'] };
  });
  await f.monitor.tick();
  assert.equal(f.store.getRound().executed.T1.usd, 12);
  assert.equal(f.store.getRound().executionPlans.T1.legs[0].spent, 12);
  assert.ok(f.store.getRound().marketDeliveries['T1:US']);
});

test('legacy off-hours signal and off-hours deliveries do not consume market reminder', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-02T15:00:00Z') });
  for (const attempted of [false, true]) {
    let round = { firedAlerts: { T1: '2026-11-01T00:00:15.758Z' } };
    let calls = 0;
    const f = signalFixture(async () => { calls++; return { sent: ['Slack'] }; }, {
      getRound: () => round, setRound: (r) => { round = r; },
      listActionRows: ({ offset }) => ({ items: offset ? [] : [
        { ts: '2026-11-01T00:00:15.757Z', type: 'signal', tier: 'T1', payload: { key: 'T1' } },
        ...(attempted ? [{ ts: '2026-11-01T00:00:16Z', type: 'notify', tier: 'T1', payload: { sent: ['Slack'] } }] : [])
      ] })
    });
    await f.monitor.tick();
    await f.monitor.tick();
    assert.equal(calls, 1);
    assert.equal(f.actions.filter((a) => a.type === 'signal').length, 0);
  }
});

test('disabled events and partial delivery do not resend successful targets', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-02T15:00:00Z') });
  for (const result of [{ skipped: true, reason: 'event-disabled' }, { sent: ['Slack'], errors: ['QQ offline'] }]) {
    let calls = 0;
    const f = signalFixture(async () => { calls++; return result; });
    await f.monitor.tick();
    t.mock.timers.tick(300001);
    await f.monitor.tick();
    assert.equal(calls, 1);
    assert.ok(f.store.getRound().firedAlerts.T1);
    assert.deepEqual(f.actions.find((a) => a.type === 'notify').payload.errors, result.errors);
  }
});

test('mixed plan sends CN and US at their respective openings, persisting independent dedupe', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-01T00:00:15Z') });
  let round = { executionPlans: { T1: { legs: [
    { symbol: '159509', currency: 'CNY', cny: 200, expiresAt: '2026-11-02T07:00:00Z' },
    { symbol: 'QQQ', currency: 'USD', usd: 40, expiresAt: '2026-11-02T21:00:00Z' }
  ] } } };
  const sent = [];
  const f = signalFixture(async (_, event) => { sent.push(event.message); return { sent: ['Slack'] }; }, {
    getRound: () => round, setRound: (r) => { round = JSON.parse(JSON.stringify(r)); }
  });
  await f.monitor.tick();
  assert.equal(sent.length, 0);
  t.mock.timers.setTime(Date.parse('2026-11-02T01:30:00Z'));
  await f.monitor.tick();
  await f.monitor.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /A股交易时段.*159509/s);
  assert.ok(round.marketDeliveries['T1:CN']);
  assert.equal(round.marketDeliveries['T1:US'], undefined);
  t.mock.timers.setTime(Date.parse('2026-11-02T14:30:00Z'));
  await f.monitor.tick();
  await f.monitor.tick();
  assert.equal(sent.length, 2);
  assert.match(sent[1], /美股交易时段.*QQQ/s);
  assert.ok(round.marketDeliveries['T1:US']);
});

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
