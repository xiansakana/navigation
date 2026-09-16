import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, '../config.json');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

export function normalizeConfig(raw) {
    var config = clone(raw || {});
    config.napcat = config.napcat || {};
    config.defaultTarget = config.defaultTarget || {};
    config.server = config.server || {};
    config.channels = config.channels || {};
    config.channels.qq = Object.assign({ enabled: true }, config.channels.qq || {});
    config.channels.email = Object.assign({
        enabled: false,
        from: '',
        to: '',
        smtp: { host: '', port: 465, secure: true, user: '', pass: '' }
    }, config.channels.email || {});
    config.channels.email.smtp = Object.assign(
        { host: '', port: 465, secure: true, user: '', pass: '' },
        config.channels.email.smtp || {}
    );
    config.monitors = config.monitors || {};
    config.monitors.tiboReset = Object.assign({
        enabled: false,
        intervalMinutes: 5,
        feedUrl: 'https://codex-reset.com/api/feed',
        rssUrl: 'https://x.noodl3.net/thsottiaux/rss'
    }, config.monitors.tiboReset || {});
    return config;
}

export function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        throw new Error(
            '未找到 config.json，请复制 config.example.json 为 config.json 并填写 NapCat 地址与 QQ 号'
        );
    }
    return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
}

export function saveConfig(config) {
    var normalized = normalizeConfig(config);
    var tempPath = CONFIG_PATH + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
    fs.renameSync(tempPath, CONFIG_PATH);
    return normalized;
}

export function publicConfig(config) {
    var output = normalizeConfig(config);
    output.napcat.hasAccessToken = !!output.napcat.accessToken;
    delete output.napcat.accessToken;
    output.server.hasNotifyToken = !!output.server.notifyToken;
    delete output.server.notifyToken;
    output.channels.email.smtp.hasPassword = !!output.channels.email.smtp.pass;
    delete output.channels.email.smtp.pass;
    return output;
}

export function applyPublicConfig(current, input) {
    var next = normalizeConfig(current);
    var body = input || {};
    var qq = body.channels?.qq || {};
    var email = body.channels?.email || {};
    var smtp = email.smtp || {};

    if (typeof qq.enabled === 'boolean') next.channels.qq.enabled = qq.enabled;
    if (typeof body.napcat?.baseUrl === 'string') next.napcat.baseUrl = body.napcat.baseUrl.trim();
    if (typeof body.napcat?.accessToken === 'string' && body.napcat.accessToken) {
        next.napcat.accessToken = body.napcat.accessToken;
    }
    if (body.napcat?.clearAccessToken === true) next.napcat.accessToken = '';
    if (typeof body.defaultTarget?.type === 'string') next.defaultTarget.type = body.defaultTarget.type;
    ['userId', 'groupId', 'atUserId'].forEach(function(key) {
        if (body.defaultTarget && Object.hasOwn(body.defaultTarget, key)) {
            next.defaultTarget[key] = String(body.defaultTarget[key] || '').trim();
        }
    });

    if (typeof email.enabled === 'boolean') next.channels.email.enabled = email.enabled;
    if (typeof email.from === 'string') next.channels.email.from = email.from.trim();
    if (typeof email.to === 'string') next.channels.email.to = email.to.trim();
    if (typeof smtp.host === 'string') next.channels.email.smtp.host = smtp.host.trim();
    if (smtp.port != null) next.channels.email.smtp.port = Number(smtp.port) || 465;
    if (typeof smtp.secure === 'boolean') next.channels.email.smtp.secure = smtp.secure;
    if (typeof smtp.user === 'string') next.channels.email.smtp.user = smtp.user.trim();
    if (typeof smtp.pass === 'string' && smtp.pass) next.channels.email.smtp.pass = smtp.pass;
    if (smtp.clearPassword === true) next.channels.email.smtp.pass = '';
    var monitor = body.monitors?.tiboReset || {};
    if (typeof monitor.enabled === 'boolean') next.monitors.tiboReset.enabled = monitor.enabled;
    if (monitor.intervalMinutes != null) {
        next.monitors.tiboReset.intervalMinutes = Math.max(1, Math.min(60, Number(monitor.intervalMinutes) || 5));
    }
    return next;
}
