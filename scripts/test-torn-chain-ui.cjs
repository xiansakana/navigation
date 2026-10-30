// Real local Portal monitoring service, simulated Torn API; external requests blocked.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const Database = require('../portal/node_modules/better-sqlite3');
async function startFixture() {
  const root = path.resolve(__dirname, '..');
  const { createDestructionStore } = await import(pathToFileURL(root + '/portal/src/torn-destruction-monitor.js'));
  const { createTornChainService } = await import(pathToFileURL(root + '/portal/src/torn-chain.js'));
  const { createFactionStore } = await import(pathToFileURL(root + '/portal/src/torn-faction-scan.js'));
  const { createFactionService } = await import(pathToFileURL(root + '/portal/src/torn-factions.js'));
  const db = new Database(':memory:'), store = createDestructionStore(db), factionStore = createFactionStore(db), deliveries = [];
  let phase = 0, guest = false;
  const keys = ['1234567890abcdef', 'abcdef1234567890', 'fedcba0987654321'];
  store.save('tester', { apiKeys: keys }); factionStore.save('tester', { apiKey: keys[1] });
  const row = (id, respect = 100, dead = false) => ({ id, name: id === 1 ? '<img src=x onerror=alert(1)>' : 'Faction ' + id, respect, is_destroyed: dead, leader: { id: id + 1000, name: 'Leader ' + id } });
  const service = createTornChainService({ store, authorizeNotify: () => true, sendNotification: async (settings, record) => { deliveries.push(record); }, monitorOptions: { schedule: () => 1, cancel: () => {}, now: () => 1000 + phase * 15 }, request: async (route, key) => {
    if (route === 'key/info') { if (key === keys[0]) throw Object.assign(new Error('Invalid Key'), { apiCode: 2, fatal: true }); return { info: { user: { id: key === keys[1] ? 1 : 2 } } }; }
    const filter = new URL(route, 'https://api.torn.com/v2/').searchParams.get('filters');
    if (filter === 'id:=:1') return { search: [row(1, 0, phase >= 2)] };
    if (filter === 'id:=:2') return { search: [] };
    if (phase === 1) return { search: [row(1,0,false), ...Array.from({length:53},(_,i)=>row(i+3,95))], _metadata: {links:{next:null}} };
    return { search: Array.from({ length: phase ? 53 : 55 }, (_, i) => row(i + (phase ? 3 : 1), phase ? 95 : 100)), _metadata: { links: { next: null } } };
  } });
  const factions = createFactionService({ store: factionStore, request: async () => { throw Error('No faction scan expected'); } });
  const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/fixture/advance' && req.method === 'POST') { phase++; const m = service.monitors.get('tester'); await m.scan(); return json(res, 200, { ok: true, notifications: deliveries.length }); }
      if (url.pathname === '/fixture/guest' && req.method === 'POST') { guest = !guest; return json(res, 200, { ok: true }); }
      const session = { userId: 'tester', isGuest: guest, permissions: ['*'] };
      if (url.pathname === '/api/me/torn-toolbox-access') return json(res,200,{ok:true,chain:true,shopping:false});
      if (url.pathname.startsWith('/api/torn-users/')) return json(res,403,{ok:false,error:'Not part of this fixture'});
      if (url.pathname.startsWith('/api/torn-chain/')) return service.handle(req, res, url, session, json);
      if (url.pathname.startsWith('/api/torn-factions/')) return factions.handle(req, res, url, session, json);
      const file = path.join(root, 'portal/public', url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname);
      if (!file.startsWith(path.join(root, 'portal/public') + path.sep)) return json(res, 404, {});
      const body = await fs.readFile(file); res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8'); res.end(body);
    } catch (error) { json(res, 500, { ok: false, error: error.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: 'http://127.0.0.1:' + server.address().port, service, close: async () => { for (const m of service.monitors.values()) { m.stop(); await m.promise; } await new Promise(resolve => server.close(resolve)); db.close(); } };
}
module.exports = { startFixture };
async function main() {
  const { chromium } = require('playwright'), f = await startFixture();
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === f.origin ? route.continue() : route.abort());
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(f.origin + '/torn-toolbox/'); await page.waitForSelector('#chain-card:not([hidden])');
    assert.equal(await page.locator('#chain-card h2').innerText(), '监控'); await page.locator('#chain-card').click();
    await page.waitForFunction(() => !document.querySelector('#api-key').disabled);
    assert.equal(await page.locator('h1').innerText(), '监控'); assert.equal(await page.locator('#api-key').inputValue(), '');
    assert.equal(await page.locator('#min-respect').inputValue(), '0'); assert.equal(await page.locator('#max-respect').inputValue(), '10000');
    assert.equal(await page.locator('#bonus-options').count(), 0);
    await page.locator('#start').click(); await page.waitForFunction(() => document.querySelector('#status').textContent.includes('已完成 1 轮'));
    assert.match(await page.locator('#coverage').innerText(), /Key 可用 2\/3/); assert.equal(await page.locator('#monitor-chains tr').count(), 50);
    await page.locator('#monitor-next').click(); await page.waitForFunction(() => document.querySelectorAll('#monitor-chains tr').length === 5); assert.equal(await page.locator('#monitor-chains tr').count(), 5);
    const advanced = await context.request.post(f.origin + '/fixture/advance'); assert.equal((await advanced.json()).notifications, 1);
    await page.reload(); await page.waitForSelector('#history article');
    assert.equal(await page.locator('#history article').count(), 1); assert.equal(await page.locator('#history img').count(), 0);
    assert.match(await page.locator('#history').innerText(), /最后存活/); assert.match(await page.locator('#history').innerText(), /发现清零/); assert.match(await page.locator('#history').innerText(), /尚未标记摧毁/);
    const confirmation=await context.request.post(f.origin+'/fixture/advance'); assert.equal((await confirmation.json()).notifications,1);
    await page.reload(); await page.waitForSelector('#history article'); assert.match(await page.locator('#history').innerText(), /后续已确认摧毁/);
    assert.equal(await page.locator('#history a').last().getAttribute('href'), 'https://www.torn.com/profiles.php?XID=1001');
    await page.locator('#monitor-filter').selectOption('problem'); await page.waitForFunction(() => document.querySelectorAll('#monitor-chains tr').length === 1); assert.equal(await page.locator('#monitor-chains tr').count(), 1);
    await page.locator('#monitor-filter').selectOption('all');
    await page.locator('#stop').click(); await page.locator('#max-respect').fill('20000'); await page.locator('#save').click();
    await page.waitForFunction(() => document.querySelector('#message').textContent.includes('配置已保存'));
    await page.reload(); await page.waitForFunction(() => document.querySelector('#max-respect').value === '20000');
    assert.match(await page.locator('#key-status').innerText(), /3 个 Key/);
    const widths = () => page.evaluate(() => ({ main: document.querySelector('[data-layout-container]').getBoundingClientRect().width, navbar: document.querySelector('header > div').getBoundingClientRect().width }));
    const before = await widths(); await page.locator('.navbar-layout-btn').click();
    await page.waitForFunction(() => document.querySelector('[data-layout-container]').getBoundingClientRect().width === 1600);
    const full = await widths(); assert.equal(full.navbar, 1600); await page.reload(); assert.equal((await widths()).main, 1600);
    await page.locator('.navbar-layout-btn').click(); await page.waitForFunction(() => document.querySelector('[data-layout-container]').getBoundingClientRect().width === 1100);
    assert.deepEqual(await widths(), before);
    await page.locator('#tab-factions').click(); assert.equal(await page.locator('#faction-view').isVisible(), true);
    for (const width of [390, 320]) { await page.setViewportSize({ width, height: 850 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); }
    await page.locator('#tab-chain').click();
    for (const width of [390, 320]) { await page.setViewportSize({ width, height: 850 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); }
    await context.request.post(f.origin + '/fixture/guest'); await page.reload(); await page.waitForSelector('#chain-readonly-note:not([hidden])');
    assert.equal(await page.locator('#min-respect').isDisabled(), true); assert.equal(await page.locator('#save').isVisible(), false); assert.equal(await page.locator('#start').isVisible(), false);
    assert.equal(await page.locator('#history article').count(), 1); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, multiKey: true, eventNotifications: 1, unknownNotDestroyed: true, safeText: true, guestReadOnly: true, mobile: [390, 320], before, full, restored: before }));
    await context.close();
  } finally { await browser.close(); await f.close(); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
