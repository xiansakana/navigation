// Local browser fixture through the real Portal shell injector. No delivery or Torn requests.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const { proxyHttpRequest } = await import('../portal/src/proxy.js');
  let settings = { qq: { enabled: false }, slack: { enabled: false }, targets: [] }, writable = true;
  const writes = [];
  const mime = file => file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8';
  const upstream = http.createServer(async (req, res) => {
    try {
      const name = new URL(req.url, 'http://localhost').pathname.replace(/^\//, '') || 'index.html';
      let body = await fs.readFile(path.join(__dirname, '../qq-bot/public', name), 'utf8');
      // Isolate the new card; other modules have their own fixtures.
      if (name === 'index.html') body = body.replace(/<script src="(?:app|integrations|codex)\.js[^>]*><\/script>/g, '').replace('</head>', '<script>function toast(message) { document.body.dataset.toast = message; }</script></head>');
      res.setHeader('Content-Type', mime(name)); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname.startsWith('/notifications')) return proxyHttpRequest({ id: 'notifications', title: '通知管理', path: '/notifications', internalUrl: 'http://127.0.0.1:' + upstream.address().port }, req, res);
    if (pathname.startsWith('/api/torn-chain/notifications')) {
      if (req.method !== 'GET') { let body = ''; for await (const chunk of req) body += chunk; writes.push({ method: req.method, body }); if (req.method === 'PUT') settings = JSON.parse(body); }
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok: true, settings, permissions: { save: writable, test: writable } }));
    }
    try { const file = path.join(__dirname, '../portal/public', pathname); const body = await fs.readFile(file); res.setHeader('Content-Type', mime(file)); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(); await page.goto(origin + '/notifications/');
    await page.waitForSelector('#chain-notifications [data-action="chain-save"]');
    const dimensions = () => page.evaluate(() => ({ main: document.querySelector('[data-layout-container]').getBoundingClientRect().width, navbar: document.querySelector('.navbar-inner').getBoundingClientRect().width }));
    const before = await dimensions(); await page.locator('.navbar-layout-btn').click(); const full = await dimensions();
    assert.ok(full.main > before.main && full.navbar > before.navbar && full.main >= 1580);
    await page.reload(); assert.equal(await page.locator('.navbar-layout-btn').getAttribute('aria-pressed'), 'true');
    await page.locator('.navbar-layout-btn').click(); assert.deepEqual(await dimensions(), before);
    await page.reload(); assert.equal(await page.locator('.navbar-layout-btn').getAttribute('aria-pressed'), 'false');
    await page.locator('#chain-notifications [data-action="add-target"]').click();
    await page.locator('#chain-notifications [data-field="groupId"]').fill('123456');
    await page.locator('#chain-notifications [data-channel="qq"]').check();
    await page.locator('#chain-notifications [data-action="chain-save"]').click();
    await page.waitForFunction(() => document.body.dataset.toast === 'Chain 提醒配置已保存');
    assert.equal(settings.targets[0].groupId, '123456'); assert.equal(settings.qq.enabled, true);
    await page.reload(); await page.waitForSelector('#chain-notifications [data-field="groupId"]');
    assert.equal(await page.locator('#chain-notifications [data-field="groupId"]').inputValue(), '123456');
    await page.locator('#chain-notifications [data-action="chain-test"]').click();
    await page.waitForFunction(() => document.body.dataset.toast?.includes('测试通知'));
    assert.ok(writes.some(row => row.method === 'POST' && !row.body));
    for (const width of [390, 320]) { await page.setViewportSize({ width, height: 850 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'overflow ' + width); }
    writable = false; await page.reload(); await page.waitForSelector('#chain-notifications [data-action="chain-save"]');
    assert.equal(await page.locator('#chain-notifications [data-action="chain-save"]').isDisabled(), true);
    assert.equal(await page.locator('#chain-notifications [data-action="chain-test"]').isDisabled(), true);
    console.log(JSON.stringify({ page: '/notifications/', before, full, mobile: [390, 320], result: 'save/reload, mocked test, permissions and layout passed' }));
    await context.close();
  } finally { await browser.close(); server.closeAllConnections(); upstream.closeAllConnections(); server.close(); upstream.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
