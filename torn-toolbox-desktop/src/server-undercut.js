import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServiceConfig, saveServiceConfig } from './config.js';
import { UndercutMonitor } from './undercut-monitor.js';
import { fetchItems } from './torn-api.js';
import { testUndercutWatcherNotify } from './notify.js';
import { maskUndercutWatcherForClient, mergeUndercutWatcherConfig } from './watchers.js';
import { normalizeItems } from './utils.js';
import {
    readJson, json, createStaticHandler, openBrowser, createAuthGuard,
    denyAccess, createSseBroadcaster, maskNotifyForClient, mergeNotifyConfig
} from './server-common.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public/undercut');
const SHARED_DIR = path.resolve(__dirname, '../public');

var config = loadServiceConfig('undercut');
var itemsCacheByWatcher = new Map();

function getConfig() { return config; }

var sse = createSseBroadcaster();
var undercutMonitor = new UndercutMonitor(getConfig);
var authorize = createAuthGuard(getConfig);
var serveStatic = createStaticHandler(PUBLIC_DIR, SHARED_DIR);

['state', 'alerts', 'error'].forEach(function(eventName) {
    undercutMonitor.on(eventName, function(data) {
        if (eventName === 'state') sse.broadcast('undercut', data);
        else if (eventName === 'alerts') sse.broadcast('undercutAlerts', data);
        else if (eventName === 'error') sse.broadcast('error', { source: 'undercut', message: data });
    });
});

async function handleApi(req, res) {
    var url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/api/state') {
        return json(res, 200, {
            ok: true,
            config: {
                undercut: {
                    intervalSeconds: config.undercut?.intervalSeconds,
                    watchers: (config.undercut?.watchers || []).map(maskUndercutWatcherForClient)
                },
                notify: maskNotifyForClient(config.notify)
            },
            undercut: undercutMonitor.getState()
        });
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
        return sse.attach(req, res, [
            { event: 'undercut', data: undercutMonitor.getState() },
            { event: 'undercutAlerts', data: undercutMonitor.getAllAlerts() }
        ]);
    }

    if (req.method === 'GET' && url.pathname === '/api/items') {
        var watcherId = url.searchParams.get('watcherId') || '';
        var watcher = (config.undercut?.watchers || []).find(function(w) { return w.id === watcherId; });
        var apiKey = watcher?.apiKey || '';
        if (!apiKey) return json(res, 400, { ok: false, error: '请先填写该账号的 API Key 并保存' });
        try {
            if (!itemsCacheByWatcher.has(watcherId)) {
                var itemsObj = await fetchItems(apiKey);
                var items = normalizeItems(itemsObj).map(function(item) {
                    return { id: item.id, name: item.name || item.title || ('Item #' + item.id) };
                });
                items.sort(function(a, b) { return String(a.name).localeCompare(String(b.name)); });
                itemsCacheByWatcher.set(watcherId, items);
            }
            var cached = itemsCacheByWatcher.get(watcherId);
            var q = (url.searchParams.get('q') || '').trim().toLowerCase();
            var filtered = cached;
            if (q) {
                filtered = cached.filter(function(item) {
                    return String(item.name).toLowerCase().includes(q) || String(item.id).includes(q);
                });
            }
            return json(res, 200, { ok: true, items: filtered, total: cached.length });
        } catch (err) {
            return json(res, 500, { ok: false, error: err.message });
        }
    }

    if (req.method === 'POST' && url.pathname === '/api/config') {
        try {
            var body = await readJson(req);
            if (body.undercut) {
                var prevWatchers = config.undercut?.watchers || [];
                config.undercut = { ...config.undercut, ...body.undercut };
                if (Array.isArray(body.undercut.watchers)) {
                    config.undercut.watchers = body.undercut.watchers.map(function(watcher, index) {
                        var prev = prevWatchers.find(function(item) { return item.id === watcher.id; })
                            || prevWatchers[index]
                            || {};
                        return mergeUndercutWatcherConfig(watcher, prev, config.tornApiKey);
                    });
                    itemsCacheByWatcher.clear();
                }
            }
            mergeNotifyConfig(body.notify, config);
            saveServiceConfig('undercut', config);
            return json(res, 200, { ok: true });
        } catch (err) {
            return json(res, 500, { ok: false, error: err.message });
        }
    }

    if (req.method === 'POST' && url.pathname === '/api/undercut/start') {
        try { undercutMonitor.start(); return json(res, 200, { ok: true }); }
        catch (err) { return json(res, 400, { ok: false, error: err.message }); }
    }

    if (req.method === 'POST' && url.pathname === '/api/undercut/stop') {
        undercutMonitor.stop();
        return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/undercut/test-notify') {
        try {
            var testBody = await readJson(req);
            var testNotify = {
                desktop: config.notify?.desktop,
                qq: {
                    url: testBody.notify?.qq?.url || config.notify?.qq?.url,
                    token: (testBody.notify?.qq?.token && String(testBody.notify.qq.token).trim())
                        ? testBody.notify.qq.token.trim()
                        : (config.notify?.qq?.token || '')
                }
            };
            var testResult = await testUndercutWatcherNotify(testNotify, testBody.watcher || {});
            return json(res, 200, { ok: true, ...testResult });
        } catch (err) {
            return json(res, 400, { ok: false, error: err.message });
        }
    }

    return json(res, 404, { ok: false, error: 'Not Found' });
}

var server = http.createServer(async function(req, res) {
    var url = new URL(req.url, 'http://127.0.0.1');
    if (!authorize(req, res, url)) return denyAccess(res);
    if (url.pathname.startsWith('/api/')) return handleApi(req, res);
    return serveStatic(req, res);
});

var host = config.server?.host || '127.0.0.1';
var port = config.server?.port || 8790;

server.listen(port, host, function() {
    var url = 'http://' + (host === '0.0.0.0' ? '127.0.0.1' : host) + ':' + port;
    console.log('Torn 压价助手已启动: ' + url);
    if (config.server?.openBrowser) openBrowser(url);
    if (config.undercut?.autoStart !== false && undercutMonitor.getWatchers().length) {
        try { undercutMonitor.start(); }
        catch (err) { console.error('压价助手自动启动失败:', err.message); }
    }
});

process.on('SIGINT', function() {
    undercutMonitor.stop();
    process.exit(0);
});
