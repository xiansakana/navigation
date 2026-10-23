function bizEscape(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function bizTargetRow(target) {
    var group = target.type !== 'private';
    return '<div class="biz-target" data-id="' + bizEscape(target.id) + '">'
        + '<select data-field="type" aria-label="通知类型"><option value="group"' + (group ? ' selected' : '') + '>群聊</option><option value="private"' + (!group ? ' selected' : '') + '>私聊</option></select>'
        + '<input data-field="groupId" aria-label="群号" placeholder="群号" value="' + bizEscape(target.groupId) + '"' + (group ? '' : ' hidden') + '>'
        + '<input data-field="atUserId" aria-label="@ QQ 号" placeholder="@ 多人：逗号/分号/空格分隔" title="支持中英文逗号、分号、空格、换行，自动去重；all 表示所有人" value="' + bizEscape(target.atUserId) + '"' + (group ? '' : ' hidden') + '>'
        + '<input data-field="userId" aria-label="私聊 QQ 号" placeholder="私聊 QQ 号" value="' + bizEscape(target.userId) + '"' + (group ? ' hidden' : '') + '>'
        + '<button type="button" data-action="remove-target" aria-label="删除通知目标">×</button></div>';
}

function bizTargets(targets, owner) {
    return '<div class="biz-targets" data-owner="' + bizEscape(owner) + '">'
        + '<div class="biz-target-list">' + (targets || []).map(bizTargetRow).join('') + '</div>'
        + '<button class="biz-link" type="button" data-action="add-target">＋ 添加 QQ 目标</button></div>';
}

function bizReadTargets(container) {
    return Array.from(container.querySelectorAll('.biz-target')).map(function(row) {
        var result = { id: row.dataset.id };
        ['type', 'groupId', 'atUserId', 'userId'].forEach(function(key) { result[key] = row.querySelector('[data-field="' + key + '"]').value.trim(); });
        return result;
    });
}

var qqGroupSuggestionSources = new Map();

function updateQqGroupSuggestions(key, label, targets) {
    qqGroupSuggestionSources.set(key, {
        label: label,
        groups: Array.from(new Set((targets || []).filter(function(target) {
            return target.type !== 'private' && /^\d{5,20}$/.test(String(target.groupId || '').trim());
        }).map(function(target) { return String(target.groupId).trim(); })))
    });
    document.dispatchEvent(new Event('notification-qq-groups-changed'));
}

function getQqGroupSuggestions() {
    var groups = new Map();
    qqGroupSuggestionSources.forEach(function(source) {
        source.groups.forEach(function(groupId) {
            if (!groups.has(groupId)) groups.set(groupId, { groupId: groupId, sources: [] });
            if (!groups.get(groupId).sources.includes(source.label)) groups.get(groupId).sources.push(source.label);
        });
    });
    return Array.from(groups.values());
}

function updateQqConfigGroupSuggestions(config) {
    updateQqGroupSuggestions('default', 'QQ 默认目标', [config.defaultTarget || {}]);
    var tibo = config.monitors?.tiboReset?.qq;
    updateQqGroupSuggestions('tibo', 'Tibo 重置监听', tibo?.useDefaultTarget === false ? tibo.targets : []);
}

// Single-line inputs otherwise remove pasted line breaks and join adjacent QQ IDs.
document.addEventListener('paste', function(event) {
    var input = event.target;
    if (!input.matches?.('#qq-at-user-id, input[data-field="atUserId"]') || input.disabled || input.readOnly) return;
    var text = event.clipboardData?.getData('text/plain');
    if (!text || !/[\r\n]/.test(text)) return;
    event.preventDefault();
    input.setRangeText(text.replace(/[\r\n]+/g, ' '), input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
});
