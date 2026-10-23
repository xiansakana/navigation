// Optional browser regression check: NODE_PATH must include Playwright.
// Serves a local fixture only; every external request is blocked.
const { chromium } = require('playwright');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  let writable = true, running = false, authorized = true;
  const config = { minHits: 100, maxHits: 500, intervalSeconds: 60, hasKey: true }, writes = [];
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      if (!authorized) { res.writeHead(403); return res.end(JSON.stringify({ ok: false, error: '无权访问' })); }
      if (req.method !== 'GET') {
        let body = ''; for await (const chunk of req) body += chunk;
        writes.push({ path: pathname, body: body && JSON.parse(body) });
        if (pathname.endsWith('/start')) running = true;
        if (pathname.endsWith('/stop')) running = false;
        return res.end('{"ok":true}');
      }
      return res.end(JSON.stringify({ ok: true, config, permissions: { configure: writable, control: writable, clear: writable }, state: { running, busy: false, rounds: 2, candidates: 3, confirmed: 3, failed: 0 }, history: [{ id: 1234, name: '<img src=x onerror=alert(1)>', hits: 250, fresh: true, detectedAt: 1792800000, cooldownUntil: 1792801000 }] }));
    }
    try {
      const file = path.join(__dirname, '../portal/public', pathname.endsWith('/') ? pathname + 'index.html' : pathname);
      const data = await readFile(file);
      res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8'); res.end(data);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const endpoint of ['/torn-toolbox/', '/torn-toolbox/chain/']) {
      await page.goto(origin + endpoint);
      if (endpoint.endsWith('chain/')) await page.waitForFunction(() => document.querySelector('#start').hidden === false);
      else await page.waitForFunction(() => document.querySelector('#chain-card').hidden === false);
      const measure = () => page.evaluate(() => ({ main: document.querySelector('[data-layout-container]').getBoundingClientRect().width, navbar: document.querySelector('.navbar-inner').getBoundingClientRect().width }));
      const before = await measure();
      await page.locator('.navbar-layout-btn').click(); const full = await measure();
      assert.ok(full.main > before.main && full.navbar > before.navbar, JSON.stringify({ endpoint, before, full }));
      assert.ok(full.main >= 1580 && full.navbar >= 1580);
      await page.reload(); assert.equal(await page.locator('.navbar-layout-btn').getAttribute('aria-pressed'), 'true');
      await page.locator('.navbar-layout-btn').click(); const restored = await measure(); assert.deepEqual(restored, before);
      await page.reload(); assert.equal(await page.locator('.navbar-layout-btn').getAttribute('aria-pressed'), 'false');
      console.log(JSON.stringify({ endpoint, before, full, restored }));
    }
    assert.equal(await page.locator('#history img').count(), 0);
    assert.ok((await page.locator('#history').innerText()).includes('<img'));
    assert.equal(await page.locator('#history a').getAttribute('href'), 'https://www.torn.com/war.php?step=chainreport&chainID=1234');
    await page.locator('#min-hits').fill('150'); await page.locator('#save').click();
    await page.waitForFunction(() => document.querySelector('#message').textContent.includes('配置已保存'));
    assert.equal(writes[0].body.minHits, '150'); assert.ok(!('apiKey' in writes[0].body));
    await page.locator('#start').click(); await page.waitForFunction(() => document.querySelector('#status').textContent.includes('运行中'));
    await page.locator('#stop').click(); await page.waitForFunction(() => document.querySelector('#status').textContent.includes('已停止'));
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 850 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile overflow ' + width);
    }
    writable = false; await page.reload(); await page.waitForFunction(() => document.querySelector('#min-hits').value === '100');
    assert.equal(await page.locator('#start').isVisible(), false); assert.equal(await page.locator('#save').isVisible(), false);
    assert.equal(await page.locator('#min-hits').isDisabled(), true);
    authorized = false;
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/torn-chain/state')), page.goto(origin + '/torn-toolbox/')]);
    assert.equal(await page.locator('#chain-card').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('Mobile 390/320, permissions, safe text, report URL and manual controls passed. External network blocked.');
    await context.close();
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
