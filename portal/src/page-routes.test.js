import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPortalPagePath, resolveRoute } from './router.js';
import { buildMenusFromServices } from './rbac.js';
import { handleOAuthCallback } from './oauth.js';

test('login and admin aliases stay in Portal even with a proxied referer', () => {
    const services = [{ id: 'notes', type: 'proxy', path: '/notes', internalUrl: 'http://localhost:6806' }];
    for (const page of ['login', 'admin']) {
        for (const suffix of ['', '/', '.html', '/index.html']) {
            const path = '/' + page + suffix;
            assert.equal(canonicalPortalPagePath(path), '/' + page + '/');
            assert.equal(resolveRoute(services, path, 'GET', '?error=retry', { referer: 'https://test/notes/' }).kind, 'pass');
        }
    }
    for (const path of ['/api/login', '/api/admin/users', '/login.js', '/admin.js', '/notes/login.html']) {
        assert.equal(canonicalPortalPagePath(path), null);
    }
});

test('persisted admin menu overrides migrate to the canonical entry', () => {
    const menu = buildMenusFromServices([], [{ id: 'menu_admin', path: '/admin.html', enabled: false, sort: 42 }]).find(m => m.id === 'menu_admin');
    assert.equal(menu.path, '/admin/');
    assert.equal(menu.permission, 'admin:access:view');
    assert.equal(menu.enabled, false);
    assert.equal(menu.sort, 42);
});

test('OAuth errors return to the canonical login page', async () => {
    const responses = [];
    const res = { writeHead(status, headers) { responses.push({ status, location: headers.Location }); }, end() {} };
    await handleOAuthCallback('google', { url: '/api/oauth/google/callback', headers: {} }, res, {}, 'secret');
    const config = { oauth: { google: { enabled: true, clientId: 'test-client', clientSecret: 'test-secret' } } };
    await handleOAuthCallback('google', { url: '/api/oauth/google/callback?error=access_denied', headers: {} }, res, config, 'secret');
    await handleOAuthCallback('google', { url: '/api/oauth/google/callback?code=invalid', headers: {} }, res, config, 'secret');
    for (const response of responses) {
        assert.equal(response.status, 302);
        assert.equal(new URL(response.location, 'https://test').pathname, '/login/');
        assert.ok(new URL(response.location, 'https://test').searchParams.get('error'));
    }
    assert.equal(new URL(responses[1].location, 'https://test').searchParams.get('error'), 'access_denied');
});
