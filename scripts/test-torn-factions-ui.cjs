// Optional browser check: NODE_PATH must include Playwright. All Torn requests
// use fixtures and every browser request outside this local origin is blocked.
const { chromium } = require('playwright');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const Database = require(require.resolve('better-sqlite3', { paths: [path.join(__dirname, '../portal')] }));

(async () => {
  const { createFactionStore } = await import('../portal/src/torn-faction-scan.js');
  const { createFactionService } = await import('../portal/src/torn-factions.js');
  const db = new Database(':memory:'), store = createFactionStore(db), today = 20000, DAY = 86400;
  const keys = ['1234567890abcdef', 'abcdef1234567890', 'fedcba0987654321'], calls = [];
  let writable = true;
  const request = async (route, key) => {
    calls.push({ route, key });
    if (route === 'key/info') return { info: { user: { id: key === keys[2] ? 2 : 1 } } };
    if (route.includes('/search')) return { search: [{ id: 10, name: 'Fixture Faction', respect: 100, leader: { id: 1010, name: 'Fixture Leader' } }], _metadata: { links: { next: null } } };
    if (route.endsWith('/basic')) return { basic: { id: 10, leader_id: 1010 } };
    if (route.endsWith('/profile')) return { profile: { id: 1010, faction_id: 10, signed_up: (today - 1001) * DAY, last_action: { timestamp: (today - 20) * DAY } } };
    if (route.endsWith('/faction')) return { faction: { id: 10, days_in_faction: 500 } };
    const day = Number(new URL(route, 'https://api.torn.com/v2/').searchParams.get('timestamp')) / DAY;
    return { personalstats: [{ name: 'networth', value: day < today - 30 ? 2000000000 : 500000000, timestamp: (day < today - 30 ? today - 1000 : today - 30) * DAY }] };
  };
  const service = createFactionService({ store, request, scannerOptions: { now: () => today * DAY + 3600 } });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1'), pathname = url.pathname;
      const json = (_, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (pathname.startsWith('/api/torn-factions/')) return await service.handle(req, res, url, { userId: 'fixture', permissions: writable ? ['*'] : ['torn-chain:view', 'torn-factions:view'] }, json);
      if (pathname.startsWith('/api/')) return json(res, 403, { ok: false, error: 'Fixture only' });
      const file = pathname === '/ui/back-to-top.js' ? path.join(__dirname, '../shared/ui/back-to-top.js') : path.join(__dirname, '../portal/public', pathname.endsWith('/') ? pathname + 'index.html' : pathname);
      const data = await readFile(file);
      res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8'); res.end(data);
    } catch (error) { console.error('Fixture error:', error.message); res.writeHead(500); res.end('Fixture error'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const origin = 'http://127.0.0.1:' + server.address().port;
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/torn-toolbox/chain/#factions');
    await page.locator('#faction-save').waitFor({ state: 'visible' }).catch(async error => {
      console.error(JSON.stringify({ errors, message: await page.locator('#faction-message').textContent(), tabHidden: await page.locator('#faction-view').getAttribute('hidden') }));
      throw error;
    });
    assert.equal(await page.locator('#faction-historyDays').inputValue(), '');
    assert.equal(await page.locator('#faction-historyDays').getAttribute('required'), null);
    await page.locator('#faction-apiKeys').fill(keys.join('\n'));
    await page.locator('#faction-historyDays').fill('90');
    await page.locator('#faction-save').click();
    await page.waitForFunction(() => document.querySelector('#faction-key-status').textContent.includes('3 个 Key'));
    assert.equal(store.get('fixture').config.historyMode, 'window');
    assert.equal(store.get('fixture').config.historyDays, 90);
    assert.equal(await page.locator('#faction-apiKeys').inputValue(), '');
    await page.locator('#faction-historyDays').fill(''); await page.locator('#faction-save').click();
    await page.waitForFunction(() => document.querySelector('#faction-estimate').textContent.includes('N 未填写'));
    assert.equal(store.get('fixture').config.historyMode, 'full');
    assert.deepEqual(store.get('fixture').config.apiKeys, keys);
    await page.locator('#faction-start').click();
    await page.waitForFunction(() => document.querySelector('#faction-counts').textContent.includes('命中 1'));
    assert.equal(service.scanners.get('fixture').run.ownerCount, 2);
    assert.equal(calls.filter(c => c.route.includes('/personalstats')).length, 2);
    assert.equal(service.scanners.get('fixture').run.rows[0].loadedDays, 1001);
    const state = await page.evaluate(async () => (await fetch('/api/torn-factions/state')).text());
    for (const key of keys) assert.ok(!state.includes(key));
    const measure = () => page.evaluate(() => ({ content: document.querySelector('[data-layout-container]').getBoundingClientRect().width, navbar: document.querySelector('.navbar-inner').getBoundingClientRect().width }));
    for (const tab of ['factions', 'chain']) {
      await page.locator('#tab-' + tab).click();
      const before = await measure(); await page.locator('.navbar-layout-btn').click(); const full = await measure();
      assert.ok(full.content >= 1580 && full.navbar >= 1580, JSON.stringify({ tab, full }));
      assert.ok(full.content > before.content && full.navbar > before.navbar);
      assert.equal(await page.locator('.navbar-layout-btn').getAttribute('aria-pressed'), 'true');
      await page.reload(); assert.deepEqual(await measure(), full);
      await page.locator('.navbar-layout-btn').click(); assert.deepEqual(await measure(), before);
      await page.reload(); assert.equal(await page.locator('.navbar-layout-btn').getAttribute('aria-pressed'), 'false');
      console.log(JSON.stringify({ tab, before, full, restored: await measure() }));
    }
    await page.locator('#tab-factions').click();
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile overflow at ' + width);
    }
    await page.screenshot({ path: process.env.FACTION_SCREENSHOT || '/tmp/navigation-factions-ui.png', fullPage: true });
    writable = false; await page.reload();
    await page.locator('#faction-apiKeys:disabled').waitFor();
    assert.equal(await page.locator('#faction-save').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('N blank/window, key replacement/privacy, owner grouping, real scanner, permissions, mobile and layout checks passed');
  } finally {
    for (const scanner of service.scanners.values()) { scanner.stop(); await scanner.promise; }
    await browser?.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
