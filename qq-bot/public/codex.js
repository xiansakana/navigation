(async function() {
  const section = document.getElementById('codex-settings');
  const state = document.getElementById('codex-save-state'), button = document.getElementById('codex-save');
  const groups = document.getElementById('codex-groups'), reply = document.getElementById('codex-group-reply');
  const newGroup = document.getElementById('codex-new-group'), addGroup = document.getElementById('codex-add-group');
  let canEdit = false, loaded = false, saving = false;
  let selected = new Set(), custom = new Set();
  function updateCount() { document.getElementById('codex-group-count').textContent = '已选 ' + selected.size + ' / 20'; }
  function renderGroups() {
    const choices = new Map(getQqGroupSuggestions().map(item => [item.groupId, item]));
    for (const groupId of new Set([...custom, ...selected])) if (!choices.has(groupId)) choices.set(groupId, { groupId, sources: ['自定义群聊'] });
    groups.innerHTML = Array.from(choices.values()).map(item => '<label class="codex-group-option"><input type="checkbox" data-group="' + bizEscape(item.groupId) + '"'
      + (selected.has(item.groupId) ? ' checked' : '') + (!canEdit || saving ? ' disabled' : '') + '><span><strong>群 ' + bizEscape(item.groupId)
      + '</strong><small>来源：' + bizEscape(item.sources.join('、')) + '</small></span></label>').join('')
      || '<p class="biz-hint">暂无已配置的通知群，可在下方添加群号。</p>';
    updateCount();
  }
  document.addEventListener('notification-qq-groups-changed', () => { if (loaded) renderGroups(); });
  async function request(options) {
    const response = await fetch('/api/qq-codex/settings', options), data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '请求失败');
    return data;
  }
  try {
    if (!location.pathname.startsWith('/notifications')) return;
    const me = await fetch('/api/me').then(r => r.json()), permissions = me.permissions || [];
    const can = permission => permissions.includes('*') || permissions.includes('qq-codex:' + permission);
    if (me.isGuest || !can('execute') || !can('settings:view')) return;
    const data = await request();
    canEdit = can('settings:edit') && data.configured;
    selected = new Set(data.groups); custom = new Set(data.groups); reply.value = data.groupReply;
    reply.disabled = button.disabled = newGroup.disabled = addGroup.disabled = !canEdit;
    loaded = true; renderGroups();
    document.getElementById('codex-status').textContent = data.configured ? (data.enabled ? '已启用 · ' : '入口已停用 · ') + data.projects.join('、') : '尚未配置执行账号';
    state.textContent = '群聊配置已加载'; section.hidden = false;
  } catch (e) { section.hidden = false; state.textContent = '读取失败：' + e.message; button.disabled = true; }
  const dirty = () => { state.textContent = '有尚未保存的修改'; };
  reply.addEventListener('change', dirty);
  groups.addEventListener('change', event => {
    const input = event.target;
    if (!input.dataset.group || !canEdit || saving) return;
    if (input.checked) {
      if (selected.size >= 20) { input.checked = false; state.textContent = '最多允许20个群聊'; return; }
      selected.add(input.dataset.group);
    } else selected.delete(input.dataset.group);
    updateCount(); dirty();
  });
  addGroup.addEventListener('click', () => {
    if (!canEdit || saving) return;
    const group = newGroup.value.trim();
    if (!/^\d{5,20}$/.test(group)) { state.textContent = '请输入5—20位数字的群号'; return; }
    if (selected.has(group)) { state.textContent = '该群已选中，无需重复添加'; return; }
    if (selected.size >= 20) { state.textContent = '最多允许20个群聊'; return; }
    custom.add(group); selected.add(group); newGroup.value = ''; renderGroups(); dirty();
  });
  newGroup.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addGroup.click(); } });
  button.addEventListener('click', async () => {
    if (!canEdit || saving) return;
    saving = true; button.disabled = true; reply.disabled = newGroup.disabled = addGroup.disabled = true; renderGroups();
    try {
      const list = Array.from(selected);
      if (list.length > 20 || list.some(g => !/^\d{5,20}$/.test(g))) throw new Error('请输入有效群号，最多20个');
      const data = await request({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groups: list, groupReply: reply.value }) });
      selected = new Set(data.groups); custom = new Set(data.groups); reply.value = data.groupReply;
      state.textContent = '群聊配置已保存，立即生效';
    } catch (e) { state.textContent = '保存失败：' + e.message; }
    finally { saving = false; reply.disabled = newGroup.disabled = addGroup.disabled = button.disabled = !canEdit; renderGroups(); }
  });
})();
