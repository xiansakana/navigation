import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

function pickHeaders(reqHeaders, extra) {
    var out = {};
    ['content-type', 'authorization', 'accept', 'accept-language', 'cache-control', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions'].forEach(function(key) {
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
    var subPath = url.pathname.slice(prefix.length) || '/';
    if (!subPath.startsWith('/')) subPath = '/' + subPath;
    var target = new URL(subPath + url.search, base.origin);
    if (service.adminToken && !subPath.startsWith('/api/')) {
        target.searchParams.set('token', service.adminToken);
    }
    return target;
}

function rewriteLocation(location, service) {
    if (!location) return location;
    var prefix = service.path.replace(/\/$/, '');
    try {
        var loc = new URL(location, service.internalUrl);
        var base = new URL(service.internalUrl);
        if (loc.origin === base.origin) {
            return prefix + loc.pathname + loc.search + loc.hash;
        }
    } catch (e) { /* ignore */ }
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
    if (prefix.startsWith('/torn-toolbox/')) {
        out = out
            .replace(/(["'])\/style\.css/g, '$1' + prefix + '/style.css')
            .replace(/(["'])\/shared\//g, '$1' + prefix + '/shared/')
            .replace(/(["'])\/app\.js/g, '$1' + prefix + '/app.js');
    }
    return out;
}

function injectPortalShell(html, service) {
    if (!html.includes('<body')) return html;
    var baseTag = '';
    if (service.injectBase !== false) {
        baseTag = '<base href="' + service.path.replace(/\/$/, '') + '/">';
    }
    var portalCss = '<link rel="stylesheet" href="/portal.css">';
    if (service.injectBar === false) {
        if (!baseTag) return html;
        return html.replace('<head>', '<head>' + baseTag);
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
        + '</div></header>';
    var bodyClass = 'has-navbar';
    if (isToolbox) bodyClass += ' toolbox-proxied';
    return html
        .replace('<head>', '<head>' + baseTag + portalCss)
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
        var prefix = napcat.path.replace(/\/$/, '');
        return { service: napcat, proxyUrl: prefix + url.pathname + url.search };
    }
    if (napcat && url.pathname.startsWith('/api/')) {
        var napcatPrefix = napcat.path.replace(/\/$/, '');
        return { service: napcat, proxyUrl: napcatPrefix + url.pathname + url.search };
    }
    return null;
}

export function getServiceEntryHref(service) {
    var base = service.path.replace(/\/$/, '');
    var entry = service.entryPath || '/';
    if (!entry.startsWith('/')) entry = '/' + entry;
    return base + entry;
}
