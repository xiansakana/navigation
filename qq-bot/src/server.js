/**
 * 本地 HTTP 推送服务（供日后 Torn 工具箱 / 云服务器调用）
 *
 * POST /notify
 * Header: Authorization: Bearer <server.notifyToken>
 * Body: { "message": "...", "userId": "可选", "groupId": "可选", "atUserId": "可选", "type": "private|group" }
 */

import http from 'node:http';
import { loadConfig } from './config.js';
import { sendMessage } from './napcat.js';

function readJson(req) {
    return new Promise(function(resolve, reject) {
        var chunks = [];
        req.on('data', function(chunk) { chunks.push(chunk); });
        req.on('end', function() {
            if (!chunks.length) return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (e) {
                reject(new Error('请求体不是合法 JSON'));
            }
        });
        req.on('error', reject);
    });
}

function json(res, status, body) {
    var text = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text, 'utf8')
    });
    res.end(text);
}

function checkAuth(req, notifyToken) {
    if (!notifyToken) return true;
    var auth = req.headers.authorization || '';
    if (auth === 'Bearer ' + notifyToken) return true;
    return false;
}

async function handleNotify(config, body) {
    var target = {
        type: body.type || config.defaultTarget.type || 'private',
        userId: body.userId || config.defaultTarget.userId,
        groupId: body.groupId || config.defaultTarget.groupId,
        atUserId: body.atUserId || config.defaultTarget.atUserId
    };

    if (!body.message) throw new Error('缺少 message 字段');

    return sendMessage(config.napcat, target, body.message);
}

async function main() {
    var config = loadConfig();
    var host = config.server?.host || '127.0.0.1';
    var port = config.server?.port || 8787;
    var notifyToken = config.server?.notifyToken || '';

    var server = http.createServer(async function(req, res) {
        try {
            if (req.method === 'GET' && req.url === '/health') {
                return json(res, 200, { ok: true });
            }

            if (req.method !== 'POST' || req.url !== '/notify') {
                return json(res, 404, { ok: false, error: 'Not Found' });
            }

            if (!checkAuth(req, notifyToken)) {
                return json(res, 401, { ok: false, error: 'Unauthorized' });
            }

            var body = await readJson(req);
            var result = await handleNotify(config, body);
            json(res, 200, { ok: true, result: result });
        } catch (err) {
            json(res, 500, { ok: false, error: err.message });
        }
    });

    server.listen(port, host, function() {
        console.log('QQ 推送服务已启动: http://' + host + ':' + port);
        console.log('健康检查: GET /health');
        console.log('发送通知: POST /notify');
        if (notifyToken) console.log('需要 Header: Authorization: Bearer <notifyToken>');
    });
}

main().catch(function(err) {
    console.error(err.message);
    process.exit(1);
});
