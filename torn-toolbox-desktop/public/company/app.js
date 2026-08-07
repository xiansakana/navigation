var WUI = window.WatcherUI;
var companyWatchers = [];

function $(id) { return document.getElementById(id); }

function formatTime(ts) {
    return new Date(ts * 1000).toLocaleString('zh-CN');
}

function formatNext(ts) {
    if (!ts) return '--';
    return new Date(ts).toLocaleTimeString('zh-CN');
}

function formatStatValue(value) {
    if (value == null || value === '') return '?';
    var num = Number(value);
    if (!Number.isNaN(num)) return num.toLocaleString('en-US');
    return String(value);
}

function formatApplicationStats(stats) {
    stats = stats || {};
    return '智力 ' + formatStatValue(stats.intelligence)
        + ' · 耐力 ' + formatStatValue(stats.endurance)
        + ' · 体力 ' + formatStatValue(stats.manual_labor);
}

async function api(path, options) {
    var resp = await fetch('api/' + path, options || {});
    var data = await resp.json();
    if (!resp.ok || data.ok === false) throw new Error(data.error || resp.statusText);
    return data;
}

function renderCompanyApps(apps) {
    var list = $('co-list');
    list.innerHTML = '';
    if (!apps.length) {
        list.innerHTML = '<p class="hint">暂无新申请</p>';
        return;
    }
    apps.forEach(function(app) {
        var div = document.createElement('div');
        div.className = 'item company';
        div.innerHTML = '<h4>新申请 #' + app.id + (app.watcherLabel ? ' · ' + WUI.escapeHtml(app.watcherLabel) : '') + '</h4>'
            + '<p>申请人：' + WUI.escapeHtml(app.name) + ' (ID ' + app.userId + ') · Lv ' + (app.level || '?') + '</p>'
            + '<p>属性：' + formatApplicationStats(app.stats) + '</p>'
            + '<p>状态：' + (app.status || '未知') + '</p>'
            + '<p>过期：' + new Date(app.expires * 1000).toLocaleString('zh-CN') + '</p>'
            + '<p>消息：' + WUI.escapeHtml(app.message || '无消息') + '</p>';
        list.appendChild(div);
    });
}

function updateCompanyState(state) {
    var running = state.running;
    $('co-start').hidden = running;
    $('co-stop').hidden = !running;
    $('co-status-text').textContent = running ? '● 监听中' : '已停止';
    $('co-status').classList.toggle('stopped', !running);
    $('co-checks').textContent = state.checks || 0;
    $('co-apps').textContent = state.apps || 0;
    $('co-next').textContent = formatNext(state.nextScanAt);
    $('co-message').textContent = state.statusMessage || '';
    $('global-status').textContent = running ? '公司监听中' : '就绪';
    WUI.renderWatcherMeta(state.watchers || [], 'apps');
}

function syncCompanyWatchersFromDom() {
    companyWatchers = collectCompanyWatchersFromDom();
}

function renderCompanyWatchers() {
    var container = $('co-watchers');
    container.innerHTML = '';
    if (!companyWatchers.length) {
        container.innerHTML = '<p class="hint">暂无监听账号，点击「添加账号」开始配置</p>';
        return;
    }

    companyWatchers.forEach(function(watcher, index) {
        var card = document.createElement('div');
        card.className = 'watcher-card';
        card.dataset.id = watcher.id;
        card.innerHTML = ''
            + '<div class="watcher-card-head">'
            + '<h3>账号 ' + (index + 1) + '</h3>'
            + '<div class="watcher-actions">'
            + '<label><input type="checkbox" data-field="enabled"' + (watcher.enabled !== false ? ' checked' : '') + '> 启用</label>'
            + '<button type="button" class="btn small" data-action="test">测试通知</button>'
            + '<button type="button" class="btn small danger" data-action="remove">删除</button>'
            + '</div></div>'
            + '<div class="watcher-grid">'
            + '<div class="field"><label>名称</label><input type="text" data-field="label" value="' + WUI.escapeHtml(watcher.label || '') + '"></div>'
            + '<div class="field"><label>Torn API Key</label><input type="password" data-field="apiKey" placeholder="' + (watcher.hasApiKey ? '已保存 ' + WUI.escapeHtml(watcher.apiKey || '***') : '填写后保存') + '"></div>'
            + '<div class="field full checks">'
            + '<label><input type="checkbox" data-field="notifyDesktop"' + (watcher.notify?.desktop !== false ? ' checked' : '') + '> 桌面通知</label>'
            + '<label><input type="checkbox" data-field="qqEnabled"' + (watcher.notify?.qq?.enabled !== false ? ' checked' : '') + '> QQ 通知</label>'
            + '</div>'
            + '<div class="notify-targets-section">'
            + '<div class="section-head"><label>QQ 通知方式（可多个）</label>'
            + '<button type="button" class="btn small" data-action="add-target">+ 添加方式</button></div>'
            + '<div class="notify-targets">'
            + (watcher.notify?.qq?.targets || [WUI.defaultQqTarget()]).map(WUI.renderQqTargetRow).join('')
            + '</div></div></div>'
            + '<div class="watcher-meta" data-watcher-meta="' + watcher.id + '"></div>';
        container.appendChild(card);
    });
}

function collectCompanyWatchersFromDom() {
    return Array.from(document.querySelectorAll('.watcher-card')).map(function(card) {
        var id = card.dataset.id;
        var existing = companyWatchers.find(function(w) { return w.id === id; }) || {};
        return {
            id: id,
            label: card.querySelector('[data-field="label"]').value.trim() || '未命名',
            enabled: card.querySelector('[data-field="enabled"]').checked,
            apiKey: card.querySelector('[data-field="apiKey"]').value.trim() || undefined,
            notify: WUI.collectWatcherNotifyFromCard(card),
            hasApiKey: existing.hasApiKey,
            apiKeyMask: existing.apiKey
        };
    });
}

async function testWatcherNotify(card) {
    var btn = card.querySelector('[data-action="test"]');
    if (btn) { btn.disabled = true; btn.textContent = '发送中...'; }
    try {
        var watcher = collectCompanyWatchersFromDom().find(function(w) { return w.id === card.dataset.id; });
        var result = await api('company/test-notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                watcher: { label: watcher.label, notify: watcher.notify },
                notify: {
                    qq: {
                        url: $('qq-url').value.trim(),
                        token: $('qq-token').value.trim() || undefined
                    }
                }
            })
        });
        $('co-message').textContent = '测试通知已发送'
            + (result.targets && result.targets.length ? ' → ' + result.targets.join('；') : '')
            + (result.errors && result.errors.length ? '（失败: ' + result.errors.join('；') + '）' : '');
    } catch (err) {
        $('co-message').textContent = err.message;
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '测试通知'; }
    }
}

async function loadState() {
    var data = await api('state');
    var cfg = data.config;
    $('co-interval').value = cfg.company?.intervalSeconds || 30;
    companyWatchers = (cfg.company?.watchers || []).map(function(watcher) {
        return {
            id: watcher.id,
            label: watcher.label || '未命名',
            enabled: watcher.enabled !== false,
            apiKey: watcher.apiKey || '',
            hasApiKey: !!watcher.hasApiKey,
            notify: WUI.normalizeWatcherNotify(watcher.notify)
        };
    });
    if (!companyWatchers.length) {
        companyWatchers = [WUI.defaultWatcher('账号 1')];
    }
    renderCompanyWatchers();
    if (cfg.notify) {
        $('notify-desktop').checked = cfg.notify.desktop !== false;
        $('notify-qq').checked = cfg.notify.qq?.enabled !== false;
        $('qq-url').value = cfg.notify.qq?.url || '';
        if (cfg.notify.qq?.hasToken) {
            $('qq-token').placeholder = '已保存 ' + (cfg.notify.qq.token || '***');
        }
    }
    updateCompanyState(data.company);
    renderCompanyApps(data.company.applications || []);
}

async function saveConfig() {
    syncCompanyWatchersFromDom();
    await api('config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            company: {
                intervalSeconds: Number($('co-interval').value) || 30,
                watchers: companyWatchers.map(function(w) {
                    return {
                        id: w.id,
                        label: w.label,
                        enabled: w.enabled,
                        apiKey: w.apiKey,
                        notify: w.notify
                    };
                })
            },
            notify: {
                desktop: $('notify-desktop').checked,
                qq: {
                    enabled: $('notify-qq').checked,
                    url: $('qq-url').value.trim(),
                    token: $('qq-token').value.trim() || undefined
                }
            }
        })
    });
    $('global-status').textContent = '设置已保存';
    await loadState();
}

function connectEvents() {
    var es = new EventSource('api/events');
    es.addEventListener('company', function(e) { updateCompanyState(JSON.parse(e.data)); });
    es.addEventListener('companyApps', function(e) { renderCompanyApps(JSON.parse(e.data)); });
    es.addEventListener('error', function(e) {
        if (!e.data) return;
        $('global-status').textContent = JSON.parse(e.data).message;
    });
}

$('co-add-watcher').addEventListener('click', function() {
    companyWatchers.push(WUI.defaultWatcher('账号 ' + (companyWatchers.length + 1)));
    renderCompanyWatchers();
});

$('co-save-config').addEventListener('click', function() {
    saveConfig().then(function() {
        $('co-message').textContent = '公司监听配置已保存';
    }).catch(function(err) { $('co-message').textContent = err.message; });
});

$('co-start').addEventListener('click', function() {
    saveConfig().then(function() { return api('company/start', { method: 'POST' }); })
        .catch(function(err) { $('co-message').textContent = err.message; });
});

$('co-stop').addEventListener('click', function() {
    api('company/stop', { method: 'POST' }).catch(function(err) { $('co-message').textContent = err.message; });
});

$('co-watchers').addEventListener('click', function(e) {
    var card = e.target.closest('.watcher-card');
    if (!card) return;
    if (e.target.dataset.action === 'remove') {
        companyWatchers = companyWatchers.filter(function(w) { return w.id !== card.dataset.id; });
        renderCompanyWatchers();
        return;
    }
    if (e.target.dataset.action === 'test') {
        testWatcherNotify(card);
    }
});

WUI.bindTargetTypeChange($('co-watchers'));
WUI.handleTargetActions($('co-watchers'), companyWatchers, renderCompanyWatchers, syncCompanyWatchersFromDom);

loadState().then(connectEvents).catch(function(err) {
    $('global-status').textContent = err.message;
});
