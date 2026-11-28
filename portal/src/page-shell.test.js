import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { injectPageScripts } from './page-shell.js';

const source = readFileSync(new URL('../public/portal-page.js', import.meta.url), 'utf8');

test('direct and proxied pages can share scripts without double-initializing the dashboard', () => {
    const dashboard = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
    const html = injectPageScripts(dashboard);
    assert.equal(injectPageScripts(html), html);
    assert.equal(html.match(/src="\/portal-page\.js\?/g).length, 1);
    assert.equal(html.match(/src="\/command-palette\.js\?/g).length, 1);
    assert.ok(html.indexOf('/portal-page.js') < html.indexOf('/command-palette.js'));
    assert.ok(html.indexOf('/command-palette.js') < html.indexOf('/navbar-dropdown.js'));
});

test('shared input and back-to-top behavior loads once on native and proxied pages', () => {
    const source = readFileSync(new URL('../public/mingli/index.html', import.meta.url), 'utf8');
    const native = injectPageScripts(source);
    const proxied = injectPageScripts("<head><script src='/ui/input-guard.js'></script></head><body></body>");
    for (const html of [native, proxied]) {
        assert.equal(html.match(/\/ui\/input-guard\.js/g).length, 1);
        assert.equal(html.match(/\/ui\/back-to-top\.js/g).length, 1);
        assert.equal(injectPageScripts(html), html);
    }
});

test('every page gets one copy of the dialog runtime, whatever it already shipped', () => {
    const pages = [
        readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8'), // ships dialog + toast
        readFileSync(new URL('../public/mingli/index.html', import.meta.url), 'utf8'), // ships dialog only
        readFileSync(new URL('../public/knowledge/index.html', import.meta.url), 'utf8'), // ships neither
        readFileSync(new URL('../public/bookkeeping/index.html', import.meta.url), 'utf8') // ships toast only
    ];
    const count = (html, asset) => (html.match(new RegExp(`src=["']${asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\?[^"']*)?["']`, 'g')) || []).length;
    for (const source of pages) {
        const html = injectPageScripts(source);
        for (const asset of ['/dialog.js', '/toast.js', '/portal-ui.js']) assert.equal(count(html, asset), 1, asset);
        assert.equal(injectPageScripts(html), html);
    }
    // The facade must be parsed after the implementations it wraps; check the
    // injected block itself so a body-level <script> on one page cannot skew it.
    const bare = injectPageScripts('<html><head></head><body></body></html>');
    assert.ok(bare.indexOf('/dialog.js') < bare.indexOf('/toast.js'));
    assert.ok(bare.indexOf('/toast.js') < bare.indexOf('/portal-ui.js'));
    assert.ok(bare.indexOf('/portal-ui.js') < bare.indexOf('/portal-page.js'));
});

test('page startup coalesces concurrent reads and retries after a transient error', async () => {
    const { window } = new JSDOM('', { runScripts: 'outside-only' });
    try {
        let requests = 0;
        window.fetch = async () => {
            requests++;
            return requests === 1 ? { ok: false, status: 503, json: async () => ({ error: 'busy' }) }
                : { ok: true, json: async () => ({ ok: true, services: ['bookkeeping'] }) };
        };
        window.eval(source);
        const first = window.portalPage.services();
        const second = window.portalPage.services();
        assert.equal(first, second);
        await assert.rejects(first, { status: 503 });
        assert.equal(requests, 1);
        assert.equal((await window.portalPage.services()).services[0], 'bookkeeping');
        assert.equal(requests, 2);
    } finally {
        window.close();
    }
});

test('session redirects surface as authentication errors without parsing HTML', async () => {
    const { window } = new JSDOM('', { runScripts: 'outside-only' });
    try {
        window.fetch = async () => ({
            redirected: true,
            url: 'https://example.test/login/?return=%2Fknowledge%2F',
            json() { assert.fail('a login page is not JSON'); }
        });
        window.eval(source);
        await assert.rejects(window.portalPage.user(), { status: 401 });
    } finally {
        window.close();
    }
});
