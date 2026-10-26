import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const read = name => fs.readFileSync(new URL('../../qq-bot/public/' + name, import.meta.url), 'utf8');
const until = async check => { for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check()); };

test('notification channel status loads and saves when Chain controls arrive before channel config', async () => {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', url: 'https://test/notifications/' });
  const w = dom.window, d = w.document; let releaseConfig; const writes = [];
  const config = {
    channels: { qq: { enabled: true }, email: { enabled: false, smtp: {} }, slack: { enabled: true } },
    napcat: {}, defaultTarget: {}, monitors: { tiboReset: { enabled: false, channels: ['qq'], qq: { useDefaultTarget: true, targets: [] } } }
  };
  const channels = [{ id: 'qq', enabled: true, ready: true }, { id: 'email', enabled: false, ready: false }, { id: 'slack', enabled: true, ready: false }];
  const response = data => ({ ok: true, status: 200, json: async () => data });
  w.fetch = async (url, options = {}) => {
    if (url === '/api/me') return response({ permissions: ['*'] });
    if (url === '/api/torn-chain/notifications') return response({ ok: true, settings: { qq: { enabled: true }, slack: { enabled: true }, targets: [] }, permissions: { save: true, test: true } });
    if (url === 'api/monitors/tibo-reset') return response({ ok: true, status: null });
    if (url === 'api/monitors/qq-login') return response({ ok: true, status: { online: false, lastCheckedAt: '2026-10-26T11:00:00Z', alertChannels: [{ id: 'slack', ready: true }, { id: 'email', ready: false }] }, bookkeeping: { connected: true } });
    if (url === 'api/config' && options.method === 'PUT') { writes.push(JSON.parse(options.body)); return response({ ok: true, config, channels }); }
    if (url === 'api/config') return new Promise(resolve => { releaseConfig = () => resolve(response({ ok: true, config, channels })); });
    throw new Error('Unexpected request: ' + url);
  };
  try {
    w.eval(read('qq-targets.js')); w.eval(read('app.js')); w.eval(read('chain-notifications.js'));
    await until(() => !d.getElementById('chain-notifications').hidden);
    releaseConfig();
    await until(() => d.getElementById('summary').textContent.includes('1 / 2'));
    await until(() => !d.getElementById('save').disabled);
    assert.equal(d.querySelector('.channel-card[data-channel="qq"] .status-text').textContent, '配置已就绪');
    assert.equal(d.querySelector('.channel-card[data-channel="email"] .status-text').textContent, '已停用');
    assert.equal(d.querySelector('.channel-card[data-channel="slack"] .status-text').textContent, '配置不完整');
    await until(() => d.getElementById('qq-login-status').textContent.includes('QQ 账号离线'));
    assert.match(d.getElementById('qq-login-status').textContent, /不代表 QQ 在线/);
    assert.match(d.getElementById('qq-alert-status').textContent, /Slack已接入.*邮件未启用/);
    assert.ok(!d.getElementById('toast').textContent.includes('加载失败'));
    assert.ok(d.querySelector('#chain-notifications input[type="checkbox"]').checked);
    d.getElementById('save').click(); await until(() => d.getElementById('save-state').textContent === '渠道配置已保存');
    assert.equal(writes.length, 1); assert.ok(!d.getElementById('toast').textContent.includes('null'));
    assert.ok(d.querySelector('#chain-notifications input[type="checkbox"]').checked);
  } finally { w.close(); }
});
