var WUI = window.WatcherUI;
var undercutWatchers = [];
var itemsCacheByWatcher = new Map();

function $(id) { return document.getElementById(id); }

function formatMoney(n) {
    var v = Math.round(Number(n) || 0);
    return '$' + Math.abs(v).toLocaleString('en-US');
}

function formatTime(ts) {
    return new Date(ts * 1000).toLocaleString('zh-CN');
}

function formatNext(ts) {
    if (!ts) return '--';
    return new Date(ts).toLocaleTimeString('zh-CN');
}

async function api(path, options) {
    var resp = await fetch('api/' + path, options || {});
    var data = await resp.json();
    if (!resp.ok || data.ok === false) throw new Error(data.error || resp.statusText);
    return data;
}

function getWatcherSelectedItems(watcher) {
    if (!watcher._selectedItems) {
        watcher._selectedItems = new Map();
        (watcher.selectedItems || []).forEach(function(item) {
            watcher._selectedItems.set(Number(item.id), item.name || ('Item #' + item.id));
        });
    }
    return watcher._selectedItems;
}

function renderUndercutAlerts(alerts) {
    var list = $('uc-list');
    list.innerHTML = '';
    if (!alerts.length) {
        list.innerHTML = '<p class="hint">暂无压价提醒</p>';
        return;
    }
    alerts.forEach(function(alert) {
        var div = document.createElement('div');
        div.className = 'item';
        var seller = alert.undercutBy
            ? '<p>压价者：' + alert.undercutBy.playerName + '（ID ' + alert.undercutBy.playerId + '）</p>'
            : '';
        var lowLabel = alert.source === 'Bazaar' ? '巴扎最低' : '市场最低';
        var label = alert.watcherLabel ? '<p>账号：' + WUI.escapeHtml(alert.watcherLabel) + '</p>' : '';
        div.innerHTML = '<h4>' + WUI.escapeHtml(alert.name) + '（ID ' + alert.itemId + '）</h4>'
            + label
            + '<p>来源：' + alert.source + '</p>'
            + '<p>你的价格：' + formatMoney(alert.myPrice) + ' · ' + lowLabel + '：' + formatMoney(alert.compareLow) + '</p>'
            + seller
            + '<p>检测时间：' + formatTime(alert.detectedAt) + '</p>';
        list.appendChild(div);
    });
}

function updateUndercutState(state) {
    var running = state.running;
    $('uc-start').hidden = running;
    $('uc-stop').hidden = !running;
    document.querySelectorAll('.uc-select-wrap').forEach(function(wrap) {
        wrap.classList.toggle('disabled', running);
    });
    $('uc-status-text').textContent = running ? '● 监听中' : '已停止';
    $('uc-status').classList.toggle('stopped', !running);
    $('uc-checks').textContent = state.checks || 0;
    $('uc-alerts').textContent = state.alerts || 0;
    $('uc-next').textContent = formatNext(state.nextScanAt);
    $('uc-message').textContent = state.statusMessage || '';
    $('global-status').textContent = running ? '压价监听中' : '就绪';
    WUI.renderWatcherMeta(state.watchers || [], 'alerts');
}

function defaultUndercutWatcher(label) {
    var w = WUI.defaultWatcher(label);
    w.watchBazaar = true;
    w.watchItemMarket = true;
    w.selectedItems = [];
    w._selectedItems = new Map();
    return w;
}

function renderItemChips(card, watcher) {
    var chips = card.querySelector('.uc-chips');
    var display = card.querySelector('.uc-select-display');
    var selected = getWatcherSelectedItems(watcher);
    chips.innerHTML = '';
    if (!selected.size) {
        display.textContent = '-- 全部物品（点击添加指定物品）--';
        return;
    }
    display.textContent = '已选 ' + selected.size + ' 个物品（点击继续添加）';
    selected.forEach(function(name, id) {
        var chip = document.createElement('span');
        chip.className = 'chip';
        chip.innerHTML = WUI.escapeHtml(name) + ' <button type="button" data-id="' + id + '">×</button>';
        chips.appendChild(chip);
    });
}

function renderUndercutWatchers() {
    var container = $('uc-watchers');
    container.innerHTML = '';
    if (!undercutWatchers.length) {
        container.innerHTML = '<p class="hint">暂无监听账号，点击「添加账号」开始配置</p>';
        return;
    }

    undercutWatchers.forEach(function(watcher, index) {
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
            + '<label><input type="checkbox" data-field="watchBazaar"' + (watcher.watchBazaar !== false ? ' checked' : '') + '> Bazaar</label>'
            + '<label><input type="checkbox" data-field="watchItemMarket"' + (watcher.watchItemMarket !== false ? ' checked' : '') + '> Item Market</label>'
            + '</div>'
            + '<div class="field full">'
            + '<label>指定物品（可选）</label>'
            + '<div class="select-wrap uc-select-wrap" data-watcher-id="' + watcher.id + '">'
            + '<div class="select-display uc-select-display">-- 全部物品 --</div>'
            + '<div class="select-drop uc-select-drop">'
            + '<input class="select-search uc-select-search" placeholder="搜索..." />'
            + '<div class="select-list uc-select-list"></div>'
            + '</div></div>'
            + '<div class="chips uc-chips"></div>'
            + '</div>'
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
        renderItemChips(card, watcher);
        bindItemSelect(card, watcher);
    });
}

function syncUndercutWatchersFromDom() {
    undercutWatchers = collectUndercutWatchersFromDom();
}

function collectUndercutWatchersFromDom() {
    return Array.from(document.querySelectorAll('.watcher-card')).map(function(card) {
        var id = card.dataset.id;
        var existing = undercutWatchers.find(function(w) { return w.id === id; }) || {};
        var selected = existing._selectedItems || getWatcherSelectedItems(existing);
        var selectedItems = Array.from(selected.entries()).map(function(entry) {
            return { id: entry[0], name: entry[1] };
        });
        return {
            id: id,
            label: card.querySelector('[data-field="label"]').value.trim() || '未命名',
            enabled: card.querySelector('[data-field="enabled"]').checked,
            apiKey: card.querySelector('[data-field="apiKey"]').value.trim() || undefined,
            watchBazaar: card.querySelector('[data-field="watchBazaar"]').checked,
            watchItemMarket: card.querySelector('[data-field="watchItemMarket"]').checked,
            selectedItems: selectedItems,
            notify: WUI.collectWatcherNotifyFromCard(card),
            hasApiKey: existing.hasApiKey,
            apiKeyMask: existing.apiKey,
            _selectedItems: selected
        };
    });
}

async function loadItemsForWatcher(watcherId) {
    var data = await api('items?watcherId=' + encodeURIComponent(watcherId));
    itemsCacheByWatcher.set(watcherId, data.items || []);
    return data.items || [];
}

function bindItemSelect(card, watcher) {
    var wrap = card.querySelector('.uc-select-wrap');
    var display = card.querySelector('.uc-select-display');
    var drop = card.querySelector('.uc-select-drop');
    var search = card.querySelector('.uc-select-search');
    var list = card.querySelector('.uc-select-list');
    var chips = card.querySelector('.uc-chips');

    function renderList(filter) {
        var items = itemsCacheByWatcher.get(watcher.id) || [];
        var selected = getWatcherSelectedItems(watcher);
        list.innerHTML = '';
        var s = (filter || '').toLowerCase();
        items.filter(function(item) {
            return !s || String(item.name).toLowerCase().includes(s) || String(item.id).includes(s);
        }).forEach(function(item) {
            var id = Number(item.id);
            var opt = document.createElement('div');
            opt.className = 'select-opt' + (selected.has(id) ? ' selected' : '');
            opt.textContent = item.name + ' (ID: ' + item.id + ')' + (selected.has(id) ? ' ✓' : '');
            if (!selected.has(id)) {
                opt.addEventListener('click', function(e) {
                    e.stopPropagation();
                    selected.set(id, item.name);
                    renderItemChips(card, watcher);
                    renderList(search.value);
                });
            }
            list.appendChild(opt);
        });
    }

    display.addEventListener('click', function(e) {
        e.stopPropagation();
        if (wrap.classList.contains('disabled')) return;
        var apiKeyInput = card.querySelector('[data-field="apiKey"]');
        if (!watcher.hasApiKey && !apiKeyInput.value.trim()) {
            WUI.toastWarn('请先填写并保存该账号的 API Key');
            $('uc-message').textContent = '请先填写并保存该账号的 API Key';
            return;
        }
        if (!itemsCacheByWatcher.has(watcher.id)) {
            $('uc-message').textContent = '正在加载物品列表...';
            loadItemsForWatcher(watcher.id).then(function(items) {
                $('uc-message').textContent = '已加载 ' + items.length + ' 个物品';
                WUI.toastOk('已加载 ' + items.length + ' 个物品');
                drop.classList.add('show');
                search.value = '';
                renderList('');
                search.focus();
            }).catch(function(err) {
                $('uc-message').textContent = err.message;
                WUI.toastErr(err.message);
            });
            return;
        }
        drop.classList.toggle('show');
        if (drop.classList.contains('show')) {
            search.value = '';
            renderList('');
            search.focus();
        }
    });

    search.addEventListener('input', function() { renderList(search.value); });
    search.addEventListener('click', function(e) { e.stopPropagation(); });

    chips.addEventListener('click', function(e) {
        if (e.target.tagName !== 'BUTTON') return;
        getWatcherSelectedItems(watcher).delete(Number(e.target.dataset.id));
        renderItemChips(card, watcher);
        if (drop.classList.contains('show')) renderList(search.value);
    });
}

document.addEventListener('click', function() {
    document.querySelectorAll('.uc-select-drop.show').forEach(function(drop) {
        drop.classList.remove('show');
    });
});

async function testWatcherNotify(card) {
    var btn = card.querySelector('[data-action="test"]');
    if (btn) { btn.disabled = true; btn.textContent = '发送中...'; }
    try {
        var watcher = collectUndercutWatchersFromDom().find(function(w) { return w.id === card.dataset.id; });
        var result = await api('undercut/test-notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                watcher: {
                    label: watcher.label,
                    notify: watcher.notify
                },
                notify: {
                    qq: {
                        url: $('qq-url').value.trim(),
                        token: $('qq-token').value.trim() || undefined
                    }
                }
            })
        });
        var msg = '测试通知已发送'
            + (result.targets && result.targets.length ? ' → ' + result.targets.join('；') : '')
            + (result.errors && result.errors.length ? '（失败: ' + result.errors.join('；') + '）' : '');
        $('uc-message').textContent = msg;
        if (result.errors && result.errors.length) WUI.toastWarn(msg);
        else WUI.toastOk(msg);
    } catch (err) {
        $('uc-message').textContent = err.message;
        WUI.toastErr(err.message);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '测试通知'; }
    }
}

async function loadState() {
    var data = await api('state');
    var cfg = data.config;
    $('uc-interval').value = cfg.undercut?.intervalSeconds || 60;
    undercutWatchers = (cfg.undercut?.watchers || []).map(function(watcher) {
        return {
            id: watcher.id,
            label: watcher.label || '未命名',
            enabled: watcher.enabled !== false,
            apiKey: watcher.apiKey || '',
            hasApiKey: !!watcher.hasApiKey,
            watchBazaar: watcher.watchBazaar !== false,
            watchItemMarket: watcher.watchItemMarket !== false,
            selectedItems: watcher.selectedItems || [],
            notify: WUI.normalizeWatcherNotify(watcher.notify)
        };
    });
    if (!undercutWatchers.length) {
        undercutWatchers = [defaultUndercutWatcher('账号 1')];
    }
    renderUndercutWatchers();
    if (cfg.notify) {
        $('notify-desktop').checked = cfg.notify.desktop !== false;
        $('notify-qq').checked = cfg.notify.qq?.enabled !== false;
        $('qq-url').value = cfg.notify.qq?.url || '';
        if (cfg.notify.qq?.hasToken) {
            $('qq-token').placeholder = '已保存 ' + (cfg.notify.qq.token || '***');
        }
    }
    updateUndercutState(data.undercut);
    renderUndercutAlerts(data.undercut.alertsList || []);
}

async function saveConfig() {
    syncUndercutWatchersFromDom();
    await api('config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            undercut: {
                intervalSeconds: Number($('uc-interval').value) || 60,
                watchers: undercutWatchers.map(function(w) {
                    return {
                        id: w.id,
                        label: w.label,
                        enabled: w.enabled,
                        apiKey: w.apiKey,
                        watchBazaar: w.watchBazaar,
                        watchItemMarket: w.watchItemMarket,
                        selectedItems: w.selectedItems,
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
    WUI.toastOk('设置已保存');
    await loadState();
}

function connectEvents() {
    var es = new EventSource('api/events');
    es.addEventListener('undercut', function(e) { updateUndercutState(JSON.parse(e.data)); });
    es.addEventListener('undercutAlerts', function(e) { renderUndercutAlerts(JSON.parse(e.data)); });
    es.addEventListener('error', function(e) {
        if (!e.data) return;
        var msg = JSON.parse(e.data).message;
        $('global-status').textContent = msg;
        WUI.toastErr(msg);
    });
}

$('uc-add-watcher').addEventListener('click', function() {
    undercutWatchers.push(defaultUndercutWatcher('账号 ' + (undercutWatchers.length + 1)));
    renderUndercutWatchers();
});

$('uc-save-config').addEventListener('click', function() {
    saveConfig().then(function() {
        $('uc-message').textContent = '压价配置已保存';
        WUI.toastOk('压价配置已保存');
    }).catch(function(err) {
        $('uc-message').textContent = err.message;
        WUI.toastErr(err.message);
    });
});

$('uc-start').addEventListener('click', function() {
    saveConfig().then(function() { return api('undercut/start', { method: 'POST' }); })
        .then(function() { WUI.toastOk('已开始监听'); })
        .catch(function(err) {
            $('uc-message').textContent = err.message;
            WUI.toastErr(err.message);
        });
});

$('uc-stop').addEventListener('click', function() {
    api('undercut/stop', { method: 'POST' })
        .then(function() { WUI.toastOk('已停止监听'); })
        .catch(function(err) {
            $('uc-message').textContent = err.message;
            WUI.toastErr(err.message);
        });
});

$('uc-watchers').addEventListener('click', function(e) {
    var card = e.target.closest('.watcher-card');
    if (!card) return;
    if (e.target.dataset.action === 'remove') {
        undercutWatchers = undercutWatchers.filter(function(w) { return w.id !== card.dataset.id; });
        renderUndercutWatchers();
        return;
    }
    if (e.target.dataset.action === 'test') {
        testWatcherNotify(card);
        return;
    }
    if (e.target.dataset.action === 'add-target') {
        syncUndercutWatchersFromDom();
        var watcherAdd = undercutWatchers.find(function(w) { return w.id === card.dataset.id; });
        if (watcherAdd) {
            watcherAdd.notify.qq.targets.push(WUI.defaultQqTarget());
            renderUndercutWatchers();
        }
        return;
    }
    if (e.target.dataset.action === 'remove-target') {
        syncUndercutWatchersFromDom();
        var targetRow = e.target.closest('.notify-target');
        var watcherRm = undercutWatchers.find(function(w) { return w.id === card.dataset.id; });
        if (watcherRm && targetRow) {
            watcherRm.notify.qq.targets = watcherRm.notify.qq.targets.filter(function(t) {
                return t.id !== targetRow.dataset.targetId;
            });
            if (!watcherRm.notify.qq.targets.length) {
                watcherRm.notify.qq.targets.push(WUI.defaultQqTarget());
            }
            renderUndercutWatchers();
        }
    }
});

WUI.bindTargetTypeChange($('uc-watchers'));

loadState().then(connectEvents).catch(function(err) {
    $('global-status').textContent = err.message;
    WUI.toastErr(err.message);
});
