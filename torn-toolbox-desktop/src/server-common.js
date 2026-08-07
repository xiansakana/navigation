import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';

export function readJson(req) {
    return new Promise(function(resolve, reject) {
        var chunks = [];
        req.on('data', function(chunk) { chunks.push(chunk); });
        req.on('end', function() {
            if (!chunks.length) return resolve({});
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (e) { reject(new Error('请求体不是合法 JSON')); }
        });
        req.on('error', reject);
    });
}

export function json(res, status, body) {
    var text = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text, 'utf8')
    });
    res.end(text);
}

export function createStaticHandler(publicDir, sharedDir) {
    return function serveStatic(req, res) {
        var urlPath = (req.url || '/').split('?')[0];
        var root = publicDir;
        if (urlPath === '/style.css' && sharedDir) {
            root = sharedDir;
        } else if (urlPath.startsWith('/shared/') && sharedDir) {
            root = sharedDir;
        } else if (urlPath === '/') {
            urlPath = '/index.html';
        }
        var filePath = path.normalize(path.join(root, urlPath));
        if (!filePath.startsWith(root)) return json(res, 403, { ok: false, error: 'Forbidden' });
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            return json(res, 404, { ok: false, error: 'Not Found' });
        }
        var ext = path.extname(filePath);
        var types = {
            '.html': 'text/html; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8'
        };
        res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
    };
}

export function openBrowser(url) {
    var cmd = process.platform === 'win32' ? 'start "" "' + url + '"'
        : process.platform === 'darwin' ? 'open "' + url + '"'
        : 'xdg-open "' + url + '"';
    exec(cmd);
}

function parseCookies(req) {
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

function isLocalRequest(req) {
    var ip = req.socket && req.socket.remoteAddress;
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

export function createAuthGuard(getConfig) {
    return function authorize(req, res, url) {
        var config = getConfig();
        var bindHost = config.server?.host || '127.0.0.1';
        if (bindHost === '127.0.0.1' && isLocalRequest(req)) return true;

        var adminToken = (config.server && config.server.adminToken) || '';
        if (!adminToken) return true;
        var queryToken = url.searchParams.get('token') || '';
        if (queryToken === adminToken) {
            res.setHeader('Set-Cookie', 'ttb_admin=' + encodeURIComponent(adminToken) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000');
            return true;
        }
        if ((req.headers.authorization || '') === 'Bearer ' + adminToken) return true;
        if (parseCookies(req).ttb_admin === adminToken) return true;
        return false;
    };
}

export function denyAccess(res) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Unauthorized: 请在 URL 加上 ?token=你的adminToken');
}

export function createSseBroadcaster() {
    var sseClients = new Set();
    return {
        clients: sseClients,
        broadcast: function(event, data) {
            var payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
            sseClients.forEach(function(client) { client.write(payload); });
        },
        attach: function(req, res, initialEvents) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });
            (initialEvents || []).forEach(function(item) {
                res.write('event: ' + item.event + '\ndata: ' + JSON.stringify(item.data) + '\n\n');
            });
            sseClients.add(res);
            req.on('close', function() { sseClients.delete(res); });
        }
    };
}

export function maskNotifyForClient(notify) {
    return {
        desktop: notify?.desktop,
        qq: {
            enabled: notify?.qq?.enabled,
            url: notify?.qq?.url,
            hasToken: !!(notify?.qq?.token),
            token: notify?.qq?.token ? '***' + notify.qq.token.slice(-4) : ''
        }
    };
}

export function mergeNotifyConfig(bodyNotify, config) {
    if (!bodyNotify) return;
    var prevQq = config.notify?.qq || {};
    config.notify = { ...config.notify, ...bodyNotify };
    if (bodyNotify.qq) {
        config.notify.qq = { ...prevQq, ...bodyNotify.qq };
        if (!bodyNotify.qq.token || !String(bodyNotify.qq.token).trim()) {
            config.notify.qq.token = prevQq.token || '';
        }
    }
}
