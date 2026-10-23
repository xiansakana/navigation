// Optional browser regression check: NODE_PATH must include Playwright.
// Serves a local fixture only; every external request is blocked.
const { chromium } = require('playwright');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  let writable = true, running = false, authorized = true;
  const config = { minHits: 100, maxHits: 500, intervalSeconds: 60, hasKey: true, bonusHits: [100, 250], leaderFilter: 'all' }, writes = [];
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      if (!authorized) { res.writeHead(403); return res.end(JSON.stringify({ ok: false, error: '无权访问' })); }
      if (req.method !== 'GET') {
        let body = ''; for await (const chunk of req) body += chunk;
        writes.push({ path: pathname, body: body && JSON.parse(body) });
        if (pathname.endsWith('/config')) Object.assign(config, JSON.parse(body));
        if (pathname.endsWith('/start')) running = true;
        if (pathname.endsWith('/stop')) running = false;
        return res.end('{"ok":true}');
      }
      return res.end(JSON.stringify({ ok: true, config, bonusHitOptions: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000], permissions: { configure: writable, control: writable, clear: writable }, state: { running, busy: false, rounds: 2, candidates: 3, confirmed: 3, failed: 0 }, history: [{ id: 1234, name: '<img src=x onerror=alert(1)>', hits: 250, fresh: true, cooldownStartedAt: 1792799500, detectedAt: 1792800000, cooldownUntil: 1792801000, bonusDetails: [{ hit: 100, defenderId: 1100, isLeader: true }, { hit: 250, defenderId: 1250, isLeader: false }] }] }));
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
    assert.ok((await page.locator('#history').innerText()).includes('进入冷却（推算）'));
    assert.ok((await page.locator('#history').innerText()).includes('发现于'));
    assert.ok((await page.locator('#history').innerText()).includes('冷却结束'));
    assert.ok(await page.evaluate(() => {
      const text = document.querySelector('#history').textContent;
      return [1792799500, 1792800000, 1792801000].every(seconds => text.includes(new Date(seconds * 1000).toLocaleString()));
    }), 'cooldown start, discovery and end timestamps must all be rendered');
    assert.equal(await page.locator('#history .chain-row > a').getAttribute('href'), 'https://www.torn.com/war.php?step=chainreport&chainID=1234');
    assert.equal(await page.locator('.chain-bonus-links a').count(), 2);
    assert.equal(await page.locator('.chain-bonus-links a').first().getAttribute('href'), 'https://www.torn.com/profiles.php?XID=1100');
    await page.locator('#bonus-options input[value="250"]').uncheck();
    await page.locator('#bonus-options input[value="500"]').check();
    await page.locator('#leader-filter').selectOption('leader');
    await page.locator('#min-hits').fill('150'); await page.locator('#save').click();
    await page.waitForFunction(() => document.querySelector('#message').textContent.includes('配置已保存'));
    assert.equal(writes[0].body.minHits, '150'); assert.ok(!('apiKey' in writes[0].body));
    assert.deepEqual(writes[0].body.bonusHits, [100, 500]);
    assert.equal(writes[0].body.leaderFilter, 'leader');
    await page.reload(); await page.waitForSelector('#bonus-options input[value="500"]');
    assert.equal(await page.locator('#bonus-options input[value="500"]').isChecked(), true);
    assert.equal(await page.locator('#bonus-options input[value="250"]').isChecked(), false);
    assert.equal(await page.locator('#leader-filter').inputValue(), 'leader');
    assert.equal(await page.locator('.chain-bonus-links a').count(), 1);
    assert.equal(await page.locator('.chain-bonus-links a').getAttribute('href'), 'https://www.torn.com/profiles.php?XID=1100');
    await page.locator('#start').click(); await page.waitForFunction(() => document.querySelector('#status').textContent.includes('运行中'));
    await page.locator('#stop').click(); await page.waitForFunction(() => document.querySelector('#status').textContent.includes('已停止'));
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 850 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile overflow ' + width);
    }
    writable = false; await page.reload(); await page.waitForFunction(() => document.querySelector('#min-hits').value === '150');
    assert.equal(await page.locator('#start').isVisible(), false); assert.equal(await page.locator('#save').isVisible(), false);
    assert.equal(await page.locator('#min-hits').isDisabled(), true);
    assert.equal(await page.locator('#bonus-options input').first().isDisabled(), true);
    assert.equal(await page.locator('#leader-filter').isDisabled(), true);
    authorized = false;
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/torn-chain/state')), page.goto(origin + '/torn-toolbox/')]);
    assert.equal(await page.locator('#chain-card').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('Mobile 390/320, permissions, safe text, report URL and manual controls passed. External network blocked.');
    await context.close();
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
