(() => {
  const $ = id => document.getElementById(id);
  let editing = false, loading = false;
  const date = seconds => seconds ? new Date(seconds * 1000).toLocaleString() : '—';
  async function api(path, method = 'GET', body) {
    const response = await fetch('/api/torn-chain/' + path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '操作失败');
    return data;
  }
  function render(data) {
    const { config, state, permissions, history } = data;
    if (!editing) {
      $('min-hits').value = config.minHits; $('max-hits').value = config.maxHits ?? ''; $('interval').value = config.intervalSeconds;
    }
    for (const id of ['min-hits', 'max-hits', 'interval', 'api-key']) $(id).disabled = !permissions.configure;
    $('save').hidden = $('clear-key').hidden = !permissions.configure;
    $('start').hidden = $('stop').hidden = !permissions.control;
    $('clear-history').hidden = !permissions.clear;
    $('clear-key').disabled = !config.hasKey;
    $('start').disabled = state.running || state.busy || !config.hasKey;
    $('stop').disabled = !state.running;
    $('key-status').textContent = config.hasKey ? '已保存 Key（不回传浏览器）' : '请保存具有公开信息权限的 Torn API Key';
    $('status').textContent = `${state.running ? state.busy ? '扫描中' : '运行中' : state.busy ? '正在停止' : '已停止'} · 已完成 ${state.rounds} 轮 · 最近扫描 ${date(state.lastScanAt)} · 下轮 ${date(state.nextScanAt)}`;
    $('coverage').textContent = `候选 ${state.candidates} · 本轮核验 ${state.confirmed} · 失败/状态不明 ${state.failed}${state.remainingCandidates ? ' · 待轮换 ' + state.remainingCandidates : ''}${state.partial ? ' · 列表不完整，覆盖受限' : ''}${state.error ? ' · ' + state.error : ''}${state.notificationError ? ' · ' + state.notificationError : ''}`;
    $('count').textContent = `(${history.length})`;
    const rows = history.map(row => {
      const article = document.createElement('article'); article.className = 'chain-row';
      const content = document.createElement('div'), title = document.createElement('strong'), badge = document.createElement('span'), info = document.createElement('p');
      badge.className = 'chain-badge' + (row.fresh ? ' fresh' : ''); badge.textContent = row.fresh ? '刚进入冷却' : '首次发现';
      title.textContent = `${row.name} · ${row.hits} hits`;
      info.textContent = `进入冷却（推算） ${date(row.cooldownStartedAt)} · 发现于 ${date(row.detectedAt)} · 冷却结束 ${date(row.cooldownUntil)}`;
      content.append(badge, title, info);
      const link = document.createElement('a'); link.textContent = '查看 report ↗'; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.href = 'https://www.torn.com/war.php?step=chainreport&chainID=' + Number(row.id);
      article.append(content, link); return article;
    });
    if (!rows.length) { const empty = document.createElement('p'); empty.textContent = '暂无符合长度范围的冷却记录。'; rows.push(empty); }
    $('history').replaceChildren(...rows);
  }
  async function refresh() {
    if (loading) return;
    loading = true;
    try { render(await api('state')); } catch (error) { $('message').textContent = error.message; } finally { loading = false; }
  }
  async function action(path, method, body) {
    try { await api(path, method, body); $('message').textContent = '操作成功'; await refresh(); } catch (error) { $('message').textContent = error.message; }
  }
  $('config-form').addEventListener('input', () => { editing = true; });
  $('config-form').addEventListener('submit', async event => {
    event.preventDefault();
    const body = { minHits: $('min-hits').value, maxHits: $('max-hits').value, intervalSeconds: $('interval').value };
    if ($('api-key').value.trim()) body.apiKey = $('api-key').value.trim();
    try { await api('config', 'POST', body); editing = false; $('api-key').value = ''; $('message').textContent = '配置已保存，请启动监控'; await refresh(); } catch (error) { $('message').textContent = error.message; }
  });
  $('start').onclick = () => action('start', 'POST');
  $('stop').onclick = () => action('stop', 'POST');
  $('clear-key').onclick = () => { if (confirm('删除已保存的 API Key 并停止监控？')) action('config', 'POST', { apiKey: '' }); };
  $('clear-history').onclick = () => { if (confirm('清空自己的冷却记录？')) action('history', 'DELETE'); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  refresh();
})();
