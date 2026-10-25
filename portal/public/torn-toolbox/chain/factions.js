(() => {
  const $ = id => document.getElementById(id), fields = ['minRespect', 'maxRespect', 'batchSize', 'apiIntervalSeconds', 'historyDays', 'dropMode', 'dailyDropAmount', 'peakDropAmount', 'minDifference', 'maxDifference'];
  let loaded = false, dirty = false, busy = false, offset = 0;
  const day = value => Number.isInteger(value) ? new Date(value * 86400000).toISOString().slice(0, 10) : '—';
  const value = number => Number.isFinite(number) ? number.toLocaleString() : '—';
  const labels = { waiting: '待扫描', scanning: '扫描中', match: '命中', excluded: '已排除', unknown: '待确认' };
  async function api(route, method = 'GET', body) {
    const response = await fetch('/api/torn-factions/' + route, { method, credentials: 'same-origin', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if ([401, 403].includes(response.status) && method === 'GET') {
      loaded = false; $('tab-factions').hidden = true; $('faction-results').replaceChildren(); tab(false); return null;
    }
    const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || '帮派筛选操作失败'); return data;
  }
  function tab(factions) {
    if (factions && !loaded) return;
    $('chain-view').hidden = factions; $('faction-view').hidden = !factions;
    $('tab-chain').setAttribute('aria-selected', String(!factions)); $('tab-factions').setAttribute('aria-selected', String(factions));
  }
  $('tab-chain').onclick = () => { history.replaceState(null, '', location.pathname + location.search + '#chain'); tab(false); };
  $('tab-factions').onclick = () => { history.replaceState(null, '', location.pathname + location.search + '#factions'); tab(true); refresh(); };
  window.addEventListener('hashchange', () => tab(location.hash === '#factions'));
  function render(data) {
    loaded = true; $('tab-factions').hidden = false;
    const { config, state, permissions, counts } = data;
    if (!dirty) for (const field of fields) $('faction-' + field).value = config[field] ?? '';
    for (const field of [...fields, 'apiKeys']) $('faction-' + field).disabled = !permissions.configure;
    $('faction-save').hidden = !permissions.configure;
    for (const name of ['start', 'stop', 'reset']) $('faction-' + name).hidden = !permissions.control;
    $('faction-start').disabled = state.running || state.busy || !config.hasKey; $('faction-stop').disabled = !state.running; $('faction-reset').disabled = state.busy;
    const skipped = (state.skippedKeys || []).map(key => `Key #${key.index}（${key.reason}）`).join('、');
    $('faction-key-status').textContent = config.hasKey ? `已保存 ${config.keyCount} 个 Key（不回传浏览器）；${state.availableKeyCount == null ? '有效账号数在扫描核验后显示' : `本次可用 ${state.availableKeyCount} 个`}${skipped ? '；已跳过：' + skipped : ''}` : '请保存用于公开帮派与个人统计查询的 API Keys';
    $('faction-estimate').textContent = config.historyMode === 'full' ? 'N 未填写，扫描全历史。倒序按更新时间跳过不变区间；每天变化的账号仍需逐日查询。' : `最近 ${config.historyDays} 天，仅确认窗口内高点；逐日查询上界约 ${config.batchSize * (config.historyDays + 7)} 次详情请求，另加 Key 核验和列表分页。跳过不变区间可减少请求，暂停后可继续。`;
    const retry = state.running && state.retryAt ? ` · 约 ${Math.max(0, Math.ceil(state.retryAt - Date.now() / 1000))} 秒后重试` : '';
    $('faction-status').textContent = `${state.running ? '运行中' : state.busy ? '停止中' : '已停止'} · ${state.stage || '尚未启动'}${retry}${state.error ? ' · ' + state.error : ''}`;
    $('faction-progress').textContent = `列表 ${state.listed || 0} 个 · 已处理 ${state.cursor || 0} 个 · 帮派第 ${state.factionBatch || 0} 批（自动续批） · 成功请求 ${state.requests || 0} · 缓存复用 ${state.cached || 0} · 跳过不变日期 ${state.skippedDays || 0} · 有效账号 ${state.ownerCount || '—'} · 当前帮派 ${state.currentFaction || '—'} · 当前历史日 ${day(state.currentDay)}`;
    $('faction-counts').textContent = `命中 ${counts.match} · 已排除 ${counts.excluded} · 待确认 ${counts.unknown} · 扫描中 ${counts.scanning} · 待扫描 ${counts.waiting}（列表完整后按 respect 升序）`;
    const rows = data.rows.map(row => {
      const article = document.createElement('article'); article.className = 'faction-result';
      const title = document.createElement('h4'), faction = document.createElement('a'); faction.textContent = `${row.name} [${row.id}]`; faction.href = 'https://www.torn.com/factions.php?step=profile&ID=' + row.id; faction.target = '_blank'; faction.rel = 'noopener noreferrer';
      title.append(faction, document.createTextNode(` · respect ${value(row.respect)} · ${labels[row.status] || row.status}`)); article.append(title);
      const leader = document.createElement('a'); leader.textContent = `Leader ${row.leaderName} [${row.leaderId}]`; leader.href = 'https://www.torn.com/profiles.php?XID=' + row.leaderId; leader.target = '_blank'; leader.rel = 'noopener noreferrer'; article.append(leader);
      const dl = document.createElement('dl');
      for (const [name, text] of [['下跌日（TCT）', day(row.dropDay)], ['A（天）', value(row.A)], ['B（天）', value(row.B)], ['C（天）', value(row.C)], ['A−B（天）', value(row.difference)], ['单日减少（Torn $）', value(row.dailyAmount)], ['距高点减少（Torn $）', value(row.peakAmount)], ['历史进度', `${row.loadedDays || 0}/${row.totalDays || '—'} · 第 ${row.historyBatch || 0} 批（自动续批）`], ['下跌前高点', value(row.peakBefore)], ['下跌前一日', value(row.beforeValue)], ['下跌日净资产', value(row.dropValue)], ['扫描范围', `${day(row.firstDay ?? row.historyStart)} 至 ${day(row.lastDay ?? state.today)}`]]) {
        const wrap = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = text; wrap.append(dt, dd); dl.append(wrap);
      }
      const reason = document.createElement('p'); reason.textContent = row.reason || '—'; article.append(dl, reason); return article;
    });
    if (!rows.length) { const empty = document.createElement('p'); empty.textContent = state.listComplete ? '当前筛选没有结果。' : '启动后先读取完整帮派列表，再按 respect 升序扫描。'; rows.push(empty); }
    $('faction-results').replaceChildren(...rows);
    $('faction-page').textContent = `${data.total ? data.offset + 1 : 0}–${Math.min(data.offset + data.limit, data.total)} / ${data.total}`;
    $('faction-prev').disabled = !data.offset; $('faction-next').disabled = data.offset + data.limit >= data.total;
  }
  async function refresh() {
    if (busy) return; busy = true;
    try { const data = await api('state?offset=' + offset + '&filter=' + $('faction-filter').value); if (data) render(data); }
    catch (error) { $('faction-message').textContent = error.message; } finally { busy = false; }
  }
  $('faction-form').addEventListener('input', () => { dirty = true; });
  $('faction-form').onsubmit = async event => {
    event.preventDefault(); const body = Object.fromEntries(fields.map(field => [field, $('faction-' + field).value]));
    if ($('faction-apiKeys').value.trim()) body.apiKeys = $('faction-apiKeys').value.trim();
    try { await api('config', 'POST', body); dirty = false; offset = 0; $('faction-apiKeys').value = ''; $('faction-message').textContent = '配置已保存，历史缓存保留；点击启动进行扫描。'; await refresh(); }
    catch (error) { $('faction-message').textContent = error.message; }
  };
  for (const name of ['start', 'stop', 'reset']) $('faction-' + name).onclick = async () => {
    if (name === 'reset' && !confirm('重新获取帮派列表并清空本次结果？已缓存的历史数据保留。')) return;
    try { await api(name, 'POST'); if (name === 'reset') offset = 0; $('faction-message').textContent = '操作成功'; await refresh(); }
    catch (error) { $('faction-message').textContent = error.message; }
  };
  $('faction-filter').onchange = () => { offset = 0; refresh(); };
  $('faction-prev').onclick = () => { offset = Math.max(0, offset - 50); refresh(); };
  $('faction-next').onclick = () => { offset += 50; refresh(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('faction-view').hidden) refresh(); });
  setInterval(() => { if (!document.hidden && !$('faction-view').hidden) refresh(); }, 5000);
  refresh().then(() => tab(location.hash === '#factions'));
})();
