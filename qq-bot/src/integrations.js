const SOURCES = {
    stock: { origin: 'http://127.0.0.1:5001', state: '/api/notification-settings', save: '/api/notify', test: '/api/notify/test' },
    undercut: { origin: 'http://127.0.0.1:8790', state: '/api/state', save: '/api/notification-settings', test: '/api/undercut/test-notify' },
    company: { origin: 'http://127.0.0.1:8791', state: '/api/state', save: '/api/notification-settings', test: '/api/company/test-notify' }
};

async function request(source, path, method, body, fetcher = fetch) {
    var target = SOURCES[source];
    if (!target) throw new Error('未知通知来源');
    var response = await fetcher(target.origin + path, {
        method: method || 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(6000)
    });
    var data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || '服务不可用');
    return data;
}

function sanitizeTarget(item) {
    return {
        id: String(item.id || '').slice(0, 80),
        type: item.type === 'private' ? 'private' : 'group',
        groupId: String(item.groupId || '').trim().slice(0, 32),
        atUserId: String(item.atUserId || '').trim().slice(0, 32),
        userId: String(item.userId || '').trim().slice(0, 32)
    };
}

function sanitizeWatcher(item) {
    return {
        id: String(item.id || '').slice(0, 80),
        notify: {
            desktop: item.notify?.desktop !== false,
            slack: { enabled: item.notify?.slack?.enabled === true },
            qq: {
                enabled: item.notify?.qq?.enabled !== false,
                targets: (item.notify?.qq?.targets || []).map(sanitizeTarget)
            }
        }
    };
}

function project(source, data) {
    if (source === 'stock') {
        return { id: source, ok: true, notify: data.notify, monitor: {
            running: !!data.monitor?.running,
            checks: data.monitor?.checks || 0
        } };
    }
    return {
        id: source, ok: true, notify: data.config?.notify || {},
        watchers: (data.config?.[source === 'undercut' ? 'undercut' : 'company']?.watchers || []).map(function(w) {
            return { id: w.id, label: w.label, enabled: w.enabled, notify: w.notify };
        })
    };
}

export async function getIntegration(source, fetcher = fetch) {
    if (!SOURCES[source]) throw new Error('未知通知来源');
    return project(source, await request(source, SOURCES[source].state, 'GET', null, fetcher));
}

export async function listIntegrations(fetcher = fetch) {
    return Promise.all(Object.keys(SOURCES).map(async function(source) {
        try { return await getIntegration(source, fetcher); }
        catch (err) { return { id: source, ok: false, error: err.message }; }
    }));
}

export async function saveIntegration(source, patch, fetcher = fetch) {
    if (!SOURCES[source]) throw new Error('未知通知来源');
    if (source === 'stock') {
        var qq = patch.qq || {};
        var events = {};
        for (var [key, value] of Object.entries(patch.events || {})) {
            if (/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key)) events[key] = value !== false;
        }
        await request(source, SOURCES[source].save, 'PUT', {
            qq: { enabled: qq.enabled === true, url: String(qq.url || '').trim(), token: String(qq.token || '') },
            slack: { enabled: patch.slack?.enabled === true },
            targets: (patch.targets || []).map(sanitizeTarget), events
        }, fetcher);
    } else {
        await request(source, SOURCES[source].save, 'PUT', {
            notify: {
                desktop: patch.notify?.desktop !== false,
                slack: { enabled: patch.notify?.slack?.enabled === true },
                qq: {
                    enabled: patch.notify?.qq?.enabled !== false,
                    url: String(patch.notify?.qq?.url || '').trim(),
                    token: String(patch.notify?.qq?.token || '')
                }
            },
            watchers: (patch.watchers || []).map(sanitizeWatcher)
        }, fetcher);
    }
    return getIntegration(source, fetcher);
}

export async function testIntegration(source, watcherId, fetcher = fetch) {
    if (!SOURCES[source]) throw new Error('未知通知来源');
    if (source === 'stock') return request(source, SOURCES[source].test, 'POST', {}, fetcher);
    var state = await getIntegration(source, fetcher);
    var watcher = (state.watchers || []).find(function(item) { return item.id === watcherId; });
    if (!watcher) throw new Error('监听账号不存在');
    return request(source, SOURCES[source].test, 'POST', {
        watcher: watcher,
        notify: { qq: { url: state.notify?.qq?.url || '' } }
    }, fetcher);
}
