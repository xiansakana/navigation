(() => {
  const $ = id => document.getElementById(id), date = value => value ? new Date(value * 1000).toLocaleString('sv-SE') : '—';
  let dirty = false, loading = false, queued = false, latest, offset = 0;
  let rowsSnapshot, historySnapshot, view;
  const viewReady = import('../../generated/torn-chain-view.js?v=1').then(({ mountChainView }) => {
    view = mountChainView({ rows: $('monitor-chains'), history: $('history') });
  });
  async function api(path, method = 'GET', body) {
    const response = await fetch('/api/torn-chain/' + path, { method, credentials: 'same-origin', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || '操作失败'); return data;
  }
  function renderRows() {
    const state = latest.state;
    const rows = state.factions || [], total = state.factionsTotal ?? rows.length;
    offset = state.factionsOffset ?? 0;
    $('monitor-count').textContent = '(' + total + ')'; $('monitor-table').hidden = !rows.length; $('monitor-empty').hidden = !!rows.length;
    $('monitor-empty').textContent = $('monitor-filter').value === 'problem' ? '没有待确认的帮派。' : '尚无存活基线，请启动监控。';
    const snapshot = JSON.stringify([rows, state.problems || []]);
    if (snapshot !== rowsSnapshot) {
      rowsSnapshot = snapshot;
      view.renderRows(rows, state.problems || []);
    }
    $('monitor-page').textContent = `${total ? offset + 1 : 0}–${Math.min(offset + 50, total)} / ${total}`;
    $('monitor-prev').disabled = !offset; $('monitor-next').disabled = offset + 50 >= total;
  }
  async function render(data) {
    await viewReady;
    latest = data; const { config, state, history, permissions } = data;
    if (!dirty) { $('min-respect').value = config.minRespect; $('max-respect').value = config.maxRespect ?? ''; $('interval').value = config.intervalSeconds; $('api-interval').value = config.apiIntervalSeconds; }
    for (const id of ['min-respect', 'max-respect', 'interval', 'api-interval', 'api-key']) $(id).disabled = !permissions.configure;
    $('save').hidden = $('clear-key').hidden = !permissions.configure; $('start').hidden = $('stop').hidden = !permissions.control; $('clear-history').hidden = !permissions.clear;
    $('chain-readonly-note').hidden = permissions.configure || permissions.control || permissions.clear;
    $('start').disabled = state.running || state.busy || !config.hasKey; $('stop').disabled = !state.running; $('clear-key').disabled = !config.hasKey;
    $('key-status').textContent = config.hasKey ? `已保存 ${config.keyCount} 个 Key（不回传浏览器）` : '请保存具有公开信息权限的 Torn API Key';
    const retry = state.retryAt ? ` · ${state.retryMessage} · 约 ${Math.max(0, Math.ceil(state.retryAt - Date.now() / 1000))} 秒后重试` : '';
    $('status').textContent = `${state.running ? state.busy ? '扫描中' : '运行中' : state.busy ? '正在停止' : '已停止'} · 已完成 ${state.rounds} 轮 · 最近扫描 ${date(state.lastScanAt)} · 下轮 ${date(state.nextScanAt)}${retry}`;
    $('coverage').textContent = `本轮列表 ${state.pages || 0} 页 · 跟踪 ${state.tracked || 0} · 核验 ${state.confirmed || 0} · 本次运行发现清零 ${state.zeroed || 0} · 其他摧毁告警 ${state.destroyed || 0} · 范围外已跳过 ${state.outsideRange || 0} · 待确认 ${state.failed || 0}${state.partial ? ' · 本轮未完成' : ''}${state.error ? ' · ' + state.error : ''}${state.notificationError ? ' · ' + state.notificationError : ''}` + (Number.isInteger(state.keyCount) ? ` · Key 可用 ${state.availableKeyCount}/${state.keyCount} · 账号 ${state.ownerCount}` : '') + (state.skippedKeys || []).map(row => ` · 已跳过 Key #${row.index}：${row.reason}`).join('');
    $('monitor-hint').textContent = state.detailsStale ? '本轮列表尚未完整；明确清零已即时处理，其余存活基线保留。' : '最新完整列表：' + date(state.detailsAt);
    renderRows(); $('count').textContent = '(' + history.length + ')';
    const snapshot = JSON.stringify(history);
    if (snapshot === historySnapshot) return;
    historySnapshot = snapshot;
    view.renderHistory(history);
  }
  async function refresh() {
    if (loading) { queued = true; return; }
    loading = true; const requestedOffset = offset, filter = $('monitor-filter').value;
    try {
      const data = await api('state?offset=' + requestedOffset + '&filter=' + filter);
      if (requestedOffset === offset && filter === $('monitor-filter').value) await render(data);
    } catch (error) { $('message').textContent = error.message; }
    finally { loading = false; if (queued) { queued = false; refresh(); } }
  }
  async function action(path, method = 'POST', body) { try { await api(path, method, body); $('message').textContent = '操作成功'; await refresh(); } catch (error) { $('message').textContent = error.message; } }
  $('config-form').oninput = () => { dirty = true; };
  $('config-form').onsubmit = async event => {
    event.preventDefault(); const body = { minRespect: $('min-respect').value, maxRespect: $('max-respect').value, intervalSeconds: $('interval').value, apiIntervalSeconds: $('api-interval').value };
    if ($('api-key').value.trim()) body.apiKeys = $('api-key').value.trim();
    try { await api('config', 'POST', body); dirty = false; $('api-key').value = ''; $('message').textContent = '配置已保存，请启动监控'; await refresh(); } catch (error) { $('message').textContent = error.message; }
  };
  $('start').onclick = () => action('start'); $('stop').onclick = () => action('stop');
  $('clear-key').onclick = async () => { if (await window.portalUI.confirm('删除全部 Keys 并停止监控？', { title: '清空 Keys', danger: true, okText: '删除' })) action('config', 'POST', { apiKeys: [] }); };
  $('clear-history').onclick = async () => { if (await window.portalUI.confirm('清空摧毁记录？去重状态保留。', { title: '清空记录', danger: true, okText: '清空' })) action('history', 'DELETE'); };
  $('monitor-filter').onchange = () => { offset = 0; refresh(); };
  $('monitor-prev').onclick = () => { offset = Math.max(0, offset - 50); refresh(); }; $('monitor-next').onclick = () => { offset += 50; refresh(); };
  function refreshVisible() {
    if (!document.hidden && !$('chain-view').hidden && !loading) void refresh();
  }
  document.addEventListener('visibilitychange', refreshVisible);
  $('tab-chain').addEventListener('click', () => queueMicrotask(refreshVisible));
  window.addEventListener('hashchange', () => queueMicrotask(refreshVisible));
  setInterval(refreshVisible, 5000);
  void refresh();
})();
