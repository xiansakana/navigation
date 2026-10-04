import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSlackWebhookUrl } from './slack.js';

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
    config.channels.slack = Object.assign({ enabled: false, webhookUrl: '' }, config.channels.slack || {});
    config.monitors = config.monitors || {};
    config.monitors.tiboReset = Object.assign({
        enabled: false,
        intervalMinutes: 5,
        channels: ['qq'],
        feedUrl: 'https://codex-reset.com/api/feed',
        rssUrl: 'https://x.noodl3.net/thsottiaux/rss'
    }, config.monitors.tiboReset || {});
    config.monitors.tiboReset.channels = Array.isArray(config.monitors.tiboReset.channels)
        ? Array.from(new Set(config.monitors.tiboReset.channels.filter(function(channel) {
            return ['qq', 'email', 'slack'].includes(channel);
        })))
        : ['qq'];
    config.monitors.tiboReset.qq = Object.assign({ useDefaultTarget: true, targets: [] }, config.monitors.tiboReset.qq || {});
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
    output.channels.slack.hasWebhookUrl = !!output.channels.slack.webhookUrl;
    delete output.channels.slack.webhookUrl;
    return output;
}

export function applyPublicConfig(current, input) {
    var next = normalizeConfig(current);
    var body = input || {};
    var qq = body.channels?.qq || {};
    var email = body.channels?.email || {};
    var slack = body.channels?.slack || {};
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
    if (typeof slack.enabled === 'boolean') next.channels.slack.enabled = slack.enabled;
    if (typeof slack.webhookUrl === 'string' && slack.webhookUrl.trim()) {
        next.channels.slack.webhookUrl = validateSlackWebhookUrl(slack.webhookUrl.trim());
    }
    if (slack.clearWebhookUrl === true) next.channels.slack.webhookUrl = '';
    var monitor = body.monitors?.tiboReset || {};
    if (monitor.qq) {
        if (typeof monitor.qq.useDefaultTarget === 'boolean') next.monitors.tiboReset.qq.useDefaultTarget = monitor.qq.useDefaultTarget;
        if (Array.isArray(monitor.qq.targets)) {
            if (monitor.qq.targets.length > 20) throw new Error('Tibo QQ 目标最多 20 个');
            next.monitors.tiboReset.qq.targets = monitor.qq.targets.map(function(target, index) {
                var result = {
                    id: String(target.id || ('target-' + index)).slice(0, 100),
                    type: target.type === 'private' ? 'private' : 'group',
                    userId: String(target.userId || '').trim(),
                    groupId: String(target.groupId || '').trim(),
                    atUserId: String(target.atUserId || '').trim()
                };
                if (!next.monitors.tiboReset.qq.useDefaultTarget) {
                    if (!/^\d+$/.test(result.type === 'private' ? result.userId : result.groupId)) throw new Error('请填写有效的 Tibo QQ 号或群号');
                    if (result.type === 'group' && result.atUserId && !/^(\d+|all)$/.test(result.atUserId)) throw new Error('@ 目标应为 QQ 号或 all');
                }
                return result;
            });
            if (new Set(next.monitors.tiboReset.qq.targets.map(function(target) { return target.id; })).size !== next.monitors.tiboReset.qq.targets.length) throw new Error('Tibo QQ 目标 ID 重复');
        }
        if (!next.monitors.tiboReset.qq.useDefaultTarget && !next.monitors.tiboReset.qq.targets.length) throw new Error('请至少添加一个 Tibo QQ 目标');
    }
    if (typeof monitor.enabled === 'boolean') next.monitors.tiboReset.enabled = monitor.enabled;
    if (Array.isArray(monitor.channels)) {
        if (monitor.channels.some(function(channel) { return !['qq', 'email', 'slack'].includes(channel); })) {
            throw new Error('不支持的监听推送渠道');
        }
        next.monitors.tiboReset.channels = Array.from(new Set(monitor.channels));
    }
    if (monitor.intervalMinutes != null) {
        next.monitors.tiboReset.intervalMinutes = Math.max(1, Math.min(60, Number(monitor.intervalMinutes) || 5));
    }
    if (next.monitors.tiboReset.enabled && !next.monitors.tiboReset.channels.length) {
        throw new Error('请至少选择一个 Tibo 推送渠道');
    }
    return next;
}
