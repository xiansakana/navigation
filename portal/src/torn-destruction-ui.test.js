import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';

async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() >= deadline) throw new Error('UI condition timeout'); await delay(5); }
}
test('a background poll cannot overwrite a pending previous-page or filter choice', async t => {
  const dom = new JSDOM(fs.readFileSync(new URL('../public/torn-toolbox/chain/index.html', import.meta.url), 'utf8'), { url: 'https://test/torn-toolbox/chain/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close()); const w = dom.window, d = w.document;
  const calls = []; let poll;
  w.setInterval = fn => { poll = fn; return 1; };
  w.fetch = url => new Promise(resolve => calls.push({ url, resolve }));
  const state = offset => ({ ok: true, config: { minRespect: 0, maxRespect: 10000, intervalSeconds: 15, apiIntervalSeconds: 2, hasKey: true, keyCount: 1 }, permissions: { configure: true, control: true, clear: true }, history: [], state: { running: true, rounds: 1, problems: [], factionsTotal: 100, factionsOffset: offset, factionsLimit: 50, factions: Array.from({ length: 50 }, (_, i) => ({ id: i + offset + 1, name: 'Faction ' + (i + offset + 1), leaderId: 1001, respect: 10, lastAliveAt: 1000 })) } });
  const respond = (call, data) => call.resolve({ ok: true, json: async () => data });
  w.eval(fs.readFileSync(new URL('../public/torn-toolbox/chain/app.js', import.meta.url), 'utf8'));
  respond(calls[0], state(0)); await until(() => d.querySelectorAll('#monitor-chains tr').length === 50);
  d.getElementById('monitor-next').click(); await until(() => calls.length === 2);
  respond(calls[1], state(50)); await until(() => d.getElementById('monitor-page').textContent.startsWith('51–100'));
  poll(); await until(() => calls.length === 3); // hold the refresh for page two
  d.getElementById('monitor-prev').click();
  respond(calls[2], state(50)); await until(() => calls.length === 4);
  assert.match(calls[3].url, /offset=0/);
  respond(calls[3], state(0)); await until(() => d.getElementById('monitor-page').textContent.startsWith('1–50'));
  assert.equal(d.querySelector('#monitor-chains tr').dataset.factionId, '1');
  poll(); await until(() => calls.length === 5);
  d.getElementById('monitor-filter').value = 'problem'; d.getElementById('monitor-filter').dispatchEvent(new w.Event('change'));
  respond(calls[4], state(0)); await until(() => calls.length === 6);
  assert.match(calls[5].url, /filter=problem/);
  respond(calls[5], { ...state(0), state: { ...state(0).state, factions: [], factionsTotal: 0 } });
  await until(() => d.querySelectorAll('#monitor-chains tr').length === 0);
  assert.equal(d.getElementById('monitor-page').textContent, '0–0 / 0');
});
