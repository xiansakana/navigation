import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import {
    clearSessionCookie,
    createSessionCookie,
    getSession,
    verifyLogin
} from './auth.js';
import { resolveProxyContext, getServiceEntryHref, napcatCanonicalWebuiPath, proxyHttpRequest, proxyWebSocket } from './proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');
var config = loadConfig();

function json(res, status, body) {
    var text = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text, 'utf8')
    });
    res.end(text);
}

function redirect(res, location, setCookie) {
    var headers = { Location: location };
    if (setCookie) headers['Set-Cookie'] = setCookie;
    res.writeHead(302, headers);
    res.end();
}

function readJson(req) {
    return new Promise(function(resolve, reject) {
        var chunks = [];
        req.on('data', function(chunk) { chunks.push(chunk); });
        req.on('end', function() {
            if (!chunks.length) return resolve({});
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (e) { reject(new Error('请求体不是合法 JSON')); }
        });
        req.on('error', reject);
    });
}

function serveStatic(filePath, res) {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        return false;
    }
    var ext = path.extname(filePath);
    var types = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8'
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
    return true;
}

function getSessionSecret() {
    return config.auth?.sessionSecret || config.auth?.password || 'portal';
}

function requireAuth(req, res) {
    var session = getSession(req, getSessionSecret());
    if (!session) {
        redirect(res, '/login.html');
        return null;
    }
    return session;
}

function publicServices() {
    return (config.services || [])
        .filter(function(service) { return !service.hidden; })
        .map(function(service) {
        var item = {
            id: service.id,
            title: service.title,
            description: service.description,
            type: service.type,
            icon: service.icon || '📦',
            newTab: !!service.newTab
        };
        if (service.type === 'proxy' || service.type === 'hub') {
            item.path = getServiceEntryHref(service);
        } else if (service.type === 'external') {
            item.url = service.url;
        }
        return item;
    });
}

async function handleApi(req, res, url, session) {
    if (req.method === 'GET' && url.pathname === '/api/me') {
        return json(res, 200, { ok: true, username: session.username });
    }

    if (req.method === 'GET' && url.pathname === '/api/services') {
        return json(res, 200, { ok: true, services: publicServices() });
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
        res.setHeader('Set-Cookie', clearSessionCookie());
        return json(res, 200, { ok: true });
    }

    return json(res, 404, { ok: false, error: 'Not Found' });
}

async function handleLoginApi(req, res) {
    if (req.method !== 'POST' || new URL(req.url, 'http://127.0.0.1').pathname !== '/api/login') {
        return false;
    }
    try {
        var body = await readJson(req);
        if (!verifyLogin(body.username, body.password, config)) {
            return json(res, 401, { ok: false, error: '用户名或密码错误' });
        }
        res.setHeader('Set-Cookie', createSessionCookie(body.username, getSessionSecret()));
        return json(res, 200, { ok: true });
    } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
    }
}

function isPortalApi(pathname, method) {
    if (pathname === '/api/login' && method === 'POST') return true;
    if (pathname === '/api/me' && method === 'GET') return true;
    if (pathname === '/api/services' && method === 'GET') return true;
    if (pathname === '/api/logout' && method === 'POST') return true;
    return false;
}

function handleProxyRoute(req, res) {
    var ctx = resolveProxyContext(config.services, req.url);
    if (!ctx) return false;

    var proxySession = requireAuth(req, res);
    if (!proxySession) return true;

    var proxyUrl = new URL(ctx.proxyUrl, 'http://127.0.0.1');
    var browserUrl = new URL(req.url, 'http://127.0.0.1');

    var napcatCanonical = napcatCanonicalWebuiPath(ctx.service, browserUrl.pathname);
    if (napcatCanonical) {
        var napcatTarget = new URL(napcatCanonical + browserUrl.search, 'http://127.0.0.1');
        if (ctx.service.adminToken && !napcatTarget.searchParams.get('token')) {
            napcatTarget.searchParams.set('token', ctx.service.adminToken);
        }
        redirect(res, napcatTarget.pathname + napcatTarget.search);
        return true;
    }

    if (browserUrl.pathname.endsWith('/web_login')) {
        if (ctx.service.id === 'napcat' && ctx.service.adminToken) {
            if (!browserUrl.searchParams.get('token')) {
                browserUrl.searchParams.set('token', ctx.service.adminToken);
                redirect(res, browserUrl.pathname + browserUrl.search);
                return true;
            }
        } else {
            var entry = new URL(getServiceEntryHref(ctx.service), 'http://127.0.0.1');
            if (ctx.service.adminToken) entry.searchParams.set('token', ctx.service.adminToken);
            redirect(res, entry.pathname + entry.search);
            return true;
        }
    }

    if (ctx.service.adminToken && !proxyUrl.searchParams.get('token')) {
        if (browserUrl.pathname.startsWith('/api/')) {
            // NapCat API 不走 URL token 重定向，直接转发
        } else if (browserUrl.pathname === '/webui' || browserUrl.pathname.startsWith('/webui/')) {
            browserUrl.searchParams.set('token', ctx.service.adminToken);
            redirect(res, browserUrl.pathname + browserUrl.search);
        } else {
            proxyUrl.searchParams.set('token', ctx.service.adminToken);
            redirect(res, proxyUrl.pathname + proxyUrl.search);
        }
        if (!browserUrl.pathname.startsWith('/api/')) {
            return true;
        }
    }

    req.url = ctx.proxyUrl;
    proxyHttpRequest(ctx.service, req, res);
    return true;
}

var server = http.createServer(async function(req, res) {
    var url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname.startsWith('/api/')) {
        if (isPortalApi(url.pathname, req.method)) {
            if (url.pathname === '/api/login') {
                await handleLoginApi(req, res);
                return;
            }
            var session = requireAuth(req, res);
            if (!session) return;
            return handleApi(req, res, url, session);
        }
        if (handleProxyRoute(req, res)) return;
        return json(res, 404, { ok: false, error: 'Not Found' });
    }

    if (handleProxyRoute(req, res)) return;

    var hubPath = '/torn-toolbox';
    if (url.pathname === hubPath || url.pathname === hubPath + '/' || url.pathname === hubPath + '/index.html') {
        var hubSession = requireAuth(req, res);
        if (!hubSession) return;
        if (serveStatic(path.join(PUBLIC_DIR, 'torn-toolbox', 'index.html'), res)) return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
        var homeSession = requireAuth(req, res);
        if (!homeSession) return;
        return serveStatic(path.join(PUBLIC_DIR, 'dashboard.html'), res);
    }

    if (url.pathname === '/login' || url.pathname === '/login.html') {
        if (getSession(req, getSessionSecret())) {
            return redirect(res, '/');
        }
        if (serveStatic(path.join(PUBLIC_DIR, 'login.html'), res)) return;
    }

    var staticPath = path.normalize(path.join(PUBLIC_DIR, url.pathname));
    if (staticPath.startsWith(PUBLIC_DIR) && serveStatic(staticPath, res)) return;

    json(res, 404, { ok: false, error: 'Not Found' });
});

server.on('upgrade', function(req, socket, head) {
    if (!getSession(req, getSessionSecret())) {
        socket.destroy();
        return;
    }
    var ctx = resolveProxyContext(config.services, req.url);
    if (!ctx) {
        socket.destroy();
        return;
    }
    req.url = ctx.proxyUrl;
    proxyWebSocket(ctx.service, req, socket, head);
});

var host = config.server?.host || '127.0.0.1';
var port = config.server?.port || 8080;

server.listen(port, host, function() {
    console.log('服务导航门户已启动: http://' + (host === '0.0.0.0' ? '127.0.0.1' : host) + ':' + port);
    if (host === '0.0.0.0' && port === 80) {
        console.log('外网访问: http://<公网IP>/');
    }
    console.log('登录后可在卡片中进入各服务（含 Torn 压价助手配置）');
});

process.on('SIGINT', function() { process.exit(0); });
