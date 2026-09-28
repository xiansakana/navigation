import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendMarketSnapshot, sendSlackNotification } from './notify.js';
import { defaultNotify } from './store.js';

test('QQ market snapshot includes price, daily change and drawdown from H', () => {
  const text = appendMarketSnapshot('T2 触发。', {
    price: 475.91,
    changePercent: -2.345,
    drawdownLive: -12,
    H: 540.81
  }, 'QQQ');

  assert.equal(
    text,
    'T2 触发。\n行情：QQQ 现价 475.91｜当日涨跌幅 -2.35%｜相对 H 回撤 -12.00%（H 540.81）'
  );
});

test('QQ market snapshot keeps unavailable quote fields explicit', () => {
  const text = appendMarketSnapshot('开盘摘要', {
    price: 100,
    changePercent: 1.2,
    drawdownLive: null,
    H: null
  }, 'SOXL');

  assert.match(text, /SOXL 现价 100\.00/);
  assert.match(text, /当日涨跌幅 \+1\.20%/);
  assert.match(text, /相对 H 回撤 —（H —）/);
});

test('stock Slack switch defaults off and sends through notification hub when enabled', async () => {
  assert.equal(defaultNotify().slack.enabled, false);
  const notify = defaultNotify({ slack: { enabled: true }, qq: { url: 'http://127.0.0.1:8787/notify', token: 'secret' } });
  let request;
  await sendSlackNotification(notify, '[抄底] 测试', { fetch: async (url, options) => {
    request = { url, options };
    return { ok: true };
  } });
  assert.equal(request.url, 'http://127.0.0.1:8787/notify');
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(request.options.body), { channel: 'slack', message: '[抄底] 测试' });
});
