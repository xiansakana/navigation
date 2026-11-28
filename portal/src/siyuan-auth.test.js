import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { proxyHttpRequest } from './proxy.js';
import { ensureSiyuanAuth } from './siyuan-auth.js';

test('a redirect to check-auth replaces an expired SiYuan cookie', async (t) => {
    let loginRequests = 0;
    const kernel = createServer((req, res) => {
        assert.equal(req.url, '/api/system/loginAuth');
        loginRequests += 1;
        res.setHeader('Set-Cookie', 'siyuan=fresh; Path=/; HttpOnly');
        res.end(JSON.stringify({ code: 0 }));
    }).listen(0, '127.0.0.1');
    t.after(() => kernel.close());
    await once(kernel, 'listening');

    const service = {
        internalUrl: `http://127.0.0.1:${kernel.address().port}`,
        accessAuthCode: 'test-code'
    };
    const req = { headers: { cookie: 'portal_session=existing; siyuan=expired' } };
    const headers = new Map();
    const res = { getHeader: headers.get.bind(headers), setHeader: headers.set.bind(headers) };

    assert.equal(await ensureSiyuanAuth(service, req, res, true), true);
    assert.equal(loginRequests, 0);
    assert.equal(await ensureSiyuanAuth(service, req, res, true, { refresh: true }), true);
    assert.equal(loginRequests, 1);
    assert.equal(req.headers.cookie, 'portal_session=existing; siyuan=fresh');
    assert.deepEqual(headers.get('Set-Cookie'), ['siyuan=fresh; Path=/; HttpOnly']);
});

test('the Notes proxy preserves the host used for the kernel origin check', async (t) => {
    const kernel = createServer((req, res) => {
        const sameHost = new URL(req.headers.origin).host === req.headers.host;
        res.writeHead(sameHost ? 200 : 401).end();
    }).listen(0, '127.0.0.1');
    t.after(() => kernel.close());
    await once(kernel, 'listening');

    const service = { id: 'notes', path: '/notes/', internalUrl: `http://127.0.0.1:${kernel.address().port}` };
    const portal = createServer((req, res) => proxyHttpRequest(service, req, res)).listen(0, '127.0.0.1');
    t.after(() => portal.close());
    await once(portal, 'listening');

    const origin = `http://127.0.0.1:${portal.address().port}`;
    const response = await fetch(`${origin}/notes/api/system/getConf`, {
        method: 'POST',
        headers: { origin }
    });
    assert.equal(response.status, 200);
});

test('only the Notes proxy forwards the app ID on a plugin storage write', async (t) => {
    const kernel = createServer((req, res) => res.end(req.headers['x-siyuan-app-id'] || '')).listen(0, '127.0.0.1');
    t.after(() => kernel.close());
    await once(kernel, 'listening');

    const internalUrl = `http://127.0.0.1:${kernel.address().port}`;
    const portal = createServer((req, res) => {
        const id = req.url.startsWith('/notes/') ? 'notes' : 'other';
        return proxyHttpRequest({ id, path: `/${id}/`, internalUrl }, req, res);
    }).listen(0, '127.0.0.1');
    t.after(() => portal.close());
    await once(portal, 'listening');

    const origin = `http://127.0.0.1:${portal.address().port}`;
    const request = { method: 'POST', headers: { 'X-SiYuan-App-ID': 'test-frontend' } };
    assert.equal(await (await fetch(`${origin}/notes/api/file/removeFile`, request)).text(), 'test-frontend');
    assert.equal(await (await fetch(`${origin}/other/api/file/removeFile`, request)).text(), '');
});
