import http from 'node:http';

export function parseCookieHeader(cookieHeader) {
    var out = {};
    (cookieHeader || '').split(';').forEach(function(part) {
        var i = part.indexOf('=');
        if (i < 0) return;
        out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    });
    return out;
}

export function hasSiyuanCookie(req) {
    return !!parseCookieHeader(req.headers.cookie).siyuan;
}

export function loginSiyuanSession(service) {
    return new Promise(function(resolve) {
        if (!service?.accessAuthCode) {
            resolve(null);
            return;
        }
        var body = JSON.stringify({
            authCode: service.accessAuthCode,
            rememberMe: true
        });
        var target = new URL('/api/system/loginAuth', service.internalUrl);
        var upstream = http.request({
            hostname: target.hostname,
            port: target.port || 80,
            path: target.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        }, function(upstreamRes) {
            var chunks = [];
            upstreamRes.on('data', function(chunk) { chunks.push(chunk); });
            upstreamRes.on('end', function() {
                var setCookie = upstreamRes.headers['set-cookie'];
                if (upstreamRes.statusCode !== 200 || !setCookie) {
                    resolve(null);
                    return;
                }
                try {
                    var payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (payload.code === 0) {
                        resolve(setCookie);
                        return;
                    }
                } catch (e) { /* ignore */ }
                resolve(null);
            });
        });
        upstream.on('error', function() { resolve(null); });
        upstream.write(body);
        upstream.end();
    });
}

export function mergeSetCookie(res, setCookies) {
    if (!setCookies) return;
    var list = Array.isArray(setCookies) ? setCookies.slice() : [setCookies];
    var existing = res.getHeader('Set-Cookie');
    if (existing) {
        list = (Array.isArray(existing) ? existing : [existing]).concat(list);
    }
    res.setHeader('Set-Cookie', list);
}

export function appendCookieHeader(req, setCookies) {
    if (!setCookies) return;
    var list = Array.isArray(setCookies) ? setCookies : [setCookies];
    var cookies = parseCookieHeader(req.headers.cookie);
    list.forEach(function(setCookie) {
        var part = String(setCookie).split(';')[0];
        var i = part.indexOf('=');
        if (i < 0) return;
        cookies[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    });
    req.headers.cookie = Object.keys(cookies).map(function(key) {
        return key + '=' + cookies[key];
    }).join('; ');
}

export async function ensureSiyuanAuth(service, req, res, canEdit) {
    if (!canEdit || !service?.accessAuthCode) return false;
    if (hasSiyuanCookie(req)) return true;
    var setCookies = await loginSiyuanSession(service);
    if (!setCookies) return false;
    if (res) mergeSetCookie(res, setCookies);
    appendCookieHeader(req, setCookies);
    return true;
}

export function isSiyuanCheckAuthPath(pathname, service) {
    if (!service || service.id !== 'notes') return false;
    var prefix = service.path.replace(/\/$/, '');
    return pathname === '/check-auth' || pathname === prefix + '/check-auth';
}

export function resolveSiyuanRedirectTarget(service, browserUrl, userAgent, siyuanEntryPath) {
    var to = browserUrl.searchParams.get('to');
    if (!to || to === '/') {
        to = siyuanEntryPath(userAgent);
    }
    if (!to.startsWith('/')) to = '/' + to;
    var prefix = service.path.replace(/\/$/, '');
    if (to.startsWith(prefix + '/') || to === prefix) return to;
    return to;
}
