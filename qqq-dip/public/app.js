const EVENT_LABELS = {
  T1: 'T1', T2: 'T2', T3: 'T3', T4: 'T4', T5: 'T5', T6: 'T6', T7: 'T7',
  R1: 'R1', R2: 'R2', T4_intraday: 'T4 盘中限价', takeProfit: '止盈',
  fakeRight: '假右侧', reset: '高点重置', openSummary: '开盘摘要',
  sleeveTqqq: 'TQQQ 袖仓', sleeveSoxl: 'SOXL 袖仓'
};

let state = {
  cash: { cashUsd: 0, cashCny: 0, usdCnyRate: 7.2 },
  settings: {},
  notify: { qq: {}, targets: [], events: {} },
  evaluation: null,
  monitor: {},
  actions: { items: [] },
  lots: [],
  tab: 'monitor'
};

function $(sel) { return document.querySelector(sel); }
function toast(type, msg) {
  const t = window.portalToast;
  if (t && typeof t[type] === 'function') t[type](String(msg));
  else if (type === 'error') console.error(msg);
}

async function api(path, opts = {}) {
  const res = await fetch('./api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtUsd(n) {
  if (!Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function fmtPct(n, digits = 2) {
  if (!Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
}

function pctClass(n) {
  if (!Number.isFinite(Number(n))) return '';
  return Number(n) >= 0 ? 'up' : 'down';
}

function holdingsHref() {
  if (location.pathname.includes('/stock-manage')) return '/stock-manage/';
  return 'http://127.0.0.1:5000/';
}

function dipHref(tab) {
  const underPortal = location.pathname.includes('/stock-manage/dip');
  const base = underPortal ? '/stock-manage/dip/' : './';
  return tab === 'qq' ? `${base}?tab=qq` : base;
}

function currentTab() {
  const q = new URLSearchParams(location.search).get('tab');
  return q === 'qq' ? 'qq' : 'monitor';
}

function renderTabs() {
  const tab = currentTab();
  $('#feature-tabs').innerHTML = `
    <a class="sm-feature-tab" href="${holdingsHref()}">持仓</a>
    <a class="sm-feature-tab ${tab === 'monitor' ? 'active' : ''}" href="${dipHref('monitor')}">抄底监控</a>
    <a class="sm-feature-tab ${tab === 'qq' ? 'active' : ''}" href="${dipHref('qq')}">QQ 提醒</a>
  `;
  $('#panel-monitor').hidden = tab !== 'monitor';
  $('#panel-qq').hidden = tab !== 'qq';
  state.tab = tab;
  document.title = tab === 'qq' ? 'QQ 提醒' : '抄底监控';
}

function statusLabel(s) {
  return {
    confirmed: '已触发',
    intraday: '盘中触及',
    executed: '已执行',
    locked: '锁定',
    frozen: '冻结',
    void: '已作废',
    idle: '未到'
  }[s] || s || '—';
}

function applyState(data) {
  if (data.cash) state.cash = data.cash;
  if (data.settings) state.settings = data.settings;
  if (data.notify) state.notify = data.notify;
  if (data.evaluation) state.evaluation = data.evaluation;
  if (data.monitor) state.monitor = data.monitor;
  if (data.actions) state.actions = data.actions;
  if (data.lots) state.lots = data.lots;
  if (data.market && state.monitor) state.monitor.market = data.market;
  render();
}

function renderMarket() {
  const m = state.monitor?.market || {};
  const pill = $('#market-pill');
  pill.textContent = `${m.label || '—'} · ${m.clock || ''} ET`;
  pill.classList.toggle('open', !!m.rth);
  const running = !!state.monitor?.running;
  $('#btn-monitor-toggle').textContent = running ? '停止监听' : '开始监听';
  const err = state.evaluation?.quoteErrors;
  const line = $('#error-line');
  if (err && Object.keys(err).length) {
    line.hidden = false;
    line.textContent = Object.entries(err).map(([k, v]) => `${k}: ${v}`).join('；');
  } else if (state.monitor?.lastError && typeof state.monitor.lastError === 'string') {
    line.hidden = false;
    line.textContent = state.monitor.lastError;
  } else {
    line.hidden = true;
  }
  $('#monitor-hint').textContent = running
    ? `监听中 · 已检查 ${state.monitor.checks || 0} 次。弹药与持仓现金互不影响。`
    : '规则来自 QQQ 抄底手册。不是投资建议。开盘时段可点「开始监听」做服务端轮询与 QQ 推送。';
}

function renderAmmo() {
  const active = document.activeElement;
  if (active && ['cash-usd', 'cash-cny', 'cash-fx'].includes(active.id)) return;
  const ev = state.evaluation;
  const c = state.cash;
  const B = ev?.B ?? 0;
  const bags = ev?.bags;
  const rem = ev?.remaining;
  $('#ammo-cards').innerHTML = `
    <div class="sm-summary-card"><div class="label">美元现金</div>
      <input type="number" step="0.01" id="cash-usd" value="${c.cashUsd ?? 0}"></div>
    <div class="sm-summary-card"><div class="label">人民币现金</div>
      <input type="number" step="0.01" id="cash-cny" value="${c.cashCny ?? 0}"></div>
    <div class="sm-summary-card"><div class="label">USD/CNY 汇率</div>
      <input type="number" step="0.0001" id="cash-fx" value="${c.usdCnyRate ?? 7.2}">
      <button type="button" class="btn link" id="btn-fx">填充参考汇率</button></div>
    <div class="sm-summary-card"><div class="label">弹药 B</div><div class="value">${fmtUsd(B)}</div>
      <div class="hint">${state.settings.variant === 'vBoost' ? 'V 型加强 55/20/25' : '默认 40/30/30'}</div></div>
    <div class="sm-summary-card"><div class="label">左侧剩余</div><div class="value">${fmtUsd(rem?.left)}</div>
      <div class="hint">袋 ${fmtUsd(bags?.left)}</div></div>
    <div class="sm-summary-card"><div class="label">危机剩余</div><div class="value">${fmtUsd(rem?.crisis)}</div>
      <div class="hint">袋 ${fmtUsd(bags?.crisis)}</div></div>
    <div class="sm-summary-card"><div class="label">右侧剩余</div><div class="value">${fmtUsd(rem?.right)}</div>
      <div class="hint">袋 ${fmtUsd(bags?.right)}</div></div>
    <div class="sm-summary-card"><div class="label">VXN</div>
      <div class="value">${ev?.vxn != null ? ev.vxn.toFixed(2) : '—'}</div>
      <div class="hint">T2≥25 ${ev?.vxnGates?.t2?.ok ? '过' : '未过'} · T3≥32 ${ev?.vxnGates?.t3?.ok ? '过' : '未过'}</div></div>
    <div class="sm-summary-card"><div class="label">规则</div>
      <label class="hint"><input type="checkbox" id="opt-vboost" ${state.settings.variant === 'vBoost' ? 'checked' : ''}> V 型加强 55/20/25</label>
      <label class="hint"><input type="checkbox" id="opt-soxl" ${state.settings.soxlEnabled ? 'checked' : ''}> 启用 SOXL 芯片观点</label>
      <label class="hint"><input type="checkbox" id="opt-spy" ${state.settings.showSpy !== false ? 'checked' : ''}> 显示 SPY</label></div>
  `;
  bindCash();
}

function bindCash() {
  const save = async () => {
    try {
      const data = await api('/cash', {
        method: 'PUT',
        body: {
          cashUsd: Number($('#cash-usd').value),
          cashCny: Number($('#cash-cny').value),
          usdCnyRate: Number($('#cash-fx').value)
        }
      });
      applyState(data);
      toast('success', '现金已保存');
    } catch (e) { toast('error', e.message); }
  };
  ['cash-usd', 'cash-cny', 'cash-fx'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el || el.dataset.bound) return;
    el.dataset.bound = '1';
    el.addEventListener('change', save);
  });
  const fxBtn = $('#btn-fx');
  if (fxBtn && !fxBtn.dataset.bound) {
    fxBtn.dataset.bound = '1';
    fxBtn.addEventListener('click', async () => {
      try {
        const fx = await api('/fx');
        $('#cash-fx').value = fx.rate;
        await save();
      } catch (e) { toast('error', e.message); }
    });
  }
  const saveSettings = async () => {
    try {
      const data = await api('/settings', {
        method: 'PUT',
        body: {
          variant: $('#opt-vboost')?.checked ? 'vBoost' : 'default',
          soxlEnabled: !!$('#opt-soxl')?.checked,
          showSpy: $('#opt-spy') ? $('#opt-spy').checked : true
        }
      });
      applyState(data);
    } catch (e) { toast('error', e.message); }
  };
  ['opt-vboost', 'opt-soxl', 'opt-spy'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el || el.dataset.bound) return;
    el.dataset.bound = '1';
    el.addEventListener('change', saveSettings);
  });
}

function renderPrimary() {
  const p = state.evaluation?.primary;
  if (!p) {
    $('#primary-rec').innerHTML = '<p class="hint">暂无推荐。配置 API Key 后刷新行情。</p>';
    return;
  }
  const prohib = (p.prohibitions || []).map((x) => `<li>${escapeHtml(x)}</li>`).join('');
  $('#primary-rec').innerHTML = `
    <h3>${escapeHtml(p.title)}</h3>
    <p>${escapeHtml(p.body)}</p>
    ${prohib ? `<ul>${prohib}</ul>` : ''}
  `;
}

function symbolRow(label, stats) {
  if (!stats) return '';
  const next = stats.triggers?.T1;
  return `<tr>
    <td>${label}</td>
    <td>${stats.price != null ? stats.price.toFixed(2) : '—'}</td>
    <td class="${pctClass(stats.changePercent)}">${fmtPct(stats.changePercent)}</td>
    <td class="${pctClass(stats.drawdownLive)}">${fmtPct(stats.drawdownLive)}</td>
    <td>H ${stats.H != null ? stats.H.toFixed(2) : '—'} · T1 ${next != null ? next : '—'}</td>
  </tr>`;
}

function renderSymbols() {
  const ev = state.evaluation || {};
  $('#symbol-table tbody').innerHTML = [
    symbolRow('QQQ', ev.qqq),
    symbolRow('SPY', ev.spy),
    symbolRow('TQQQ', ev.tqqq),
    symbolRow('SOXL', ev.soxl)
  ].join('');
  const leaps = ev.leaps;
  const contracts = (ev.suggestedContracts || []).slice(0, 6)
    .map((c) => `${c.expiry} ${c.strike}C`).join(' · ');
  $('#leap-hint').textContent = leaps?.medium
    ? `中虚值行权价约 ${leaps.medium.low}–${leaps.medium.high}；1 月 LEAP：${(leaps.expiries || []).map((x) => x.expiry).join(' / ') || '—'}。${contracts ? `链上有量参考：${contracts}` : ''}`
    : '';
}

function renderTiers() {
  const tiers = state.evaluation?.tiers || [];
  $('#tier-table tbody').innerHTML = tiers.map((t) => `
    <tr>
      <td>${t.id}</td>
      <td>${t.bag}</td>
      <td>${t.triggerPrice ?? '—'}${t.intradayPrice ? ` / 盘中 ${t.intradayPrice}` : ''}</td>
      <td>${(t.pctB * 100).toFixed(0)}%</td>
      <td>${fmtUsd(t.usd)}</td>
      <td class="st-${t.status}">${statusLabel(t.status)}</td>
      <td>${t.status === 'confirmed' || t.status === 'intraday'
        ? `<button class="btn link" data-exec="${t.id}">标记已执行</button>` : ''}</td>
    </tr>
  `).join('');
}

function renderLots() {
  const lots = state.evaluation?.lots || state.lots || [];
  $('#lot-table tbody').innerHTML = lots.length ? lots.map((lot) => `
    <tr>
      <td>${escapeHtml(lot.symbol || '')}</td>
      <td>${lot.type === 'call' ? 'Call' : '正股'}</td>
      <td>${fmtUsd(lot.cost)}</td>
      <td>${lot.mark != null ? fmtUsd(lot.mark) : '—'}</td>
      <td>${lot.multiple != null ? lot.multiple.toFixed(2) + '×' : '—'}</td>
      <td>${(lot.alerts || []).map((a) => a.action).join('；') || '—'}</td>
      <td><button class="btn link danger" data-del-lot="${lot.id}">删除</button></td>
    </tr>
  `).join('') : '<tr><td colspan="7" class="hint">还没有登记抄底仓位</td></tr>';
}

function renderActions() {
  const filter = $('#action-filter')?.value || 'all';
  const items = (state.actions?.items || []).filter((a) => {
    if (filter === 'auto') return a.source === 'auto';
    if (filter === 'user') return a.source === 'user';
    return true;
  });
  $('#action-list').innerHTML = items.length ? items.map((a) => `
    <div class="sm-action">
      <div class="meta">${escapeHtml(a.ts)} · ${escapeHtml(a.source)} · ${escapeHtml(a.type)}${a.tier ? ' · ' + escapeHtml(a.tier) : ''}</div>
      <div>${escapeHtml(a.message)}</div>
    </div>
  `).join('') : '<p class="hint">暂无操作记录</p>';
}

function defaultTarget() {
  return {
    id: 't-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    type: 'group',
    groupId: '',
    atUserId: '',
    userId: ''
  };
}

function renderQq() {
  if (state.tab !== 'qq') return;
  const active = document.activeElement;
  if (active && $('#panel-qq')?.contains(active) && active.tagName !== 'BUTTON') return;
  const n = state.notify || {};
  const qq = n.qq || {};
  $('#qq-enabled').checked = qq.enabled !== false;
  $('#auto-start').checked = !!state.settings.autoStart;
  $('#qq-url').value = qq.url || 'http://127.0.0.1:8787/notify';
  if (!$('#qq-token').dataset.filled) {
    $('#qq-token').placeholder = qq.hasToken ? `已保存 ${qq.token}` : '与 qq-bot notifyToken 一致';
  }
  $('#interval-sec').value = state.settings.intervalSeconds || 30;
  const targets = n.targets?.length ? n.targets : [defaultTarget()];
  $('#qq-targets').innerHTML = targets.map((t, i) => {
    const isGroup = t.type !== 'private';
    return `
      <div class="notify-target" data-target-id="${escapeHtml(t.id)}">
        <div class="notify-target-head"><span>通知方式 ${i + 1}</span>
          <button type="button" class="btn sm-btn-sm danger" data-remove-target="${escapeHtml(t.id)}">删除</button></div>
        <div class="sm-grid">
          <label class="field">类型
            <select data-field="targetType">
              <option value="group" ${isGroup ? 'selected' : ''}>群聊</option>
              <option value="private" ${!isGroup ? 'selected' : ''}>私聊</option>
            </select>
          </label>
          <label class="field"${isGroup ? '' : ' hidden'}>群号
            <input data-field="groupId" value="${escapeHtml(t.groupId || '')}">
          </label>
          <label class="field"${isGroup ? '' : ' hidden'}>@ QQ 号（留空直接发）
            <input data-field="atUserId" value="${escapeHtml(t.atUserId || '')}">
          </label>
          <label class="field" ${isGroup ? 'hidden' : ''}>私聊 QQ 号
            <input data-field="userId" value="${escapeHtml(t.userId || '')}">
          </label>
        </div>
      </div>`;
  }).join('');
  const events = n.events || {};
  $('#event-checks').innerHTML = Object.keys(EVENT_LABELS).map((k) => `
    <label><input type="checkbox" data-event="${k}" ${events[k] !== false ? 'checked' : ''}> ${EVENT_LABELS[k]}</label>
  `).join('');
  const m = state.monitor || {};
  $('#qq-monitor-status').textContent = `${m.running ? '监听中' : '已停止'} · ${(m.market && m.market.label) || ''} · 检查 ${m.checks || 0} 次`;
}

function collectNotify() {
  const targets = Array.from(document.querySelectorAll('#qq-targets .notify-target')).map((row) => ({
    id: row.dataset.targetId,
    type: row.querySelector('[data-field="targetType"]').value,
    groupId: row.querySelector('[data-field="groupId"]').value.trim(),
    atUserId: row.querySelector('[data-field="atUserId"]').value.trim(),
    userId: row.querySelector('[data-field="userId"]').value.trim()
  }));
  const events = {};
  document.querySelectorAll('[data-event]').forEach((el) => {
    events[el.dataset.event] = el.checked;
  });
  const token = $('#qq-token').value.trim();
  return {
    qq: {
      enabled: $('#qq-enabled').checked,
      url: $('#qq-url').value.trim(),
      token
    },
    targets,
    events
  };
}

function render() {
  renderTabs();
  renderMarket();
  renderAmmo();
  renderPrimary();
  renderSymbols();
  renderTiers();
  renderLots();
  renderActions();
  if (state.tab === 'qq') renderQq();
}

function openModal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="sm-modal-backdrop"><div class="sm-modal">${html}</div></div>`;
  root.querySelector('[data-close]')?.addEventListener('click', () => { root.innerHTML = ''; });
  root.querySelector('.sm-modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target.classList.contains('sm-modal-backdrop')) root.innerHTML = '';
  });
  return root;
}

function bind() {
  $('#btn-refresh').addEventListener('click', async () => {
    try {
      const data = await api('/quotes/refresh', { method: 'POST' });
      applyState({ evaluation: data.evaluation, monitor: data.monitor });
      toast('success', '已刷新');
    } catch (e) { toast('error', e.message); }
  });
  $('#btn-monitor-toggle').addEventListener('click', async () => {
    try {
      const running = !!state.monitor?.running;
      const data = await api(running ? '/monitor/stop' : '/monitor/start', { method: 'POST' });
      state.monitor = data.monitor;
      render();
    } catch (e) { toast('error', e.message); }
  });
  $('#btn-qq-start').addEventListener('click', async () => {
    try {
      const data = await api('/monitor/start', { method: 'POST' });
      state.monitor = data.monitor;
      render();
    } catch (e) { toast('error', e.message); }
  });
  $('#btn-qq-stop').addEventListener('click', async () => {
    try {
      const data = await api('/monitor/stop', { method: 'POST' });
      state.monitor = data.monitor;
      render();
    } catch (e) { toast('error', e.message); }
  });
  $('#action-filter').addEventListener('change', renderActions);
  $('#tier-table').addEventListener('click', async (e) => {
    const id = e.target.dataset.exec;
    if (!id) return;
    const tier = (state.evaluation?.tiers || []).find((t) => t.id === id);
    openModal(`
      <h3>标记 ${id} 已执行</h3>
      <label class="field">动用美元<input id="exec-usd" type="number" step="0.01" value="${tier?.usd ?? 0}"></label>
      <label class="field">备注<input id="exec-note" type="text" placeholder="券商单号 / 合约"></label>
      <div class="sm-modal-actions">
        <button class="btn ghost" data-close>取消</button>
        <button class="btn primary" id="exec-ok">确认</button>
      </div>
    `);
    $('#exec-ok').addEventListener('click', async () => {
      try {
        const data = await api('/actions', {
          method: 'POST',
          body: {
            type: 'execute',
            tier: id,
            usd: Number($('#exec-usd').value),
            note: $('#exec-note').value,
            message: `已执行 ${id}，动用 $${Number($('#exec-usd').value).toFixed(2)}`
          }
        });
        $('#modal-root').innerHTML = '';
        applyState(data);
        toast('success', '已记录');
      } catch (err) { toast('error', err.message); }
    });
  });
  $('#btn-add-note').addEventListener('click', () => {
    openModal(`
      <h3>手动记录</h3>
      <label class="field">内容<textarea id="note-text" rows="3"></textarea></label>
      <div class="sm-modal-actions">
        <button class="btn ghost" data-close>取消</button>
        <button class="btn primary" id="note-ok">保存</button>
      </div>
    `);
    $('#note-ok').addEventListener('click', async () => {
      try {
        const data = await api('/actions', { method: 'POST', body: { type: 'note', message: $('#note-text').value } });
        $('#modal-root').innerHTML = '';
        applyState(data);
      } catch (err) { toast('error', err.message); }
    });
  });
  $('#btn-add-lot').addEventListener('click', () => {
    openModal(`
      <h3>登记抄底仓位</h3>
      <div class="sm-grid">
        <label class="field">代码<input id="lot-sym" placeholder="QQQ 或 QQQ270115C00700000"></label>
        <label class="field">类型<select id="lot-type"><option value="equity">正股</option><option value="call">Call</option></select></label>
        <label class="field">成本<input id="lot-cost" type="number" step="0.01"></label>
        <label class="field">数量<input id="lot-qty" type="number" step="1" value="1"></label>
        <label class="field">档位<input id="lot-tier" placeholder="T2"></label>
        <label class="field">虚值分类<select id="lot-otm">
          <option value="">正股</option>
          <option value="medium">中虚值</option>
          <option value="deep">深虚值</option>
          <option value="shallow">浅虚值</option>
        </select></label>
        <label class="field">行权价<input id="lot-strike" type="number" step="0.5"></label>
        <label class="field">到期<input id="lot-exp" type="date"></label>
      </div>
      <div class="sm-modal-actions">
        <button class="btn ghost" data-close>取消</button>
        <button class="btn primary" id="lot-ok">保存</button>
      </div>
    `);
    $('#lot-ok').addEventListener('click', async () => {
      try {
        const data = await api('/lots', {
          method: 'POST',
          body: {
            symbol: $('#lot-sym').value.trim().toUpperCase(),
            type: $('#lot-type').value,
            cost: Number($('#lot-cost').value),
            qty: Number($('#lot-qty').value) || 1,
            tier: $('#lot-tier').value,
            otmClass: $('#lot-otm').value || ( $('#lot-type').value === 'call' ? 'medium' : 'equity'),
            strike: Number($('#lot-strike').value) || undefined,
            expiry: $('#lot-exp').value || undefined,
            openedAt: new Date().toISOString()
          }
        });
        $('#modal-root').innerHTML = '';
        applyState(data);
      } catch (err) { toast('error', err.message); }
    });
  });
  $('#lot-table').addEventListener('click', async (e) => {
    const id = e.target.dataset.delLot;
    if (!id) return;
    try {
      const data = await api('/lots/' + id, { method: 'DELETE' });
      applyState(data);
    } catch (err) { toast('error', err.message); }
  });
  $('#btn-add-target').addEventListener('click', () => {
    const n = collectNotify();
    n.targets.push(defaultTarget());
    state.notify = { ...state.notify, ...n, qq: { ...state.notify.qq, ...n.qq } };
    renderQq();
  });
  $('#qq-targets').addEventListener('click', (e) => {
    const id = e.target.dataset.removeTarget;
    if (!id) return;
    const n = collectNotify();
    n.targets = n.targets.filter((t) => t.id !== id);
    if (!n.targets.length) n.targets.push(defaultTarget());
    state.notify = { ...state.notify, ...n };
    renderQq();
  });
  $('#qq-targets').addEventListener('change', (e) => {
    if (e.target.dataset.field !== 'targetType') return;
    const row = e.target.closest('.notify-target');
    const isGroup = e.target.value === 'group';
    row.querySelector('[data-field="groupId"]').closest('.field').hidden = !isGroup;
    row.querySelector('[data-field="atUserId"]').closest('.field').hidden = !isGroup;
    row.querySelector('[data-field="userId"]').closest('.field').hidden = isGroup;
  });
  $('#btn-save-qq').addEventListener('click', async () => {
    try {
      const notify = collectNotify();
      const nres = await api('/notify', { method: 'PUT', body: notify });
      const sres = await api('/settings', {
        method: 'PUT',
        body: {
          autoStart: $('#auto-start').checked,
          intervalSeconds: Number($('#interval-sec').value) || 30
        }
      });
      applyState({ notify: nres.notify, settings: sres.settings, evaluation: sres.evaluation });
      toast('success', '已保存');
    } catch (e) { toast('error', e.message); }
  });
  $('#btn-test-qq').addEventListener('click', async () => {
    try {
      await api('/notify', { method: 'PUT', body: collectNotify() });
      const r = await api('/notify/test', { method: 'POST' });
      toast('success', '已发送：' + (r.targets || []).join('，'));
    } catch (e) { toast('error', e.message); }
  });
}

function connectSse() {
  try {
    const es = new EventSource('./api/events');
    es.addEventListener('state', (ev) => {
      try { applyState(JSON.parse(ev.data)); } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
}

async function init() {
  renderTabs();
  bind();
  try {
    applyState(await api('/state'));
  } catch (e) {
    $('#error-line').hidden = false;
    $('#error-line').textContent = e.message;
  }
  connectSse();
}

init();
