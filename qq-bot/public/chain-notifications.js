(() => {
  const host = document.getElementById('chain-notifications');
  let state;
  async function request(method = 'GET', body) {
    const response = await fetch('/api/torn-chain/notifications' + (method === 'POST' ? '/test' : ''), { method, credentials: 'same-origin', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (response.status === 403 && method === 'GET') { host.hidden = true; return null; }
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Chain 通知操作失败');
    return data;
  }
  function render() {
    host.hidden = false;
    host.innerHTML = '<article class="business-card" data-source="chain"><div class="business-card-head"><div><h3>Torn · Chain 冷却</h3><p>当前账号的 Chain 监控</p></div><a href="/torn-toolbox/chain/">打开监控 →</a></div>'
      + '<div class="biz-global"><label class="biz-check"><input data-channel="qq" type="checkbox"' + (state.settings.qq.enabled ? ' checked' : '') + '> QQ 推送</label><label class="biz-check"><input data-channel="slack" type="checkbox"' + (state.settings.slack.enabled ? ' checked' : '') + '> Slack 推送</label></div>'
      + '<p class="biz-hint">推送符合长度范围、首次发现仍在冷却的 Chain，附 report 链接；所选 Bonus hit 的被打玩家 profile 在 Chain 监控页多选配置。QQ 使用下方目标，Slack 使用通知管理上方已配置的渠道。</p>'
      + '<h4>QQ 通知目标</h4>' + bizTargets(state.settings.targets, 'chain')
      + '<div class="biz-actions"><button type="button" class="test-btn compact" data-action="chain-save">保存提醒配置</button><button type="button" class="test-btn compact" data-action="chain-test">发送测试</button></div></article>';
    host.querySelectorAll('input,select').forEach(input => { input.disabled = !state.permissions.save; });
    host.querySelectorAll('button').forEach(button => { button.disabled = button.dataset.action === 'chain-test' ? !state.permissions.test : !state.permissions.save; });
  }
  function read() {
    state.settings = { qq: { enabled: host.querySelector('[data-channel="qq"]').checked }, slack: { enabled: host.querySelector('[data-channel="slack"]').checked }, targets: bizReadTargets(host.querySelector('.biz-targets')) };
  }
  async function load() {
    try { const data = await request(); if (data) { state = data; render(); } }
    catch (error) { host.hidden = false; host.textContent = 'Chain 通知读取失败：' + error.message; }
  }
  host.addEventListener('change', event => {
    if (event.target.dataset.field !== 'type') return;
    const row = event.target.closest('.biz-target'), group = event.target.value === 'group';
    ['groupId', 'atUserId'].forEach(field => { row.querySelector('[data-field="' + field + '"]').hidden = !group; });
    row.querySelector('[data-field="userId"]').hidden = group;
  });
  host.addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]');
    if (!button || !state || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'chain-test' ? !state.permissions.test : !state.permissions.save) return;
    read();
    if (action === 'add-target' || action === 'remove-target') {
      if (action === 'add-target') state.settings.targets.push({ id: 'chain-' + Date.now(), type: 'group', groupId: '', userId: '', atUserId: '' });
      else state.settings.targets.splice(Array.from(host.querySelectorAll('.biz-target')).indexOf(button.closest('.biz-target')), 1);
      render(); return;
    }
    button.disabled = true;
    try {
      if (action === 'chain-save') { const data = await request('PUT', state.settings); state.settings = data.settings; render(); toast('Chain 提醒配置已保存'); }
      if (action === 'chain-test') { await request('POST'); toast('Chain 测试通知已发送（使用已保存配置）'); }
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  });
  document.getElementById('business-refresh').addEventListener('click', load);
  load();
})();
