var businessState = {};
var businessNames = { stock: '股票管理 · 抄底提醒', undercut: 'Torn · 压价提醒', company: 'Torn · 公司申请' };
var businessEventNames = { openSummary: '开盘摘要', takeProfit: '止盈', fakeRight: '假右侧', reset: '高点重置', T4_intraday: 'T4 盘中限价', sleeveTqqq: 'TQQQ 袖仓', sleeveSoxl: 'SOXL 袖仓' };

function bizEscape(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function bizTargetRow(target) {
    var group = target.type !== 'private';
    return '<div class="biz-target" data-id="' + bizEscape(target.id) + '">'
        + '<select data-field="type" aria-label="通知类型"><option value="group"' + (group ? ' selected' : '') + '>群聊</option><option value="private"' + (!group ? ' selected' : '') + '>私聊</option></select>'
        + '<input data-field="groupId" aria-label="群号" placeholder="群号" value="' + bizEscape(target.groupId) + '"' + (group ? '' : ' hidden') + '>'
        + '<input data-field="atUserId" aria-label="@ QQ 号" placeholder="@ QQ 号（可选）" value="' + bizEscape(target.atUserId) + '"' + (group ? '' : ' hidden') + '>'
        + '<input data-field="userId" aria-label="私聊 QQ 号" placeholder="私聊 QQ 号" value="' + bizEscape(target.userId) + '"' + (group ? ' hidden' : '') + '>'
        + '<button type="button" data-action="remove-target" aria-label="删除通知目标">×</button></div>';
}

function bizTargets(targets, owner) {
    return '<div class="biz-targets" data-owner="' + bizEscape(owner) + '">'
        + '<div class="biz-target-list">' + (targets || []).map(bizTargetRow).join('') + '</div>'
        + '<button class="biz-link" type="button" data-action="add-target">＋ 添加 QQ 目标</button></div>';
}

function bizCard(item) {
    var id = item.id;
    var qq = id === 'stock' ? item.notify?.qq || {} : item.notify?.qq || {};
    if (!item.ok) return '<article id="business-' + id + '" class="business-card" data-source="' + id + '"><h3>' + businessNames[id] + '</h3><p class="biz-error">服务暂不可用：' + bizEscape(item.error) + '</p></article>';
    var html = '<article id="business-' + id + '" class="business-card" data-source="' + id + '"><div class="business-card-head"><div><h3>' + businessNames[id] + '</h3><p>' + (id === 'stock' ? '抄底监控事件' : '独立监听账号') + '</p></div><span class="biz-state">已连接</span></div>';
    html += '<div class="biz-global"><label class="biz-check"><input data-field="qqEnabled" type="checkbox"' + (qq.enabled !== false ? ' checked' : '') + '> QQ 推送</label>'
        + '<label class="biz-check"><input data-field="slackEnabled" type="checkbox"' + (item.notify?.slack?.enabled === true ? ' checked' : '') + '> Slack 推送</label>';
    if (id !== 'stock') html += '<label class="biz-check"><input data-field="desktop" type="checkbox"' + (item.notify?.desktop !== false ? ' checked' : '') + '> 桌面通知</label>';
    html += '</div><div class="biz-endpoint"><label>推送地址<input data-field="url" value="' + bizEscape(qq.url || '') + '" placeholder="http://127.0.0.1:8787/notify"></label>'
        + '<label>推送 Token<input data-field="token" type="password" autocomplete="new-password" placeholder="' + (qq.hasToken ? '已保存，留空保持原值' : '留空保持现有配置') + '"></label></div>';
    if (id === 'stock') {
        html += '<h4>通知目标</h4>' + bizTargets(item.notify?.targets || [], 'stock') + '<h4>事件类型</h4><div class="biz-events">';
        Object.entries(item.notify?.events || {}).forEach(function(entry) {
            html += '<label class="biz-check"><input data-event="' + bizEscape(entry[0]) + '" type="checkbox"' + (entry[1] !== false ? ' checked' : '') + '> ' + bizEscape(businessEventNames[entry[0]] || entry[0]) + '</label>';
        });
        html += '</div><p class="biz-hint">' + (item.monitor?.running ? '监听中' : '未监听') + ' · 已检查 ' + (item.monitor?.checks || 0) + ' 次。监听启停和业务规则仍在抄底监控页。</p>';
    } else {
        (item.watchers || []).forEach(function(watcher) {
            html += '<div class="biz-watcher" data-watcher="' + bizEscape(watcher.id) + '"><div class="biz-watcher-head"><h4>' + bizEscape(watcher.label) + '</h4><button class="biz-link" type="button" data-action="test-watcher">测试此账号</button></div>'
                + '<div class="biz-global"><label class="biz-check"><input data-field="watcherQq" type="checkbox"' + (watcher.notify?.qq?.enabled !== false ? ' checked' : '') + '> QQ</label>'
                + '<label class="biz-check"><input data-field="watcherSlack" type="checkbox"' + (watcher.notify?.slack?.enabled === true ? ' checked' : '') + '> Slack</label>'
                + '<label class="biz-check"><input data-field="watcherDesktop" type="checkbox"' + (watcher.notify?.desktop !== false ? ' checked' : '') + '> 桌面</label></div>'
                + bizTargets(watcher.notify?.qq?.targets || [], watcher.id) + '</div>';
        });
        if (!item.watchers?.length) html += '<p class="biz-hint">暂无监听账号，请先在 Torn 工具箱中添加。</p>';
    }
    return html + '<div class="biz-actions"><button class="test-btn compact" type="button" data-action="save">保存提醒配置</button>'
        + (id === 'stock' ? '<button class="test-btn compact" type="button" data-action="test-stock">发送测试</button>' : '') + '</div></article>';
}

function bizReadTargets(container) {
    return Array.from(container.querySelectorAll('.biz-target')).map(function(row) {
        var result = { id: row.dataset.id };
        ['type', 'groupId', 'atUserId', 'userId'].forEach(function(key) { result[key] = row.querySelector('[data-field="' + key + '"]').value.trim(); });
        return result;
    });
}

function bizReadCard(card) {
    var item = businessState[card.dataset.source];
    if (!item?.ok) return null;
    var qq = item.notify.qq || {};
    qq.enabled = card.querySelector('[data-field="qqEnabled"]').checked;
    item.notify.slack = { enabled: card.querySelector('[data-field="slackEnabled"]').checked };
    qq.url = card.querySelector('[data-field="url"]').value.trim();
    qq.token = card.querySelector('[data-field="token"]').value.trim();
    if (item.id === 'stock') {
        item.notify.targets = bizReadTargets(card.querySelector('[data-owner="stock"]'));
        card.querySelectorAll('[data-event]').forEach(function(input) { item.notify.events[input.dataset.event] = input.checked; });
    } else {
        item.notify.desktop = card.querySelector('[data-field="desktop"]').checked;
        (item.watchers || []).forEach(function(watcher) {
            var row = Array.from(card.querySelectorAll('.biz-watcher')).find(function(el) { return el.dataset.watcher === watcher.id; });
            if (!row) return;
            watcher.notify.qq.enabled = row.querySelector('[data-field="watcherQq"]').checked;
            watcher.notify.slack = { enabled: row.querySelector('[data-field="watcherSlack"]').checked };
            watcher.notify.desktop = row.querySelector('[data-field="watcherDesktop"]').checked;
            watcher.notify.qq.targets = bizReadTargets(row.querySelector('.biz-targets'));
        });
    }
    return item;
}

function bizRender() {
    byId('business-grid').innerHTML = ['stock', 'undercut', 'company'].map(function(id) { return bizCard(businessState[id] || { id: id, ok: false, error: '尚未加载' }); }).join('');
    byId('business-grid').querySelectorAll('input,select').forEach(function(el) { el.disabled = !access.canBusinessSave; });
    byId('business-grid').querySelectorAll('button[data-action]').forEach(function(el) {
        el.disabled = (el.dataset.action === 'test-stock' || el.dataset.action === 'test-watcher') ? !access.canBusinessTest : !access.canBusinessSave;
    });
}

async function bizLoad() {
    byId('business-refresh').disabled = true;
    try {
        var data = await api('api/integrations');
        data.integrations.forEach(function(item) { businessState[item.id] = item; });
        bizRender();
    } catch (err) { byId('business-grid').textContent = '业务提醒读取失败：' + err.message; }
    finally { byId('business-refresh').disabled = false; }
}

byId('business-refresh').addEventListener('click', bizLoad);
byId('business-grid').addEventListener('change', function(event) {
    if (event.target.dataset.field !== 'type') return;
    var row = event.target.closest('.biz-target');
    var group = event.target.value === 'group';
    ['groupId', 'atUserId'].forEach(function(field) { row.querySelector('[data-field="' + field + '"]').hidden = !group; });
    row.querySelector('[data-field="userId"]').hidden = group;
});
byId('business-grid').addEventListener('click', async function(event) {
    var button = event.target.closest('[data-action]');
    if (!button) return;
    var card = button.closest('.business-card');
    var action = button.dataset.action;
    if ((action === 'test-stock' || action === 'test-watcher') ? !access.canBusinessTest : !access.canBusinessSave) return;
    var item = bizReadCard(card);
    if (!item) return;
    if (action === 'add-target' || action === 'remove-target') {
        var owner = button.closest('.biz-targets').dataset.owner;
        var targets = owner === 'stock' ? item.notify.targets : item.watchers.find(function(w) { return w.id === owner; }).notify.qq.targets;
        if (action === 'add-target') targets.push({ id: 't-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), type: 'group', groupId: '', atUserId: '', userId: '' });
        else targets.splice(targets.findIndex(function(t) { return t.id === button.closest('.biz-target').dataset.id; }), 1);
        bizRender();
        return;
    }
    button.disabled = true;
    try {
        if (action === 'save') {
            var patch = item.id === 'stock' ? { qq: item.notify.qq, slack: item.notify.slack, targets: item.notify.targets, events: item.notify.events }
                : { notify: item.notify, watchers: item.watchers.map(function(w) { return { id: w.id, notify: w.notify }; }) };
            var saved = await api('api/integrations/' + item.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
            businessState[item.id] = saved.integration;
            bizRender();
            toast('提醒配置已保存');
        } else if (action === 'test-stock' || action === 'test-watcher') {
            var watcherId = button.closest('.biz-watcher')?.dataset.watcher;
            await api('api/integrations/' + item.id + '/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ watcherId: watcherId }) });
            toast('测试通知已发送（使用已保存的配置）');
        }
    } catch (err) { toast(err.message, true); }
    finally { button.disabled = false; }
});

loadAccess().then(bizLoad).catch(function(err) { byId('business-grid').textContent = '权限读取失败：' + err.message; });
