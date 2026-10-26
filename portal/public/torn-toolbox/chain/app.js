(() => {
  const $ = id => document.getElementById(id);
  let editing = false, loading = false, lastMonitorState;
  const date = seconds => seconds ? new Date(seconds * 1000).toLocaleString() : '—';
  const monitorLabels = { waiting: '待核验', checking: '核验中', active: '活动中', cooldown: '冷却中', ended: '已结束', failed: '核验失败', unknown: '状态不明' };
  function renderMonitor(state) {
    lastMonitorState = state;
    const rows = state.chains || [], filter = $('monitor-filter').value;
    const visible = rows.filter(row => filter === 'all' || filter === 'problem' && ['failed', 'unknown'].includes(row.status) || filter === 'pending' && ['waiting', 'checking'].includes(row.status) || row.status === filter);
    $('monitor-count').textContent = `(${visible.length}/${rows.length})`;
    $('monitor-hint').textContent = state.detailsStale && rows.length ? '本轮候选列表尚未刷新，以下为上次扫描明细。' : state.detailsAt ? '候选列表更新于 ' + date(state.detailsAt) : state.busy ? '正在读取候选列表…' : '';
    $('monitor-table').hidden = !visible.length; $('monitor-empty').hidden = !!visible.length;
    $('monitor-empty').textContent = rows.length ? '没有符合当前状态筛选的 Chain。' : '启动监控并读取候选列表后显示帮派和 Chain 明细。';
    const elements = visible.map(row => {
      const tr = document.createElement('tr'); tr.dataset.chainId = row.id;
      const cell = label => { const td = document.createElement('td'), content = document.createElement('div'); td.dataset.label = label; td.append(content); tr.append(td); return content; };
      const small = (parent, text) => { const node = document.createElement('small'); node.textContent = text; parent.append(node); };
      const faction = cell('帮派'), factionLink = document.createElement('a'); factionLink.textContent = row.name; factionLink.href = 'https://www.torn.com/factions.php?step=profile&ID=' + Number(row.factionId); factionLink.target = '_blank'; factionLink.rel = 'noopener noreferrer'; faction.append(factionLink); small(faction, 'ID ' + row.factionId);
      const chain = cell('Chain'), report = document.createElement('a'); report.textContent = '#' + row.id; report.href = 'https://www.torn.com/war.php?step=chainreport&chainID=' + Number(row.id); report.target = '_blank'; report.rel = 'noopener noreferrer'; chain.append(report);
      const hits = cell('长度'); hits.textContent = Number.isSafeInteger(row.hits) ? row.hits + ' hits' : '未知'; small(hits, row.hitsSource === 'list' ? '列表值，待详情核验' : '详情核验值');
      const status = cell('状态 / 计时'), label = document.createElement('strong'); label.dataset.state = row.status;
      label.textContent = row.status === 'cooldown' && row.cooldownUntil && row.cooldownUntil <= Date.now() / 1000 ? '冷却预计已到期，待核验' : (monitorLabels[row.status] || '状态不明') + (row.cached ? '（缓存）' : ''); status.append(label);
      if (row.status === 'active' && Number.isSafeInteger(row.timeoutSeconds)) small(status, '核验时断链剩余 ' + row.timeoutSeconds + ' 秒');
      if (row.cooldownUntil && row.status === 'cooldown') small(status, '冷却结束 ' + date(row.cooldownUntil));
      const checked = cell('核验时间'); checked.textContent = row.verifiedAt ? date(row.verifiedAt) : '尚未成功核验';
      if (row.attemptedAt && ['failed', 'unknown', 'checking', 'waiting'].includes(row.status)) small(checked, '最近尝试 ' + date(row.attemptedAt));
      const reason = cell('核验说明'); reason.textContent = row.reason || '—';
      if (row.inRange === false) small(reason, '长度超出配置范围，继续观察');
      if (row.listed === false) small(reason, '已从当前列表消失，保留跟踪');
      if (['failed', 'unknown', 'waiting', 'checking'].includes(row.status) && row.previousStatus) small(reason, '上次确认：' + (monitorLabels[row.previousStatus] || '状态不明'));
      return tr;
    });
    $('monitor-chains').replaceChildren(...elements);
  }
  async function api(path, method = 'GET', body) {
    const response = await fetch('/api/torn-chain/' + path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '操作失败');
    return data;
  }
  function render(data) {
    const { config, state, permissions, history } = data;
    if (!$('bonus-options').children.length) for (const hit of data.bonusHitOptions || []) {
      const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.value = hit; input.name = 'bonusHits';
      label.append(input, document.createTextNode('#' + hit)); $('bonus-options').append(label);
    }
    if (!editing) {
      $('min-hits').value = config.minHits; $('max-hits').value = config.maxHits ?? ''; $('interval').value = config.intervalSeconds; $('api-interval').value = config.apiIntervalSeconds ?? 2;
      $('bonus-options').querySelectorAll('input').forEach(input => { input.checked = (config.bonusHits || []).includes(Number(input.value)); });
      $('leader-filter').value = config.leaderFilter || 'all';
    }
    $('leader-filter').disabled = !permissions.configure;
    $('bonus-options').querySelectorAll('input').forEach(input => { input.disabled = !permissions.configure; });
    for (const id of ['min-hits', 'max-hits', 'interval', 'api-interval', 'api-key']) $(id).disabled = !permissions.configure;
    $('save').hidden = $('clear-key').hidden = !permissions.configure;
    $('start').hidden = $('stop').hidden = !permissions.control;
    $('clear-history').hidden = !permissions.clear;
    $('chain-readonly-note').hidden = permissions.configure || permissions.control || permissions.clear;
    $('clear-key').disabled = !config.hasKey;
    $('start').disabled = state.running || state.busy || !config.hasKey;
    $('stop').disabled = !state.running;
    $('key-status').textContent = config.hasKey ? '已保存 Key（不回传浏览器）' : '请保存具有公开信息权限的 Torn API Key';
    const retry = state.running && state.retryAt ? ` · ${state.retryMessage} · 约 ${Math.max(0, Math.ceil(state.retryAt - Date.now() / 1000))} 秒后重试` : '';
    $('status').textContent = `${state.running ? state.busy ? '扫描中' : '运行中' : state.busy ? '正在停止' : '已停止'} · 已完成 ${state.rounds} 轮 · 最近扫描 ${date(state.lastScanAt)} · 下轮 ${date(state.nextScanAt)}${retry}`;
    $('coverage').textContent = `候选 ${state.candidates} · 本轮核验 ${state.confirmed} · 已跳过短 Chain ${state.belowMinimum || 0} · 失败/状态不明 ${state.failed}${state.remainingCandidates ? ' · 待轮换 ' + state.remainingCandidates : ''}${state.partial ? ' · 列表不完整，覆盖受限' : ''}${state.error ? ' · ' + state.error : ''}${state.notificationError ? ' · ' + state.notificationError : ''}`;
    renderMonitor(state);
    const leaderFilter = config.leaderFilter || 'all';
    const matchesLeader = bonus => leaderFilter === 'all' || leaderFilter === 'leader' && bonus?.isLeader === true || leaderFilter === 'non-leader' && bonus?.isLeader === false;
    const visibleHistory = history.filter(row => leaderFilter === 'all' || (config.bonusHits || []).some(hit => hit <= row.hits && matchesLeader(row.bonusDetails?.find(item => item.hit === hit))));
    $('count').textContent = `(${visibleHistory.length}${leaderFilter !== 'all' ? '/' + history.length : ''})`;
    const rows = visibleHistory.map(row => {
      const article = document.createElement('article'); article.className = 'chain-row';
      const content = document.createElement('div'), title = document.createElement('strong'), badge = document.createElement('span'), info = document.createElement('p');
      badge.className = 'chain-badge' + (row.fresh ? ' fresh' : ''); badge.textContent = row.fresh ? '刚进入冷却' : '首次发现';
      title.textContent = `${row.name} · ${row.hits} hits`;
      info.textContent = `进入冷却（推算） ${date(row.cooldownStartedAt)} · 发现于 ${date(row.detectedAt)} · 冷却结束 ${date(row.cooldownUntil)}`;
      content.append(badge, title, info);
      const bonuses = document.createElement('div'); bonuses.className = 'chain-bonus-links';
      for (const hit of config.bonusHits || []) {
        if (hit > row.hits) continue;
        const bonus = row.bonusDetails?.find(item => item.hit === hit);
        if (!matchesLeader(bonus)) continue;
        if (Number.isSafeInteger(bonus?.defenderId) && bonus.defenderId > 0) {
          const profile = document.createElement('a'); profile.textContent = `Bonus #${hit} 被打玩家 [${bonus.defenderId}]${typeof bonus.isLeader === 'boolean' ? bonus.isLeader ? ' · Leader' : ' · 非 Leader' : bonus.isLeader === null ? ' · 身份未知' : ''} ↗`;
          if (bonus.leaderCheckedAt) profile.title = '身份核验于 ' + date(bonus.leaderCheckedAt);
          profile.href = 'https://www.torn.com/profiles.php?XID=' + bonus.defenderId; profile.target = '_blank'; profile.rel = 'noopener noreferrer'; bonuses.append(profile);
        } else {
          const pending = document.createElement('span'); pending.textContent = `Bonus #${hit} 被打玩家：${row.bonusAttempts >= 3 ? '暂不可用，请查看 report' : '待查询'}`; bonuses.append(pending);
        }
      }
      content.append(bonuses);
      const link = document.createElement('a'); link.textContent = '查看 report ↗'; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.href = 'https://www.torn.com/war.php?step=chainreport&chainID=' + Number(row.id);
      article.append(content, link); return article;
    });
    if (!rows.length) { const empty = document.createElement('p'); empty.textContent = leaderFilter === 'all' ? '暂无符合长度范围的冷却记录。' : '暂无符合 Leader 身份筛选的记录；未确认身份不匹配，可取消筛选查看查询状态。'; rows.push(empty); }
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
  $('monitor-filter').addEventListener('change', () => { if (lastMonitorState) renderMonitor(lastMonitorState); });
  $('config-form').addEventListener('submit', async event => {
    event.preventDefault();
    const body = { minHits: $('min-hits').value, maxHits: $('max-hits').value, intervalSeconds: $('interval').value, apiIntervalSeconds: $('api-interval').value, bonusHits: Array.from($('bonus-options').querySelectorAll('input:checked'), input => Number(input.value)), leaderFilter: $('leader-filter').value };
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
