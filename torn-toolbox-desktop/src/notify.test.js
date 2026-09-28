import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWatcherQqConfigs, canSendWatcherSlack, sendSlackNotification } from './notify.js';

test('global and watcher QQ switches both gate delivery', function() {
    var watcher = { qq: { enabled: true, targets: [{ id: 't1', type: 'private', userId: '123' }] } };
    assert.equal(buildWatcherQqConfigs({ qq: { enabled: false, url: 'http://127.0.0.1:8787/notify' } }, watcher).length, 0);
    assert.equal(buildWatcherQqConfigs({ qq: { enabled: true, url: 'http://127.0.0.1:8787/notify' } }, watcher).length, 1);
    assert.equal(buildWatcherQqConfigs({ qq: { enabled: true, url: 'http://127.0.0.1:8787/notify' } }, { qq: { ...watcher.qq, enabled: false } }).length, 0);
});

test('Torn Slack requires both service and watcher switches', function() {
    assert.equal(canSendWatcherSlack({ slack: { enabled: true } }, { slack: { enabled: true } }), true);
    assert.equal(canSendWatcherSlack({ slack: { enabled: false } }, { slack: { enabled: true } }), false);
    assert.equal(canSendWatcherSlack({ slack: { enabled: true } }, { slack: { enabled: false } }), false);
});

test('Torn Slack request uses notification hub channel', async function() {
    var sent;
    await sendSlackNotification({ qq: { url: 'http://127.0.0.1:8787/notify', token: 'secret' } }, '测试', {
        fetch: async function(url, options) { sent = { url: url, options: options }; return { ok: true }; }
    });
    assert.deepEqual(JSON.parse(sent.options.body), { channel: 'slack', message: '测试' });
    assert.equal(sent.options.headers.Authorization, 'Bearer secret');
});
