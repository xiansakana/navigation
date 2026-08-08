import http from 'node:http';
import { parseCookieHeader, mergeSetCookie, appendCookieHeader } from './siyuan-auth.js';

var SHARE_SESSION = 'PHPSESSID';

function httpRequest(options, body) {
    return new Promise(function(resolve, reject) {
        var req = http.request(options, function(res) {
            var chunks = [];
            res.on('data', function(chunk) { chunks.push(chunk); });
            res.on('end', function() {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks)
                });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function parseSetCookies(headers) {
    var setCookie = headers['set-cookie'];
    if (!setCookie) return [];
    return Array.isArray(setCookie) ? setCookie : [setCookie];
}

function mergeCookieJar(jar, setCookies) {
    setCookies.forEach(function(setCookie) {
        var part = String(setCookie).split(';')[0];
        var i = part.indexOf('=');
        if (i < 0) return;
        jar[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    });
}

function cookieHeaderFromJar(jar) {
    return Object.keys(jar).map(function(key) {
        return key + '=' + jar[key];
    }).join('; ');
}

function extractCsrf(html) {
    var text = String(html);
    var match = text.match(/name="csrf"\s+value="([^"]+)"/);
    if (match) return match[1];
    match = text.match(/value="([^"]+)"\s+name="csrf"/);
    return match ? match[1] : '';
}

function shareLooksLoggedIn(html) {
    var text = String(html);
    return !text.includes('账号登录') && !text.includes('auth-form') && !text.includes('用户名或密码错误');
}

export async function verifyShareSession(service, cookieHeader) {
    if (!cookieHeader || !cookieHeader.includes(SHARE_SESSION)) return false;
    var base = new URL(service.internalUrl);
    var res = await httpRequest({
        hostname: base.hostname,
        port: base.port || 80,
        path: '/dashboard',
        method: 'GET',
        headers: { Cookie: cookieHeader }
    });
    if (res.statusCode >= 300 && res.statusCode < 400) {
        var loc = String(res.headers.location || '');
        return !loc.includes('/login');
    }
    if (res.statusCode !== 200) return false;
    return shareLooksLoggedIn(res.body.toString('utf8'));
}

export async function loginShareSession(service) {
    if (!service?.shareUsername || !service?.sharePassword) return null;
    var base = new URL(service.internalUrl);
    var jar = {};
    var loginPage = await httpRequest({
        hostname: base.hostname,
        port: base.port || 80,
        path: '/login',
        method: 'GET'
    });
    mergeCookieJar(jar, parseSetCookies(loginPage.headers));
    var csrf = extractCsrf(loginPage.body.toString('utf8'));
    if (!csrf) return null;

    var body = new URLSearchParams({
        username: service.shareUsername,
        password: service.sharePassword,
        csrf: csrf
    }).toString();
    var loginRes = await httpRequest({
        hostname: base.hostname,
        port: base.port || 80,
        path: '/login',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
            Cookie: cookieHeaderFromJar(jar)
        }
    }, body);
    mergeCookieJar(jar, parseSetCookies(loginRes.headers));
    var cookieHeader = cookieHeaderFromJar(jar);
    if (!await verifyShareSession(service, cookieHeader)) return null;
    if (!jar[SHARE_SESSION]) return null;
    return ['PHPSESSID=' + jar[SHARE_SESSION] + '; Path=/; HttpOnly; SameSite=Lax'];
}

export async function ensureShareAuth(service, req, res, enabled) {
    if (!enabled || !service?.shareUsername || !service?.sharePassword) return false;
    if (await verifyShareSession(service, req.headers.cookie || '')) return true;
    var setCookies = await loginShareSession(service);
    if (!setCookies) return false;
    if (res) mergeSetCookie(res, setCookies);
    appendCookieHeader(req, setCookies);
    return true;
}

export function isShareLoginPath(pathname, service) {
    if (!service || service.id !== 'siyuan-share') return false;
    var prefix = service.path.replace(/\/$/, '');
    return pathname === prefix + '/login' || pathname === prefix + '/login/';
}

export function getShareDashboardPath(service) {
    return service.path.replace(/\/$/, '') + '/dashboard';
}
