import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { siyuanEntryPath } from './router.js';

export { siyuanEntryPath } from './router.js';

function pickHeaders(reqHeaders, extra, opts) {
    var options = opts || {};
    var keys = [
        'content-type', 'authorization', 'x-api-key', 'accept', 'accept-language', 'cache-control',
        'cookie', 'user-agent', 'referer', 'origin',
        'range', 'if-range',
        // AList 上传/操作依赖这些自定义头；丢掉 File-Path 会报 storage not found
        'file-path', 'as-task', 'password', 'overwrite',
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
    if (service.upstreamPathPrefix) {
        var upPrefix = String(service.upstreamPathPrefix).replace(/\/$/, '');
        subPath = subPath === '/' ? upPrefix + '/' : upPrefix + subPath;
    }
    var target = new URL(subPath + url.search, base.origin);
    if (service.adminToken && !subPath.startsWith('/api/')) {
        target.searchParams.set('token', service.adminToken);
    }
    return target;
}

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

function rewriteSiyuanPublishBody(text, prefix) {
    var pub = prefix.replace(/\/$/, '');
    var pubEsc = pub.replace(/\//g, '\\/');
    var rootAlt = 'api|stage|appearance|plugins|widgets|templates|emojis|snippets|assets|export|public|history|repo|manifest|favicon|protyle|ws|upload|check-auth';
    var out = String(text)
        .replace(/https?:\/\/127\.0\.0\.1:6808/g, pub)
        .replace(/https?:\/\/[^"'\s]+:6808/g, pub);
    // 压缩 JS 里大量 "/api/xxx" 字符串，需统一加 /publish 前缀
    out = out.replace(
        new RegExp('(["\'`])/(?!' + pubEsc + '/)(' + rootAlt + ')(?=/|["\'`])', 'g'),
        '$1' + pub + '/$2'
    );
    out = out.replace(
        new RegExp('(["\'`])/(?!' + pubEsc + '/)manifest(?=\\.)', 'g'),
        '$1' + pub + '/manifest'
    );
    return out;
}

function injectSiyuanPublishShim(html, prefix) {
    if (!html.includes('<head') || html.includes('portal-siyuan-publish-shim')) return html;
    var pub = prefix.replace(/\/$/, '');
    var shim = '<script id="portal-siyuan-publish-shim">(function(){'
        + 'var P=' + JSON.stringify(pub) + ';'
        + 'var ROOT=/^\\/(api|stage|appearance|plugins|widgets|templates|emojis|snippets|assets|export|public|history|repo|manifest|favicon|protyle|ws|upload|check-auth)(\\/|$)/;'
        + 'function fix(u){if(typeof u!=="string"||u.startsWith(P+"/"))return u;'
        + 'if(u.startsWith("/")&&ROOT.test(u))return P+u;'
        + 'try{var abs=new URL(u,location.href);'
        + 'if(abs.origin===location.origin&&ROOT.test(abs.pathname))return P+abs.pathname+abs.search+abs.hash;'
        + '}catch(e){}'
        + 'if(/^wss?:\\/\\//i.test(u)){try{var w=new URL(u);'
        + 'if(w.host===location.host&&ROOT.test(w.pathname)){w.pathname=P+w.pathname;return w.toString();}'
        + '}catch(e){}}'
        + 'return u;}'
        + 'var f=window.fetch;window.fetch=function(i,o){'
        + 'if(typeof i==="string")i=fix(i);'
        + 'else if(i&&i.url){var u=fix(i.url);if(u!==i.url)i=new Request(u,i);}'
        + 'return f.call(this,i,o);};'
        + 'var WS=window.WebSocket;window.WebSocket=function(u,p){return new WS(fix(u),p);};'
        + 'var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,a,s,t){return xo.call(this,m,fix(u),a,s,t);};'
        + '})();</script>';
    return html.replace(/<head[^>]*>/i, function(m) { return m + shim; });
}

function alreadyUnderPrefix(pathname, prefix) {
    return pathname === prefix || pathname.startsWith(prefix + '/') || pathname.startsWith(prefix + '?');
}

function rewriteLocation(location, service, userAgent) {
    if (!location) return location;
    var prefix = service.path.replace(/\/$/, '');
    try {
        var loc = new URL(location, service.internalUrl);
        var base = new URL(service.internalUrl);
        if (loc.origin === base.origin) {
            // AList 等 site_url=/alist 时 Location 已带公开前缀，勿再叠一层
            if (alreadyUnderPrefix(loc.pathname, prefix)) {
                var keepSearch = service.id === 'napcat'
                    ? stripTokenQuery(loc.search)
                    : loc.search;
                return loc.pathname + keepSearch + loc.hash;
            }
            if (service.id === 'notes' && loc.pathname === '/check-auth') {
                return prefix + loc.pathname + fixSiyuanAuthQuery(loc.search, userAgent);
            }
            if (service.id === 'napcat') {
                return prefix + loc.pathname + stripTokenQuery(loc.search) + loc.hash;
            }
            if (service.id === 'siyuan-publish') {
                return prefix + loc.pathname + loc.search + loc.hash;
            }
            return prefix + loc.pathname + loc.search + loc.hash;
        }
    } catch (e) { /* ignore */ }
    if (String(location).startsWith('/') && !String(location).startsWith('//')) {
        if (alreadyUnderPrefix(String(location), prefix)) {
            if (service.id === 'napcat') {
                var keepIdx = location.indexOf('?');
                var keepPath = keepIdx >= 0 ? location.slice(0, keepIdx) : location;
                var keepQ = keepIdx >= 0 ? location.slice(keepIdx) : '';
                return keepPath + stripTokenQuery(keepQ);
            }
            return location;
        }
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
        if (service.id === 'siyuan-publish') {
            var pubIdx = location.indexOf('?');
            var pubPath = pubIdx >= 0 ? location.slice(0, pubIdx) : location;
            var pubSearch = pubIdx >= 0 ? location.slice(pubIdx) : '';
            return prefix + pubPath + pubSearch;
        }
        return prefix + location;
    }
    var out = String(location)
        .replace(/https?:\/\/127\.0\.0\.1:6099/g, prefix)
        .replace(/https?:\/\/[^/]+:6099/g, prefix);
    if (service.id === 'siyuan-publish') {
        out = out
            .replace(/https?:\/\/127\.0\.0\.1:6808/g, prefix)
            .replace(/https?:\/\/[^"'\s]+:6808/g, prefix);
    }
    return out;
}

/**
 * @param {string} kind 'html' | 'js' | 'css' | 'json' | ''
 * 注意：绝不能对 JS 做「去掉 ?token=」类全局替换，会把三元运算 cond?"a":"b" 弄成 SyntaxError。
 */
function rewriteProxiedBody(text, service, kind) {
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
            // CSS: url(/webui/fonts/...) 无引号
            .replace(/url\(\/webui\//g, 'url(' + prefix + '/webui/');
        // 仅 HTML 清理 URL 里的 token，禁止作用于 JS
        if (kind === 'html') {
            out = out
                .replace(/([?&])token=[^&"'`\s)]+/g, '$1')
                .replace(/\?&/g, '?')
                .replace(/\?(?=[#'"`\s])/g, '')
                .replace(/&(?=[#'"`\s])/g, '');
        }
    }
    if (service.id === 'siyuan-publish') {
        return rewriteSiyuanPublishBody(out, prefix);
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
    var positionByVariant = {
        notes: '.portal-proxied-back--notes{top:8px!important;left:172px!important;right:auto!important;padding:5px 10px;font-size:13px;line-height:1.2}',
        napcat: '.portal-proxied-back--napcat{top:8px!important;left:132px!important;right:auto!important;padding:5px 10px;font-size:13px;line-height:1.2}',
        publish: '.portal-proxied-back--publish{top:8px!important;left:172px!important;right:auto!important;padding:5px 10px;font-size:13px;line-height:1.2}',
        alist: '.portal-proxied-back--alist{top:10px!important;left:12px!important;right:auto!important;padding:5px 10px;font-size:13px;line-height:1.2}'
    };
    var positionRule = positionByVariant[variant] || positionByVariant.publish;
    var css = '<style>'
        + '.portal-proxied-back{position:fixed;z-index:2147483647;display:inline-flex;align-items:center;padding:8px 12px;border-radius:8px;font:14px/1.4 system-ui,sans-serif;text-decoration:none;color:#e8edf5;background:rgba(15,17,21,.88);border:1px solid rgba(255,255,255,.12);box-shadow:0 4px 16px rgba(0,0,0,.25);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);pointer-events:auto}'
        + '.portal-proxied-back:hover{background:rgba(23,27,34,.95)}'
        + '@media (prefers-color-scheme:light){.portal-proxied-back{color:#152033;background:rgba(255,255,255,.92);border-color:rgba(15,23,42,.12);box-shadow:0 4px 16px rgba(15,23,42,.12)}.portal-proxied-back:hover{background:#fff}}'
        + positionRule
        + '@media (max-width:768px){.portal-proxied-back--notes,.portal-proxied-back--napcat,.portal-proxied-back--publish,.portal-proxied-back--alist{top:auto!important;bottom:calc(12px + env(safe-area-inset-bottom,0px))!important;left:12px!important;right:auto!important;padding:8px 12px!important;font-size:14px!important;line-height:1.3!important}}'
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

function injectNapcatTokenShim(html, token, mountPath) {
    if (!token || !html.includes('<head')) return html;
    var mount = (mountPath || '/napcat').replace(/\/$/, '');
    var loginUrl = mount + '/api/auth/login';
    var shim = '<script src="/sha256-fallback.js"></script>'
        + '<script>(function(){var t=' + JSON.stringify(token) + ';'
        + 'var loginUrl=' + JSON.stringify(loginUrl) + ';'
        + 'var g=URLSearchParams.prototype.get;URLSearchParams.prototype.get=function(k){'
        + 'if(k==="token")return g.call(this,k)||t;return g.call(this,k);};'
        + 'function napcatSha256(s){var enc=new TextEncoder().encode(s);'
        + 'if(window.crypto&&crypto.subtle){return crypto.subtle.digest("SHA-256",enc).then(function(buf){'
        + 'return Array.from(new Uint8Array(buf)).map(function(b){return b.toString(16).padStart(2,"0");}).join("");});}'
        + 'return Promise.resolve(window.portalSha256Hex(s));}'
        + 'napcatSha256(t+".napcat").then(function(hash){return fetch(loginUrl,{method:"POST",headers:{'
        + '"Content-Type":"application/json"},body:JSON.stringify({hash:hash})});}).then(function(r){return r.json();})'
        + '.then(function(data){if(data&&data.code===0&&data.data&&data.data.Credential){'
        + 'localStorage.setItem("token",JSON.stringify(data.data.Credential));}}).catch(function(){});})();</script>';
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
        var skipShell = service.id === 'napcat' || service.id === 'siyuan-publish'
            || service.id === 'alist' || isSiyuanAuthPage;
        var headInject = skipShell ? '' : themeBoot + themeJs + toastJs + dialogJs + baseTag;
        if (!headInject && service.id !== 'napcat' && service.id !== 'notes'
            && service.id !== 'siyuan-publish' && service.id !== 'alist') return html;
        if (headInject) html = html.replace('<head>', '<head>' + headInject);
        if (service.id === 'napcat') {
            html = injectNapcatTokenShim(html, service.adminToken, service.path);
            html = injectProxiedBackLink(html, 'napcat');
        }
        if (service.id === 'notes' && !isSiyuanAuthPage) html = injectProxiedBackLink(html, 'notes');
        if (service.id === 'siyuan-publish') html = injectProxiedBackLink(html, 'publish');
        if (service.id === 'alist') html = injectProxiedBackLink(html, 'alist');
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
    var url = new URL(reqUrl, 'http://127.0.0.1');
    var prefix = service.path.replace(/\/$/, '');
    if (service.id === 'notes') {
        if (url.pathname.startsWith('/api/')) return true;
        return url.pathname.startsWith(prefix + '/api/');
    }
    if (service.id === 'siyuan-publish') {
        return url.pathname.startsWith(prefix + '/api/');
    }
    return false;
}

/** 发布站不对游客暴露的插件静态目录（含密钥/图床配置入口） */
var PUBLISH_BLOCKED_PLUGIN_PREFIXES = [
    '/plugins/siyuan-plugin-picgo',
    '/plugins/siyuan-plugin-share'
];

function publishUpstreamPath(service, reqUrl) {
    var target = buildTargetUrl(service, reqUrl);
    return target.pathname || '/';
}

function isBlockedPublishPluginPath(subPath) {
    return PUBLISH_BLOCKED_PLUGIN_PREFIXES.some(function(prefix) {
        return subPath === prefix || subPath.startsWith(prefix + '/');
    });
}

function forcePublishLoadPetalsBody(body, subPath) {
    if (subPath !== '/api/petal/loadPetals' || !body || !body.length) return body;
    try {
        var json = JSON.parse(body.toString('utf8'));
        if (!json || typeof json !== 'object' || Array.isArray(json)) return body;
        json.frontend = 'publish';
        return Buffer.from(JSON.stringify(json), 'utf8');
    } catch (e) {
        return body;
    }
}

function sendPublishForbidden(res) {
    var text = JSON.stringify({ ok: false, error: '发布站禁止访问该资源' });
    res.writeHead(403, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text, 'utf8')
    });
    res.end(text);
}

export async function proxyHttpRequest(service, req, res) {
    var target = buildTargetUrl(service, req.url);
    var lib = target.protocol === 'https:' ? https : http;
    var body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req);
    var pipeJson = shouldPipeJsonResponse(service, req.url);

    if (service.id === 'siyuan-publish') {
        var pubSubPath = publishUpstreamPath(service, req.url);
        if (isBlockedPublishPluginPath(pubSubPath)) {
            sendPublishForbidden(res);
            return;
        }
        if (body) {
            var nextBody = forcePublishLoadPetalsBody(body, pubSubPath);
            if (nextBody !== body) {
                body = nextBody;
                req.headers['content-length'] = String(body.length);
                delete req.headers['transfer-encoding'];
            }
        }
    }

    await new Promise(function(resolve) {
        var fwdHost = req.headers['x-forwarded-host'] || req.headers.host || target.host;
        var fwdProto = req.headers['x-forwarded-proto']
            || (req.socket && req.socket.encrypted ? 'https' : 'http');
        var fwdFor = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
        var headersOut = pickHeaders(req.headers, {
            host: target.host,
            'x-forwarded-host': fwdHost,
            'x-forwarded-proto': fwdProto,
            'x-forwarded-for': fwdFor,
            'x-real-ip': req.socket.remoteAddress || ''
        }, { allowEncoding: pipeJson });
        // AList 用 Host/site_url 拼分享链接；有公网 Host 时优先传给上游
        if (service.id === 'alist' && fwdHost && !String(fwdHost).includes('127.0.0.1')) {
            headersOut.host = fwdHost;
        }
        if (body && body.length) {
            headersOut['content-length'] = String(body.length);
        }
        var upstream = lib.request(target, {
            method: req.method,
            headers: headersOut
        }, function(upstreamRes) {
            var headers = Object.assign({}, upstreamRes.headers);
            delete headers['content-security-policy'];
            if (headers.location) {
                headers.location = rewriteLocation(headers.location, service, req.headers['user-agent']);
            }
            var ctype = String(upstreamRes.headers['content-type'] || '');
            var isHtml = ctype.includes('text/html') && upstreamRes.statusCode >= 200 && upstreamRes.statusCode < 500;
            var isJs = (ctype.includes('javascript') || ctype.includes('text/js')) && upstreamRes.statusCode === 200;
            var isCss = ctype.includes('text/css') && upstreamRes.statusCode === 200
                && service.id === 'napcat';
            var isJson = ctype.includes('json') && upstreamRes.statusCode === 200
                && !pipeJson;
            var isStream = ctype.includes('text/event-stream');
            var rewriteKind = isHtml ? 'html' : isJs ? 'js' : isCss ? 'css' : isJson ? 'json' : '';

            if (isStream) {
                res.writeHead(upstreamRes.statusCode, headers);
                upstreamRes.pipe(res);
                upstreamRes.on('end', resolve);
                return;
            }

            if (!rewriteKind) {
                res.writeHead(upstreamRes.statusCode, headers);
                upstreamRes.pipe(res);
                upstreamRes.on('end', resolve);
                return;
            }

            // 缓冲改写时去掉压缩标记，避免 Content-Encoding 与明文 body 不一致
            delete headers['content-encoding'];
            delete headers['transfer-encoding'];

            var chunks = [];
            upstreamRes.on('data', function(chunk) { chunks.push(chunk); });
            upstreamRes.on('end', function() {
                var buf = Buffer.concat(chunks);
                var text = rewriteProxiedBody(buf.toString('utf8'), service, rewriteKind);
                if (isHtml) {
                    text = injectPortalShell(text, service);
                    if (service.id === 'siyuan-publish') {
                        text = injectSiyuanPublishShim(text, service.path.replace(/\/$/, ''));
                    }
                }
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
