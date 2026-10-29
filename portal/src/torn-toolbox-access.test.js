import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { tornToolboxAccess } from './torn-toolbox-access.js';
import { resolveRoute } from './router.js';

test('toolbox access endpoint reaches authenticated Portal routing without a worker proxy', () => {
  assert.equal(resolveRoute([], '/api/me/torn-toolbox-access', 'GET').kind, 'portal-api');
  assert.equal(resolveRoute([], '/api/me/torn-toolbox-access', 'POST').kind, 'not-found');
});

test('toolbox visibility uses scoped view permissions and denies unavailable scopes without asking the worker', () => {
  const session = { userId: 'viewer', permissions: ['*'] };
  const access = (_req, _session, module) => ({ ownerId: 'owner', permissions: [module + ':view'] });
  assert.deepEqual(tornToolboxAccess({}, session, {}, access), { shopping: true, chain: true });
  assert.deepEqual(tornToolboxAccess({}, session, {}, () => ({ ownerId: 'owner', permissions: [] })), { shopping: false, chain: false });
  assert.deepEqual(tornToolboxAccess({}, session, {}, () => { throw Error('scope denied'); }), { shopping: false, chain: false });
});

test('card loader uses Portal access only and recovers from temporary permission lookup failure', async () => {
  const dom = new JSDOM('<a id="shopping-card" hidden></a><a id="chain-card" hidden></a>', { runScripts: 'outside-only' });
  const w = dom.window, timers = [], requests = []; let calls = 0;
  w.AbortSignal = AbortSignal;
  w.setTimeout = fn => { timers.push(fn); };
  w.fetch = async url => { requests.push(url); if (++calls === 1) throw Error('temporary outage'); return { ok: true, status: 200, json: async () => ({ ok: true, shopping: true, chain: false }) }; };
  const until = async check => { const end = Date.now() + 1000; while (!check() && Date.now() < end) await new Promise(resolve => setImmediate(resolve)); assert.ok(check()); };
  try {
    w.eval(readFileSync(new URL('../public/torn-toolbox/cards.js', import.meta.url), 'utf8'));
    await until(() => timers.length === 1); await timers.shift()();
    await until(() => !w.document.getElementById('shopping-card').hidden);
    assert.equal(w.document.getElementById('chain-card').hidden, true);
    assert.ok(requests.every(url => url === '/api/me/torn-toolbox-access'));
  } finally { w.close(); }
});
