(() => {
  const $ = id => document.getElementById(id), fields = ['leadMinutes', 'intervalSeconds', 'apiIntervalSeconds'];
  let dirty = false, loading = false, loaded = false, offset = 0, records = [], serverOffset = 0;
  const time = value => Number.isFinite(value) ? new Date(value * 1000).toLocaleString() : '—';
  const text = (parent, tag, value) => { const e = document.createElement(tag); e.textContent = value; parent.append(e); return e; };
  function link(parent, row) { const a = text(parent, 'a', (row.name || '用户') + ' [' + row.id + ']'); a.href = 'https://www.torn.com/profiles.php?XID=' + row.id; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  function select() {
    const users = location.hash === '#users' && loaded;
    $('users-view').hidden = !users;
    if (users) {
      $('chain-view').hidden = true; $('faction-view').hidden = true;
      ['chain', 'factions', 'users'].forEach(name => $('tab-' + name).setAttribute('aria-selected', String(name === 'users')));
    }
  }
  $('tab-users').onclick = () => { history.replaceState(null, '', location.pathname + location.search + '#users'); select(); refresh(); };
  ['chain', 'factions'].forEach(name => $('tab-' + name).addEventListener('click', () => { $('users-view').hidden = true; $('tab-users').setAttribute('aria-selected', 'false'); }));
  window.addEventListener('hashchange', select);
  async function api(path, method = 'GET', body) {
    const response = await fetch('/api/torn-users/' + path, { method, credentials: 'same-origin', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw Object.assign(new Error(data.error || '用户监控操作失败'), { status: response.status });
    return data;
  }
  function historyRows() {
    const pageSize = 20; offset = Math.min(offset, Math.max(0, Math.floor((records.length - 1) / pageSize) * pageSize));
    $('users-history').replaceChildren();
    for (const row of records.slice(offset, offset + pageSize)) {
      const e = document.createElement('article'); link(e, row);
      text(e, 'p', '预计出院 ' + time(row.hospitalUntil) + ' · 提醒于 ' + time(row.detectedAt) + ' · 当时剩余 ' + row.remainingSeconds + ' 秒');
      text(e, 'p', '通知：' + ({ pending: '待确认', sent: '已提交渠道', disabled: '未开启渠道或无通知权限', failed: '失败，请检查通知管理' }[row.notification] || '未知')); $('users-history').append(e);
    }
    if (!records.length) $('users-history').textContent = '尚无出院提醒记录';
    $('users-page').textContent = '第 ' + (Math.floor(offset / pageSize) + 1) + ' / ' + Math.max(1, Math.ceil(records.length / pageSize)) + ' 页 · ' + records.length + ' 条';
    $('users-prev').disabled = offset === 0; $('users-next').disabled = offset + pageSize >= records.length;
  }
  function countdowns() {
    const now = Date.now() / 1000 + serverOffset;
    document.querySelectorAll('#users-rows [data-until]').forEach(e => { const seconds = Math.max(0, Math.ceil(Number(e.dataset.until) - now)); e.textContent = seconds ? Math.floor(seconds / 60) + '分 ' + seconds % 60 + '秒' : '预计时间已到，等待 API 核验'; });
  }
  function render(data) {
    loaded = true; $('tab-users').hidden = false;
    const { config, permissions: p, state } = data;
    if (!dirty) { fields.forEach(field => $('users-' + field).value = config[field]); $('users-targets').value = config.targets.map(row => row.id).join('\n'); }
    $('users-form').querySelectorAll('input,textarea').forEach(e => { e.disabled = !p.configure; });
    $('users-save').hidden = $('users-clear-keys').hidden = !p.configure;
    $('users-start').hidden = $('users-stop').hidden = !p.control; $('users-clear').hidden = !p.clear;
    $('users-readonly').hidden = p.configure || p.control;
    $('users-key-status').textContent = '已保存 ' + config.keyCount + ' 个 Key；当前用户数 ' + config.targets.length;
    $('users-status').textContent = (state.running ? '运行中' : '已停止') + ' · 已完成 ' + state.rounds + ' 轮 · 最近 ' + time(state.lastScanAt) + ' · 下轮 ' + time(state.nextScanAt) + (state.retryMessage ? ' · ' + state.retryMessage : '') + (state.error ? ' · ' + state.error : '');
    $('users-notification-error').textContent = state.notificationError || '';
    serverOffset = state.serverNow - Date.now() / 1000; $('users-rows').replaceChildren();
    for (const row of state.rows) {
      const tr = document.createElement('tr'); link(text(tr, 'td', ''), row);
      text(tr, 'td', row.status === 'unknown' ? '状态不明' : row.status);
      text(tr, 'td', time(row.hospitalUntil)); const remaining = text(tr, 'td', '—'); if (row.hospitalUntil) remaining.dataset.until = row.hospitalUntil;
      text(tr, 'td', time(row.reminderAt)); text(tr, 'td', time(row.checkedAt) + (row.error ? ' · ' + row.error : ''));
      Array.from(tr.children).forEach((cell,index) => { cell.dataset.label = ['用户','状态','预计出院','剩余时间','提醒时间','最近核验 / 问题'][index]; });
      $('users-rows').append(tr);
    }
    records = data.history; historyRows(); countdowns(); select();
  }
  async function refresh() {
    if (loading) return; loading = true;
    try { render(await api('state')); }
    catch (error) {
      if ([401, 403].includes(error.status)) { loaded = false; $('tab-users').hidden = true; $('users-view').hidden = true; $('users-rows').replaceChildren(); $('users-history').replaceChildren(); if (location.hash === '#users') $('tab-chain').click(); }
      else $('users-message').textContent = error.message;
    } finally { loading = false; }
  }
  $('users-form').addEventListener('input', () => { dirty = true; });
  $('users-form').onsubmit = async event => {
    event.preventDefault(); const body = Object.fromEntries(fields.map(field => [field, $('users-' + field).value])); body.targets = $('users-targets').value;
    if ($('users-apiKeys').value.trim()) body.apiKeys = $('users-apiKeys').value.trim();
    try { await api('config', 'POST', body); dirty = false; $('users-apiKeys').value = ''; $('users-message').textContent = '已保存，请启动用户监控'; await refresh(); } catch (error) { $('users-message').textContent = error.message; }
  };
  for (const action of ['start', 'stop', 'clear', 'clear-keys']) $('users-' + action).onclick = async () => {
    if (['clear', 'clear-keys'].includes(action) && !confirm('确认' + (action === 'clear' ? '清空记录（去重保留）' : '删除全部 Keys 并停止用户监控') + '？')) return;
    try { await api(action === 'clear' ? 'history' : action === 'clear-keys' ? 'config' : action, action === 'clear' ? 'DELETE' : 'POST', action === 'clear-keys' ? { apiKeys: [] } : {}); $('users-message').textContent = '操作成功'; await refresh(); } catch (error) { $('users-message').textContent = error.message; }
  };
  $('users-prev').onclick = () => { offset = Math.max(0, offset - 20); historyRows(); }; $('users-next').onclick = () => { offset += 20; historyRows(); };
  setInterval(() => { if (!document.hidden && !$('users-view').hidden) refresh(); }, 5000);
  setInterval(() => { if (!document.hidden && !$('users-view').hidden) countdowns(); }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('users-view').hidden) refresh(); });
  refresh();
})();
