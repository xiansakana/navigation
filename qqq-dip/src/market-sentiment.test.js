import test from 'node:test';
import assert from 'node:assert/strict';
import { createSentimentLoader, parseSentimentArchive } from './market-sentiment.js';

const csv = `Date,Fear Greed,Rating
2026-10-29,40,fear
2026-10-30,35,fear
2026-11-02,19,extreme fear
2026-11-03,23,extreme fear
2026-11-04,34,fear
2026-11-05,19.88,extreme fear
2026-11-05,19.88,extreme fear
2026-11-06,60,greed`;

test('CNN archive excludes unfinished sessions and calculates changes across distinct observations', () => {
  const observation = parseSentimentArchive(csv, '2026-11-05');
  assert.equal(observation.score, 19.88);
  assert.equal(observation.asOf, '2026-11-05');
  assert.equal(observation.comparisonDate, '2026-10-29');
  assert.equal(observation.change5, -20.12);
  assert.throws(() => parseSentimentArchive('Date,Fear Greed,Rating\n2026-11-05,,fear', '2026-11-05'), /没有有效/);
});

test('archive cache refreshes when the expected session changes and preserves dated stale data on failure', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-06T20:59:00Z') });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1 ? { ok: true, arrayBuffer: async () => Buffer.from(csv) } : { ok: false, status: 403 };
  };
  const load = createSentimentLoader();
  const current = await load();
  assert.equal(current.stale, false);
  assert.equal((await load()).score, 19.88);
  assert.equal(calls, 1);
  t.mock.timers.tick(120000);
  const stale = await load();
  assert.equal(calls, 2);
  assert.equal(stale.stale, true);
  assert.equal(stale.asOf, '2026-11-05');
  assert.equal(stale.fetchedAt, current.fetchedAt);
});
