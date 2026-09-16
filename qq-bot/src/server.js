/**
 * 通知管理服务。
 *
 * - Web 管理页：配置、启停并测试 QQ / 邮件渠道
 * - POST /notify：供后续业务统一发送通知
 *
 * Torn 工具箱与股票管理当前仍使用各自的提醒实现，不在此处迁移。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, publicConfig, applyPublicConfig } from './config.js';
import { sendMessage } from './napcat.js';
import { sendEmail } from './email.js';
import { startLoginWatchdog } from './watchdog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');

function readJson(req) {
    return new Promise(function(resolve, reject) {
        var chunks = [];
        var size = 0;
        req.on('data', function(chunk) {
            size += chunk.length;
            if (size > 1024 * 1024) {
                reject(new Error('请求体过大'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', function() {
            if (!chunks.length) return resolve({});
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (e) { reject(new Error('请求体不是合法 JSON')); }
        });
        req.on('error', reject);
    });
}

function json(res, status, body) {
    var text = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text, 'utf8'),
        'Cache-Control': 'no-store'
    });
    res.end(text);
}

function serve(file, res) {
    var full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full)) return false;
    var type = file.endsWith('.css') ? 'text/css; charset=utf-8'
        : file.endsWith('.js') ? 'application/javascript; charset=utf-8'
        : 'text/html; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(full).pipe(res);
    return true;
}

function checkNotifyAuth(req, notifyToken) {
    if (!notifyToken) return true;
    return (req.headers.authorization || '') === 'Bearer ' + notifyToken;
}

function qqTarget(config, body) {
    return {
        type: body.type || config.defaultTarget.type || 'private',
        userId: body.userId || config.defaultTarget.userId,
        groupId: body.groupId || config.defaultTarget.groupId,
        atUserId: body.atUserId || config.defaultTarget.atUserId
    };
}

async function sendThrough(config, channel, body) {
    if (!body.message) throw new Error('缺少 message 字段');
    if (channel === 'qq') {
        if (!config.channels.qq.enabled) throw new Error('QQ 渠道未启用');
        return sendMessage(config.napcat, qqTarget(config, body), body.message);
    }
    if (channel === 'email') {
        if (!config.channels.email.enabled) throw new Error('邮件渠道未启用');
        return sendEmail(config.channels.email, body.message, body);
    }
    throw new Error('不支持的通知渠道：' + channel);
}

function channelStatus(config) {
    return [
        {
            id: 'qq', name: 'QQ', enabled: !!config.channels.qq.enabled,
            ready: !!config.napcat.baseUrl && !!(config.defaultTarget.userId || config.defaultTarget.groupId)
        },
        {
            id: 'email', name: '邮件', enabled: !!config.channels.email.enabled,
            ready: !!config.channels.email.smtp.host && !!config.channels.email.to
        }
    ];
}

export function createNotificationServer(initialConfig) {
    var config = initialConfig || loadConfig();
    return http.createServer(async function(req, res) {
        var url = new URL(req.url, 'http://127.0.0.1');
        try {
            if (req.method === 'GET' && url.pathname === '/health') {
                return json(res, 200, { ok: true, channels: channelStatus(config) });
            }
            if (req.method === 'GET' && url.pathname === '/api/config') {
                return json(res, 200, { ok: true, config: publicConfig(config), channels: channelStatus(config) });
            }
            if (req.method === 'PUT' && url.pathname === '/api/config') {
                config = saveConfig(applyPublicConfig(config, await readJson(req)));
                return json(res, 200, { ok: true, config: publicConfig(config), channels: channelStatus(config) });
            }
            if (req.method === 'POST' && url.pathname === '/api/test') {
                var testBody = await readJson(req);
                var channel = testBody.channel || 'qq';
                var result = await sendThrough(config, channel, {
                    ...testBody,
                    message: testBody.message || ('通知管理测试成功 · ' + new Date().toLocaleString('zh-CN'))
                });
                return json(res, 200, { ok: true, channel: channel, result: result });
            }
            if (req.method === 'POST' && url.pathname === '/notify') {
                if (!checkNotifyAuth(req, config.server.notifyToken || '')) {
                    return json(res, 401, { ok: false, error: 'Unauthorized' });
                }
                var body = await readJson(req);
                var requested = Array.isArray(body.channels) ? body.channels : [body.channel || 'qq'];
                var results = [];
                for (var channelId of requested) {
                    results.push({ channel: channelId, result: await sendThrough(config, channelId, body) });
                }
                return json(res, 200, { ok: true, results: results });
            }
            if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/' || url.pathname === '/index.html')) {
                return serve('index.html', res);
            }
            if (req.method === 'GET' && url.pathname === '/style.css') return serve('style.css', res);
            if (req.method === 'GET' && url.pathname === '/app.js') return serve('app.js', res);
            return json(res, 404, { ok: false, error: 'Not Found' });
        } catch (err) {
            return json(res, 400, { ok: false, error: err.message });
        }
    });
}

async function main() {
    var config = loadConfig();
    var host = config.server.host || '127.0.0.1';
    var port = config.server.port || 8787;
    var server = createNotificationServer(config);
    startLoginWatchdog(config);
    server.listen(port, host, function() {
        console.log('通知管理服务已启动: http://' + host + ':' + port);
        console.log('管理页面: GET /');
        console.log('统一通知: POST /notify');
    });
}

// PM2 fork mode can replace process.argv[1] with its ProcessContainer wrapper.
// Node's test runner exposes NODE_TEST_CONTEXT, so imports stay side-effect free in tests
// while direct Node, npm and PM2 execution all start the HTTP service.
if (!process.env.NODE_TEST_CONTEXT) {
    main().catch(function(err) {
        console.error(err.message);
        process.exit(1);
    });
}
