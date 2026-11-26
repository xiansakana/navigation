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
    assert.ok(html.indexOf('/portal-page.js') < html.indexOf('/navbar-dropdown.js'));
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
