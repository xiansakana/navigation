import { createServer } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { ProxyAgent, request } from '../portal/node_modules/undici/index.js';
import { geminiServerConfig } from '../portal/src/knowledge-gemini.js';

const [host, containerIp] = process.argv.slice(2);
const { proxyUrl } = geminiServerConfig();
if (!host || !containerIp || !proxyUrl) throw new Error('SiYuan Docker network and knowledge module proxy are required');

const origin = 'https://generativelanguage.googleapis.com';
const dispatcher = new ProxyAgent(proxyUrl);

createServer(async (req, res) => {
    if (req.socket.remoteAddress !== containerIp) {
        res.writeHead(403).end();
        return;
    }

    if (!/^\/v1(?:beta)?\//.test(req.url) || !['GET', 'POST'].includes(req.method)) {
        res.writeHead(404).end();
        return;
    }
    const url = new URL(origin + req.url);

    const headers = {};
    for (const name of ['authorization', 'x-goog-api-key', 'content-type', 'accept']) {
        if (req.headers[name]) headers[name] = req.headers[name];
    }

    const controller = new AbortController();
    res.once('close', () => controller.abort());
    try {
        const upstream = await request(url, {
            dispatcher,
            method: req.method,
            headers,
            body: req.method === 'POST' ? req : undefined,
            signal: controller.signal
        });
        for (const name of ['content-type', 'content-encoding', 'retry-after']) {
            if (upstream.headers[name]) res.setHeader(name, upstream.headers[name]);
        }
        res.writeHead(upstream.statusCode);
        await pipeline(upstream.body, res);
    } catch {
        if (res.destroyed) return;
        if (res.headersSent) res.destroy();
        else res.writeHead(502, { 'Content-Type': 'application/json' }).end('{"error":{"message":"Gemini upstream unavailable"}}');
    }
}).listen(17891, host);
