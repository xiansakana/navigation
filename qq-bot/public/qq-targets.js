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

function bizReadTargets(container) {
    return Array.from(container.querySelectorAll('.biz-target')).map(function(row) {
        var result = { id: row.dataset.id };
        ['type', 'groupId', 'atUserId', 'userId'].forEach(function(key) { result[key] = row.querySelector('[data-field="' + key + '"]').value.trim(); });
        return result;
    });
}
