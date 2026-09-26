import { loadPortalContext, can, canDip } from '../js/portal-auth.js';

const $ = (selector) => document.querySelector(selector);
const state = { status: null, timer: null, chain: null, chainCaptureId: null, selectedOptionSymbol: null, collapsedExpirations: new Set(), optionChart: null };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, options = {}) {
  const response = await fetch(`../api${path}`, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText || '请求失败');
  return data;
}

function dateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
function money(value) { return Number.isFinite(Number(value)) ? `$${Number(value).toFixed(2)}` : '—'; }
function percent(value) { return Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? '+' : ''}${(Number(value) * 100).toFixed(2)}%` : '—'; }
function decimal(value, digits = 4) { return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—'; }

function captureLabel(item) {
  const kind = item.capture_kind === 'daily-summary' ? '收盘摘要' : '日内';
  return `${item.market_date} · ${kind} · ${dateTime(item.captured_at)}`;
}

function applyPermissions() {
  document.querySelectorAll('.sm-feature-tab').forEach((link) => {
    const href = link.getAttribute('href') || '';
    if (href.includes('tab=qq')) link.hidden = !canDip('tab-qq');
    else if (href.includes('/yolo/')) link.hidden = !can('tab-yolo');
    else if (href.includes('/quant/')) link.hidden = !can('tab-quant');
    else if (href.includes('/dip/')) link.hidden = !canDip('tab-monitor');
  });
  const editable = can('yolo-control', 'edit');
  $('#capture-now').hidden = !editable;
  $('#backfill-close').hidden = !editable;
  $('#save-collector').hidden = !editable;
  $('#collector-enabled').disabled = !editable;
  $('#capture-interval').disabled = !editable;
  $('#run-yolo-backtest').hidden = !can('yolo-backtest-run', 'edit');
}

function renderStatus(data) {
  state.status = data;
  const { settings, stats, recent = [] } = data;
  $('#market-status').textContent = data.marketOpen ? '美股交易中' : '美股已休市';
  $('#market-status').classList.toggle('open', !!data.marketOpen);
  $('#collector-enabled').checked = settings.enabled;
  $('#capture-interval').value = String(settings.intervalSeconds);
  $('#collector-state').textContent = settings.enabled ? (settings.lastError ? '异常' : '运行中') : '已暂停';
  $('#collector-state').className = settings.lastError ? 'neg' : settings.enabled ? 'pos' : '';
  $('#capture-days').textContent = stats.days || 0;
  $('#capture-counts').textContent = `${stats.captures || 0} / ${Number(stats.quoteRows || 0).toLocaleString()}`;
  $('#last-capture').textContent = dateTime(stats.latestCaptureAt);
  $('#first-capture').textContent = dateTime(stats.firstCaptureAt);
  const latest = recent[0];
  $('#latest-expiration').textContent = latest?.expiration || '—';
  $('#latest-spot').textContent = money(latest?.underlying_price);
  $('#latest-source').textContent = latest?.source || '—';
  $('#collector-message').textContent = settings.lastError
    ? `最近错误：${settings.lastError}`
    : settings.enabled
      ? `自动记录已开启，每 ${settings.intervalSeconds} 秒检查一次；休市期间不请求。`
      : '自动记录已暂停。';
  $('#collector-message').className = `yolo-message${settings.lastError ? ' error' : ''}`;
  $('#capture-body').innerHTML = recent.length ? recent.map((item) => `<tr class="yolo-capture-row" data-capture-id="${item.id}"><td>${dateTime(item.captured_at)}</td><td>${item.capture_kind === 'daily-summary' ? '收盘摘要' : '日内快照'}</td><td>${escapeHtml(item.market_date)}</td><td>${escapeHtml(item.expiration)}</td><td class="align-right">${money(item.underlying_price)}</td><td class="align-right">${Number(item.contract_count).toLocaleString()}</td><td>${escapeHtml(item.source || '—')}</td></tr>`).join('') : '<tr><td colspan="7" class="quant-empty">尚无数据；可先回填昨日收盘，开盘后自动积累分钟快照。</td></tr>';
  const captureSelect = $('#chain-capture');
  const selected = String(state.chainCaptureId || captureSelect.value || '');
  captureSelect.innerHTML = recent.length
    ? recent.map((item) => `<option value="${item.id}">${escapeHtml(captureLabel(item))}</option>`).join('')
    : '<option value="">尚无快照</option>';
  const available = recent.some((item) => String(item.id) === selected);
  const nextId = available ? selected : String(recent[0]?.id || '');
  captureSelect.value = nextId;
  if (nextId && nextId !== String(state.chainCaptureId || '')) loadCaptureDetails(nextId);
}

function moneyness(quote, spot) {
  if (!(spot > 0)) return { label: '—', otm: false };
  const gap = quote.strike / spot - 1;
  if (Math.abs(gap) <= 0.002) return { label: '近平值', otm: false };
  const otm = quote.right_type === 'C' ? quote.strike > spot : quote.strike < spot;
  return { label: otm ? '价外' : '价内', otm };
}

function optionPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return number >= 1 ? number.toFixed(2) : number.toFixed(3);
}

function sum(rows, key) { return rows.reduce((total, row) => total + (Number(row?.[key]) || 0), 0); }

function renderChainMetrics(payload, spot) {
  const calls = payload.quotes.filter((quote) => quote.right_type === 'C');
  const puts = payload.quotes.filter((quote) => quote.right_type === 'P');
  const callVolume = sum(calls, 'volume');
  const putVolume = sum(puts, 'volume');
  const callOi = sum(calls, 'open_interest');
  const putOi = sum(puts, 'open_interest');
  const ivs = payload.quotes.map((quote) => Number(quote.iv)).filter(Number.isFinite);
  const averageIv = ivs.length ? ivs.reduce((total, value) => total + value, 0) / ivs.length : null;
  const items = [
    ['QQQ', money(spot)],
    ['到期日', payload.capture.expiration],
    ['Call 成交量', callVolume.toLocaleString()],
    ['Put 成交量', putVolume.toLocaleString()],
    ['Put/Call 成交比', callVolume ? (putVolume / callVolume).toFixed(2) : '—'],
    ['Put/Call 持仓比', callOi ? (putOi / callOi).toFixed(2) : '—'],
    ['平均 IV', averageIv == null ? '—' : percent(averageIv)]
  ];
  $('#chain-metrics').innerHTML = items.map(([label, value]) => `<div><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
}

function quoteAllowed(quote, spot) {
  if (!quote) return false;
  const minDeltaInput = $('#chain-delta-min').value;
  if (minDeltaInput && Math.abs(Number(quote.delta)) < Number(minDeltaInput)) return false;
  const filter = $('#chain-moneyness').value;
  const stateValue = moneyness(quote, spot);
  if (filter === 'otm' && !stateValue.otm) return false;
  if (filter === 'itm' && (stateValue.otm || stateValue.label === '近平值')) return false;
  return true;
}

function optionCell(quote, className, content, title = '') {
  if (!quote) return `<td class="${className} chain-empty">—</td>`;
  return `<td class="${className} chain-contract-cell" data-option="${escapeHtml(quote.option_symbol)}" title="${escapeHtml(title || quote.option_symbol)}">${content}</td>`;
}

function chainColumns(mode, side) {
  const price = side === 'call'
    ? [['chain-last', '最新'], ['chain-bid', '买入价'], ['chain-ask', '卖出价']]
    : [['chain-bid', '买入价'], ['chain-ask', '卖出价'], ['chain-last', '最新']];
  if (mode === 'mobile') return side === 'call' ? price.slice(1) : price.slice(0, 2);
  const greeks = side === 'call'
    ? [['chain-greeks', 'Delta'], ['chain-greeks', 'IV'], ...price]
    : [...price, ['chain-greeks', 'IV'], ['chain-greeks', 'Delta']];
  return mode === 'all'
    ? (side === 'call' ? [['chain-flow', '成交 / 持仓'], ...greeks] : [...greeks, ['chain-flow', '成交 / 持仓']])
    : mode === 'greeks' ? greeks : price;
}

function renderChainHead(mode) {
  const callColumns = chainColumns(mode, 'call');
  const putColumns = chainColumns(mode, 'put');
  $('#chain-head').innerHTML = `<tr class="yolo-chain-sides"><th colspan="${callColumns.length}">CALL 看涨</th><th class="yolo-strike-head" rowspan="2">行权价</th><th colspan="${putColumns.length}">PUT 看跌</th></tr><tr>${callColumns.map(([, label]) => `<th>${label}</th>`).join('')}${putColumns.map(([, label]) => `<th>${label}</th>`).join('')}</tr>`;
}

function optionCells(quote, side, isItm = false, mode = 'price') {
  const columns = chainColumns(mode, side);
  if (!quote) return columns.map(([name]) => optionCell(null, name, '')).join('');
  const flow = `${Number(quote.volume || 0).toLocaleString()} / ${Number(quote.open_interest || 0).toLocaleString()}`;
  const changeClass = Number(quote.last_price) >= Number(quote.prev_close) ? 'chain-up' : 'chain-down';
  const values = {
    '成交 / 持仓': flow,
    Delta: decimal(quote.delta, 3),
    IV: quote.iv == null ? '—' : percent(quote.iv),
    最新: optionPrice(quote.last_price),
    买入价: `${optionPrice(quote.bid)}<small>${Number(quote.bid_size || 0)}</small>`,
    卖出价: `${optionPrice(quote.ask)}<small>${Number(quote.ask_size || 0)}</small>`
  };
  return columns.map(([className, label]) => {
    const extra = label === '最新' ? ` ${changeClass}` : '';
    return optionCell(quote, `${className}${extra}${isItm ? ' chain-itm' : ''}`, values[label]);
  }).join('');
}

function renderContractDetail(quote = null) {
  if (!quote) {
    $('#chain-detail').innerHTML = '<span>单击查看报价详情，双击 Call 或 Put 任意报价单元格查看该合约 K 线</span>';
    return;
  }
  state.selectedOptionSymbol = quote.option_symbol;
  const spreadMid = (Number(quote.bid) + Number(quote.ask)) / 2;
  const spread = spreadMid > 0 ? (Number(quote.ask) - Number(quote.bid)) / spreadMid : null;
  const fields = [
    ['Bid / Ask', `${optionPrice(quote.bid)} / ${optionPrice(quote.ask)}`], ['价差', spread == null ? '—' : percent(spread)],
    ['Last', optionPrice(quote.last_price)], ['O / H / L', `${optionPrice(quote.open_price)} / ${optionPrice(quote.high_price)} / ${optionPrice(quote.low_price)}`],
    ['前收', optionPrice(quote.prev_close)], ['Delta', decimal(quote.delta)], ['Gamma', decimal(quote.gamma)],
    ['Theta', decimal(quote.theta)], ['Vega', decimal(quote.vega)], ['IV', quote.iv == null ? '—' : percent(quote.iv)],
    ['成交 / 持仓', `${Number(quote.volume || 0).toLocaleString()} / ${Number(quote.open_interest || 0).toLocaleString()}`],
    ['最后成交', dateTime(quote.last_trade_at)]
  ];
  $('#chain-detail').innerHTML = `<div class="yolo-detail-title"><b>${quote.right_type === 'C' ? 'CALL' : 'PUT'}</b><strong>${escapeHtml(String(quote.option_symbol).replace(/^O:/, ''))}</strong></div><div class="yolo-detail-grid">${fields.map(([label, value]) => `<div><span>${label}</span><b>${escapeHtml(value)}</b></div>`).join('')}</div>`;
}

function renderChain() {
  const payload = state.chain;
  if (!payload) return;
  const spot = Number(payload.capture.underlying_price);
  const minStrike = Number($('#chain-strike-min').value);
  const maxStrike = Number($('#chain-strike-max').value);
  const mode = window.innerWidth <= 700 ? 'mobile' : $('#chain-mode').value;
  const sideSpan = chainColumns(mode, 'call').length;
  const totalSpan = sideSpan * 2 + 1;
  $('#chain-table').dataset.mode = mode;
  renderChainHead(mode);
  renderChainMetrics(payload, spot);
  const groups = new Map();
  payload.quotes.forEach((quote) => {
    const expiration = quote.expiration || payload.capture.expiration || '未知到期日';
    if (!groups.has(expiration)) groups.set(expiration, []);
    groups.get(expiration).push(quote);
  });
  const output = [];
  let visibleRows = 0;
  groups.forEach((quotes, expiration) => {
    const pairs = new Map();
    quotes.forEach((quote) => {
      if ($('#chain-strike-min').value && quote.strike < minStrike) return;
      if ($('#chain-strike-max').value && quote.strike > maxStrike) return;
      if (!pairs.has(quote.strike)) pairs.set(quote.strike, { strike: quote.strike, call: null, put: null });
      pairs.get(quote.strike)[quote.right_type === 'C' ? 'call' : 'put'] = quote;
    });
    const rows = [...pairs.values()].sort((a, b) => a.strike - b.strike).map((pair) => ({
      ...pair,
      call: quoteAllowed(pair.call, spot) ? pair.call : null,
      put: quoteAllowed(pair.put, spot) ? pair.put : null
    })).filter((pair) => pair.call || pair.put);
    visibleRows += rows.length;
    const groupKey = `${payload.capture.id}:${expiration}`;
    const collapsed = state.collapsedExpirations.has(groupKey);
    output.push(`<tr class="yolo-expiry-row" data-expiry-toggle="${escapeHtml(groupKey)}"><td colspan="${totalSpan}"><button type="button" class="yolo-expiry-toggle" aria-expanded="${!collapsed}"><span>${collapsed ? '›' : '⌄'}</span><strong>${escapeHtml(expiration)}</strong><small>${rows.length} 个行权价 · ${quotes.length} 个合约</small></button></td></tr>`);
    if (collapsed) return;
    let spotInserted = false;
    rows.forEach((pair) => {
      if (!spotInserted && pair.strike >= spot) {
        output.push(`<tr class="yolo-spot-row"><td colspan="${sideSpan}">CALL</td><td><span>QQQ ${optionPrice(spot)}</span></td><td colspan="${sideSpan}">PUT</td></tr>`);
        spotInserted = true;
      }
      const callItm = pair.call && !moneyness(pair.call, spot).otm && moneyness(pair.call, spot).label !== '近平值';
      const putItm = pair.put && !moneyness(pair.put, spot).otm && moneyness(pair.put, spot).label !== '近平值';
      output.push(`<tr>${optionCells(pair.call, 'call', callItm, mode)}<td class="yolo-strike">${optionPrice(pair.strike)}</td>${optionCells(pair.put, 'put', putItm, mode)}</tr>`);
    });
    if (!spotInserted && rows.length) output.push(`<tr class="yolo-spot-row"><td colspan="${sideSpan}">CALL</td><td><span>QQQ ${optionPrice(spot)}</span></td><td colspan="${sideSpan}">PUT</td></tr>`);
  });
  $('#chain-message').textContent = `${payload.capture.market_date} · ${payload.capture.capture_kind === 'daily-summary' ? '收盘摘要' : '日内快照'} · 显示 ${visibleRows} 个行权价 / ${payload.quotes.length} 个合约`;
  $('#chain-body').innerHTML = output.length ? output.join('') : `<tr><td colspan="${totalSpan}" class="quant-empty">没有符合当前筛选条件的合约。</td></tr>`;
  requestAnimationFrame(() => {
    const scroller = document.querySelector('.yolo-chain-scroll');
    const spotRow = scroller?.querySelector('.yolo-spot-row');
    if (scroller && spotRow) scroller.scrollTop = Math.max(0, spotRow.offsetTop - scroller.clientHeight / 2);
  });
  const selected = payload.quotes.find((quote) => quote.option_symbol === state.selectedOptionSymbol);
  renderContractDetail(selected || null);
}

const optionIntervals = [
  [1, '1 分钟'], [3, '3 分钟'], [5, '5 分钟'], [10, '10 分钟'], [15, '15 分钟'],
  [30, '30 分钟'], [60, '1 小时'], [120, '2 小时'], [240, '4 小时'], [1440, '1 日']
];

function closeOptionChart() {
  if (!state.optionChart) return;
  state.optionChart.chart?.dispose();
  state.optionChart.modal?.remove();
  state.optionChart = null;
}

function optionChartOption(payload) {
  const candles = payload.candles || [];
  const labels = candles.map((c) => new Date(c.timestamp).toLocaleString('zh-CN', { timeZone: 'America/New_York', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
  const values = candles.map((c) => [Number(c.open), Number(c.close), Number(c.low), Number(c.high)]);
  const signed = (value, digits = 2) => `${value >= 0 ? '+' : ''}${Number(value).toFixed(digits)}`;
  return {
    animation: false,
    backgroundColor: 'transparent',
    grid: { left: 58, right: 20, top: 28, bottom: 42 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' }, formatter: (params) => {
      const item = Array.isArray(params) ? params[0] : params;
      const index = Number(item?.dataIndex);
      const candle = values[index];
      if (!candle) return '';
      const base = index > 0 ? values[index - 1][1] : candle[0];
      const change = candle[1] - base;
      const pct = base ? change / base * 100 : 0;
      return `${labels[index]}<br/>开 ${candle[0].toFixed(3)}　高 ${candle[3].toFixed(3)}<br/>低 ${candle[2].toFixed(3)}　收 ${candle[1].toFixed(3)}<br/><span style="color:${change >= 0 ? '#fb7185' : '#34d399'}">涨跌 ${signed(change, 3)} (${signed(pct, 2)}%)</span>`;
    } },
    xAxis: { type: 'category', data: labels, boundaryGap: true, axisLabel: { color: '#94a3b8', hideOverlap: true } },
    yAxis: { scale: true, axisLabel: { color: '#94a3b8', formatter: (value) => `$${Number(value).toFixed(2)}` }, splitLine: { lineStyle: { color: 'rgba(100,116,139,.18)' } } },
    dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 8 }],
    series: [{ type: 'candlestick', name: '权利金', data: values, itemStyle: { color: '#fb7185', color0: '#34d399', borderColor: '#fb7185', borderColor0: '#34d399' } }]
  };
}

async function showOptionChart(symbol) {
  closeOptionChart();
  const modal = document.createElement('div');
  modal.className = 'sm-modal-backdrop yolo-kline-backdrop';
  modal.innerHTML = `<div class="sm-modal sm-modal--xl yolo-kline-modal" role="dialog" aria-modal="true" aria-labelledby="yolo-kline-title"><div class="sm-modal-head"><div><h3 id="yolo-kline-title">${escapeHtml(String(symbol).replace(/^O:/, ''))} · 期权 K 线</h3><p id="yolo-kline-status">正在读取累计采集数据…</p></div><button type="button" class="btn link" data-yolo-kline-close>关闭</button></div><div class="yolo-kline-toolbar"><label>时间单位 <select id="yolo-kline-interval">${optionIntervals.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label><span>价格优先使用 Last，无 Last 时使用 Bid/Ask 中间价；只展示本站已采集数据。</span></div><div class="sm-modal-body yolo-kline-body"><div id="yolo-kline-chart"></div></div></div>`;
  document.body.appendChild(modal);
  const chartHost = modal.querySelector('#yolo-kline-chart');
  const chart = globalThis.echarts ? globalThis.echarts.init(chartHost, null, { renderer: 'canvas' }) : null;
  state.optionChart = { modal, chart, symbol };
  const close = () => closeOptionChart();
  modal.querySelector('[data-yolo-kline-close]').addEventListener('click', close);
  modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
  const load = async () => {
    const interval = Number(modal.querySelector('#yolo-kline-interval').value);
    const status = modal.querySelector('#yolo-kline-status');
    status.textContent = '正在读取累计采集数据…';
    try {
      const payload = await api(`/yolo/option-history?symbol=${encodeURIComponent(symbol)}&interval=${interval}`);
      if (!payload.candles?.length) {
        status.textContent = `暂无该合约的累计采集数据（原始样本 ${payload.samples || 0} 条）。`;
        chart?.clear();
        return;
      }
      status.textContent = `${payload.candles.length} 根 K 线 · ${payload.firstCapturedAt ? dateTime(payload.firstCapturedAt) : '—'} 至 ${payload.lastCapturedAt ? dateTime(payload.lastCapturedAt) : '—'}`;
      chart?.setOption(optionChartOption(payload), true);
    } catch (error) { status.textContent = error.message; }
  };
  modal.querySelector('#yolo-kline-interval').addEventListener('change', load);
  window.addEventListener('keydown', function escape(event) { if (event.key === 'Escape' && state.optionChart?.modal === modal) { window.removeEventListener('keydown', escape); close(); } });
  window.requestAnimationFrame(() => { chart?.resize(); load(); });
}

async function loadCaptureDetails(captureId) {
  if (!captureId) return;
  state.chainCaptureId = String(captureId);
  $('#chain-message').textContent = '正在读取期权链…';
  try {
    state.chain = await api(`/yolo/captures/${encodeURIComponent(captureId)}/quotes`);
    renderChain();
  } catch (error) {
    state.chain = null;
    $('#chain-message').textContent = error.message;
    $('#chain-body').innerHTML = '<tr><td colspan="13" class="quant-empty">期权链加载失败。</td></tr>';
  }
}

async function loadStatus(silent = false) {
  try { renderStatus(await api('/yolo/status')); }
  catch (error) { if (!silent) $('#collector-message').textContent = error.message; }
}

async function saveCollector() {
  const button = $('#save-collector');
  button.disabled = true;
  try {
    await api('/yolo/settings', { method: 'PUT', body: JSON.stringify({ enabled: $('#collector-enabled').checked, intervalSeconds: Number($('#capture-interval').value) }) });
    await loadStatus();
  } catch (error) { $('#collector-message').textContent = error.message; }
  finally { button.disabled = false; }
}

async function captureNow() {
  const button = $('#capture-now');
  button.disabled = true; button.textContent = '采集中…';
  try {
    const result = await api('/yolo/capture', { method: 'POST', body: '{}' });
    renderStatus({ ...result.status, marketOpen: state.status?.marketOpen, collectorRunning: false });
    $('#collector-message').textContent = `已写入 ${result.contracts} 个真实期权报价。`;
  } catch (error) { $('#collector-message').textContent = error.message; $('#collector-message').className = 'yolo-message error'; await loadStatus(true); }
  finally { button.disabled = false; button.textContent = '立即采集'; }
}

async function backfillPreviousClose() {
  const button = $('#backfill-close');
  button.disabled = true; button.textContent = '回填中…';
  try {
    const result = await api('/yolo/backfill-previous-close', { method: 'POST', body: '{}' });
    renderStatus({ ...result.status, marketOpen: state.status?.marketOpen, collectorRunning: false });
    $('#collector-message').textContent = `已回填 ${result.marketDate} 收盘摘要：${result.contracts} 个合约；该摘要不参与分钟回测。`;
  } catch (error) {
    $('#collector-message').textContent = error.message;
    $('#collector-message').className = 'yolo-message error';
    await loadStatus(true);
  } finally {
    button.disabled = false; button.textContent = '回填昨日收盘';
  }
}

function renderBacktest(result) {
  $('#bt-return').textContent = percent(result.totalReturn);
  $('#bt-return').className = result.totalReturn >= 0 ? 'pos' : 'neg';
  $('#bt-pf').textContent = result.profitFactor == null ? '—' : Number(result.profitFactor).toFixed(3);
  $('#bt-winrate').textContent = `${(Number(result.winRate) * 100).toFixed(1)}% / ${result.trades.length}`;
  $('#bt-drawdown').textContent = percent(result.maxDrawdown);
  $('#backtest-message').textContent = result.trades.length
    ? `使用 ${result.trades.length} 笔真实NBBO交易；结果只覆盖本站开始采集后的日期。`
    : '当前数据不足以形成交易：需要完整覆盖09:30、09:45及退出时段。';
  $('#trade-body').innerHTML = result.trades.length ? result.trades.map((trade) => `<tr><td>${escapeHtml(trade.marketDate)}</td><td><strong>${escapeHtml(trade.direction)}</strong><span class="quant-sub">${escapeHtml(trade.optionSymbol)}</span></td><td class="align-right">${money(trade.entryAsk)} → ${money(trade.exitBid)}<span class="quant-sub">${trade.contracts} 张</span></td><td class="align-right">${Number(trade.entryDelta).toFixed(3)}</td><td class="align-right ${trade.netPnl >= 0 ? 'pos' : 'neg'}">${percent(trade.optionReturn)}<span class="quant-sub">${money(trade.netPnl)}</span></td><td>${escapeHtml(trade.reason)}</td></tr>`).join('') : '<tr><td colspan="6" class="quant-empty">暂无满足条件的交易。</td></tr>';
}

async function runBacktest(event) {
  event.preventDefault();
  const button = $('#run-yolo-backtest');
  button.disabled = true; button.textContent = '回测中…';
  try {
    const payload = {
      targetDelta: Number($('#bt-delta').value), minMovePct: Number($('#bt-move').value) / 100,
      stopLoss: Number($('#bt-stop').value) / 100, profitTarget: Number($('#bt-target').value) / 100,
      initialCapital: Number($('#bt-capital').value)
    };
    renderBacktest(await api('/yolo/backtest', { method: 'POST', body: JSON.stringify(payload) }));
  } catch (error) { $('#backtest-message').textContent = error.message; }
  finally { button.disabled = false; button.textContent = '运行回测'; }
}

async function init() {
  await loadPortalContext();
  applyPermissions();
  if (!can('yolo-dashboard')) throw new Error('无权查看梭哈平台');
  await loadStatus();
  $('#save-collector').addEventListener('click', saveCollector);
  $('#capture-now').addEventListener('click', captureNow);
  $('#backfill-close').addEventListener('click', backfillPreviousClose);
  $('#chain-capture').addEventListener('change', (event) => loadCaptureDetails(event.target.value));
  ['#chain-mode', '#chain-moneyness', '#chain-strike-min', '#chain-strike-max', '#chain-delta-min']
    .forEach((selector) => $(selector).addEventListener('input', renderChain));
  $('#chain-body').addEventListener('click', (event) => {
    const expiry = event.target.closest('[data-expiry-toggle]');
    if (expiry) {
      const key = expiry.dataset.expiryToggle;
      if (state.collapsedExpirations.has(key)) state.collapsedExpirations.delete(key);
      else state.collapsedExpirations.add(key);
      renderChain();
      return;
    }
    const cell = event.target.closest('[data-option]');
    if (!cell || !state.chain) return;
    renderContractDetail(state.chain.quotes.find((quote) => quote.option_symbol === cell.dataset.option));
  });
  $('#chain-body').addEventListener('dblclick', (event) => {
    const cell = event.target.closest('[data-option]');
    if (!cell || !state.chain) return;
    const quote = state.chain.quotes.find((item) => item.option_symbol === cell.dataset.option);
    if (quote) showOptionChart(quote.option_symbol);
  });
  $('#capture-body').addEventListener('click', (event) => {
    const row = event.target.closest('[data-capture-id]');
    if (!row) return;
    $('#chain-capture').value = row.dataset.captureId;
    loadCaptureDetails(row.dataset.captureId);
    $('#option-chain-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  window.addEventListener('resize', () => { renderChain(); state.optionChart?.chart?.resize(); });
  $('#yolo-backtest-form').addEventListener('submit', runBacktest);
  state.timer = setInterval(() => loadStatus(true), 30000);
}

init().catch((error) => { $('#collector-message').textContent = error.message; $('#collector-message').className = 'yolo-message error'; });
