import crypto from 'node:crypto';
import {
    loadRbac,
    saveRbac,
    upsertOAuthUser
} from './rbac.js';
import { createSessionCookie } from './auth.js';

const PROVIDERS = {
    github: {
        id: 'github',
        label: 'GitHub',
        authorizeUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        scope: 'read:user user:email'
    },
    google: {
        id: 'google',
        label: 'Google',
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        scope: 'openid email profile'
    }
};

function sign(payload, secret) {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function getProviderConfig(config, providerId) {
    var provider = PROVIDERS[providerId];
    var cfg = config.oauth?.[providerId];
    if (!provider || !cfg?.enabled) return null;
    if (!cfg.clientId || !cfg.clientSecret) return null;
    return { provider: provider, cfg: cfg };
}

export function listOAuthProviders(config) {
    return Object.keys(PROVIDERS).filter(function(id) {
        return !!getProviderConfig(config, id);
    }).map(function(id) {
        return { id: id, label: PROVIDERS[id].label };
    });
}

function createStateCookie(provider, secret) {
    var state = crypto.randomBytes(16).toString('hex');
    var exp = Date.now() + 10 * 60 * 1000;
    var payload = provider + ':' + state + ':' + exp;
    var token = sign(payload, secret);
    return {
        state: state,
        cookie: 'portal_oauth_state=' + encodeURIComponent(payload + '.' + token)
            + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=600'
    };
}

function verifyStateCookie(req, provider, state, secret) {
    var raw = (req.headers.cookie || '').split(';').map(function(p) { return p.trim(); })
        .find(function(p) { return p.startsWith('portal_oauth_state='); });
    if (!raw) return false;
    var val = decodeURIComponent(raw.slice('portal_oauth_state='.length));
    var dot = val.lastIndexOf('.');
    if (dot < 0) return false;
    var payload = val.slice(0, dot);
    var sig = val.slice(dot + 1);
    if (sign(payload, secret) !== sig) return false;
    var parts = payload.split(':');
    if (parts.length < 3) return false;
    var cookieProvider = parts[0];
    var cookieState = parts[1];
    var exp = Number(parts[2]);
    if (cookieProvider !== provider) return false;
    if (cookieState !== state) return false;
    if (!exp || Date.now() > exp) return false;
    return true;
}

function clearStateCookie() {
    return 'portal_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

async function readJsonResponse(resp) {
    var text = await resp.text();
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(text.slice(0, 200) || resp.statusText);
    }
}

async function exchangeGitHubToken(cfg, provider, code) {
    var body = new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code: code,
        redirect_uri: cfg.redirectUri
    });
    var resp = await fetch(provider.tokenUrl, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body.toString()
    });
    var data = await readJsonResponse(resp);
    if (!resp.ok || !data.access_token) {
        throw new Error(data.error_description || data.error || 'GitHub token 交换失败');
    }
    var userResp = await fetch('https://api.github.com/user', {
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: 'Bearer ' + data.access_token,
            'User-Agent': 'navigation-portal'
        }
    });
    var profile = await readJsonResponse(userResp);
    if (!userResp.ok || !profile.id) {
        throw new Error('无法读取 GitHub 用户信息');
    }
    var email = profile.email || '';
    if (!email) {
        var emailResp = await fetch('https://api.github.com/user/emails', {
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: 'Bearer ' + data.access_token,
                'User-Agent': 'navigation-portal'
            }
        });
        var emails = await readJsonResponse(emailResp);
        if (Array.isArray(emails)) {
            var primary = emails.find(function(item) { return item.primary && item.verified; })
                || emails.find(function(item) { return item.verified; });
            email = primary?.email || emails[0]?.email || '';
        }
    }
    return {
        provider: 'github',
        providerId: String(profile.id),
        username: 'github:' + (profile.login || profile.id),
        login: profile.login || '',
        email: email,
        name: profile.name || profile.login || ''
    };
}

async function exchangeGoogleToken(cfg, provider, code) {
    var body = new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code: code,
        redirect_uri: cfg.redirectUri,
        grant_type: 'authorization_code'
    });
    var resp = await fetch(provider.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });
    var data = await readJsonResponse(resp);
    if (!resp.ok || !data.access_token) {
        throw new Error(data.error_description || data.error || 'Google token 交换失败');
    }
    var userResp = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: 'Bearer ' + data.access_token }
    });
    var profile = await readJsonResponse(userResp);
    if (!userResp.ok || !profile.sub) {
        throw new Error('无法读取 Google 用户信息');
    }
    var email = profile.email || '';
    return {
        provider: 'google',
        providerId: String(profile.sub),
        username: 'google:' + (email || profile.sub),
        login: profile.name || email || profile.sub,
        email: email,
        name: profile.name || email || ''
    };
}

async function resolveOAuthProfile(providerId, cfg, provider, code) {
    if (providerId === 'github') return exchangeGitHubToken(cfg, provider, code);
    if (providerId === 'google') return exchangeGoogleToken(cfg, provider, code);
    throw new Error('不支持的 OAuth 提供商');
}

export function handleOAuthStart(providerId, req, res, config, secret) {
    var setup = getProviderConfig(config, providerId);
    if (!setup) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('OAuth 未启用');
        return;
    }
    var stateInfo = createStateCookie(providerId, secret);
    var params = new URLSearchParams({
        client_id: setup.cfg.clientId,
        redirect_uri: setup.cfg.redirectUri,
        scope: setup.provider.scope,
        state: stateInfo.state,
        response_type: 'code'
    });
    if (providerId === 'google') {
        params.set('access_type', 'online');
        params.set('prompt', 'select_account');
    }
    res.writeHead(302, {
        Location: setup.provider.authorizeUrl + '?' + params.toString(),
        'Set-Cookie': stateInfo.cookie
    });
    res.end();
}

export async function handleOAuthCallback(providerId, req, res, config, secret) {
    var setup = getProviderConfig(config, providerId);
    if (!setup) {
        res.writeHead(302, { Location: '/login.html?error=' + encodeURIComponent('OAuth 未启用') });
        res.end();
        return;
    }
    var url = new URL(req.url, 'http://127.0.0.1');
    var err = url.searchParams.get('error');
    if (err) {
        res.writeHead(302, { Location: '/login.html?error=' + encodeURIComponent(err) });
        res.end();
        return;
    }
    var code = url.searchParams.get('code');
    var state = url.searchParams.get('state');
    if (!code || !state || !verifyStateCookie(req, providerId, state, secret)) {
        res.writeHead(302, { Location: '/login.html?error=' + encodeURIComponent('OAuth 状态无效，请重试') });
        res.end();
        return;
    }
    try {
        var profile = await resolveOAuthProfile(providerId, setup.cfg, setup.provider, code);
        var rbac = loadRbac(config);
        var defaultRoleId = config.oauth?.defaultRoleId || 'role_guest';
        var user = upsertOAuthUser(rbac, Object.assign({}, profile, { defaultRoleId: defaultRoleId }));
        saveRbac(rbac);
        res.writeHead(302, {
            Location: '/',
            'Set-Cookie': [
                createSessionCookie(user.id, secret),
                clearStateCookie()
            ]
        });
        res.end();
    } catch (e) {
        res.writeHead(302, {
            Location: '/login.html?error=' + encodeURIComponent(e.message || 'OAuth 登录失败'),
            'Set-Cookie': clearStateCookie()
        });
        res.end();
    }
}
