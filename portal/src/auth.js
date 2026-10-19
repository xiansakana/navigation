import crypto from 'node:crypto';
import {
    loadRbac,
    authenticateUser,
    findUserByUsername,
    findUserById,
    resolveUserPermissions
} from './rbac.js';

const DEFAULT_PERSONAL_PERMISSIONS = Object.freeze([
    'knowledge:view',
    'knowledge:notes:view',
    'knowledge:storage:edit',
    'knowledge:source:view',
    'knowledge:transcript:view',
    'knowledge:frames:view',
    'knowledge:upload:edit',
    'knowledge:import:edit',
    'knowledge:bilibili:view',
    'knowledge:bilibili:edit',
    'knowledge:quality:edit',
    'knowledge:local-input:edit',
    'knowledge:process:edit',
    'knowledge:notes:edit',
    'knowledge:publish:edit',
    'knowledge:publish:batch:edit',
    'knowledge:delete:edit',
    'knowledge:export:view',
    'knowledge:settings:edit',
    'knowledge:model:edit',
    'knowledge:worker:edit',
    'knowledge:devices:view',
    'knowledge:devices:install',
    'knowledge:devices:install-zip',
    'knowledge:devices:edit',
    'mingli:categories:view',
    'mingli:categories:edit',
    'mingli:cases:classify',
    'mingli:cases:import',
    'mingli:view',
    'mingli:chart:calculate',
    'mingli:cases:view',
    'mingli:cases:filter',
    'mingli:knowledge:view',
    'mingli:knowledge:filter',
    'mingli:cases:edit',
    'mingli:cases:delete',
    'bookkeeping:location:edit',
    'bookkeeping:qq:edit',
    'bookkeeping:view',
    'bookkeeping:entries:edit',
    'bookkeeping:accounts:view',
    'bookkeeping:accounts:edit',
    'bookkeeping:import:edit',
    'bookkeeping:export:view',
    'bookkeeping:settings:edit',
    'bookkeeping:fx:edit',
    'bookkeeping:analysis:view',
    'bookkeeping:categories:view',
    'bookkeeping:categories:edit',
]);

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function parseCookies(req) {
    var out = {};
    (req.headers.cookie || '').split(';').forEach(function(part) {
        var i = part.indexOf('=');
        if (i < 0) return;
        var key = part.slice(0, i).trim();
        var val = part.slice(i + 1).trim();
        if (key) { try { out[key] = decodeURIComponent(val); } catch { /* Ignore malformed cookies. */ } }
    });
    return out;
}

function sign(payload, secret) {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function createSessionCookie(userId, secret, options = {}) {
    var exp = Date.now() + SESSION_MAX_AGE_MS;
    var payload = userId + ':' + exp;
    var token = sign(payload, secret);
    return 'portal_session=' + encodeURIComponent(payload + '.' + token)
        + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(SESSION_MAX_AGE_MS / 1000) + (options.secure ? '; Secure' : '');
}

export function clearSessionCookie(options = {}) {
    return 'portal_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (options.secure ? '; Secure' : '');
}

export function getSession(req, secret) {
    var raw = parseCookies(req).portal_session;
    if (!raw) return null;
    var dot = raw.lastIndexOf('.');
    if (dot < 0) return null;
    var payload = raw.slice(0, dot);
    var sig = raw.slice(dot + 1);
    if (!secret || !/^[a-f0-9]{64}$/.test(sig) || !crypto.timingSafeEqual(Buffer.from(sign(payload, secret), 'hex'), Buffer.from(sig, 'hex'))) return null;
    var parts = payload.split(':');
    if (parts.length < 2) return null;
    var exp = Number(parts[parts.length - 1]);
    if (!exp || Date.now() > exp) return null;
    var subject = parts.slice(0, -1).join(':');
    return { userId: subject, exp: exp };
}

export function resolveLoggedInPermissions(rbac, user, config = {}) {
    if (!user || user.enabled === false) return [];
    var permissions = resolveUserPermissions(rbac, user);
    if (user.username === (config.auth?.guestUsername || 'guest')) return permissions;
    // Signed-in members own personal ledgers/cases and may publish their own blog posts.
    // These grants do not confer access to other users' data, stock, or admin features.
    return Array.from(new Set(permissions.concat(
        DEFAULT_PERSONAL_PERMISSIONS,
        'blog:post:edit'
    )));
}

export function resolveSessionUser(session, config) {
    if (!session?.userId) return null;
    var rbac = loadRbac(config);
    var user = findUserById(rbac, session.userId);
    if (user && user.enabled !== false) {
        return {
            user: user,
            permissions: resolveLoggedInPermissions(rbac, user, config),
            rbac: rbac
        };
    }
    var legacy = findUserByUsername(rbac, session.userId);
    if (legacy && legacy.enabled !== false) {
        return {
            user: legacy,
            permissions: resolveLoggedInPermissions(rbac, legacy, config),
            rbac: rbac
        };
    }
    return null;
}

export function isAnonymousGuestEnabled(config) {
    return config?.auth?.anonymousGuest !== false;
}

export function resolveGuestContext(config) {
    var rbac = loadRbac(config);
    var guestUsername = config?.auth?.guestUsername || 'guest';
    var user = findUserByUsername(rbac, guestUsername);
    if (!user || user.enabled === false) return null;
    return {
        user: user,
        permissions: resolveUserPermissions(rbac, user),
        rbac: rbac
    };
}

export function resolveRequestUser(req, config) {
    var secret = config?.auth?.sessionSecret;
    var session = getSession(req, secret);
    if (session) {
        var ctx = resolveSessionUser(session, config);
        if (ctx) {
            return {
                userId: ctx.user.id,
                username: ctx.user.username,
                permissions: ctx.permissions,
                rbac: ctx.rbac,
                isGuest: ctx.user.username === (config.auth?.guestUsername || 'guest'),
                session: session
            };
        }
    }
    if (!isAnonymousGuestEnabled(config)) return null;
    var guest = resolveGuestContext(config);
    if (!guest) return null;
    return {
        userId: guest.user.id,
        username: guest.user.username,
        permissions: guest.permissions,
        rbac: guest.rbac,
        isGuest: true,
        session: null
    };
}

export function verifyLogin(username, password, config) {
    var rbac = loadRbac(config);
    var user = authenticateUser(rbac, username, password);
    if (user && user.enabled !== false) return user;
    return null;
}
