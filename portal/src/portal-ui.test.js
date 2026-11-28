import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const read = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
const dialogSource = read('dialog.js');
const toastSource = read('toast.js');
const uiSource = read('portal-ui.js');

function createPage({ withDialog = true, withToast = true } = {}) {
    const dom = new JSDOM('<!doctype html><html><body><button id="focus">x</button></body></html>', { runScripts: 'outside-only' });
    const { window } = dom;
    if (withDialog) window.eval(dialogSource);
    if (withToast) window.eval(toastSource);
    window.eval(uiSource);
    return { dom, window };
}

test('portalUI.confirm renders the shared dialog and resolves true on confirm', async () => {
    const { dom, window } = createPage();
    try {
        const pending = window.portalUI.confirm('删除这篇笔记？', { title: '删除笔记', danger: true, okText: '删除' });
        const host = window.document.querySelector('.portal-dialog-host');
        assert.ok(host && host.hidden === false);
        assert.equal(host.querySelector('.portal-dialog-title').textContent, '删除笔记');
        assert.equal(host.querySelector('.portal-dialog-message').textContent, '删除这篇笔记？');
        const ok = host.querySelector('[data-action="ok"]');
        assert.equal(ok.textContent, '删除');
        assert.ok(ok.classList.contains('portal-dialog-danger'));
        ok.click();
        assert.equal(await pending, true);
        assert.equal(host.hidden, true);
    } finally { dom.window.close(); }
});

test('portalUI.confirm resolves false when cancelled and prompt returns the typed value', async () => {
    const { dom, window } = createPage();
    try {
        const cancelled = window.portalUI.confirm('继续？', { title: '确认' });
        const host = window.document.querySelector('.portal-dialog-host');
        host.querySelector('[data-action="cancel"]').click();
        assert.equal(await cancelled, false);

        const prompted = window.portalUI.prompt('链接地址', 'https://example.test', { title: '插入链接' });
        const input = window.document.querySelector('.portal-dialog-input');
        assert.equal(input.value, 'https://example.test');
        input.value = 'https://saoyu.fun/';
        window.document.querySelector('[data-action="ok"]').click();
        assert.equal(await prompted, 'https://saoyu.fun/');
    } finally { dom.window.close(); }
});

test('portalUI.alert uses the styled dialog instead of browser chrome', async () => {
    const { dom, window } = createPage();
    try {
        let nativeCalled = false;
        window.alert = () => { nativeCalled = true; };
        const pending = window.portalUI.alert('已保存');
        assert.equal(window.document.querySelector('.portal-dialog-message').textContent, '已保存');
        window.document.querySelector('[data-action="ok"]').click();
        await pending;
        assert.equal(nativeCalled, false);
    } finally { dom.window.close(); }
});

test('portalUI falls back to native confirm when dialog.js is absent', async () => {
    const { dom, window } = createPage({ withDialog: false });
    try {
        assert.equal(window.portalUI.available(), false);
        let asked = '';
        window.confirm = (message) => { asked = message; return false; };
        assert.equal(await window.portalUI.confirm('真的删除？'), false);
        assert.equal(asked, '真的删除？');
        window.prompt = () => 'typed';
        assert.equal(await window.portalUI.prompt('值'), 'typed');
    } finally { dom.window.close(); }
});

test('portalUI.toast delegates to portalToast and stays safe without it', () => {
    const { dom, window } = createPage();
    try {
        const seen = [];
        window.portalToast = {
            show: (message, opts) => seen.push(['show', message, opts]),
            info: (message) => seen.push(['info', message]),
            success: (message) => seen.push(['success', message]),
            error: (message) => seen.push(['error', message]),
            warn: (message) => seen.push(['warn', message])
        };
        window.portalUI.toast.success('已保存');
        window.portalUI.toast.error('失败');
        assert.deepEqual(seen, [['success', '已保存'], ['error', '失败']]);
    } finally { dom.window.close(); }

    const bare = createPage({ withToast: false });
    try {
        assert.doesNotThrow(() => bare.window.portalUI.toast.warn('无宿主'));
        assert.equal(bare.window.portalUI.toast.warn('无宿主'), undefined);
    } finally { bare.dom.window.close(); }
});

test('dialog.js and toast.js are idempotent so the page shell can inject them twice', () => {
    const { dom, window } = createPage();
    try {
        const dialog = window.portalDialog;
        const toast = window.portalToast;
        window.eval(dialogSource);
        window.eval(toastSource);
        window.eval(uiSource);
        assert.equal(window.portalDialog, dialog);
        assert.equal(window.portalToast, toast);
        assert.equal(window.document.querySelectorAll('.portal-dialog-host').length, 0);
    } finally { dom.window.close(); }
});
