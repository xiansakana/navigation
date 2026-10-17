(async function() {
  const section = document.getElementById('codex-settings');
  const state = document.getElementById('codex-save-state'), button = document.getElementById('codex-save');
  const groups = document.getElementById('codex-groups'), reply = document.getElementById('codex-group-reply');
  let canEdit = false;
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
    groups.value = data.groups.join('\n'); reply.value = data.groupReply;
    groups.disabled = reply.disabled = button.disabled = !canEdit;
    document.getElementById('codex-status').textContent = data.configured ? (data.enabled ? '已启用 · ' : '入口已停用 · ') + data.projects.join('、') : '尚未配置执行账号';
    state.textContent = '群聊配置已加载'; section.hidden = false;
  } catch (e) { section.hidden = false; state.textContent = '读取失败：' + e.message; button.disabled = true; }
  for (const control of [groups, reply]) control.addEventListener('input', () => { state.textContent = '有尚未保存的修改'; });
  button.addEventListener('click', async () => {
    if (!canEdit) return;
    button.disabled = true;
    try {
      const list = groups.value.split(/[\s,，]+/).filter(Boolean);
      if (list.length > 20 || list.some(g => !/^\d{5,20}$/.test(g))) throw new Error('请输入有效群号，最多20个');
      const data = await request({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groups: list, groupReply: reply.value }) });
      groups.value = data.groups.join('\n'); state.textContent = '群聊配置已保存，立即生效';
    } catch (e) { state.textContent = '保存失败：' + e.message; }
    finally { button.disabled = false; }
  });
})();
