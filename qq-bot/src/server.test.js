import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createNotificationServer } from './server.js';
import { normalizeConfig } from './config.js';

async function withServer(run, settings) {
    var server = createNotificationServer(normalizeConfig({
        napcat: { baseUrl: 'http://127.0.0.1:3000', accessToken: 'secret' },
        defaultTarget: { type: 'private', userId: '123' },
        server: { notifyToken: 'notify-secret' },
        channels: settings?.channels
    }), settings?.adapters);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        await run('http://127.0.0.1:' + server.address().port);
    } finally {
        server.close();
        await once(server, 'close');
    }
}

test('management page and redacted config API are available', async function() {
    await withServer(async function(base) {
        var page = await fetch(base + '/');
        assert.equal(page.status, 200);
        assert.match(await page.text(), /通知管理/);

        var response = await fetch(base + '/api/config');
        var body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.config.napcat.hasAccessToken, true);
        assert.equal(body.config.napcat.accessToken, undefined);
        assert.equal(body.channels[0].ready, true);
    });
});

test('Slack test and unified notification routes use the configured webhook', async function() {
    var sent = [];
    await withServer(async function(base) {
        var status = await (await fetch(base + '/api/config')).json();
        assert.equal(status.config.channels.slack.hasWebhookUrl, true);
        assert.equal(status.config.channels.slack.webhookUrl, undefined);
        assert.equal(status.channels.find(function(channel) { return channel.id === 'slack'; }).ready, true);

        var testResponse = await fetch(base + '/api/test/slack', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: '测试 Slack' })
        });
        assert.equal(testResponse.status, 200);
        var notifyResponse = await fetch(base + '/notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer notify-secret' },
            body: JSON.stringify({ channel: 'slack', message: '业务通知' })
        });
        assert.equal(notifyResponse.status, 200);
        assert.deepEqual(sent, ['测试 Slack', '业务通知']);
    }, {
        channels: { slack: { enabled: true, webhookUrl: 'https://hooks.slack.com/services/T/B/secret' } },
        adapters: { sendSlack: async function(_, message) { sent.push(message); return { ok: true }; } }
    });
});

test('notify endpoint still requires the configured bearer token', async function() {
    await withServer(async function(base) {
        var response = await fetch(base + '/notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'test' })
        });
        assert.equal(response.status, 401);
    });
});

test('business integration API reads and saves only notification settings', async function() {
    var calls = [];
    var adapter = async function(url, options) {
        calls.push({ url: url, options: options });
        if (url.endsWith('/api/notification-settings')) {
            return { ok: true, json: async function() { return { ok: true, notify: { qq: { enabled: true }, targets: [], events: {} }, monitor: { running: false } }; } };
        }
        if (url.endsWith('/api/state')) {
            var source = url.includes(':8790') ? 'undercut' : 'company';
            return { ok: true, json: async function() { return { ok: true, config: { notify: { qq: { enabled: true } }, [source]: { watchers: [] } } }; } };
        }
        return { ok: true, json: async function() { return { ok: true }; } };
    };
    await withServer(async function(base) {
        var listed = await (await fetch(base + '/api/integrations')).json();
        assert.deepEqual(listed.integrations.map(function(item) { return item.id; }), ['stock', 'undercut', 'company']);
        var saved = await fetch(base + '/api/integrations/stock', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ qq: { enabled: true }, targets: [], events: {} })
        });
        assert.equal(saved.status, 200);
        assert.ok(calls.some(function(call) { return call.url.endsWith('/api/notify') && call.options.method === 'PUT'; }));
        assert.equal((await fetch(base + '/integrations.js')).status, 200);
    }, { adapters: { fetch: adapter } });
});
