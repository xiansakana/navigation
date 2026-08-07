import crypto from 'node:crypto';
import {
    loadRbac,
    authenticateUser,
    findUserByUsername,
    findUserById,
    resolveUserPermissions
} from './rbac.js';

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

export function createSessionCookie(userId, secret) {
    var exp = Date.now() + SESSION_MAX_AGE_MS;
    var payload = userId + ':' + exp;
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
    var subject = parts.slice(0, -1).join(':');
    return { userId: subject, exp: exp };
}

export function resolveSessionUser(session, config) {
    if (!session?.userId) return null;
    var rbac = loadRbac(config);
    var user = findUserById(rbac, session.userId);
    if (user && user.enabled !== false) {
        return {
            user: user,
            permissions: resolveUserPermissions(rbac, user),
            rbac: rbac
        };
    }
    var legacy = findUserByUsername(rbac, session.userId);
    if (legacy && legacy.enabled !== false) {
        return {
            user: legacy,
            permissions: resolveUserPermissions(rbac, legacy),
            rbac: rbac
        };
    }
    return null;
}

export function verifyLogin(username, password, config) {
    var rbac = loadRbac(config);
    var user = authenticateUser(rbac, username, password);
    if (user) return user;
    if (username === config.auth?.username && password === config.auth?.password) {
        return findUserByUsername(rbac, config.auth.username) || findUserById(rbac, 'usr_admin');
    }
    return null;
}
