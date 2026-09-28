import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function read(relative) {
    return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

const hub = read('qq-bot/config.json');
const expected = String(hub.server?.notifyToken || '').trim();
if (!expected) throw new Error('通知管理未配置事件鉴权 Token');
const port = String(hub.server?.port || 8787);

function checkEndpoint(name, value) {
    const endpoint = new URL('/api/business-events', value);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || (endpoint.port || '80') !== port) {
        throw new Error(name + '事件上报地址与本机通知管理服务不一致');
    }
}

for (const [name, file] of [
    ['Torn 压价', 'torn-toolbox-desktop/config.undercut.json'],
    ['Torn 公司', 'torn-toolbox-desktop/config.company.json']
]) {
    const source = read(file);
    const configured = source.notify?.qq || {};
    checkEndpoint(name, configured.url || '');
    if (String(configured.token || '').trim() !== expected) throw new Error(name + '事件鉴权 Token 与通知管理不一致');
    console.log(name + '事件上报配置：通过');
}

const stock = read('qqq-dip/config.json');
const stockUrl = stock.notify?.qq?.url || 'http://127.0.0.1:8787/notify';
checkEndpoint('股票', stockUrl);
const stockToken = String(stock.notify?.qq?.token || process.env.QQ_NOTIFY_TOKEN || expected).trim();
if (stockToken !== expected) throw new Error('股票事件鉴权 Token 与通知管理不一致');
console.log('股票事件上报配置：通过');
