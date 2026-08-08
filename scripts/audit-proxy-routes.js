#!/usr/bin/env node
/**
 * 校验 Portal 路由：Portal API、反代前缀、思源/NapCat 命名空间隔离。
 * 用法: node scripts/audit-proxy-routes.js
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRoute, resolveProxyContext } from '../portal/src/router.js';

var __dirname = dirname(fileURLToPath(import.meta.url));
var configPath = join(__dirname, '../portal/config.ecs.example.json');
var config = JSON.parse(readFileSync(configPath, 'utf8'));
var services = config.services;

function check(label, ok, detail) {
    if (!ok) return { label: label, detail: detail };
    return null;
}

var failed = [];

function expectRoute(pathname, method, want) {
    var route = resolveRoute(services, pathname, method, '');
    var ok = route.kind === want.kind;
    if (want.id && route.service?.id !== want.id) ok = false;
    var fail = check(pathname + ' [' + method + ']', ok, 'kind=' + route.kind + (route.service ? ', id=' + route.service.id : ''));
    if (fail) failed.push(fail);
}

function expectProxy(pathname, want, opts) {
    var ctx = resolveProxyContext(services, pathname, opts || {});
    var got = ctx ? ctx.service.id : null;
    var proxyPath = ctx ? new URL(ctx.proxyUrl, 'http://127.0.0.1').pathname : null;
    var ok = got === want.id;
    if (want.proxyPath && proxyPath !== want.proxyPath) ok = false;
    var fail = check(pathname + ' (proxy)', ok, 'got ' + (got || 'null') + ', want ' + want.id);
    if (fail) failed.push(fail);
}

// resolveRoute：Portal API
[
    ['/api/me', 'GET', { kind: 'portal-api' }],
    ['/api/login', 'POST', { kind: 'portal-api' }],
    ['/api/admin/rbac', 'GET', { kind: 'portal-api' }],
    ['/api/oauth/github/start', 'GET', { kind: 'portal-oauth' }],
    ['/api/oauth/providers', 'GET', { kind: 'portal-oauth' }],
].forEach(function(c) { expectRoute(c[0], c[1], c[2]); });

// resolveRoute：未知 / 保留 API 不应反代
[
    ['/api/unknown-endpoint', 'GET', { kind: 'not-found' }],
    ['/api/state', 'GET', { kind: 'not-found' }],
    ['/api/health', 'GET', { kind: 'not-found' }],
    ['/api/admin/hack', 'POST', { kind: 'portal-api' }],
].forEach(function(c) { expectRoute(c[0], c[1], c[2]); });

// resolveRoute：反代
[
    ['/api/transactions', 'POST', { kind: 'proxy', id: 'notes' }],
    ['/api/auth/login', 'POST', { kind: 'proxy', id: 'napcat' }],
    ['/api/QQLogin/GetQQLoginQrcode', 'POST', { kind: 'proxy', id: 'napcat' }],
    ['/stock-manage/api/health', 'GET', { kind: 'proxy', id: 'stock-manage' }],
    ['/ws', 'GET', { kind: 'proxy', id: 'notes' }],
].forEach(function(c) {
    var route = resolveRoute(services, c[0], c[1], '');
    var ok = route.kind === c[2].kind && route.service?.id === c[2].id;
    var fail = check(c[0] + ' route', ok, 'kind=' + route.kind + ', id=' + (route.service?.id || 'null'));
    if (fail) failed.push(fail);
});

// resolveProxyContext 细节
[
    { path: '/api/transactions', want: { id: 'notes', proxyPath: '/api/transactions' } },
    { path: '/api/plugin', want: { id: 'notes', proxyPath: '/api/plugin' } },
    { path: '/api/block/insertBlock', want: { id: 'notes', proxyPath: '/api/block/insertBlock' } },
    { path: '/api/auth/login', want: { id: 'napcat', proxyPath: '/napcat/api/auth/login' } },
    { path: '/api/QQLogin/GetQQLoginQrcode', want: { id: 'napcat', proxyPath: '/napcat/api/QQLogin/GetQQLoginQrcode' } },
    { path: '/webui/', want: { id: 'napcat', proxyPath: '/napcat/webui/' } },
    { path: '/stock-manage/api/health', want: { id: 'stock-manage', proxyPath: '/stock-manage/api/health' } },
    { path: '/torn-toolbox/undercut/api/state', want: { id: 'torn-undercut' } },
    { path: '/publish/', want: { id: 'siyuan-publish' } },
    { path: '/notes/stage/build/desktop/', want: { id: 'notes' } },
    { path: '/api/me', want: { id: null } },
    { path: '/api/state', want: { id: null } },
    { path: '/api/health', want: { id: null } },
].forEach(function(c) { expectProxy(c.path, c.want); });

expectProxy('/api/file/getFile', { id: 'notes', proxyPath: '/api/file/getFile' });
expectProxy('/api/file/getFile', {
    id: 'siyuan-publish',
    proxyPath: '/publish/api/file/getFile'
}, { referer: 'http://127.0.0.1/publish/stage/build/desktop/' });
expectProxy('/ws', { id: 'siyuan-publish', proxyPath: '/publish/ws' }, {
    referer: 'http://127.0.0.1/publish/'
});

if (failed.length) {
    console.error('FAILED ' + failed.length + ' check(s):');
    failed.forEach(function(r) {
        console.error('  ' + r.label + ': ' + r.detail);
    });
    process.exit(1);
}

console.log('OK: proxy route architecture checks passed');
