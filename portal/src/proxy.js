import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { mergeSetCookie } from './siyuan-auth.js';

function pickHeaders(reqHeaders, extra, opts) {
    var options = opts || {};
    var keys = [
        'content-type', 'authorization', 'x-api-key', 'accept', 'accept-language', 'cache-control',
        'cookie', 'user-agent', 'referer', 'origin',
        'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions'
    ];
    if (options.allowEncoding) keys.push('accept-encoding');
    var out = {};
    keys.forEach(function(key) {
        var val = reqHeaders[key];
        if (val) out[key] = val;
    });
    if (extra) Object.assign(out, extra);
    return out;
}

function readBody(req) {
    return new Promise(function(resolve, reject) {
        var chunks = [];
        req.on('data', function(chunk) { chunks.push(chunk); });
        req.on('end', function() { resolve(Buffer.concat(chunks)); });
        req.on('error', reject);
    });
}

export function buildTargetUrl(service, reqUrl) {
    var base = new URL(service.internalUrl);
    var prefix = service.path.replace(/\/$/, '');
    var url = new URL(reqUrl, 'http://127.0.0.1');
    var subPath;
    if (url.pathname === prefix || url.pathname.startsWith(prefix + '/')) {
        subPath = url.pathname.slice(prefix.length) || '/';
    } else {
        subPath = url.pathname || '/';
    }
    if (!subPath.startsWith('/')) subPath = '/' + subPath;
    var target = new URL(subPath + url.search, base.origin);
    if (service.adminToken) {
        var skipApi = subPath.startsWith('/api/') && service.id !== 'napcat';
        if (!skipApi) {
            target.searchParams.set('token', service.adminToken);
        }
    }
    return target;
}

function isMobileUserAgent(userAgent) {
    var ua = String(userAgent || '');
    if (!ua) return false;
    if (ua.includes('Electron')) return false;
    if (ua.includes('Pad')) return false;
    if (ua.includes('Android') && !ua.includes('Mobile')) return false;
    return /Mobile|iPhone|iPod|Android.*Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
}

function siyuanEntryPath(userAgent) {
    return isMobileUserAgent(userAgent)
        ? '/stage/build/mobile/'
        : '/stage/build/desktop/';
}

export { siyuanEntryPath };

function fixSiyuanAuthQuery(search, userAgent) {
    var params = new URLSearchParams(search || '');
    var to = params.get('to');
    if (!to || to === '/') {
        params.set('to', siyuanEntryPath(userAgent));
    }
    var q = params.toString();
    return q ? '?' + q : '';
}

function stripTokenQuery(search) {
    var params = new URLSearchParams(search || '');
    params.delete('token');
    var q = params.toString();
    return q ? '?' + q : '';
}

function rewriteLocation(location, service, userAgent) {
    if (!location) return location;
    var prefix = service.path.replace(/\/$/, '');
    try {
        var loc = new URL(location, service.internalUrl);
        var base = new URL(service.internalUrl);
        if (loc.origin === base.origin) {
            if (service.id === 'notes' && loc.pathname === '/check-auth') {
                return prefix + loc.pathname + fixSiyuanAuthQuery(loc.search, userAgent);
            }
            if (service.id === 'napcat') {
                return prefix + loc.pathname + stripTokenQuery(loc.search) + loc.hash;
            }
            if (service.id === 'siyuan-share') {
                return prefix + loc.pathname + loc.search + loc.hash;
            }
            return prefix + loc.pathname + loc.search + loc.hash;
        }
    } catch (e) { /* ignore */ }
    if (String(location).startsWith('/') && !String(location).startsWith('//')) {
        if (service.id === 'notes' && String(location).startsWith('/check-auth')) {
            var qIdx = location.indexOf('?');
            var path = qIdx >= 0 ? location.slice(0, qIdx) : location;
            var search = qIdx >= 0 ? location.slice(qIdx) : '';
            return prefix + path + fixSiyuanAuthQuery(search, userAgent);
        }
        if (service.id === 'napcat') {
            var napIdx = location.indexOf('?');
            var napPath = napIdx >= 0 ? location.slice(0, napIdx) : location;
            var napSearch = napIdx >= 0 ? location.slice(napIdx) : '';
            return prefix + napPath + stripTokenQuery(napSearch);
        }
        return prefix + location;
    }
    return String(location)
        .replace(/https?:\/\/127\.0\.0\.1:6099/g, prefix)
        .replace(/https?:\/\/[^/]+:6099/g, prefix);
}

function rewriteProxiedBody(text, service) {
    var prefix = service.path.replace(/\/$/, '');
    var out = String(text)
        .replace(/https?:\/\/127\.0\.0\.1:6099/g, prefix)
        .replace(/https?:\/\/[^"'\s]+:6099/g, prefix)
        .replace(/(["'])\/webui/g, '$1' + prefix + '/webui');
    if (service.id === 'napcat') {
        var webuiBase = prefix + '/webui/';
        out = out
            .replace(/basename:"\/webui\/"/g, 'basename:"' + webuiBase + '"')
            .replace(/basename:'\/webui\/'/g, "basename:'" + webuiBase + "'")
            .replace(/const e="\/webui\/"/g, 'const e="' + webuiBase + '"')
            .replace(/([?&])token=[^&"'`\s)]+/g, '$1')
            .replace(/\?&/g, '?')
            .replace(/\?(?=[#'"`\s])/g, '')
            .replace(/&(?=[#'"`\s])/g, '');
    }
    if (prefix.startsWith('/torn-toolbox/')) {
        out = out
            .replace(/(["'])\/style\.css/g, '$1' + prefix + '/style.css')
            .replace(/(["'])\/shared\//g, '$1' + prefix + '/shared/')
            .replace(/(["'])\/app\.js/g, '$1' + prefix + '/app.js');
    }
    if (service.id === 'siyuan-share') {
        out = rewriteShareProxiedBody(out, prefix, service.publicUrl);
    }
    return out;
}

/** 思源分享反代：绝对路径补 /share 前缀，公开链接与插件 API 响应中的 URL 一并修正 */
function rewriteShareProxiedBody(text, prefix, publicUrl) {
    var p = prefix.replace(/\/$/, '');
    if (!p) return text;
    var out = text;
    if (publicUrl) {
        var pub = String(publicUrl).replace(/\/$/, '');
        out = out
            .replace(/https?:\/\/127\.0\.0\.1:6807(?=\/|"|\s|$)/g, pub)
            .replace(/https?:\/\/127\.0\.0\.1(?=\/s\/|"|\s|$)/g, pub);
    }
    var segments = [
        '/api/v1/', '/api/instances/', '/api-key/',
        '/assets/', '/uploads/', '/s/',
        '/login/', '/register/', '/forgot/', '/reset/', '/logout',
        '/dashboard/', '/admin-home/', '/admin/', '/account/', '/captcha', '/email-code'
    ];
    var exact = [
        '/login', '/register', '/forgot', '/reset', '/logout',
        '/dashboard', '/admin-home', '/admin', '/account', '/captcha', '/email-code'
    ];
    segments.forEach(function(seg) {
        var escaped = seg.replace(/\//g, '\\/');
        out = out.replace(new RegExp('(["\'`(])' + escaped, 'g'), '$1' + p + seg);
    });
    exact.forEach(function(seg) {
        var escaped = seg.replace(/\//g, '\\/');
        out = out.replace(new RegExp('(["\'`(])' + escaped + '(?=[\"\'`?#\\s])', 'g'), '$1' + p + seg);
    });
    out = out.replace(new RegExp(p + p + '(/|")', 'g'), p + '$1');
    out = out.replace(new RegExp('(https?:\\/\\/[^"\'\\s]+)' + p + '\\/s\\/', 'g'), '$1' + p + '/s/');
    return out;
}

function injectProxiedBackLink(html, variant) {
    var positionRule = variant === 'notes'
        ? '.portal-proxied-back--notes{top:8px!important;left:172px!important;right:auto!important;padding:5px 10px;font-size:13px;line-height:1.2}'
        : variant === 'share'
            ? '.portal-proxied-back--share{top:12px!important;left:12px!important;right:auto!important;padding:6px 10px;font-size:13px;line-height:1.2}'
            : '.portal-proxied-back--napcat{top:8px!important;left:132px!important;right:auto!important;padding:5px 10px;font-size:13px;line-height:1.2}';
    var css = '<style>'
        + '.portal-proxied-back{position:fixed;z-index:2147483647;display:inline-flex;align-items:center;padding:8px 12px;border-radius:8px;font:14px/1.4 system-ui,sans-serif;text-decoration:none;color:#e8edf5;background:rgba(15,17,21,.88);border:1px solid rgba(255,255,255,.12);box-shadow:0 4px 16px rgba(0,0,0,.25);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);pointer-events:auto}'
        + '.portal-proxied-back:hover{background:rgba(23,27,34,.95)}'
        + '@media (prefers-color-scheme:light){.portal-proxied-back{color:#152033;background:rgba(255,255,255,.92);border-color:rgba(15,23,42,.12);box-shadow:0 4px 16px rgba(15,23,42,.12)}.portal-proxied-back:hover{background:#fff}}'
        + positionRule
        + '@media (max-width:768px){.portal-proxied-back--notes,.portal-proxied-back--napcat,.portal-proxied-back--share{top:auto!important;bottom:calc(12px + env(safe-area-inset-bottom,0px))!important;left:12px!important;right:auto!important;padding:8px 12px!important;font-size:14px!important;line-height:1.3!important}}'
        + '</style>';
    var keeper = '<script>(function(){var c="portal-proxied-back portal-proxied-back--' + variant + '";function m(){var e=document.querySelector("."+c.split(" ")[0]);if(!e){e=document.createElement("a");e.className=c;e.href="/";e.textContent="← 服务导航";document.body.appendChild(e)}}m();new MutationObserver(m).observe(document.documentElement,{childList:true,subtree:true})})();</script>';
    if (html.includes('</head>')) html = html.replace('</head>', css + '</head>');
    else html = css + html;
    if (html.includes('</body>')) {
        return html.replace('</body>', keeper + '</body>');
    }
    if (!html.includes('<body')) return html;
    return html.replace(/<body([^>]*)>/, function(match, attrs) {
        return '<body' + attrs + '>' + keeper;
    });
}

function ensureViewportMeta(html) {
    if (/name=["']viewport["']/i.test(html)) return html;
    var tag = '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">';
    if (html.includes('<head>')) return html.replace('<head>', '<head>' + tag);
    return tag + html;
}

function injectNapcatTokenShim(html, token) {
    if (!token || !html.includes('<head')) return html;
    var shim = '<script>(function(){var t=' + JSON.stringify(token)
        + ';var g=URLSearchParams.prototype.get;URLSearchParams.prototype.get=function(k){'
        + 'if(k==="token")return g.call(this,k)||t;return g.call(this,k);};})();</script>';
    return html.replace(/<head[^>]*>/i, function(m) { return m + shim; });
}

function injectPortalShell(html, service) {
    if (!html.includes('<body')) return html;
    html = ensureViewportMeta(html);
    var themeBoot = '<script>(function(){try{var t=localStorage.getItem("portal-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t);}catch(e){}})();</script>';
    var themeJs = '<script src="/theme.js"></script>';
    var toastJs = '<script src="/toast.js"></script>';
    var dialogJs = '<script src="/dialog.js"></script>';
    var layoutJs = service.id === 'stock-manage' ? '<script src="/layout.js"></script>' : '';
    var themeBtn = '<button type="button" class="btn ghost navbar-theme-btn" aria-label="切换主题"><span class="navbar-theme-icon" aria-hidden="true">☀️</span><span class="label navbar-theme-label">日间</span></button>';
    var layoutBtn = service.id === 'stock-manage'
        ? '<button type="button" class="btn ghost navbar-layout-btn" aria-pressed="false" aria-label="全宽布局"><span class="label">全宽</span></button>'
        : '';
    var baseTag = '';
    if (service.injectBase !== false) {
        baseTag = '<base href="' + service.path.replace(/\/$/, '') + '/">';
    }
    var portalCss = '<link rel="stylesheet" href="/portal.css">';
    if (service.injectBar === false) {
        var isSiyuanAuthPage = service.id === 'notes' && html.includes('id="authCode"');
        var skipShell = service.id === 'napcat' || service.id === 'siyuan-share' || isSiyuanAuthPage;
        var headInject = skipShell ? '' : themeBoot + themeJs + toastJs + dialogJs + baseTag;
        if (!headInject && service.id !== 'napcat' && service.id !== 'notes' && service.id !== 'siyuan-share') return html;
        if (headInject) html = html.replace('<head>', '<head>' + headInject);
        if (service.id === 'napcat') {
            html = injectNapcatTokenShim(html, service.adminToken);
            html = injectProxiedBackLink(html, 'napcat');
        }
        if (service.id === 'notes' && !isSiyuanAuthPage) html = injectProxiedBackLink(html, 'notes');
        if (service.id === 'siyuan-share') html = injectProxiedBackLink(html, 'share');
        if (service.id === 'siyuan-share' && service.injectBase !== false && !/<base[\s>]/i.test(html)) {
            var shareBase = service.path.replace(/\/$/, '') + '/';
            html = html.replace(/<head[^>]*>/i, function(match) {
                return match + '<base href="' + shareBase + '">';
            });
        }
        return html;
    }
    var title = service.title || '服务';
    var isToolbox = service.path.startsWith('/torn-toolbox/');
    var navLinks = '';
    if (isToolbox) {
        navLinks = '<a class="navbar-link" href="/torn-toolbox/"><span class="label">Torn 工具箱</span></a>'
            + '<span class="navbar-sep"></span>'
            + '<span class="navbar-title">' + title + '</span>';
    } else {
        navLinks = '<span class="navbar-title">' + title + '</span>';
    }
    var bar = '<header class="navbar"><div class="navbar-inner">'
        + '<a class="navbar-brand" href="/"><span class="navbar-logo">⚡</span><span>服务导航</span></a>'
        + '<nav class="navbar-nav">' + navLinks + '</nav>'
        + '<div class="navbar-actions">' + layoutBtn + themeBtn + '</div>'
        + '</div></header>';
    var bodyClass = 'has-navbar';
    if (isToolbox) bodyClass += ' toolbox-proxied';
    if (service.id === 'stock-manage') bodyClass += ' stock-proxied';
    if (service.id === 'notes') bodyClass += ' notes-proxied';
    return html
        .replace('<head>', '<head>' + themeBoot + baseTag + portalCss + themeJs + toastJs + dialogJs + layoutJs)
        .replace(/<body([^>]*)>/, function(match, attrs) {
            var cls = bodyClass;
            if (/class="([^"]*)"/.test(attrs)) {
                attrs = attrs.replace(/class="([^"]*)"/, 'class="$1 ' + cls + '"');
            } else {
                attrs += ' class="' + cls + '"';
            }
            return '<body' + attrs + '>' + bar;
        });
}

function shouldPipeJsonResponse(service, reqUrl) {
    if (service.id !== 'notes') return false;
    var url = new URL(reqUrl, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) return true;
    var prefix = service.path.replace(/\/$/, '');
    return url.pathname.startsWith(prefix + '/api/');
}

export async function proxyHttpRequest(service, req, res) {
    var target = buildTargetUrl(service, req.url);
    var lib = target.protocol === 'https:' ? https : http;
    var body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req);
    var pipeJson = shouldPipeJsonResponse(service, req.url);

    await new Promise(function(resolve) {
        var upstream = lib.request(target, {
            method: req.method,
            headers: pickHeaders(req.headers, { host: target.host }, { allowEncoding: pipeJson })
        }, function(upstreamRes) {
            var headers = Object.assign({}, upstreamRes.headers);
            delete headers['content-security-policy'];
            if (headers.location) {
                headers.location = rewriteLocation(headers.location, service, req.headers['user-agent']);
            }
            var ctype = String(upstreamRes.headers['content-type'] || '');
            var isHtml = ctype.includes('text/html') && upstreamRes.statusCode >= 200 && upstreamRes.statusCode < 500;
            var isJs = (ctype.includes('javascript') || ctype.includes('text/js')) && upstreamRes.statusCode === 200;
            var isJson = ctype.includes('json') && upstreamRes.statusCode === 200
                && !pipeJson;
            var isStream = ctype.includes('text/event-stream');

            if (isStream) {
                res.writeHead(upstreamRes.statusCode, headers);
                upstreamRes.pipe(res);
                upstreamRes.on('end', resolve);
                return;
            }

            if (!isHtml && !isJs && !isJson) {
                res.writeHead(upstreamRes.statusCode, headers);
                upstreamRes.pipe(res);
                upstreamRes.on('end', resolve);
                return;
            }

            var chunks = [];
            upstreamRes.on('data', function(chunk) { chunks.push(chunk); });
            upstreamRes.on('end', function() {
                var buf = Buffer.concat(chunks);
                var text = rewriteProxiedBody(buf.toString('utf8'), service);
                if (isHtml) text = injectPortalShell(text, service);
                headers['content-length'] = Buffer.byteLength(text, 'utf8');
                res.writeHead(upstreamRes.statusCode, headers);
                res.end(text);
                resolve();
            });
        });

        upstream.on('error', function(err) {
            res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: '上游服务不可用: ' + err.message }));
            resolve();
        });

        if (body && body.length) upstream.write(body);
        upstream.end();
    });
}

/** Share logout: upstream destroys PHP session then redirects to /. Send user to portal home instead of re-SSO into /share/. */
export async function proxyShareLogout(service, req, res) {
    var target = buildTargetUrl(service, req.url);
    var lib = target.protocol === 'https:' ? https : http;
    var body = await readBody(req);

    await new Promise(function(resolve) {
        var upstream = lib.request(target, {
            method: 'POST',
            headers: pickHeaders(req.headers, { host: target.host })
        }, function(upstreamRes) {
            var status = upstreamRes.statusCode;
            var headers = {};
            if (status >= 300 && status < 400) {
                headers.location = '/';
            }
            mergeSetCookie(res, ['PHPSESSID=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax']);
            res.writeHead(status, headers);
            upstreamRes.resume();
            upstreamRes.on('end', function() {
                res.end();
                resolve();
            });
        });

        upstream.on('error', function(err) {
            res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: '上游服务不可用: ' + err.message }));
            resolve();
        });

        if (body && body.length) upstream.write(body);
        upstream.end();
    });
}

export function proxyWebSocket(service, req, socket, head) {
    var target = buildTargetUrl(service, req.url);
    var port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
    var proxySocket = net.connect(port, target.hostname, function() {
        var lines = [req.method + ' ' + target.pathname + target.search + ' HTTP/' + req.httpVersion];
        var headers = Object.assign({}, req.headers, { host: target.host });
        Object.keys(headers).forEach(function(key) {
            var val = headers[key];
            if (val == null) return;
            if (Array.isArray(val)) val.forEach(function(v) { lines.push(key + ': ' + v); });
            else lines.push(key + ': ' + val);
        });
        proxySocket.write(lines.join('\r\n') + '\r\n\r\n');
        if (head && head.length) proxySocket.write(head);
        proxySocket.pipe(socket);
        socket.pipe(proxySocket);
    });
    proxySocket.on('error', function() { socket.destroy(); });
    socket.on('error', function() { proxySocket.destroy(); });
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

/** SiYuan 使用根路径 /ws、/stage 等，需在 portal 根路由反代；/api 按命名空间区分 */
var SIYUAN_ROOT_PREFIXES = [
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

var SIYUAN_API_PREFIXES = [
    '/api/account/', '/api/ai/', '/api/archive/', '/api/asset/', '/api/attr/', '/api/av/',
    '/api/bazaar/', '/api/block/', '/api/bookmark/', '/api/broadcast/', '/api/clipboard/',
    '/api/cloud/', '/api/convert/', '/api/export/', '/api/extension/', '/api/file/',
    '/api/filetree/', '/api/format/', '/api/graph/', '/api/history/', '/api/icon/',
    '/api/import/', '/api/inbox/', '/api/lute/', '/api/network/', '/api/notebook/',
    '/api/notification/', '/api/outline/', '/api/petal/', '/api/plugin/', '/api/query/',
    '/api/ref/', '/api/repo/', '/api/riff/', '/api/search/', '/api/setting/',
    '/api/snippet/', '/api/sqlite/', '/api/storage/', '/api/sync/', '/api/system/',
    '/api/tag/', '/api/template/', '/api/transactions/', '/api/ui/'
];

function isSiyuanApiPath(pathname) {
    return SIYUAN_API_PREFIXES.some(function(prefix) {
        return pathname.startsWith(prefix);
    });
}

function isSiyuanRootPath(pathname) {
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

function findNapcatService(services) {
    return (services || []).find(function(service) {
        return service.id === 'napcat' && service.type === 'proxy';
    });
}

function findShareService(services) {
    return (services || []).find(function(service) {
        return service.id === 'siyuan-share' && service.type === 'proxy';
    });
}

/** Share 页面使用绝对路径；跳过与 portal 冲突的 /admin、/login */
var SHARE_ROOT_BLOCKED = { '/admin': true, '/login': true };

var SHARE_ROOT_EXACT = [
    '/register', '/forgot', '/reset', '/logout',
    '/dashboard', '/admin-home', '/account', '/captcha', '/email-code'
];

var SHARE_ROOT_PREFIXES = [
    '/login/', '/register/', '/forgot/', '/reset/', '/logout',
    '/dashboard/', '/admin-home/', '/admin/', '/account/', '/api-key/',
    '/api/v1/', '/api/instances/', '/assets/', '/uploads/', '/s/'
];

export function isShareRootPath(pathname) {
    if (SHARE_ROOT_BLOCKED[pathname]) return false;
    if (SHARE_ROOT_EXACT.indexOf(pathname) >= 0) return true;
    return SHARE_ROOT_PREFIXES.some(function(prefix) {
        return pathname.startsWith(prefix);
    });
}

function shareSubPath(pathname, service) {
    var prefix = service.path.replace(/\/$/, '');
    if (pathname === prefix || pathname.startsWith(prefix + '/')) {
        return pathname.slice(prefix.length) || '/';
    }
    if (isShareRootPath(pathname)) return pathname;
    return null;
}

function isSharePublicSubPath(sub) {
    if (sub === '/s' || sub.startsWith('/s/')) return true;
    if (sub.startsWith('/assets/')) return true;
    if (sub.startsWith('/uploads/')) return true;
    if (sub.startsWith('/api/v1/')) return true;
    return false;
}

/** NapCat WebUI 使用绝对路径 /webui/...，需额外挂载到同一反代 */
export function isSharePublicPath(pathname, service) {
    if (!service || service.id !== 'siyuan-share') return false;
    var sub = shareSubPath(pathname, service);
    if (!sub) return false;
    return isSharePublicSubPath(sub);
}

export function resolveProxyContext(services, reqUrl) {
    var url = new URL(reqUrl, 'http://127.0.0.1');
    var service = findProxyService(services, url.pathname);
    if (service) return { service: service, proxyUrl: reqUrl };

    var share = findShareService(services);
    if (share && isShareRootPath(url.pathname)) {
        var sharePrefix = share.path.replace(/\/$/, '');
        return { service: share, proxyUrl: sharePrefix + url.pathname + url.search };
    }

    var napcat = findNapcatService(services);
    if (napcat && (url.pathname === '/webui' || url.pathname.startsWith('/webui/'))) {
        var webuiPrefix = napcat.path.replace(/\/$/, '');
        return { service: napcat, proxyUrl: webuiPrefix + url.pathname + url.search };
    }
    if (napcat && url.pathname.startsWith('/api/') && !isSiyuanApiPath(url.pathname) && !isShareRootPath(url.pathname)) {
        var apiPrefix = napcat.path.replace(/\/$/, '');
        return { service: napcat, proxyUrl: apiPrefix + url.pathname + url.search };
    }

    var notes = findNotesService(services);
    if (notes && isSiyuanRootPath(url.pathname)) {
        return { service: notes, proxyUrl: url.pathname + url.search };
    }

    return null;
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
