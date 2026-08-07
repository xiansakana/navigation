import crypto from 'node:crypto';

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function parseCookies(req) {
    var out = {};
    (req.headers.cookie || '').split(';').forEach(function(part) {
        var i = part.indexOf('=');
        if (i < 0) return;
        var key = part.slice(0, i).trim();
        var val = part.slice(i + 1).trim();
        if (key) out[key] = decodeURIComponent(val);
    });
    return out;
}

function sign(payload, secret) {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function createSessionCookie(username, secret) {
    var exp = Date.now() + SESSION_MAX_AGE_MS;
    var payload = username + ':' + exp;
    var token = sign(payload, secret);
    return 'portal_session=' + encodeURIComponent(payload + '.' + token)
        + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(SESSION_MAX_AGE_MS / 1000);
}

export function clearSessionCookie() {
    return 'portal_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

export function getSession(req, secret) {
    var raw = parseCookies(req).portal_session;
    if (!raw) return null;
    var dot = raw.lastIndexOf('.');
    if (dot < 0) return null;
    var payload = raw.slice(0, dot);
    var sig = raw.slice(dot + 1);
    if (sign(payload, secret) !== sig) return null;
    var parts = payload.split(':');
    if (parts.length < 2) return null;
    var exp = Number(parts[parts.length - 1]);
    if (!exp || Date.now() > exp) return null;
    return { username: parts.slice(0, -1).join(':'), exp: exp };
}

export function verifyLogin(username, password, config) {
    return username === config.auth?.username && password === config.auth?.password;
}
