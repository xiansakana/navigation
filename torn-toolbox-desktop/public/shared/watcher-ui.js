window.WatcherUI = (function() {
    function escapeHtml(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function defaultQqTarget() {
        return {
            id: 't-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
            type: 'group',
            groupId: '',
            atUserId: '',
            userId: ''
        };
    }

    function normalizeWatcherNotify(notify) {
        notify = notify || {};
        var qq = notify.qq || {};
        var targets = [];
        if (Array.isArray(qq.targets) && qq.targets.length) {
            targets = qq.targets.map(function(target) {
                return {
                    id: target.id || defaultQqTarget().id,
                    type: target.type || 'group',
                    groupId: target.groupId || '',
                    atUserId: target.atUserId || '',
                    userId: target.userId || ''
                };
            });
        } else if (qq.groupId || qq.userId) {
            targets = [{
                id: 'legacy',
                type: qq.type || (qq.userId && !qq.groupId ? 'private' : 'group'),
                groupId: qq.groupId || '',
                atUserId: qq.atUserId || '',
                userId: qq.userId || ''
            }];
        } else {
            targets = [defaultQqTarget()];
        }
        return {
            desktop: notify.desktop !== false,
            qq: { enabled: qq.enabled !== false, targets: targets }
        };
    }

    function defaultWatcher(label) {
        return {
            id: 'w-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
            label: label || '新账号',
            enabled: true,
            apiKey: '',
            hasApiKey: false,
            notify: normalizeWatcherNotify({
                desktop: true,
                qq: { enabled: true, targets: [defaultQqTarget()] }
            })
        };
    }

    function toggleTargetFields(row, type) {
        var isGroup = type === 'group';
        row.querySelector('[data-field="groupId"]').closest('.field').hidden = !isGroup;
        row.querySelector('[data-field="atUserId"]').closest('.field').hidden = !isGroup;
        row.querySelector('[data-field="userId"]').closest('.field').hidden = isGroup;
    }

    function renderQqTargetRow(target, index) {
        var type = target.type || 'group';
        var isGroup = type === 'group';
        return ''
            + '<div class="notify-target" data-target-id="' + escapeHtml(target.id) + '">'
            + '<div class="notify-target-head"><span>通知方式 ' + (index + 1) + '</span>'
            + '<button type="button" class="btn small danger" data-action="remove-target">删除</button></div>'
            + '<div class="watcher-grid">'
            + '<div class="field"><label>类型</label><select data-field="targetType">'
            + '<option value="group"' + (isGroup ? ' selected' : '') + '>群聊</option>'
            + '<option value="private"' + (!isGroup ? ' selected' : '') + '>私聊</option>'
            + '</select></div>'
            + '<div class="field"' + (isGroup ? '' : ' hidden') + '><label>群号</label><input type="text" data-field="groupId" value="' + escapeHtml(target.groupId || '') + '"></div>'
            + '<div class="field"' + (isGroup ? '' : ' hidden') + '><label>@ QQ 号（留空直接发）</label><input type="text" data-field="atUserId" value="' + escapeHtml(target.atUserId || '') + '"></div>'
            + '<div class="field"' + (!isGroup ? '' : ' hidden') + '><label>私聊 QQ 号</label><input type="text" data-field="userId" value="' + escapeHtml(target.userId || '') + '"></div>'
            + '</div></div>';
    }

    function collectQqTargetsFromCard(card) {
        return Array.from(card.querySelectorAll('.notify-target')).map(function(row) {
            return {
                id: row.dataset.targetId,
                type: row.querySelector('[data-field="targetType"]').value,
                groupId: row.querySelector('[data-field="groupId"]').value.trim(),
                atUserId: row.querySelector('[data-field="atUserId"]').value.trim(),
                userId: row.querySelector('[data-field="userId"]').value.trim()
            };
        });
    }

    function collectWatcherNotifyFromCard(card) {
        return {
            desktop: card.querySelector('[data-field="notifyDesktop"]').checked,
            qq: {
                enabled: card.querySelector('[data-field="qqEnabled"]').checked,
                targets: collectQqTargetsFromCard(card)
            }
        };
    }

    function renderWatcherMeta(watchers, metaField) {
        document.querySelectorAll('[data-watcher-meta]').forEach(function(node) {
            var id = node.dataset.watcherMeta;
            var info = watchers.find(function(w) { return w.id === id; });
            if (!info) {
                node.textContent = '';
                return;
            }
            var parts = ['已检查 ' + (info.checks || 0) + ' 次'];
            if (metaField === 'apps') parts.push('申请 ' + (info.apps || 0) + ' 个');
            if (metaField === 'alerts') parts.push('提醒 ' + (info.alerts || 0) + ' 个');
            if (info.lastError) parts.push('错误: ' + info.lastError);
            node.textContent = parts.join(' · ');
        });
    }

    function bindTargetTypeChange(container) {
        container.addEventListener('change', function(e) {
            if (e.target.dataset.field !== 'targetType') return;
            var row = e.target.closest('.notify-target');
            if (row) toggleTargetFields(row, e.target.value);
        });
    }

    function resolveWatchers(getWatchers) {
        return typeof getWatchers === 'function' ? getWatchers() : getWatchers;
    }

    function handleTargetActions(container, getWatchers, renderFn, syncFn) {
        container.addEventListener('click', function(e) {
            var card = e.target.closest('.watcher-card');
            if (!card) return;
            if (e.target.dataset.action === 'add-target') {
                syncFn();
                var watcher = resolveWatchers(getWatchers).find(function(w) { return w.id === card.dataset.id; });
                if (watcher) {
                    watcher.notify.qq.targets.push(defaultQqTarget());
                    renderFn();
                }
                return;
            }
            if (e.target.dataset.action === 'remove-target') {
                syncFn();
                var targetRow = e.target.closest('.notify-target');
                var watcherRm = resolveWatchers(getWatchers).find(function(w) { return w.id === card.dataset.id; });
                if (watcherRm && targetRow) {
                    watcherRm.notify.qq.targets = watcherRm.notify.qq.targets.filter(function(t) {
                        return t.id !== targetRow.dataset.targetId;
                    });
                    if (!watcherRm.notify.qq.targets.length) {
                        watcherRm.notify.qq.targets.push(defaultQqTarget());
                    }
                    renderFn();
                }
            }
        });
    }

    function toastCall(type, msg) {
        if (msg == null || msg === '') return;
        var t = window.portalToast;
        if (t && typeof t[type] === 'function') {
            t[type](String(msg));
        }
    }

    function toastErr(msg) { toastCall('error', msg); }
    function toastOk(msg) { toastCall('success', msg); }
    function toastWarn(msg) { toastCall('warn', msg); }
    function toastInfo(msg) { toastCall('info', msg); }

    return {
        escapeHtml: escapeHtml,
        defaultQqTarget: defaultQqTarget,
        normalizeWatcherNotify: normalizeWatcherNotify,
        defaultWatcher: defaultWatcher,
        toggleTargetFields: toggleTargetFields,
        renderQqTargetRow: renderQqTargetRow,
        collectQqTargetsFromCard: collectQqTargetsFromCard,
        collectWatcherNotifyFromCard: collectWatcherNotifyFromCard,
        renderWatcherMeta: renderWatcherMeta,
        bindTargetTypeChange: bindTargetTypeChange,
        handleTargetActions: handleTargetActions,
        toastErr: toastErr,
        toastOk: toastOk,
        toastWarn: toastWarn,
        toastInfo: toastInfo
    };
})();
