/**
 * Portal 统一路由：请求分流优先级
 *
 * 1. Portal 自有 API（/api/oauth、/api/me、/api/admin 等）— 绝不反代
 * 2. 前缀反代（/stock-manage、/notes、/napcat、/torn-toolbox/...）
 * 3. 思源根路径（/api/{siyuan-ns}、/ws、/stage/ 等）
 * 4. NapCat 根路径（/webui、/api/{napcat-ns}，非思源且非 Portal 保留）
 *
 * 未知 /api/* 返回 not-found，避免误打到 NapCat。
 */

function isMobileUserAgent(userAgent) {
    var ua = String(userAgent || '');
    if (!ua) return false;
    if (ua.includes('Electron')) return false;
    if (ua.includes('Pad')) return false;
    if (ua.includes('Android') && !ua.includes('Mobile')) return false;
    return /Mobile|iPhone|iPod|Android.*Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
}

export function siyuanEntryPath(userAgent) {
    return isMobileUserAgent(userAgent)
        ? '/stage/build/mobile/'
        : '/stage/build/desktop/';
}

/** Portal 保留命名空间：即使未在 isPortalApi 注册，也不进入反代 */
export var PORTAL_API_NAMESPACES = new Set([
    'oauth', 'login', 'me', 'services', 'menus', 'logout', 'admin'
]);

/** 思源 /api/{ns} 命名空间（与 kernel/api/router.go 同步） */
export var SIYUAN_API_NAMESPACES = new Set([
    'account', 'ai', 'archive', 'asset', 'attr', 'av', 'bazaar', 'block', 'bookmark',
    'broadcast', 'clipboard', 'cloud', 'convert', 'export', 'extension', 'file', 'filetree',
    'format', 'graph', 'history', 'icon', 'import', 'inbox', 'lute', 'network', 'notebook',
    'notification', 'outline', 'petal', 'plugin', 'query', 'ref', 'repo', 'riff', 'search',
    'setting', 'snippet', 'sqlite', 'storage', 'sync', 'system', 'tag', 'template',
    'transactions', 'ui'
]);

/** NapCat WebUI 使用的根 /api 命名空间（allowlist，避免吞掉未知 API） */
export var NAPCAT_API_NAMESPACES = new Set([
    'auth'
]);

/** 思源非 /api 根路径（块编辑器、静态资源、WebSocket 等） */
export var SIYUAN_ROOT_PREFIXES = [
    '/ws',
    '/stage/',
    '/appearance/',
    '/plugins/',
    '/widgets/',
    '/templates/',
    '/emojis/',
    '/snippets/',
    '/assets/',
    '/export/',
    '/public/',
    '/history/',
    '/upload',
    '/check-auth',
    '/favicon.ico',
    '/manifest.json',
    '/manifest.webmanifest',
    '/service-worker.js',
    '/repo/'
];

export function apiNamespace(pathname) {
    if (!pathname.startsWith('/api/')) return null;
    var rest = pathname.slice('/api/'.length);
    if (!rest) return null;
    return rest.split('/')[0];
}

export function isPortalApiNamespace(pathname) {
    var ns = apiNamespace(pathname);
    return ns != null && PORTAL_API_NAMESPACES.has(ns);
}

export function isSiyuanApiPath(pathname) {
    var ns = apiNamespace(pathname);
    return ns != null && SIYUAN_API_NAMESPACES.has(ns);
}

export function isSiyuanRootPath(pathname) {
    if (isSiyuanApiPath(pathname)) return true;
    if (pathname === '/upload') return true;
    if (pathname === '/check-auth') return true;
    if (pathname === '/favicon.ico') return true;
    if (pathname === '/manifest.json' || pathname === '/manifest.webmanifest') return true;
    if (pathname === '/service-worker.js') return true;
    if (pathname === '/ws' || pathname.startsWith('/ws/')) return true;
    return SIYUAN_ROOT_PREFIXES.some(function(prefix) {
        if (prefix.endsWith('/')) return pathname.startsWith(prefix);
        return false;
    });
}

export function isNapcatApiPath(pathname) {
    if (isPortalApiNamespace(pathname) || isSiyuanApiPath(pathname)) return false;
    var ns = apiNamespace(pathname);
    return ns != null && NAPCAT_API_NAMESPACES.has(ns);
}

/** Portal 自有 HTTP API（method + path）；新增接口只需在此登记 */
export function isPortalApi(pathname, method) {
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

export function findProxyService(services, pathname) {
    var matches = (services || []).filter(function(service) {
        return service.type === 'proxy'
            && service.path
            && (pathname === service.path || pathname.startsWith(service.path + '/'));
    });
    if (!matches.length) return null;
    return matches.sort(function(a, b) { return b.path.length - a.path.length; })[0];
}

function findNotesService(services) {
    return (services || []).find(function(service) {
        return service.id === 'notes' && service.type === 'proxy';
    });
}

function findNapcatService(services) {
    return (services || []).find(function(service) {
        return service.id === 'napcat' && service.type === 'proxy';
    });
}

/**
 * 解析反代目标。仅处理需转发到上游的请求；Portal API 应在上层已拦截。
 * @returns {{ service: object, proxyUrl: string } | null}
 */
export function resolveProxyContext(services, reqUrl) {
    var url = new URL(reqUrl, 'http://127.0.0.1');

    if (url.pathname.startsWith('/api/') && isPortalApiNamespace(url.pathname)) {
        return null;
    }

    var service = findProxyService(services, url.pathname);
    if (service) return { service: service, proxyUrl: reqUrl };

    var napcat = findNapcatService(services);
    if (napcat && (url.pathname === '/webui' || url.pathname.startsWith('/webui/'))) {
        var webuiPrefix = napcat.path.replace(/\/$/, '');
        return { service: napcat, proxyUrl: webuiPrefix + url.pathname + url.search };
    }
    if (napcat && isNapcatApiPath(url.pathname)) {
        var apiPrefix = napcat.path.replace(/\/$/, '');
        return { service: napcat, proxyUrl: apiPrefix + url.pathname + url.search };
    }

    var notes = findNotesService(services);
    if (notes && isSiyuanRootPath(url.pathname)) {
        return { service: notes, proxyUrl: url.pathname + url.search };
    }

    return null;
}

/**
 * 统一路由解析（HTTP 入口）
 * @returns {{ kind: 'portal-oauth'|'portal-api'|'proxy'|'not-found'|'pass', oauthProvider?: string, oauthAction?: string, service?: object, proxyUrl?: string }}
 */
export function resolveRoute(services, pathname, method, search) {
    search = search || '';

    if (pathname.startsWith('/api/')) {
        if (pathname === '/api/oauth/providers' && method === 'GET') {
            return { kind: 'portal-oauth', oauthAction: 'providers' };
        }
        var oauthMatch = pathname.match(/^\/api\/oauth\/(github|google)\/(start|callback)$/);
        if (oauthMatch && method === 'GET') {
            return {
                kind: 'portal-oauth',
                oauthProvider: oauthMatch[1],
                oauthAction: oauthMatch[2]
            };
        }
        if (isPortalApi(pathname, method)) {
            return { kind: 'portal-api', pathname: pathname, method: method };
        }
        if (isPortalApiNamespace(pathname)) {
            return { kind: 'not-found' };
        }

        var proxyCtx = resolveProxyContext(services, pathname + search);
        if (proxyCtx) {
            return { kind: 'proxy', service: proxyCtx.service, proxyUrl: proxyCtx.proxyUrl };
        }
        return { kind: 'not-found' };
    }

    var nonApiProxy = resolveProxyContext(services, pathname + search);
    if (nonApiProxy) {
        return { kind: 'proxy', service: nonApiProxy.service, proxyUrl: nonApiProxy.proxyUrl };
    }
    return { kind: 'pass' };
}

export function getServiceEntryHref(service, userAgent) {
    var base = service.path.replace(/\/$/, '');
    var entry = service.entryPath || '/';
    if (service.id === 'notes') {
        if (!entry || entry === '/' || entry === '/stage/build/desktop/' || entry === '/stage/build/mobile/') {
            entry = userAgent ? siyuanEntryPath(userAgent) : '/';
        }
    }
    if (!entry.startsWith('/')) entry = '/' + entry;
    return base + entry;
}

/** 兼容根路径 /webui，统一重定向到 /napcat/webui */
export function napcatCanonicalWebuiPath(service, pathname) {
    if (service.id !== 'napcat') return null;
    if (pathname === '/webui' || pathname.startsWith('/webui/')) {
        var mount = service.path.replace(/\/$/, '') + '/webui';
        return mount + pathname.slice('/webui'.length) || mount + '/';
    }
    return null;
}
