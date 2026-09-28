import test from 'node:test';
import assert from 'node:assert/strict';
import { appendMarketSnapshot, maskNotifyForClient } from './notify.js';

test('monitor adds market context but does not decide delivery', () => {
  assert.match(appendMarketSnapshot('触发', { price: 500, H: 510, changePercent: -1, drawdownLive: -2 }, 'QQQ'), /QQQ 现价 500.00/);
  assert.match(appendMarketSnapshot('触发', null), /现价 —/);
});

test('legacy notification snapshot masks transport secrets during migration', () => {
  const result = maskNotifyForClient({ qq: { enabled: true, token: 'secret' }, events: { T1: false } });
  assert.equal(result.qq.token, '***cret');
  assert.equal(result.events.T1, false);
});
