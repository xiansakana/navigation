import test from 'node:test';
import assert from 'node:assert/strict';
import { publishBusinessEvent } from './business-events.js';

test('monitor reports only the event and authenticates to the local hub', async () => {
    let request;
    const result = await publishBusinessEvent({ qq: { url: 'http://127.0.0.1:8787/notify', token: 'secret' } },
        { source: 'company', watcherId: 'w1', eventKey: 'application', message: '新申请' },
        { fetch: async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ ok: true, result: { sent: ['Slack'] } }) }; } });
    assert.equal(request.url.pathname, '/api/business-events');
    assert.equal(request.options.headers.Authorization, 'Bearer secret');
    assert.deepEqual(result.sent, ['Slack']);
    await assert.rejects(publishBusinessEvent({ qq: { url: 'https://example.com/notify', token: 'secret' } }, { source: 'stock', message: 'test' }), /本机/);
});
