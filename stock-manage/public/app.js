const $ = (sel, root = document) => root.querySelector(sel);
const fmt = (n) => Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
const fmtPct = (n) => Number.isFinite(n) ? n.toFixed(2) + '%' : '—';
const cls = (n) => n > 0 ? 'pos' : n < 0 ? 'neg' : '';

let state = { cash: 0, trades: [], holdings: [], summary: {} };

async function api(path, opts = {}) {
  const res = await fetch('./api' + path, {
    headers: opts.body && !(opts.body instanceof ArrayBuffer) && !(opts.body instanceof Blob)
      ? { 'Content-Type': 'application/json', ...opts.headers }
      : opts.headers,
    ...opts,
    body: opts.body instanceof ArrayBuffer || opts.body instanceof Blob
      ? opts.body
      : opts.body != null ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function renderSummary() {
  const s = state.summary || {};
  const cards = [
    ['现金', fmt(state.cash)],
    ['总市值', fmt(s.totalMv)],
    ['总资产', fmt(s.totalAssets)],
    ['未实现盈亏', fmt(s.unrealized)],
    ['已实现盈亏', fmt(s.realizedPL)],
    ['净盈亏', fmt(s.netPL)]
  ];
  $('#summary-cards').innerHTML = cards.map(([label, value]) =>
    `<div class="sm-stat"><div class="label">${label}</div><div class="value">${value}</div></div>`
  ).join('');
}

function renderHoldings() {
  const rows = state.holdings || [];
  $('#holdings-body').innerHTML = rows.length ? rows.map(h => `
    <tr>
      <td>${h.symbol}</td>
      <td>${h.name || ''}</td>
      <td>${h.shares}</td>
      <td>${fmt(h.avgCost)}</td>
      <td>${fmt(h.price)}</td>
      <td>${fmt(h.marketValue)}</td>
      <td class="${cls(h.pnl)}">${h.pnl == null ? '—' : fmt(h.pnl)}</td>
      <td>${fmtPct(h.weight)}</td>
    </tr>
  `).join('') : '<tr><td colspan="8" class="empty">暂无持仓</td></tr>';
}

function typeLabel(t) {
  if (t.type === 'buy') return '买入';
  if (t.type === 'sell') return '卖出';
  if (t.type === 'other') return '其它/' + (t.other_category || '');
  return t.type;
}

function renderTrades() {
  const trades = [...(state.trades || [])].sort((a, b) => new Date(b.trade_date) - new Date(a.trade_date));
  $('#trades-body').innerHTML = trades.length ? trades.map(t => `
    <tr>
      <td>${(t.trade_date || '').slice(0, 19).replace('T', ' ')}</td>
      <td>${typeLabel(t)}</td>
      <td>${t.symbol}</td>
      <td>${t.name || ''}</td>
      <td>${t.type === 'other' ? '—' : t.shares}</td>
      <td>${t.type === 'other' ? '—' : fmt(t.price)}</td>
      <td>${fmt(t.total_amount)}</td>
      <td>${fmt(t.commission)}</td>
      <td>
        <button class="btn link" data-edit="${t.id}">编辑</button>
        <button class="btn link" data-del="${t.id}">删除</button>
      </td>
    </tr>
  `).join('') : '<tr><td colspan="9" class="empty">暂无记录</td></tr>';
}

function applyPortfolio(data) {
  state = data;
  renderSummary();
  renderHoldings();
  renderTrades();
}

async function loadPortfolio() {
  applyPortfolio(await api('/portfolio'));
}

function closeModal() {
  $('#modal-root').innerHTML = '';
}

function openModal(title, bodyHtml, onSubmit) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="sm-modal-backdrop">
      <div class="sm-modal" role="dialog">
        <div class="sm-modal-head">
          <h3>${title}</h3>
          <button type="button" class="btn link" data-close>关闭</button>
        </div>
        <form class="sm-modal-body" id="modal-form">${bodyHtml}</form>
        <div class="sm-modal-foot">
          <button type="button" class="btn ghost" data-close>取消</button>
          <button type="submit" form="modal-form" class="btn primary">保存</button>
        </div>
      </div>
    </div>`;
  const backdrop = root.querySelector('.sm-modal-backdrop');
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });
  root.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', closeModal);
  });
  $('#modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await onSubmit(new FormData(e.target));
      closeModal();
      await loadPortfolio();
    } catch (err) {
      alert(err.message);
    }
  });
}

function tradeFormFields(trade = {}) {
  const type = trade.type || 'buy';
  const dt = (trade.trade_date || new Date().toISOString()).slice(0, 16);
  return `
    <label>类型
      <select name="type" id="trade-type">
        <option value="buy" ${type === 'buy' ? 'selected' : ''}>买入</option>
        <option value="sell" ${type === 'sell' ? 'selected' : ''}>卖出</option>
        <option value="other" ${type === 'other' ? 'selected' : ''}>其它收支</option>
      </select>
    </label>
    <label class="${type === 'other' ? '' : 'hidden'}" id="field-other">其它类别
      <input name="other_category" value="${trade.other_category || ''}">
    </label>
    <label>代码
      <input name="symbol" required value="${trade.symbol || ''}" placeholder="AAPL 或期权码">
    </label>
    <label>名称
      <input name="name" value="${trade.name || ''}">
    </label>
    <label class="${type === 'other' ? 'hidden' : ''}" id="field-shares">数量
      <input name="shares" type="number" step="any" value="${trade.shares ?? ''}">
    </label>
    <label class="${type === 'other' ? 'hidden' : ''}" id="field-price">价格
      <input name="price" type="number" step="any" value="${trade.price ?? ''}">
    </label>
    <label>金额 ${type === 'other' ? '' : '(自动计算，其它类型填金额)'}
      <input name="total_amount" type="number" step="any" value="${trade.total_amount ?? ''}" ${type === 'other' ? '' : 'readonly tabindex=-1'}>
    </label>
    <label>费用
      <input name="commission" type="number" step="any" value="${trade.commission ?? 0}">
    </label>
    <label>时间
      <input name="trade_date" type="datetime-local" value="${dt}">
    </label>`;
}

function bindTradeFormToggle(root) {
  const typeEl = root.querySelector('#trade-type');
  if (!typeEl) return;
  const sync = () => {
    const other = typeEl.value === 'other';
    root.querySelector('#field-other')?.classList.toggle('hidden', !other);
    root.querySelector('#field-shares')?.classList.toggle('hidden', other);
    root.querySelector('#field-price')?.classList.toggle('hidden', other);
    const amt = root.querySelector('[name=total_amount]');
    if (amt) {
      amt.readOnly = !other;
      if (other) amt.removeAttribute('tabindex'); else amt.tabIndex = -1;
    }
  };
  typeEl.addEventListener('change', sync);
  sync();
}

function formToTrade(fd, existing = {}) {
  const type = fd.get('type');
  const trade_date = new Date(fd.get('trade_date')).toISOString();
  const base = {
    type,
    symbol: String(fd.get('symbol') || '').trim(),
    name: String(fd.get('name') || '').trim(),
    commission: Number(fd.get('commission')) || 0,
    trade_date,
    id: existing.id
  };
  if (type === 'other') {
    return { ...base, other_category: String(fd.get('other_category') || '').trim(), total_amount: Number(fd.get('total_amount')) };
  }
  return {
    ...base,
    shares: Number(fd.get('shares')),
    price: Number(fd.get('price'))
  };
}

function openTradeModal(trade) {
  openModal(trade?.id ? '编辑交易' : '记一笔', tradeFormFields(trade), async (fd) => {
    const body = formToTrade(fd, trade);
    if (trade?.id) await api('/trades/' + trade.id, { method: 'PUT', body });
    else await api('/trades', { method: 'POST', body });
  });
  bindTradeFormToggle($('#modal-form'));
}

function openImportModal() {
  openModal('导入交易', `
    <p class="hint">支持 Moomoo（富途）历史 xlsx，或本应用导出的「交易记录」xlsx。仅导入「全部成交」记录。</p>
    <label>导入模式
      <select name="mode">
        <option value="merge">合并到现有记录</option>
        <option value="replace">替换全部记录</option>
      </select>
    </label>
    <label>选择文件
      <input type="file" name="file" accept=".xlsx,.xls" required>
    </label>`, async (fd) => {
    const file = fd.get('file');
    if (!file?.size) throw new Error('请选择文件');
    const mode = fd.get('mode') || 'merge';
    const buf = await file.arrayBuffer();
    await fetch('./api/trades/import?mode=' + encodeURIComponent(mode), {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      body: buf
    }).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '导入失败');
      applyPortfolio(data);
    });
  });
}

async function refreshQuotes() {
  $('#btn-refresh').disabled = true;
  try {
    applyPortfolio(await api('/quotes/refresh', { method: 'POST' }));
  } catch (e) {
    alert(e.message);
  } finally {
    $('#btn-refresh').disabled = false;
  }
}

async function loadPnl() {
  const start = $('#pnl-start').value;
  const end = $('#pnl-end').value;
  const q = new URLSearchParams();
  if (start) q.set('start', start);
  if (end) q.set('end', end);
  const p = await api('/pnl?' + q.toString());
  const items = [
    ['买入', p.totalBuy], ['卖出', p.totalSell], ['费用', p.commission],
    ['其它', p.otherAmount], ['已实现', p.realizedPL], ['净盈亏', p.netPL]
  ];
  $('#pnl-box').innerHTML = items.map(([label, val]) =>
    `<div class="sm-stat"><div class="label">${label}</div><div class="value ${cls(val)}">${fmt(val)}</div></div>`
  ).join('');
}

$('#btn-refresh').addEventListener('click', refreshQuotes);
$('#btn-add').addEventListener('click', () => openTradeModal());
$('#btn-import').addEventListener('click', openImportModal);
$('#btn-pnl').addEventListener('click', () => loadPnl().catch(e => alert(e.message)));

$('#trades-body').addEventListener('click', async (e) => {
  const editId = e.target.closest('[data-edit]')?.dataset.edit;
  const delId = e.target.closest('[data-del]')?.dataset.del;
  if (editId) {
    const trade = state.trades.find(t => t.id === editId);
    if (trade) openTradeModal(trade);
  }
  if (delId && confirm('确定删除这条记录？')) {
    try {
      applyPortfolio(await api('/trades/' + delId, { method: 'DELETE' }));
    } catch (err) {
      alert(err.message);
    }
  }
});

loadPortfolio().catch(e => {
  document.body.innerHTML = '<p class="sm-error">加载失败: ' + e.message + '</p>';
});
