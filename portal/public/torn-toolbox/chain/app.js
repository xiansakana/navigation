(() => {
  const $ = id => document.getElementById(id), date = value => value ? new Date(value * 1000).toLocaleString() : '—';
  let dirty = false, loading = false, latest, offset = 0;
  async function api(path, method = 'GET', body) {
    const response = await fetch('/api/torn-chain/' + path, { method, credentials: 'same-origin', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || '操作失败'); return data;
  }
  function link(label, url) { const a = document.createElement('a'); a.textContent = label; a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; }
  const factionLink = row => link(row.name + ' [' + row.id + ']', 'https://www.torn.com/factions.php?step=profile&ID=' + Number(row.id));
  const leaderLink = row => link((row.leaderName || 'Leader') + ' [' + row.leaderId + ']', 'https://www.torn.com/profiles.php?XID=' + Number(row.leaderId));
  function renderRows() {
    const state = latest.state, problems = new Map((state.problems || []).map(row => [row.id, row.reason]));
    const rows = state.factions || [], total = state.factionsTotal ?? rows.length;
    offset = state.factionsOffset ?? 0;
    $('monitor-count').textContent = '(' + total + ')'; $('monitor-table').hidden = !rows.length; $('monitor-empty').hidden = !!rows.length;
    $('monitor-empty').textContent = $('monitor-filter').value === 'problem' ? '没有待确认的帮派。' : '尚无存活基线，请启动监控。';
    $('monitor-chains').replaceChildren(...rows.map(row => {
      const tr = document.createElement('tr'); tr.dataset.factionId = row.id;
      const change = Number.isSafeInteger(row.previousRespect) ? row.respect - row.previousRespect : null;
      for (const [label, content] of [['帮派', factionLink(row)], ['Leader', leaderLink(row)], ['respect', row.respect.toLocaleString()], ['变化', change === null ? '基线' : (change > 0 ? '+' : '') + change], ['最近存活', date(row.lastAliveAt)], ['核验说明', problems.get(row.id) || 'API 确认存活']]) {
        const td = document.createElement('td'); td.dataset.label = label; if (typeof content === 'string') td.textContent = content; else td.append(content); tr.append(td);
      } return tr;
    }));
    $('monitor-page').textContent = `${total ? offset + 1 : 0}–${Math.min(offset + 50, total)} / ${total}`;
    $('monitor-prev').disabled = !offset; $('monitor-next').disabled = offset + 50 >= total;
  }
  function render(data) {
    latest = data; const { config, state, history, permissions } = data;
    if (!dirty) { $('min-respect').value = config.minRespect; $('max-respect').value = config.maxRespect ?? ''; $('interval').value = config.intervalSeconds; $('api-interval').value = config.apiIntervalSeconds; }
    for (const id of ['min-respect', 'max-respect', 'interval', 'api-interval', 'api-key']) $(id).disabled = !permissions.configure;
    $('save').hidden = $('clear-key').hidden = !permissions.configure; $('start').hidden = $('stop').hidden = !permissions.control; $('clear-history').hidden = !permissions.clear;
    $('chain-readonly-note').hidden = permissions.configure || permissions.control || permissions.clear;
    $('start').disabled = state.running || state.busy || !config.hasKey; $('stop').disabled = !state.running; $('clear-key').disabled = !config.hasKey;
    $('key-status').textContent = config.hasKey ? `已保存 ${config.keyCount} 个 Key（不回传浏览器）` : '请保存具有公开信息权限的 Torn API Key';
    const retry = state.retryAt ? ` · ${state.retryMessage} · 约 ${Math.max(0, Math.ceil(state.retryAt - Date.now() / 1000))} 秒后重试` : '';
    $('status').textContent = `${state.running ? state.busy ? '扫描中' : '运行中' : state.busy ? '正在停止' : '已停止'} · 已完成 ${state.rounds} 轮 · 最近扫描 ${date(state.lastScanAt)} · 下轮 ${date(state.nextScanAt)}${retry}`;
    $('coverage').textContent = `本轮列表 ${state.pages || 0} 页 · 跟踪 ${state.tracked || 0} · 核验 ${state.confirmed || 0} · 本次运行发现摧毁 ${state.destroyed || 0} · 范围外已跳过 ${state.outsideRange || 0} · 待确认 ${state.failed || 0}${state.partial ? ' · 本轮未完成' : ''}${state.error ? ' · ' + state.error : ''}${state.notificationError ? ' · ' + state.notificationError : ''}` + (Number.isInteger(state.keyCount) ? ` · Key 可用 ${state.availableKeyCount}/${state.keyCount} · 账号 ${state.ownerCount}` : '') + (state.skippedKeys || []).map(row => ` · 已跳过 Key #${row.index}：${row.reason}`).join('');
    $('monitor-hint').textContent = state.detailsStale ? '本轮列表尚未完整返回，保留之前的存活基线。' : '最新完整列表：' + date(state.detailsAt);
    renderRows(); $('count').textContent = '(' + history.length + ')';
    const articles = history.map(row => {
      const article = document.createElement('article'); article.className = 'chain-row';
      const content = document.createElement('div'), title = document.createElement('strong'), info = document.createElement('p'), reason = document.createElement('p');
      title.textContent = '已确认摧毁 · '; title.append(factionLink(row));
      info.textContent = `最后存活 ${date(row.lastAliveAt)} · 发现摧毁 ${date(row.detectedAt)} · respect ${row.previousRespect} → ${row.respect}`;
      reason.textContent = '原因未知；未判定为 Bonus 导致。'; content.append(title, info, reason); article.append(content, leaderLink(row)); return article;
    });
    if (!articles.length) { const empty = document.createElement('p'); empty.textContent = '暂无确认的存活 → 摧毁记录。'; articles.push(empty); }
    $('history').replaceChildren(...articles);
  }
  async function refresh() { if (loading) return; loading = true; try { render(await api('state?offset=' + offset + '&filter=' + $('monitor-filter').value)); } catch (error) { $('message').textContent = error.message; } finally { loading = false; } }
  async function action(path, method = 'POST', body) { try { await api(path, method, body); $('message').textContent = '操作成功'; await refresh(); } catch (error) { $('message').textContent = error.message; } }
  $('config-form').oninput = () => { dirty = true; };
  $('config-form').onsubmit = async event => {
    event.preventDefault(); const body = { minRespect: $('min-respect').value, maxRespect: $('max-respect').value, intervalSeconds: $('interval').value, apiIntervalSeconds: $('api-interval').value };
    if ($('api-key').value.trim()) body.apiKeys = $('api-key').value.trim();
    try { await api('config', 'POST', body); dirty = false; $('api-key').value = ''; $('message').textContent = '配置已保存，请启动监控'; await refresh(); } catch (error) { $('message').textContent = error.message; }
  };
  $('start').onclick = () => action('start'); $('stop').onclick = () => action('stop');
  $('clear-key').onclick = () => { if (confirm('删除全部 Keys 并停止监控？')) action('config', 'POST', { apiKeys: [] }); };
  $('clear-history').onclick = () => { if (confirm('清空摧毁记录？去重状态保留。')) action('history', 'DELETE'); };
  $('monitor-filter').onchange = () => { offset = 0; refresh(); };
  $('monitor-prev').onclick = () => { offset = Math.max(0, offset - 50); refresh(); }; $('monitor-next').onclick = () => { offset += 50; refresh(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); }); setInterval(() => { if (!document.hidden) refresh(); }, 5000); refresh();
})();
