import notifier from 'node-notifier';

const SOURCES = {
    stock: { origin: 'http://127.0.0.1:5001', path: '/api/notification-settings' },
    undercut: { origin: 'http://127.0.0.1:8790', path: '/api/state' },
    company: { origin: 'http://127.0.0.1:8791', path: '/api/state' }
};
const STOCK_EVENTS = [
    'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'R1', 'R2',
    'T4_intraday', 'takeProfit', 'fakeRight', 'reset', 'openSummary', 'sleeveTqqq', 'sleeveSoxl'
];

function target(item) {
    return {
        id: String(item?.id || '').slice(0, 80),
        type: item?.type === 'private' ? 'private' : 'group',
        groupId: String(item?.groupId || '').trim().slice(0, 32),
        atUserId: String(item?.atUserId || '').trim().slice(0, 32),
        userId: String(item?.userId || '').trim().slice(0, 32)
    };
}

function normalizeNotify(source, raw = {}, previous = {}) {
    const qq = raw.qq || {};
    const oldQq = previous.qq || {};
    const result = {
        desktop: raw.desktop ?? previous.desktop ?? false,
        qq: { enabled: qq.enabled ?? oldQq.enabled ?? true },
        slack: { enabled: raw.slack?.enabled ?? previous.slack?.enabled ?? false }
    };
    if (source === 'stock') {
        result.targets = (raw.targets ?? previous.targets ?? []).map(target);
        result.events = Object.fromEntries(STOCK_EVENTS.map(key => [key, raw.events?.[key] ?? previous.events?.[key] ?? (key !== 'openSummary')]));
    } else {
        result.qq.targets = (qq.targets ?? oldQq.targets ?? []).map(target);
    }
    return result;
}

async function sourceState(source, fetcher) {
    const meta = SOURCES[source];
    const response = await fetcher(meta.origin + meta.path, { signal: AbortSignal.timeout(6000) });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || '监控服务不可用');
    return data;
}

function notifyDesktop(title, message) {
    return new Promise(resolve => notifier.notify({ title, message, sound: true, wait: false }, resolve));
}

export function createBusinessService(config, { fetcher = fetch, persist = () => {}, send, desktop = notifyDesktop } = {}) {
    config.business = config.business || {};
    const pending = new Map();

    async function integration(source) {
        if (!SOURCES[source]) throw new Error('未知通知来源');
        const data = await sourceState(source, fetcher);
        const legacy = source === 'stock' ? data.notify : data.config?.notify;
        if (!legacy || typeof legacy !== 'object') throw new Error('监控服务未返回旧提醒配置，已停止自动导入');
        const roster = source === 'stock' ? [] : (data.config?.[source]?.watchers || []);
        if (!Array.isArray(roster)) throw new Error('监控服务未返回监听账号列表');
        let changed = false;
        if (!config.business[source]) {
            config.business[source] = { notify: normalizeNotify(source, legacy) };
            if (source !== 'stock') config.business[source].watchers = {};
            changed = true;
        }
        const saved = config.business[source];
        if (source !== 'stock') {
            saved.watchers = saved.watchers || {};
            for (const watcher of roster) {
                if (!saved.watchers[watcher.id]) {
                    saved.watchers[watcher.id] = normalizeNotify(source, watcher.notify);
                    changed = true;
                }
            }
        }
        if (changed) persist(config);
        if (source === 'stock') return {
            id: source, ok: true, notify: saved.notify,
            monitor: { running: !!data.monitor?.running, checks: data.monitor?.checks || 0 }
        };
        return {
            id: source, ok: true, notify: saved.notify,
            watchers: roster.map(w => ({ id: w.id, label: w.label, enabled: w.enabled, notify: saved.watchers[w.id] }))
        };
    }

    async function ensure(source) {
        if (config.business[source]) return config.business[source];
        if (!pending.has(source)) pending.set(source, integration(source).finally(() => pending.delete(source)));
        await pending.get(source);
        return config.business[source];
    }

    async function list() {
        return Promise.all(Object.keys(SOURCES).map(async source => {
            try { return await integration(source); }
            catch (error) { return { id: source, ok: false, error: error.message }; }
        }));
    }

    async function save(source, patch) {
        const state = await integration(source);
        const saved = config.business[source];
        if (source === 'stock') {
            saved.notify = normalizeNotify(source, patch, saved.notify);
        } else {
            if ((patch.watchers || []).some(update => !state.watchers.some(w => w.id === update.id))) {
                throw new Error('监听账号不存在');
            }
            saved.notify = normalizeNotify(source, patch.notify, saved.notify);
            for (const update of patch.watchers || []) {
                saved.watchers[update.id] = normalizeNotify(source, update.notify, saved.watchers[update.id]);
            }
        }
        persist(config);
        return integration(source);
    }

    async function dispatch(source, watcherId, eventKey, message) {
        if (!SOURCES[source]) throw new Error('未知通知来源');
        if (!message || typeof message !== 'string' || message.length > 100000) throw new Error('无效的通知内容');
        const saved = await ensure(source);
        if (source === 'stock' && eventKey !== 'test' && !STOCK_EVENTS.includes(eventKey)) throw new Error('未知股票事件');
        if (source === 'stock' && eventKey !== 'test' && saved.notify.events[eventKey] === false) return { skipped: true, reason: 'event-disabled' };
        if (source !== 'stock' && !saved.watchers?.[watcherId]) await integration(source);
        const watcher = source === 'stock' ? null : saved.watchers?.[watcherId];
        if (source !== 'stock' && !watcher) throw new Error('监听账号不存在');
        const options = source === 'stock' ? saved.notify : watcher;
        const prefix = source === 'stock' ? '[抄底] ' : source === 'undercut' ? '[Torn压价] ' : '[Torn公司] ';
        const text = prefix + message;
        const sent = [];
        const errors = [];
        const qqEnabled = saved.notify.qq.enabled && options.qq.enabled;
        const targets = source === 'stock' ? options.targets : options.qq.targets;
        if (qqEnabled) {
            for (const item of targets || []) {
                if (!(item.type === 'private' ? item.userId : item.groupId)) continue;
                try { await send('qq', { message: text.replace(/\$/g, '\uFF04'), ...item }); sent.push('QQ ' + (item.userId || item.groupId)); }
                catch (error) { errors.push('QQ: ' + error.message); }
            }
        }
        if (saved.notify.slack.enabled && options.slack.enabled) {
            try { await send('slack', { message: text }); sent.push('Slack'); }
            catch (error) { errors.push('Slack: ' + error.message); }
        }
        if (source !== 'stock' && saved.notify.desktop && options.desktop) {
            try { await desktop(prefix.trim(), message); sent.push('桌面'); }
            catch (error) { errors.push('桌面: ' + error.message); }
        }
        return { skipped: !sent.length && !errors.length, sent, errors };
    }

    async function test(source, watcherId) {
        const state = await integration(source);
        if (source !== 'stock' && !state.watchers.some(w => w.id === watcherId)) throw new Error('监听账号不存在');
        const result = await dispatch(source, watcherId, 'test', '测试通知 - 配置正常');
        if (!result.sent.length) throw new Error(result.errors.join('；') || '没有启用且可用的通知目标');
        return result;
    }

    return { integration, list, save, dispatch, test };
}
