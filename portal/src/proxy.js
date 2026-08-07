import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

function pickHeaders(reqHeaders, extra) {
    var out = {};
    [
        'content-type', 'authorization', 'accept', 'accept-language', 'cache-control',
        'cookie', 'user-agent', 'referer', 'origin',
        'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions'
    ].forEach(function(key) {
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
    if (service.adminToken && !subPath.startsWith('/api/')) {
        target.searchParams.set('token', service.adminToken);
    }
    return target;
}

function siyuanEntryPath() {
    return '/stage/build/desktop/';
}

function fixSiyuanAuthQuery(search) {
    var params = new URLSearchParams(search || '');
    var to = params.get('to');
    if (!to || to === '/') {
        params.set('to', siyuanEntryPath());
    }
    var q = params.toString();
    return q ? '?' + q : '';
}

function rewriteLocation(location, service) {
    if (!location) return location;
    var prefix = service.path.replace(/\/$/, '');
    try {
        var loc = new URL(location, service.internalUrl);
        var base = new URL(service.internalUrl);
        if (loc.origin === base.origin) {
            if (service.id === 'notes' && loc.pathname === '/check-auth') {
                return prefix + loc.pathname + fixSiyuanAuthQuery(loc.search);
            }
            return prefix + loc.pathname + loc.search + loc.hash;
        }
    } catch (e) { /* ignore */ }
    if (String(location).startsWith('/') && !String(location).startsWith('//')) {
        if (service.id === 'notes' && String(location).startsWith('/check-auth')) {
            var qIdx = location.indexOf('?');
            var path = qIdx >= 0 ? location.slice(0, qIdx) : location;
            var search = qIdx >= 0 ? location.slice(qIdx) : '';
            return prefix + path + fixSiyuanAuthQuery(search);
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
            .replace(/const e="\/webui\/"/g, 'const e="' + webuiBase + '"');
    }
    if (prefix.startsWith('/torn-toolbox/')) {
        out = out
            .replace(/(["'])\/style\.css/g, '$1' + prefix + '/style.css')
            .replace(/(["'])\/shared\//g, '$1' + prefix + '/shared/')
            .replace(/(["'])\/app\.js/g, '$1' + prefix + '/app.js');
    }
    return out;
}

function injectProxiedBackLink(html, variant) {
    var positionRule = variant === 'notes'
        ? '.portal-proxied-back--notes{top:12px!important;right:56px!important;left:auto!important}'
        : '.portal-proxied-back--napcat{top:12px!important;right:12px!important;left:auto!important}';
    var css = '<style>'
        + '.portal-proxied-back{position:fixed;z-index:2147483647;display:inline-flex;align-items:center;padding:8px 12px;border-radius:8px;font:14px/1.4 system-ui,sans-serif;text-decoration:none;color:#e8edf5;background:rgba(15,17,21,.88);border:1px solid rgba(255,255,255,.12);box-shadow:0 4px 16px rgba(0,0,0,.25);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);pointer-events:auto}'
        + '.portal-proxied-back:hover{background:rgba(23,27,34,.95)}'
        + '@media (prefers-color-scheme:light){.portal-proxied-back{color:#152033;background:rgba(255,255,255,.92);border-color:rgba(15,23,42,.12);box-shadow:0 4px 16px rgba(15,23,42,.12)}.portal-proxied-back:hover{background:#fff}}'
        + positionRule
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

function injectPortalShell(html, service) {
    if (!html.includes('<body')) return html;
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
        var skipShell = service.id === 'napcat' || isSiyuanAuthPage;
        var headInject = skipShell ? '' : themeBoot + themeJs + toastJs + dialogJs + baseTag;
        if (!headInject && service.id !== 'napcat' && service.id !== 'notes') return html;
        if (headInject) html = html.replace('<head>', '<head>' + headInject);
        if (service.id === 'napcat') html = injectProxiedBackLink(html, 'napcat');
        if (service.id === 'notes' && !isSiyuanAuthPage) html = injectProxiedBackLink(html, 'notes');
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

export async function proxyHttpRequest(service, req, res) {
    var target = buildTargetUrl(service, req.url);
    var lib = target.protocol === 'https:' ? https : http;
    var body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req);

    await new Promise(function(resolve) {
        var upstream = lib.request(target, {
            method: req.method,
            headers: pickHeaders(req.headers, { host: target.host })
        }, function(upstreamRes) {
            var headers = Object.assign({}, upstreamRes.headers);
            delete headers['content-security-policy'];
            if (headers.location) {
                headers.location = rewriteLocation(headers.location, service);
            }
            var ctype = String(upstreamRes.headers['content-type'] || '');
            var isHtml = ctype.includes('text/html') && upstreamRes.statusCode === 200;
            var isJs = (ctype.includes('javascript') || ctype.includes('text/js')) && upstreamRes.statusCode === 200;
            var isStream = ctype.includes('text/event-stream');

            if (isStream) {
                res.writeHead(upstreamRes.statusCode, headers);
                upstreamRes.pipe(res);
                upstreamRes.on('end', resolve);
                return;
            }

            if (!isHtml && !isJs) {
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

/** NapCat WebUI 使用绝对路径 /webui/...，需额外挂载到同一反代 */
export function resolveProxyContext(services, reqUrl) {
    var url = new URL(reqUrl, 'http://127.0.0.1');
    var service = findProxyService(services, url.pathname);
    if (service) return { service: service, proxyUrl: reqUrl };

    var napcat = findNapcatService(services);
    if (napcat && (url.pathname === '/webui' || url.pathname.startsWith('/webui/'))) {
        var webuiPrefix = napcat.path.replace(/\/$/, '');
        return { service: napcat, proxyUrl: webuiPrefix + url.pathname + url.search };
    }
    if (napcat && url.pathname.startsWith('/api/') && !isSiyuanApiPath(url.pathname)) {
        var apiPrefix = napcat.path.replace(/\/$/, '');
        return { service: napcat, proxyUrl: apiPrefix + url.pathname + url.search };
    }

    var notes = findNotesService(services);
    if (notes && isSiyuanRootPath(url.pathname)) {
        return { service: notes, proxyUrl: url.pathname + url.search };
    }

    return null;
}

export function getServiceEntryHref(service) {
    var base = service.path.replace(/\/$/, '');
    var entry = service.entryPath || '/';
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
