import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createNotificationServer } from './server.js';
import { normalizeConfig } from './config.js';

async function withServer(run) {
    var server = createNotificationServer(normalizeConfig({
        napcat: { baseUrl: 'http://127.0.0.1:3000', accessToken: 'secret' },
        defaultTarget: { type: 'private', userId: '123' },
        server: { notifyToken: 'notify-secret' }
    }));
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
