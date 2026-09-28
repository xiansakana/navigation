import test from 'node:test';
import assert from 'node:assert/strict';
import { getIntegration, listIntegrations, saveIntegration, testIntegration } from './integrations.js';

function fakeFetch(calls) {
    return async function(url, options) {
        calls.push({ url, options });
        if (url.endsWith('/api/notification-settings') && url.includes(':5001')) {
            return { ok: true, json: async function() { return { ok: true, notify: { qq: { enabled: true, hasToken: true }, targets: [], events: { reset: true } }, monitor: { running: true } }; } };
        }
        if (url.endsWith('/api/state')) {
            var type = url.includes(':8790') ? 'undercut' : 'company';
            return { ok: true, json: async function() { return { ok: true, config: { notify: { qq: { enabled: true } }, [type]: { watchers: [{ id: 'w1', label: '账号', apiKey: 'SECRET', notify: { desktop: true, qq: { enabled: true, targets: [] } } }] } } }; } };
        }
        return { ok: true, json: async function() { return { ok: true, targets: ['私聊 123'] }; } };
    };
}

test('integration listing projects notification data without Torn API keys', async function() {
    var calls = [];
    var result = await listIntegrations(fakeFetch(calls));
    assert.deepEqual(result.map(function(item) { return item.id; }), ['stock', 'undercut', 'company']);
    assert.equal(result[0].monitor.running, true);
    assert.equal(result[1].watchers[0].apiKey, undefined);
    assert.equal(calls.length, 3);
});

test('save Torn notification settings changes only notification payload', async function() {
    var calls = [];
    await saveIntegration('undercut', { notify: { desktop: false, slack: { enabled: true }, qq: { enabled: true, url: 'http://127.0.0.1:8787/notify' } }, watchers: [{ id: 'w1', apiKey: 'DO-NOT-SEND', notify: { desktop: false, slack: { enabled: true }, qq: { enabled: false, targets: [{ type: 'private', userId: '123' }] } } }] }, fakeFetch(calls));
    var save = calls.find(function(call) { return call.options.method === 'PUT'; });
    var body = JSON.parse(save.options.body);
    assert.equal(body.watchers[0].apiKey, undefined);
    assert.equal(body.watchers[0].notify.qq.targets[0].userId, '123');
    assert.equal(body.watchers[0].notify.qq.enabled, false);
    assert.equal(body.notify.slack.enabled, true);
    assert.equal(body.watchers[0].notify.slack.enabled, true);
});

test('test request uses stored watcher notification settings', async function() {
    var calls = [];
    await testIntegration('company', 'w1', fakeFetch(calls));
    var testCall = calls.find(function(call) { return call.url.endsWith('/api/company/test-notify'); });
    assert.ok(testCall, JSON.stringify(calls));
    assert.equal(JSON.parse(testCall.options.body).watcher.id, 'w1');
    await assert.rejects(testIntegration('company', 'missing', fakeFetch([])), /监听账号不存在/);
    await assert.rejects(getIntegration('unknown', fakeFetch([])), /未知通知来源/);
});

test('stock Slack switch is included in saved notification settings', async function() {
    var calls = [];
    await saveIntegration('stock', { qq: { enabled: false }, slack: { enabled: true }, targets: [], events: {} }, fakeFetch(calls));
    var save = calls.find(function(call) { return call.options.method === 'PUT'; });
    assert.equal(JSON.parse(save.options.body).slack.enabled, true);
});
