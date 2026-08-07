import notifier from 'node-notifier';
import { sanitizeQqText, formatApplicationSummary } from './utils.js';
import { normalizeQqTargets } from './watchers.js';

export async function sendDesktopNotification(title, text) {
    return new Promise(function(resolve) {
        notifier.notify({
            title: title,
            message: text,
            sound: true,
            wait: false
        }, resolve);
    });
}

function buildQqPayload(qqConfig, text) {
    var payload = { message: sanitizeQqText(text) };
    if (qqConfig.type) payload.type = qqConfig.type;
    if (qqConfig.groupId) payload.groupId = String(qqConfig.groupId);
    if (qqConfig.userId) payload.userId = String(qqConfig.userId);
    if (qqConfig.atUserId) payload.atUserId = String(qqConfig.atUserId);
    return payload;
}

export function buildWatcherQqConfigs(globalNotify, watcherNotify) {
    if (!watcherNotify?.qq?.enabled) return [];
    var globalQq = globalNotify?.qq || {};
    if (!globalQq.url) return [];
    return normalizeQqTargets(watcherNotify.qq).map(function(target) {
        return {
            enabled: true,
            url: globalQq.url,
            token: globalQq.token,
            type: target.type || 'group',
            groupId: target.groupId || '',
            userId: target.userId || '',
            atUserId: target.atUserId || ''
        };
    }).filter(function(cfg) {
        if (cfg.type === 'private') return !!cfg.userId;
        return !!cfg.groupId;
    });
}

export async function sendQqNotification(qqConfig, text) {
    if (!qqConfig?.enabled) return;
    var url = (qqConfig.url || '').trim();
    if (!url) return;
    var headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (qqConfig.token) headers.Authorization = 'Bearer ' + qqConfig.token;
    var resp = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(buildQqPayload(qqConfig, text))
    });
    if (!resp.ok) {
        var body = await resp.text();
        throw new Error('QQ 推送失败 (' + resp.status + '): ' + body);
    }
}

export async function notifyUndercutAlert(globalNotify, watcherNotify, alert, alertText) {
    var sourceLabel = alert.source === 'Bazaar' ? 'Bazaar' : 'Item Market';
    var title = 'Torn 压价 · ' + sourceLabel;
    var tasks = [];
    if (watcherNotify?.desktop !== false && globalNotify?.desktop) {
        tasks.push(sendDesktopNotification(title, alertText));
    }
    buildWatcherQqConfigs(globalNotify, watcherNotify).forEach(function(qqConfig) {
        tasks.push(sendQqNotification(qqConfig, '[Torn压价] ' + alertText));
    });
    await Promise.allSettled(tasks).then(function(results) {
        results.forEach(function(result) {
            if (result.status === 'rejected') {
                console.error('[notify]', result.reason?.message || result.reason);
            }
        });
    });
}

export async function testUndercutWatcherNotify(globalNotify, watcher) {
    var label = watcher.label || '测试';
    var watcherNotify = watcher.notify || {};
    if (!watcherNotify.qq?.enabled) {
        throw new Error('请先启用该账号的 QQ 通知');
    }
    var configs = buildWatcherQqConfigs(globalNotify, watcherNotify);
    if (!configs.length) {
        throw new Error('请至少添加一个有效的 QQ 通知方式（群号或私聊 QQ 号）');
    }
    var text = '[' + label + '] 测试通知 - 压价助手配置正常';
    var sent = [];
    var errors = [];
    for (var i = 0; i < configs.length; i++) {
        var cfg = configs[i];
        try {
            await sendQqNotification(cfg, '[Torn压价] ' + text);
            sent.push(describeQqTarget(cfg));
        } catch (err) {
            errors.push(describeQqTarget(cfg) + ': ' + err.message);
        }
    }
    if (!sent.length) {
        throw new Error(errors.join('；'));
    }
    return { targets: sent, errors: errors.length ? errors : undefined };
}

function formatCompanyApplicationText(label, newApps) {
    var prefix = label ? '[' + label + '] ' : '';
    var summary = '发现 ' + newApps.length + ' 个新申请';
    var details = newApps.map(function(app) {
        return formatApplicationSummary(app);
    }).join('；');
    return prefix + summary + (details ? '：' + details : '');
}

function describeQqTarget(qqConfig) {
    if (qqConfig.type === 'private') {
        return '私聊 ' + qqConfig.userId;
    }
    if (qqConfig.atUserId) {
        return '群 ' + qqConfig.groupId + ' @' + qqConfig.atUserId;
    }
    return '群 ' + qqConfig.groupId;
}

export async function notifyCompanyApplications(globalNotify, watcherNotify, label, newApps) {
    var text = formatCompanyApplicationText(label, newApps);
    var tasks = [];
    if (watcherNotify?.desktop !== false && globalNotify?.desktop) {
        tasks.push(sendDesktopNotification('Torn 公司新申请', text));
    }
    buildWatcherQqConfigs(globalNotify, watcherNotify).forEach(function(qqConfig) {
        tasks.push(sendQqNotification(qqConfig, '[Torn公司] ' + text));
    });
    await Promise.allSettled(tasks).then(function(results) {
        results.forEach(function(result) {
            if (result.status === 'rejected') {
                console.error('[notify]', result.reason?.message || result.reason);
            }
        });
    });
}

export async function testCompanyWatcherNotify(globalNotify, watcher) {
    var label = watcher.label || '测试';
    var watcherNotify = watcher.notify || {};
    if (!watcherNotify.qq?.enabled) {
        throw new Error('请先启用该账号的 QQ 通知');
    }
    var configs = buildWatcherQqConfigs(globalNotify, watcherNotify);
    if (!configs.length) {
        throw new Error('请至少添加一个有效的 QQ 通知方式（群号或私聊 QQ 号）');
    }
    var text = '[' + label + '] 测试通知 - 公司监听配置正常';
    var sent = [];
    var errors = [];
    for (var i = 0; i < configs.length; i++) {
        var cfg = configs[i];
        try {
            await sendQqNotification(cfg, '[Torn公司] ' + text);
            sent.push(describeQqTarget(cfg));
        } catch (err) {
            errors.push(describeQqTarget(cfg) + ': ' + err.message);
        }
    }
    if (!sent.length) {
        throw new Error(errors.join('；'));
    }
    return { targets: sent, errors: errors.length ? errors : undefined };
}
