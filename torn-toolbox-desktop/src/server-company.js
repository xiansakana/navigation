import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServiceConfig, saveServiceConfig } from './config.js';
import { CompanyMonitor } from './company-monitor.js';
import { testCompanyWatcherNotify } from './notify.js';
import { maskWatcherForClient, mergeWatcherConfig } from './watchers.js';
import {
    readJson, json, createStaticHandler, openBrowser, createAuthGuard,
    denyAccess, createSseBroadcaster, maskNotifyForClient, mergeNotifyConfig
} from './server-common.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public/company');
const SHARED_DIR = path.resolve(__dirname, '../public');

var config = loadServiceConfig('company');

function getConfig() { return config; }

var sse = createSseBroadcaster();
var companyMonitor = new CompanyMonitor(getConfig);
var authorize = createAuthGuard(getConfig);
var serveStatic = createStaticHandler(PUBLIC_DIR, SHARED_DIR);

['state', 'applications', 'error'].forEach(function(eventName) {
    companyMonitor.on(eventName, function(data) {
        if (eventName === 'state') sse.broadcast('company', data);
        else if (eventName === 'applications') sse.broadcast('companyApps', data);
        else if (eventName === 'error') sse.broadcast('error', { source: 'company', message: data });
    });
});

async function handleApi(req, res) {
    var url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/api/state') {
        return json(res, 200, {
            ok: true,
            config: {
                company: {
                    intervalSeconds: config.company?.intervalSeconds,
                    watchers: (config.company?.watchers || []).map(maskWatcherForClient)
                },
                notify: maskNotifyForClient(config.notify)
            },
            company: companyMonitor.getState()
        });
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
        return sse.attach(req, res, [
            { event: 'company', data: companyMonitor.getState() },
            { event: 'companyApps', data: companyMonitor.applications }
        ]);
    }

    if (req.method === 'POST' && url.pathname === '/api/config') {
        try {
            var body = await readJson(req);
            if (body.company) {
                var prevCompanyWatchers = config.company?.watchers || [];
                config.company = { ...config.company, ...body.company };
                if (Array.isArray(body.company.watchers)) {
                    config.company.watchers = body.company.watchers.map(function(watcher, index) {
                        var prev = prevCompanyWatchers.find(function(item) { return item.id === watcher.id; })
                            || prevCompanyWatchers[index]
                            || {};
                        return mergeWatcherConfig(watcher, prev, config.tornApiKey);
                    });
                }
            }
            mergeNotifyConfig(body.notify, config);
            saveServiceConfig('company', config);
            return json(res, 200, { ok: true });
        } catch (err) {
            return json(res, 500, { ok: false, error: err.message });
        }
    }

    if (req.method === 'POST' && url.pathname === '/api/company/start') {
        try {
            config.company = { ...config.company, autoStart: true };
            saveServiceConfig('company', config);
            companyMonitor.start();
            return json(res, 200, { ok: true });
        } catch (err) { return json(res, 400, { ok: false, error: err.message }); }
    }

    if (req.method === 'POST' && url.pathname === '/api/company/stop') {
        config.company = { ...config.company, autoStart: false };
        saveServiceConfig('company', config);
        companyMonitor.stop();
        return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/company/test-notify') {
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
            var testResult = await testCompanyWatcherNotify(testNotify, testBody.watcher || {});
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
var port = config.server?.port || 8791;

server.listen(port, host, function() {
    var url = 'http://' + (host === '0.0.0.0' ? '127.0.0.1' : host) + ':' + port;
    console.log('Torn 公司监听已启动: ' + url);
    if (config.server?.openBrowser) openBrowser(url);
    if (config.company?.autoStart !== false && companyMonitor.getWatchers().length) {
        try { companyMonitor.start(); }
        catch (err) { console.error('公司监听自动启动失败:', err.message); }
    }
});

process.on('SIGINT', function() {
    companyMonitor.stop();
    process.exit(0);
});
