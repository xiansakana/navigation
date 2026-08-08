#!/usr/bin/env node
/**
 * 校验 Portal 路由：Portal / 思源 / NapCat / 前缀反代隔离与常见踩坑路径。
 * 用法: node scripts/audit-proxy-routes.js
 *
 * 路由优先级（与 portal/src/router.js 一致）：
 * 1. Portal 自有 /api（oauth/login/me/...）
 * 2. 前缀反代（/notes /napcat /publish /stock-manage /torn-toolbox/...）
 * 3. NapCat 根路径（/webui /plugin /files + /api/{NapCat-ns} + Referer=/napcat 未知 /api）
 * 4. 思源根路径 + Referer=/publish → siyuan-publish
 * 5. 思源根路径 → notes
 * 6. 未知 /api → not-found
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    resolveRoute,
    resolveProxyContext,
    SIYUAN_API_NAMESPACES,
    NAPCAT_API_NAMESPACES,
    PORTAL_API_NAMESPACES
} from '../portal/src/router.js';

var __dirname = dirname(fileURLToPath(import.meta.url));
var configPath = join(__dirname, '../portal/config.ecs.example.json');
var config = JSON.parse(readFileSync(configPath, 'utf8'));
var services = config.services;

var failed = [];

function check(label, ok, detail) {
    if (!ok) failed.push({ label: label, detail: detail || '' });
}

function expectRoute(pathname, method, want, opts) {
    var route = resolveRoute(services, pathname, method, '', opts || {});
    var ok = route.kind === want.kind;
    if (want.id && route.service?.id !== want.id) ok = false;
    check(
        pathname + ' [' + method + ']',
        ok,
        'kind=' + route.kind + (route.service ? ', id=' + route.service.id : '')
    );
}

function expectProxy(pathname, want, opts) {
    var ctx = resolveProxyContext(services, pathname, opts || {});
    var got = ctx ? ctx.service.id : null;
    var proxyPath = ctx ? new URL(ctx.proxyUrl, 'http://127.0.0.1').pathname : null;
    var ok = got === want.id;
    if (want.proxyPath && proxyPath !== want.proxyPath) ok = false;
    check(
        pathname + ' (proxy' + (opts && opts.referer ? '+referer' : '') + ')',
        ok,
        'got ' + (got || 'null') + (proxyPath ? ' path=' + proxyPath : '')
            + ', want ' + want.id
            + (want.proxyPath ? ' path=' + want.proxyPath : '')
    );
}

// namespace isolation
PORTAL_API_NAMESPACES.forEach(function(ns) {
    check('portal-vs-siyuan:' + ns, !SIYUAN_API_NAMESPACES.has(ns));
    check('portal-vs-napcat:' + ns, !NAPCAT_API_NAMESPACES.has(ns));
});
SIYUAN_API_NAMESPACES.forEach(function(ns) {
    check('siyuan-vs-napcat-exact:' + ns, !NAPCAT_API_NAMESPACES.has(ns));
});

// Portal API
[
    ['/api/me', 'GET', { kind: 'portal-api' }],
    ['/api/login', 'POST', { kind: 'portal-api' }],
    ['/api/admin/rbac', 'GET', { kind: 'portal-api' }],
    ['/api/oauth/github/start', 'GET', { kind: 'portal-oauth' }],
    ['/api/oauth/providers', 'GET', { kind: 'portal-oauth' }],
].forEach(function(c) { expectRoute(c[0], c[1], c[2]); });

// unknown / reserved
[
    ['/api/unknown-endpoint', 'GET', { kind: 'not-found' }],
    ['/api/state', 'GET', { kind: 'not-found' }],
    ['/api/health', 'GET', { kind: 'not-found' }],
    ['/api/admin/hack', 'POST', { kind: 'portal-api' }],
].forEach(function(c) { expectRoute(c[0], c[1], c[2]); });

// SiYuan
[
    ['/api/transactions', 'POST', { kind: 'proxy', id: 'notes' }],
    ['/api/file/getFile', 'POST', { kind: 'proxy', id: 'notes' }],
    ['/api/plugin', 'POST', { kind: 'proxy', id: 'notes' }],
    ['/ws', 'GET', { kind: 'proxy', id: 'notes' }],
    ['/stage/build/desktop/', 'GET', { kind: 'proxy', id: 'notes' }],
].forEach(function(c) { expectRoute(c[0], c[1], c[2]); });

// NapCat (including past breakage)
[
    ['/api/auth/login', 'POST', { kind: 'proxy', id: 'napcat' }],
    ['/api/QQLogin/GetQQLoginQrcode', 'POST', { kind: 'proxy', id: 'napcat' }],
    ['/api/ws/terminal', 'GET', { kind: 'proxy', id: 'napcat' }],
    ['/api/OB11Config/Get', 'POST', { kind: 'proxy', id: 'napcat' }],
    ['/api/File/upload', 'POST', { kind: 'proxy', id: 'napcat' }],
    ['/api/Plugin/list', 'POST', { kind: 'proxy', id: 'napcat' }],
    ['/webui/', 'GET', { kind: 'proxy', id: 'napcat' }],
    ['/plugin/foo/api', 'GET', { kind: 'proxy', id: 'napcat' }],
    ['/files/theme.css', 'GET', { kind: 'proxy', id: 'napcat' }],
].forEach(function(c) { expectRoute(c[0], c[1], c[2]); });

// prefixed services
[
    ['/stock-manage/api/health', 'GET', { kind: 'proxy', id: 'stock-manage' }],
    ['/torn-toolbox/undercut/api/state', 'GET', { kind: 'proxy', id: 'torn-undercut' }],
    ['/publish/', 'GET', { kind: 'proxy', id: 'siyuan-publish' }],
    ['/notes/stage/build/desktop/', 'GET', { kind: 'proxy', id: 'notes' }],
    ['/napcat/webui/', 'GET', { kind: 'proxy', id: 'napcat' }],
].forEach(function(c) { expectRoute(c[0], c[1], c[2]); });

// proxyUrl details
[
    { path: '/api/transactions', want: { id: 'notes', proxyPath: '/api/transactions' } },
    { path: '/api/plugin', want: { id: 'notes', proxyPath: '/api/plugin' } },
    { path: '/api/Plugin/list', want: { id: 'napcat', proxyPath: '/napcat/api/Plugin/list' } },
    { path: '/api/file/getFile', want: { id: 'notes', proxyPath: '/api/file/getFile' } },
    { path: '/api/File/upload', want: { id: 'napcat', proxyPath: '/napcat/api/File/upload' } },
    { path: '/api/auth/login', want: { id: 'napcat', proxyPath: '/napcat/api/auth/login' } },
    { path: '/api/QQLogin/GetQQLoginQrcode', want: { id: 'napcat', proxyPath: '/napcat/api/QQLogin/GetQQLoginQrcode' } },
    { path: '/api/ws/terminal', want: { id: 'napcat', proxyPath: '/napcat/api/ws/terminal' } },
    { path: '/webui/', want: { id: 'napcat', proxyPath: '/napcat/webui/' } },
    { path: '/plugin/x', want: { id: 'napcat', proxyPath: '/napcat/plugin/x' } },
    { path: '/files/theme.css', want: { id: 'napcat', proxyPath: '/napcat/files/theme.css' } },
    { path: '/stock-manage/api/health', want: { id: 'stock-manage', proxyPath: '/stock-manage/api/health' } },
    { path: '/torn-toolbox/undercut/api/state', want: { id: 'torn-undercut' } },
    { path: '/publish/', want: { id: 'siyuan-publish' } },
    { path: '/notes/stage/build/desktop/', want: { id: 'notes' } },
    { path: '/api/me', want: { id: null } },
    { path: '/api/state', want: { id: null } },
    { path: '/api/health', want: { id: null } },
].forEach(function(c) { expectProxy(c.path, c.want); });

// Referer fallbacks
expectProxy('/api/file/getFile', {
    id: 'siyuan-publish',
    proxyPath: '/publish/api/file/getFile'
}, { referer: 'http://127.0.0.1/publish/stage/build/desktop/' });
expectProxy('/ws', { id: 'siyuan-publish', proxyPath: '/publish/ws' }, {
    referer: 'http://127.0.0.1/publish/'
});
expectProxy('/api/FutureNapCatThing/x', {
    id: 'napcat',
    proxyPath: '/napcat/api/FutureNapCatThing/x'
}, { referer: 'http://127.0.0.1/napcat/webui/' });
// unknown NapCat namespace without Referer must stay not-found
expectRoute('/api/FutureNapCatThing/x', 'POST', { kind: 'not-found' });

if (failed.length) {
    console.error('FAILED ' + failed.length + ' check(s):');
    failed.forEach(function(r) {
        console.error('  ' + r.label + ': ' + r.detail);
    });
    process.exit(1);
}

console.log('OK: proxy route architecture checks passed ('
    + 'siyuan-ns=' + SIYUAN_API_NAMESPACES.size
    + ', napcat-ns=' + NAPCAT_API_NAMESPACES.size
    + ')');
