import { loadPortalContext, can, isPortalMode } from './js/portal-auth.js';

const EVENT_LABELS = {
  T1: 'T1', T2: 'T2', T3: 'T3', T4: 'T4', T5: 'T5', T6: 'T6', T7: 'T7',
  R1: 'R1', R2: 'R2', T4_intraday: 'T4 盘中限价', takeProfit: '止盈',
  fakeRight: '假右侧', reset: '高点重置', openSummary: '开盘摘要（每交易日首检）',
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

function fmtPctB(pctB) {
  const pct = (Number(pctB) || 0) * 100;
  const rounded = Math.round(pct * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

const MONEY_MASK = '••••••';

function canViewLotMoney() {
  if (!isPortalMode()) return true;
  return can('lots') || can('lots-edit', 'edit');
}

function maskMoney(html) {
  return canViewLotMoney() ? html : `<span class="sm-mask">${MONEY_MASK}</span>`;
}

function maskMoneyText(text) {
  return canViewLotMoney() ? text : MONEY_MASK;
}

function fmtPct(n, digits = 2) {
  if (!Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
}

function fmtFxHint(cash) {
  if (!cash?.fxUpdatedAt) return '打开页面或刷新行情时自动更新';
  const src = cash.fxSource === 'manual' ? '手动' : (cash.fxSource || '自动');
  const ts = Date.parse(cash.fxUpdatedAt);
  if (!Number.isFinite(ts)) return `${src}更新`;
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return `${src} · ${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${src} · ${hours} 小时前`;
  const days = Math.round(hours / 24);
  return `${src} · ${days} 天前`;
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
  const showMonitor = can('tab-monitor');
  const showQq = can('tab-qq');
  let tabsHtml = `<a class="sm-feature-tab" href="${holdingsHref()}">持仓</a>`;
  if (showMonitor) {
    tabsHtml += `<a class="sm-feature-tab ${tab === 'monitor' ? 'active' : ''}" href="${dipHref('monitor')}">抄底监控</a>`;
  }
  if (showQq) {
    tabsHtml += `<a class="sm-feature-tab ${tab === 'qq' ? 'active' : ''}" href="${dipHref('qq')}">QQ 提醒</a>`;
  }
  $('#feature-tabs').innerHTML = tabsHtml;
  if (!showMonitor && !showQq) {
    $('#panel-monitor').hidden = true;
    $('#panel-qq').hidden = true;
    const line = $('#error-line');
    if (line) {
      line.hidden = false;
      line.textContent = '无权访问抄底监控，请联系管理员在权限管理中分配 Tab 权限。';
    }
    return;
  }
  if (tab === 'monitor' && !showMonitor && showQq) {
    location.replace(dipHref('qq'));
    return;
  }
  if (tab === 'qq' && !showQq && showMonitor) {
    location.replace(dipHref('monitor'));
    return;
  }
  $('#panel-monitor').hidden = tab !== 'monitor' || !showMonitor;
  $('#panel-qq').hidden = tab !== 'qq' || !showQq;
  state.tab = tab;
  document.title = tab === 'qq' ? 'QQ 提醒' : '抄底监控';
}

function applyPermissions() {
  if (!isPortalMode()) return;

  const cashEditable = canViewLotMoney() && can('cash', 'edit');
  ['cash-usd', 'cash-cny', 'cash-fx'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.readOnly = !cashEditable;
  });
  const fxBtn = $('#btn-fx');
  if (fxBtn) fxBtn.hidden = !cashEditable;

  $('#btn-refresh')?.toggleAttribute('hidden', !can('refresh', 'edit'));
  $('#btn-monitor-toggle')?.toggleAttribute('hidden', !can('monitor-control', 'edit'));
  document.querySelectorAll('[data-doc]').forEach((el) => {
    el.toggleAttribute('hidden', !can('docs'));
  });

  if (!can('buy-preview') || !canViewLotMoney()) {
    $('#primary-actions')?.replaceChildren();
  }

  const canEditLots = can('lots-edit', 'edit');
  $('#btn-add-lot')?.classList.toggle('hidden', !canEditLots);
  // 仓位表始终可进；无查看权限时数字脱敏（见 renderLots）
  document.querySelectorAll('[data-perm-panel="lots"]').forEach((el) => {
    el.classList.remove('hidden');
    el.hidden = false;
  });

  const canViewActions = can('actions') || can('actions-note', 'edit');
  document.querySelectorAll('[data-perm-panel="actions"]').forEach((el) => {
    el.classList.toggle('hidden', !canViewActions);
    el.hidden = !canViewActions;
  });
  $('#btn-add-note')?.classList.toggle('hidden', !can('actions-note', 'edit'));
  if (!canViewActions) $('#action-list')?.replaceChildren();

  ['opt-vboost', 'opt-soxl', 'opt-spy'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = !can('settings', 'edit');
  });

  if ($('#panel-qq') && !$('#panel-qq').hidden) {
    $('#btn-save-qq')?.toggleAttribute('hidden', !can('qq-save', 'edit'));
    $('#btn-test-qq')?.toggleAttribute('hidden', !can('qq-test', 'edit'));
    $('#btn-qq-start')?.toggleAttribute('hidden', !can('qq-monitor', 'edit'));
    $('#btn-qq-stop')?.toggleAttribute('hidden', !can('qq-monitor', 'edit'));
    const qqReadonly = !can('qq-save', 'edit');
    ['qq-enabled', 'auto-start', 'qq-url', 'qq-token', 'interval-sec'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.type === 'checkbox') el.disabled = qqReadonly;
      else el.readOnly = qqReadonly;
    });
    $('#btn-add-target')?.toggleAttribute('hidden', qqReadonly);
    $('#qq-targets')?.querySelectorAll('[data-remove-target]').forEach((el) => {
      el.toggleAttribute('hidden', qqReadonly);
    });
    $('#event-checks')?.querySelectorAll('input').forEach((el) => {
      el.disabled = qqReadonly;
    });
  }
}

function guardEdit(feature, action = 'edit') {
  if (!can(feature, action)) {
    toast('error', '无权执行此操作');
    return false;
  }
  return true;
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
    : '规则来自 QQQ 抄底手册。不是投资建议。可点「手册速查」或「操作手册」预览完整文档。';
}

function renderAmmo() {
  const active = document.activeElement;
  if (active && ['cash-usd', 'cash-cny', 'cash-fx'].includes(active.id)) return;
  const ev = state.evaluation;
  const c = state.cash;
  const B = ev?.B ?? 0;
  const bags = ev?.bags;
  const rem = ev?.remaining;
  const showMoney = canViewLotMoney();
  const cashUsdField = showMoney
    ? `<input type="number" step="0.01" id="cash-usd" value="${c.cashUsd ?? 0}">`
    : `<div class="value sm-mask">${MONEY_MASK}</div>`;
  const cashCnyField = showMoney
    ? `<input type="number" step="0.01" id="cash-cny" value="${c.cashCny ?? 0}">`
    : `<div class="value sm-mask">${MONEY_MASK}</div>`;
  $('#ammo-cards').innerHTML = `
    <div class="sm-summary-card"><div class="label">美元现金</div>
      ${cashUsdField}</div>
    <div class="sm-summary-card"><div class="label">人民币现金</div>
      ${cashCnyField}</div>
    <div class="sm-summary-card"><div class="label">USD/CNY 汇率</div>
      <input type="number" step="0.0001" id="cash-fx" value="${c.usdCnyRate ?? 7.2}">
      <div class="hint" id="fx-hint">${escapeHtml(fmtFxHint(c))}</div>
      <button type="button" class="btn link" id="btn-fx">立即刷新汇率</button></div>
    <div class="sm-summary-card"><div class="label">弹药 B</div><div class="value">${maskMoney(fmtUsd(B))}</div>
      <div class="hint">${state.settings.variant === 'vBoost' ? 'V 型加强 55/20/25' : '默认 40/30/30'}</div></div>
    <div class="sm-summary-card"><div class="label">左侧剩余</div><div class="value">${maskMoney(fmtUsd(rem?.left))}</div>
      <div class="hint">袋 ${maskMoneyText(fmtUsd(bags?.left))}</div></div>
    <div class="sm-summary-card"><div class="label">危机剩余</div><div class="value">${maskMoney(fmtUsd(rem?.crisis))}</div>
      <div class="hint">袋 ${maskMoneyText(fmtUsd(bags?.crisis))}</div></div>
    <div class="sm-summary-card"><div class="label">右侧剩余</div><div class="value">${maskMoney(fmtUsd(rem?.right))}</div>
      <div class="hint">袋 ${maskMoneyText(fmtUsd(bags?.right))}</div></div>
    <div class="sm-summary-card"><div class="label">VXN</div>
      <div class="value">${ev?.vxn != null ? ev.vxn.toFixed(2) : '—'}</div>
      <div class="hint">T2≥25 ${ev?.vxnGates?.t2?.ok ? '过' : '未过'} · T3≥32 ${ev?.vxnGates?.t3?.ok ? '过' : '未过'}${state.quotes?.VXN?.asOf ? ` · 收盘 ${state.quotes.VXN.asOf}` : ''}</div></div>
    <div class="sm-summary-card"><div class="label">规则</div>
      <label class="hint"><input type="checkbox" id="opt-vboost" ${state.settings.variant === 'vBoost' ? 'checked' : ''}> V 型加强 55/20/25</label>
      <label class="hint"><input type="checkbox" id="opt-soxl" ${state.settings.soxlEnabled ? 'checked' : ''}> 启用 SOXL 芯片观点</label>
      <label class="hint"><input type="checkbox" id="opt-spy" ${state.settings.showSpy !== false ? 'checked' : ''}> 显示 SPY</label></div>
  `;
  bindCash();
}

function bindCash() {
  const save = async () => {
    if (!canViewLotMoney()) {
      toast('error', '无权查看弹药现金');
      return;
    }
    if (!can('cash', 'edit')) {
      toast('error', '无权修改弹药现金');
      return;
    }
    try {
      const data = await api('/cash', {
        method: 'PUT',
        body: {
          cashUsd: Number($('#cash-usd')?.value),
          cashCny: Number($('#cash-cny')?.value),
          usdCnyRate: Number($('#cash-fx')?.value)
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
        if (!canViewLotMoney() || !can('cash', 'edit')) {
          toast('error', '无权修改弹药现金');
          return;
        }
        const fx = await api('/fx');
        const data = await api('/cash', {
          method: 'PUT',
          body: {
            cashUsd: Number($('#cash-usd')?.value),
            cashCny: Number($('#cash-cny')?.value),
            usdCnyRate: fx.rate,
            fxSource: fx.source,
            fxUpdatedAt: new Date().toISOString()
          }
        });
        applyState(data);
        toast('success', `汇率已更新 ${fx.rate}（${fx.source || '自动'}）`);
      } catch (e) { toast('error', e.message); }
    });
  }
  const saveSettings = async () => {
    if (!can('settings', 'edit')) {
      toast('error', '无权修改规则开关');
      return;
    }
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
      toast('success', '规则已更新');
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
  const preview = state.evaluation?.buyPreview;
  const actions = $('#primary-actions');
  if (preview?.available && can('buy-preview') && canViewLotMoney()) {
    actions.innerHTML = `<button type="button" class="btn primary sm-btn-sm" id="btn-buy-preview">预览买入</button>`;
  } else {
    actions.innerHTML = '';
  }
  if (!p) {
    $('#primary-rec').innerHTML = '<p class="hint">暂无推荐。配置 API Key 后刷新行情。</p>';
    return;
  }
  const prohib = (p.prohibitions || []).map((x) => `<li>${escapeHtml(x)}</li>`).join('');
  const previewHint = preview?.available && canViewLotMoney()
    ? `<p class="hint">本档预算 ${fmtUsd(preview.totalUsd)}，QQQ 现价 ${preview.spot?.toFixed(2) ?? '—'}。点「预览买入」查看拆单。</p>`
    : (preview?.reason ? `<p class="hint">${escapeHtml(preview.reason)}</p>` : '');
  $('#primary-rec').innerHTML = `
    <h3>${escapeHtml(p.title)}</h3>
    <p>${escapeHtml(p.body)}</p>
    ${previewHint}
    ${prohib ? `<ul>${prohib}</ul>` : ''}
  `;
}

function legRow(leg) {
  if (leg.kind === 'equity') {
    return `<tr>
      <td>正股</td>
      <td>${escapeHtml(leg.symbol)}</td>
      <td>买入</td>
      <td>${leg.pct}%</td>
      <td>${fmtUsd(leg.usd)}</td>
      <td>${leg.shares} 股 @ ${leg.price?.toFixed(2) ?? '—'}</td>
      <td>≈ ${fmtUsd(leg.estUsd)}</td>
      <td>${escapeHtml(leg.note || '')}</td>
    </tr>`;
  }
  return `<tr>
    <td>Call</td>
    <td>${escapeHtml(leg.occSymbol || leg.symbol)}</td>
    <td>买入</td>
    <td>${leg.pct}%</td>
    <td>${fmtUsd(leg.usd)}</td>
    <td>${leg.strike} / ${escapeHtml(leg.expiry || '—')}</td>
    <td>${leg.otmPct != null ? leg.otmPct.toFixed(1) + '% 虚值' : '—'}</td>
    <td>${escapeHtml(leg.note || '')}</td>
  </tr>`;
}

function openBuyPreview() {
  if (!guardEdit('buy-preview', 'view')) return;
  if (!canViewLotMoney()) {
    toast('error', '无权查看仓位金额');
    return;
  }
  const preview = state.evaluation?.buyPreview;
  if (!preview?.available) {
    toast('error', preview?.reason || '当前无法预览买入');
    return;
  }
  const notes = (preview.notes || []).map((n) => `<li>${escapeHtml(n)}</li>`).join('');
  const checklist = (preview.checklist || []).map((n) => `<li>${escapeHtml(n)}</li>`).join('');
  const prohib = (preview.prohibitions || []).map((n) => `<li>${escapeHtml(n)}</li>`).join('');
  const legs = (preview.legs || []).map(legRow).join('');
  const summary = [
    preview.title,
    `预算 ${fmtUsd(preview.totalUsd)}`,
    `QQQ ${preview.spot?.toFixed(2) ?? '—'}`,
    preview.pendingClose ? '待收盘确认' : null
  ].filter(Boolean).join(' · ');

  openModal(`
    <div class="sm-modal sm-modal--buy">
      <h3>${escapeHtml(summary)}</h3>
      <p class="hint">${escapeHtml(preview.recommendation || '')}</p>
      ${notes ? `<ul class="sm-buy-notes">${notes}</ul>` : ''}
      <div class="sm-table-wrap">
        <table class="sm-table sm-buy-table">
          <thead>
            <tr>
              <th>类型</th><th>标的</th><th>方向</th><th>占比</th><th>预算</th><th>数量/合约</th><th>参考</th><th>说明</th>
            </tr>
          </thead>
          <tbody>${legs}</tbody>
        </table>
      </div>
      ${checklist ? `<h4>下单前核对</h4><ul class="sm-buy-checklist">${checklist}</ul>` : ''}
      ${prohib ? `<h4>禁令</h4><ul>${prohib}</ul>` : ''}
      <p class="hint">期权张数需按实际买卖价重算；有 Polygon 链上合约时会填入 OCC 代码。</p>
      <div class="sm-modal-actions">
        <button type="button" class="btn ghost" id="btn-copy-buy">复制清单</button>
        ${preview.tier ? `<button type="button" class="btn ghost" data-exec-preview="${escapeHtml(preview.tier)}">标记已执行</button>` : ''}
        <button type="button" class="btn primary" data-close>关闭</button>
      </div>
    </div>
  `);

  $('#btn-copy-buy')?.addEventListener('click', async () => {
    const lines = [
      summary,
      '',
      ...(preview.legs || []).map((leg) => {
        if (leg.kind === 'equity') {
          return `${leg.symbol} 正股 买入 ${leg.shares}股 预算${fmtUsd(leg.usd)} @${leg.price?.toFixed(2)}`;
        }
        return `${leg.occSymbol || leg.symbol} Call 买入 预算${fmtUsd(leg.usd)} K${leg.strike} 到期${leg.expiry}`;
      }),
      '',
      '核对:',
      ...(preview.checklist || [])
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast('success', '已复制买入清单');
    } catch {
      toast('error', '复制失败');
    }
  });

  const execBtn = document.querySelector('[data-exec-preview]');
  execBtn?.addEventListener('click', () => {
    const tierId = execBtn.getAttribute('data-exec-preview');
    $('#modal-root').innerHTML = '';
    const tier = (state.evaluation?.tiers || []).find((t) => t.id === tierId);
    openModal(`
      <h3>标记 ${tierId} 已执行</h3>
      <label class="field">动用美元<input id="exec-usd" type="number" step="0.01" value="${tier?.usd ?? preview.totalUsd ?? 0}"></label>
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
            tier: tierId,
            usd: Number($('#exec-usd').value),
            note: $('#exec-note').value,
            message: `已执行 ${tierId}，动用 $${Number($('#exec-usd').value).toFixed(2)}`
          }
        });
        $('#modal-root').innerHTML = '';
        applyState(data);
        toast('success', '已记录');
      } catch (err) { toast('error', err.message); }
    });
  });
}

function sleeveBySymbol(symbol) {
  return (state.evaluation?.sleeves || []).find((s) => s.symbol === symbol) || null;
}

function nextLevelHint(label, stats) {
  if (!stats?.H) return '—';
  const H = stats.H;
  const hTxt = `H ${H.toFixed(2)}`;
  if (label === 'QQQ') {
    const next = stats.triggers?.T1;
    return `${hTxt} · T1(−8%) ${next != null ? next : '—'}`;
  }
  if (label === 'SPY') {
    return `${hTxt} · 非独立梯子（最多可作 QQQ T1 的 20% 降波）`;
  }
  if (label === 'TQQQ') {
    const sleeve = sleeveBySymbol('TQQQ');
    const t35 = sleeve?.trigger35 ?? roundMoneyClient(H * 0.65);
    const t50 = sleeve?.trigger50 ?? roundMoneyClient(H * 0.5);
    const dd = stats.drawdownLive;
    if (dd != null && dd <= -50) return `${hTxt} · 袖仓已到 −50%（上限档 ${t50}）`;
    if (dd != null && dd <= -35) return `${hTxt} · 下一袖仓 −50% ${t50}`;
    return `${hTxt} · 下一袖仓 −35% ${t35}`;
  }
  if (label === 'SOXL') {
    const sleeve = sleeveBySymbol('SOXL');
    const t50 = sleeve?.trigger50 ?? roundMoneyClient(H * 0.5);
    const t70 = sleeve?.trigger70 ?? roundMoneyClient(H * 0.3);
    const dd = stats.drawdownLive;
    if (!state.settings?.soxlEnabled) return `${hTxt} · 芯片观点未开`;
    if (dd != null && dd <= -70) return `${hTxt} · 袖仓已近 −70% 上限（${t70}）`;
    if (dd != null && dd <= -50) return `${hTxt} · 下一袖仓 −70% ${t70}`;
    return `${hTxt} · 下一袖仓 −50% ${t50}`;
  }
  return hTxt;
}

function roundMoneyClient(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function symbolRow(label, stats) {
  if (!stats) return '';
  return `<tr>
    <td>${label}</td>
    <td>${stats.price != null ? stats.price.toFixed(2) : '—'}</td>
    <td class="${pctClass(stats.changePercent)}">${fmtPct(stats.changePercent)}</td>
    <td class="${pctClass(stats.drawdownLive)}">${fmtPct(stats.drawdownLive)}</td>
    <td>${nextLevelHint(label, stats)}</td>
  </tr>`;
}

function renderSymbols() {
  const ev = state.evaluation || {};
  const rows = [symbolRow('QQQ', ev.qqq)];
  if (state.settings?.showSpy !== false) rows.push(symbolRow('SPY', ev.spy));
  rows.push(symbolRow('TQQQ', ev.tqqq));
  if (state.settings?.soxlEnabled) rows.push(symbolRow('SOXL', ev.soxl));
  $('#symbol-table tbody').innerHTML = rows.join('');
  const leaps = ev.leaps;
  const contracts = (ev.suggestedContracts || []).slice(0, 6)
    .map((c) => `${c.expiry} ${c.strike}C`).join(' · ');
  $('#leap-hint').textContent = leaps?.medium
    ? `中虚值行权价约 ${leaps.medium.low}–${leaps.medium.high}；1 月 LEAP：${(leaps.expiries || []).map((x) => x.expiry).join(' / ') || '—'}。${contracts ? `链上有量参考：${contracts}` : ''}`
    : '';
}

function bagLabel(bag) {
  return ({ left: '左侧', crisis: '危机', right: '右侧' })[bag] || bag || '—';
}

function renderTiers() {
  const tiers = state.evaluation?.tiers || [];
  $('#tier-table tbody').innerHTML = tiers.map((t) => {
    const action = t.recommendation || '—';
    const cond = t.triggerCondition || '—';
    return `
    <tr class="tier-row st-row-${escapeHtml(t.status || '')}">
      <td><strong>${escapeHtml(t.id)}</strong></td>
      <td>${escapeHtml(bagLabel(t.bag))}</td>
      <td class="tier-cond" title="${escapeHtml(cond)}">${escapeHtml(cond)}</td>
      <td>${t.triggerPrice ?? '—'}${t.intradayPrice ? ` / 盘中 ${t.intradayPrice}` : ''}</td>
      <td>${fmtPctB(t.pctB)}%</td>
      <td>${maskMoney(fmtUsd(t.usd))}</td>
      <td class="st-${t.status}">${statusLabel(t.status)}</td>
      <td class="tier-action" title="${escapeHtml(action)}">${escapeHtml(action)}</td>
      <td>${t.status === 'confirmed' || t.status === 'intraday'
        ? (can('tier-exec', 'edit') ? `<button class="btn link" data-exec="${t.id}">标记已执行</button>` : '') : ''}</td>
    </tr>`;
  }).join('');
}

function renderLots() {
  const lots = state.evaluation?.lots || state.lots || [];
  $('#lot-table tbody').innerHTML = lots.length ? lots.map((lot) => `
    <tr>
      <td>${escapeHtml(lot.symbol || '')}</td>
      <td>${lot.type === 'call' ? 'Call' : '正股'}</td>
      <td>${maskMoney(fmtUsd(lot.cost))}</td>
      <td>${lot.mark != null ? maskMoney(fmtUsd(lot.mark)) : '—'}</td>
      <td>${lot.multiple != null ? lot.multiple.toFixed(2) + '×' : '—'}</td>
      <td>${(lot.alerts || []).map((a) => a.action).join('；') || '—'}</td>
      <td>${can('lots-edit', 'edit') ? `<button class="btn link danger" data-del-lot="${lot.id}">删除</button>` : ''}</td>
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
  applyPermissions();
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

async function openDocPreview(id) {
  const root = $('#modal-root');
  const wideStored = sessionStorage.getItem('qqq-dip-doc-wide') === '1';
  root.innerHTML = `
    <div class="sm-modal-backdrop ${wideStored ? 'sm-modal-backdrop--wide' : ''}">
      <div class="sm-modal sm-modal--doc ${wideStored ? 'sm-modal--doc-wide' : ''}" role="dialog" aria-modal="true">
        <div class="sm-doc-toolbar">
          <strong id="doc-title">加载中…</strong>
          <div class="sm-doc-toolbar-actions">
            <button type="button" class="btn ghost sm-btn-sm" data-doc-switch="cheatsheet">速查</button>
            <button type="button" class="btn ghost sm-btn-sm" data-doc-switch="manual">完整手册</button>
            <button type="button" class="btn ghost sm-btn-sm" id="btn-doc-wide">${wideStored ? '退出宽屏' : '宽屏'}</button>
            <button type="button" class="btn ghost sm-btn-sm" data-close>关闭</button>
          </div>
        </div>
        <div class="sm-doc-layout">
          <aside class="sm-doc-toc" id="doc-toc" hidden>
            <div class="sm-doc-toc-title">目录</div>
            <nav class="sm-doc-toc-nav" id="doc-toc-nav"></nav>
          </aside>
          <div class="sm-doc-body sm-doc-content" id="doc-body"><p class="hint">加载中…</p></div>
        </div>
      </div>
    </div>`;
  const modal = root.querySelector('.sm-modal--doc');
  const backdrop = root.querySelector('.sm-modal-backdrop');
  const tocEl = $('#doc-toc');
  const tocNav = $('#doc-toc-nav');
  let tocObserver = null;

  backdrop?.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      document.body.classList.remove('sm-doc-open-wide');
      root.innerHTML = '';
    }
  });
  root.querySelector('[data-close]')?.addEventListener('click', () => {
    document.body.classList.remove('sm-doc-open-wide');
    root.innerHTML = '';
  });

  $('#btn-doc-wide')?.addEventListener('click', () => {
    const wide = !modal.classList.toggle('sm-modal--doc-wide');
    backdrop?.classList.toggle('sm-modal-backdrop--wide', wide);
    sessionStorage.setItem('qqq-dip-doc-wide', wide ? '1' : '0');
    $('#btn-doc-wide').textContent = wide ? '退出宽屏' : '宽屏';
    document.body.classList.toggle('sm-doc-open-wide', wide);
  });

  document.body.classList.toggle('sm-doc-open-wide', wideStored);

  function slugHeading(text, index) {
    const base = String(text || '').trim()
      .replace(/\s+/g, '-')
      .replace(/[^\w\u4e00-\u9fff-]+/g, '')
      .slice(0, 48);
    return base || `section-${index}`;
  }

  function buildDocToc(bodyEl) {
    const headings = [...bodyEl.querySelectorAll('h1,h2,h3,h4')];
    const used = new Set();
    const toc = [];
    headings.forEach((h, i) => {
      let id = h.id;
      if (!id) {
        let base = slugHeading(h.textContent, i);
        let candidate = base;
        let n = 0;
        while (used.has(candidate)) candidate = `${base}-${++n}`;
        used.add(candidate);
        id = candidate;
        h.id = id;
      } else {
        used.add(id);
      }
      toc.push({
        id,
        text: h.textContent.trim(),
        level: Number(h.tagName.slice(1))
      });
    });
    return toc;
  }

  function renderDocToc(toc, bodyEl) {
    if (!tocNav || !tocEl) return;
    if (!toc.length) {
      tocNav.innerHTML = '';
      tocEl.hidden = true;
      return;
    }
    tocEl.hidden = false;
    tocNav.innerHTML = toc.map((item) =>
      `<a href="#${escapeHtml(item.id)}" class="sm-doc-toc-item sm-doc-toc-l${item.level}" data-toc-id="${escapeHtml(item.id)}">${escapeHtml(item.text)}</a>`
    ).join('');
    tocNav.querySelectorAll('a').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const target = bodyEl.querySelector(`#${CSS.escape(a.dataset.tocId)}`);
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  function bindDocTocScroll(bodyEl) {
    if (tocObserver) tocObserver.disconnect();
    const links = [...(tocNav?.querySelectorAll('[data-toc-id]') || [])];
    if (!links.length) return;
    const byId = new Map(links.map((l) => [l.dataset.tocId, l]));
    tocObserver = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
      if (!visible.length) return;
      const id = visible[0].target.id;
      links.forEach((l) => l.classList.toggle('active', l.dataset.tocId === id));
      const active = byId.get(id);
      active?.scrollIntoView({ block: 'nearest' });
    }, { root: bodyEl, rootMargin: '-8% 0px -75% 0px', threshold: [0, 0.1, 0.5, 1] });
    bodyEl.querySelectorAll('h1,h2,h3,h4').forEach((h) => tocObserver.observe(h));
  }

  async function load(docId) {
    const titleEl = $('#doc-title');
    const bodyEl = $('#doc-body');
    titleEl.textContent = '加载中…';
    bodyEl.innerHTML = '<p class="hint">加载中…</p>';
    if (tocNav) tocNav.innerHTML = '';
    if (tocObserver) tocObserver.disconnect();
    try {
      const data = await api(`/docs/${docId}`);
      const doc = data.doc;
      titleEl.textContent = doc.version ? `${doc.title}（${doc.version}）` : doc.title;
      bodyEl.innerHTML = doc.html;
      bodyEl.querySelectorAll('a[href^="doc:"]').forEach((a) => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          load(a.getAttribute('href').slice(4));
        });
      });
      const toc = buildDocToc(bodyEl);
      renderDocToc(toc, bodyEl);
      bindDocTocScroll(bodyEl);
      bodyEl.scrollTop = 0;
      root.querySelectorAll('[data-doc-switch]').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-doc-switch') === docId);
      });
    } catch (e) {
      titleEl.textContent = '加载失败';
      bodyEl.innerHTML = `<p class="hint sm-error">${escapeHtml(e.message)}</p>`;
      if (tocEl) tocEl.hidden = true;
    }
  }

  root.querySelectorAll('[data-doc-switch]').forEach((btn) => {
    btn.addEventListener('click', () => load(btn.getAttribute('data-doc-switch')));
  });
  await load(id);
}

function bind() {
  document.addEventListener('click', (e) => {
    if (e.target.id === 'btn-buy-preview') {
      openBuyPreview();
    }
    const docBtn = e.target.closest('[data-doc]');
    if (docBtn && docBtn.closest('#panel-monitor')) {
      if (!can('docs')) {
        toast('error', '无权查看手册');
        return;
      }
      openDocPreview(docBtn.getAttribute('data-doc'));
    }
  });
  $('#btn-refresh').addEventListener('click', async () => {
    if (!guardEdit('refresh')) return;
    try {
      const data = await api('/quotes/refresh', { method: 'POST' });
      applyState({ evaluation: data.evaluation, monitor: data.monitor });
      toast('success', '已刷新');
    } catch (e) { toast('error', e.message); }
  });
  $('#btn-monitor-toggle').addEventListener('click', async () => {
    if (!guardEdit('monitor-control')) return;
    try {
      const running = !!state.monitor?.running;
      const data = await api(running ? '/monitor/stop' : '/monitor/start', { method: 'POST' });
      state.monitor = data.monitor;
      render();
    } catch (e) { toast('error', e.message); }
  });
  $('#btn-qq-start').addEventListener('click', async () => {
    if (!guardEdit('qq-monitor')) return;
    try {
      const data = await api('/monitor/start', { method: 'POST' });
      state.monitor = data.monitor;
      render();
    } catch (e) { toast('error', e.message); }
  });
  $('#btn-qq-stop').addEventListener('click', async () => {
    if (!guardEdit('qq-monitor')) return;
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
    if (!guardEdit('tier-exec')) return;
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
    if (!guardEdit('actions-note')) return;
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
    if (!guardEdit('lots-edit')) return;
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
    if (!guardEdit('lots-edit')) return;
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
    if (!guardEdit('qq-save')) return;
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
    if (!guardEdit('qq-test')) return;
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
  bind();
  await loadPortalContext();
  renderTabs();
  try {
    applyState(await api('/state'));
  } catch (e) {
    $('#error-line').hidden = false;
    $('#error-line').textContent = e.message;
  }
  connectSse();
}

init();
