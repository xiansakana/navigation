import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import {
    clearSessionCookie,
    createSessionCookie,
    getSession,
    verifyLogin,
    resolveSessionUser,
    resolveRequestUser
} from './auth.js';
import {
    getVisibleMenus,
    canViewService,
    canEditService,
    canViewAdmin,
    hasPermission,
    loadRbac,
    getStockManagePrefs,
    updateUserPrefs
} from './rbac.js';
import { resolveProxyContext, getServiceEntryHref, napcatCanonicalWebuiPath, proxyHttpRequest, proxyWebSocket } from './proxy.js';
import { handleAdminApi } from './admin-api.js';
import { wantsJsonResponse, renderErrorPage, sendHtml } from './error-page.js';
import { handleOAuthStart, handleOAuthCallback, listOAuthProviders } from './oauth.js';

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

function sendError(req, res, url, status, message, pageOptions) {
    if (wantsJsonResponse(req, url)) {
        return json(res, status, { ok: false, error: message });
    }
    var html = renderErrorPage(Object.assign({
        status: status,
        title: status === 403 ? '无权访问' : status === 404 ? '页面不存在' : '出错了',
        message: message,
        hint: ''
    }, pageOptions || {}));
    return sendHtml(res, status, html);
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

function requireAuth(req, res, options) {
    var opts = options || {};
    var ctx = resolveRequestUser(req, config);
    if (!ctx) {
        redirect(res, '/login.html');
        return null;
    }
    if (opts.requireLogin && ctx.isGuest) {
        redirect(res, '/login.html');
        return null;
    }
    return {
        username: ctx.username,
        userId: ctx.userId,
        permissions: ctx.permissions,
        isGuest: ctx.isGuest
    };
}

function menuToService(menu, userAgent) {
    var service = (config.services || []).find(function(s) { return s.id === menu.serviceId; });
    var item = {
        id: menu.id,
        title: menu.title,
        description: menu.description || (service && service.description) || '',
        type: menu.type || (service && service.type) || 'external',
        icon: menu.icon || (service && service.icon) || '📦',
        newTab: !!(service && service.newTab)
    };
    if (menu.url || (service && service.type === 'external')) {
        item.url = menu.url || (service && service.url);
    } else if (menu.path) {
        item.path = menu.path;
        if (service && (service.type === 'proxy' || service.type === 'hub')) {
            item.path = getServiceEntryHref(service, userAgent);
        }
    } else if (service) {
        if (service.type === 'proxy' || service.type === 'hub') item.path = getServiceEntryHref(service, userAgent);
        else item.url = service.url;
    }
    return item;
}

function publicServices(userCtx, userAgent) {
    if (!userCtx) return [];
    var rbac = loadRbac(config);
    return getVisibleMenus(rbac, userCtx.permissions)
        .filter(function(menu) { return menu.id !== 'menu_admin'; })
        .map(function(menu) { return menuToService(menu, userAgent); });
}

async function handleApi(req, res, url, session) {
    if (req.method === 'GET' && url.pathname === '/api/me') {
        var rbac = loadRbac(config);
        var stockManagePrefs = getStockManagePrefs(rbac, session.userId);
        return json(res, 200, {
            ok: true,
            username: session.username,
            userId: session.userId,
            permissions: session.permissions,
            isGuest: !!session.isGuest,
            canAdmin: !session.isGuest && canViewAdmin(session.permissions),
            prefs: { stockManage: stockManagePrefs }
        });
    }

    if (req.method === 'PUT' && url.pathname === '/api/me/prefs') {
        if (!canViewService(session.permissions, 'stock-manage')) {
            return json(res, 403, { ok: false, error: '无权保存偏好设置' });
        }
        try {
            var body = await readJson(req);
            var rbacData = loadRbac(config);
            var patch = {};
            if (body.stockManage && typeof body.stockManage === 'object') {
                var sm = body.stockManage;
                var stockPatch = {};
                if (typeof sm.dashboardVisible === 'boolean') stockPatch.dashboardVisible = sm.dashboardVisible;
                if (typeof sm.pnlVisible === 'boolean') stockPatch.pnlVisible = sm.pnlVisible;
                if (sm.colVis && typeof sm.colVis === 'object') stockPatch.colVis = sm.colVis;
                patch.stockManage = stockPatch;
            }
            updateUserPrefs(rbacData, session.userId, patch);
            return json(res, 200, {
                ok: true,
                prefs: { stockManage: getStockManagePrefs(rbacData, session.userId) }
            });
        } catch (err) {
            return json(res, 400, { ok: false, error: err.message });
        }
    }

    if (req.method === 'GET' && url.pathname === '/api/services') {
        return json(res, 200, { ok: true, services: publicServices(session, req.headers['user-agent']) });
    }

    if (req.method === 'GET' && url.pathname === '/api/menus') {
        var rbacMenus = loadRbac(config);
        var menus = getVisibleMenus(rbacMenus, session.permissions).map(function(menu) {
            return menuToService(menu, req.headers['user-agent']);
        });
        return json(res, 200, { ok: true, menus: menus });
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
        res.setHeader('Set-Cookie', clearSessionCookie());
        return json(res, 200, { ok: true });
    }

    if (url.pathname.startsWith('/api/admin/')) {
        if (session.isGuest) {
            return json(res, 401, { ok: false, error: '请先登录' });
        }
        return handleAdminApi(req, res, url, session, config, json, readJson);
    }

    return json(res, 404, { ok: false, error: 'Not Found' });
}

async function handleLoginApi(req, res) {
    if (req.method !== 'POST' || new URL(req.url, 'http://127.0.0.1').pathname !== '/api/login') {
        return false;
    }
    try {
        var body = await readJson(req);
        var user = verifyLogin(body.username, body.password, config);
        if (!user) {
            return json(res, 401, { ok: false, error: '用户名或密码错误' });
        }
        res.setHeader('Set-Cookie', createSessionCookie(user.id, getSessionSecret()));
        return json(res, 200, { ok: true });
    } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
    }
}

function isPortalApi(pathname, method) {
    if (pathname === '/api/oauth/providers' && method === 'GET') return true;
    if (/^\/api\/oauth\/(github|google)\/(start|callback)$/.test(pathname) && method === 'GET') return true;
    if (pathname === '/api/login' && method === 'POST') return true;
    if (pathname === '/api/me' && method === 'GET') return true;
    if (pathname === '/api/me/prefs' && method === 'PUT') return true;
    if (pathname === '/api/services' && method === 'GET') return true;
    if (pathname === '/api/menus' && method === 'GET') return true;
    if (pathname === '/api/logout' && method === 'POST') return true;
    if (pathname.startsWith('/api/admin/')) return true;
    return false;
}

function isWriteMethod(method) {
    return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function handleProxyRoute(req, res) {
    var ctx = resolveProxyContext(config.services, req.url);
    if (!ctx) return false;

    var proxySession = requireAuth(req, res);
    if (!proxySession) return true;

    if (!canViewService(proxySession.permissions, ctx.service.id)) {
        var serviceTitle = ctx.service.title || ctx.service.id;
        sendError(req, res, new URL(req.url, 'http://127.0.0.1'), 403, '无权访问该服务', {
            title: '无权访问该服务',
            message: '您没有访问「' + serviceTitle + '」的权限',
            hint: '如需访问，请联系管理员分配权限，或登录具备相应权限的账号。'
        });
        return true;
    }
    if (isWriteMethod(req.method) && !canEditService(proxySession.permissions, ctx.service.id)) {
        sendError(req, res, new URL(req.url, 'http://127.0.0.1'), 403, '该服务为只读权限，无法修改');
        return true;
    }

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
            var entry = new URL(getServiceEntryHref(ctx.service, req.headers['user-agent']), 'http://127.0.0.1');
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
        if (url.pathname === '/api/oauth/providers' && req.method === 'GET') {
            return json(res, 200, { ok: true, providers: listOAuthProviders(config) });
        }
        var oauthMatch = url.pathname.match(/^\/api\/oauth\/(github|google)\/(start|callback)$/);
        if (oauthMatch && req.method === 'GET') {
            if (oauthMatch[2] === 'start') {
                return handleOAuthStart(oauthMatch[1], req, res, config, getSessionSecret());
            }
            return handleOAuthCallback(oauthMatch[1], req, res, config, getSessionSecret());
        }
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
        if (!canViewService(hubSession.permissions, 'torn-toolbox')) {
            return sendError(req, res, url, 403, '无权访问该服务', {
                title: '无权访问该服务',
                message: '您没有访问「Torn 工具箱」的权限',
                hint: '如需访问，请联系管理员分配权限，或登录具备相应权限的账号。'
            });
        }
        if (serveStatic(path.join(PUBLIC_DIR, 'torn-toolbox', 'index.html'), res)) return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
        var homeSession = requireAuth(req, res);
        if (!homeSession) return;
        return serveStatic(path.join(PUBLIC_DIR, 'dashboard.html'), res);
    }

    if (url.pathname === '/admin' || url.pathname === '/admin.html') {
        var adminSession = requireAuth(req, res, { requireLogin: true });
        if (!adminSession) return;
        if (!canViewAdmin(adminSession.permissions)) {
            return redirect(res, '/');
        }
        if (serveStatic(path.join(PUBLIC_DIR, 'admin.html'), res)) return;
    }

    if (url.pathname === '/login' || url.pathname === '/login.html') {
        var loginSession = getSession(req, getSessionSecret());
        if (loginSession && resolveSessionUser(loginSession, config)) {
            return redirect(res, '/');
        }
        if (serveStatic(path.join(PUBLIC_DIR, 'login.html'), res)) return;
    }

    if (url.pathname === '/error.html') {
        var q = url.searchParams;
        var html = renderErrorPage({
            status: Number(q.get('status')) || 403,
            title: q.get('title') || '无权访问',
            message: q.get('message') || '无权访问该服务',
            hint: q.get('hint') || '',
            showLogin: q.get('login') !== '0'
        });
        return sendHtml(res, Number(q.get('status')) || 403, html);
    }

    var staticPath = path.normalize(path.join(PUBLIC_DIR, url.pathname));
    if (staticPath.startsWith(PUBLIC_DIR) && serveStatic(staticPath, res)) return;

    json(res, 404, { ok: false, error: 'Not Found' });
});

server.on('upgrade', function(req, socket, head) {
    var ctx = resolveRequestUser(req, config);
    if (!ctx) {
        socket.destroy();
        return;
    }
    var proxyCtx = resolveProxyContext(config.services, req.url);
    if (!proxyCtx) {
        socket.destroy();
        return;
    }
    if (!canViewService(ctx.permissions, proxyCtx.service.id)) {
        socket.destroy();
        return;
    }
    req.url = proxyCtx.proxyUrl;
    proxyWebSocket(proxyCtx.service, req, socket, head);
});

var host = config.server?.host || '127.0.0.1';
var port = config.server?.port || 8080;

server.listen(port, host, function() {
    console.log('服务导航门户已启动: http://' + (host === '0.0.0.0' ? '127.0.0.1' : host) + ':' + port);
    if (host === '0.0.0.0' && port === 80) {
        console.log('外网访问: http://<公网IP>/');
    }
    console.log('未登录访客默认使用 guest 账号权限；管理员可访问 /admin.html');
});

process.on('SIGINT', function() { process.exit(0); });
