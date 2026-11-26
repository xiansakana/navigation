(() => {
  const $ = id => document.getElementById(id), fields = ['leadMinutes', 'intervalSeconds', 'apiIntervalSeconds'];
  let dirty = false, loading = false, loaded = false, offset = 0, records = [], serverOffset = 0, view;
  const viewReady = import('../../generated/torn-users-view.js?v=1').then(({ mountUsersView }) => {
    view = mountUsersView({ rows: $('users-rows'), history: $('users-history') });
  });
  const time = value => Number.isFinite(value) ? new Date(value * 1000).toLocaleString('sv-SE') : '—';
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
    if (!view) return;
    view.renderHistory(records.slice(offset, offset + pageSize));
    $('users-page').textContent = '第 ' + (Math.floor(offset / pageSize) + 1) + ' / ' + Math.max(1, Math.ceil(records.length / pageSize)) + ' 页 · ' + records.length + ' 条';
    $('users-prev').disabled = offset === 0; $('users-next').disabled = offset + pageSize >= records.length;
  }
  function countdowns() {
    const now = Date.now() / 1000 + serverOffset;
    document.querySelectorAll('#users-rows [data-until]').forEach(e => { const seconds = Math.max(0, Math.ceil(Number(e.dataset.until) - now)); e.textContent = seconds ? Math.floor(seconds / 60) + '分 ' + seconds % 60 + '秒' : '预计时间已到，等待 API 核验'; });
  }
  async function render(data) {
    await viewReady;
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
    serverOffset = state.serverNow - Date.now() / 1000; view.renderRows(state.rows);
    records = data.history; historyRows(); countdowns(); select();
  }
  async function refresh() {
    if (loading) return; loading = true;
    try { await render(await api('state')); }
    catch (error) {
      if ([401, 403].includes(error.status)) { loaded = false; $('tab-users').hidden = true; $('users-view').hidden = true; if (view) { view.renderRows([]); view.renderHistory([]); } if (location.hash === '#users') $('tab-chain').click(); }
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
