import test from 'node:test';
import assert from 'node:assert/strict';
import { watchCash } from './cash-sync.js';

test('cash sync observes reservations and releases without a monitor or quote call', () => {
  let cash = { cashUsd: 9000, strategyCashUsd: 1000, strategyCashCny: 2000 };
  let tick, stopped = false;
  const messages = [];
  const stop = watchCash({ read: () => cash, send: (value) => messages.push(value),
    schedule: (callback, ms) => { assert.equal(ms, 2000); tick = callback; return 7; },
    cancel: (timer) => { assert.equal(timer, 7); stopped = true; } });
  tick(); assert.equal(messages.length, 0);
  cash = { ...cash, strategyCashUsd: 5000, strategyCashCny: 3000 }; tick();
  assert.equal(messages[0].strategyCashUsd, 5000);
  cash = { ...cash, strategyCashUsd: 0, strategyCashCny: 0 }; tick();
  assert.equal(messages[1].strategyCashCny, 0);
  assert.equal(messages[1].cashUsd, 9000);
  stop(); assert.equal(stopped, true);
});

test('transient read/send errors are retried and do not acknowledge a failed push', () => {
  let value = 1, tick, failed = true;
  const messages = [];
  const stop = watchCash({ read: () => ({ value }), send: (cash) => {
    if (failed) { failed = false; throw new Error('temporary'); } messages.push(cash);
  }, schedule: (callback) => { tick = callback; }, cancel: () => {} });
  value = 2; tick(); assert.equal(messages.length, 0);
  tick(); assert.deepEqual(messages, [{ value: 2 }]);
  stop();
});
