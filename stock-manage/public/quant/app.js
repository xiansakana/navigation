import { loadPortalContext, canDip } from '../js/portal-auth.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const DEFAULT_CONFIG = Object.freeze({ rsiPeriod: 14, rsiOverbought: 58, rsiOversold: 42, macdFast: 12, macdSlow: 26, macdSignal: 9, bollingerPeriod: 20, bollingerStdDev: 2, buyThreshold: 0.25, sellThreshold: -0.3 });
const state = { settings: null, signals: [], loading: false, updatedAt: null, klineChart: null, klineSymbol: '' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

async function api(path, options = {}) {
  const response = await fetch(`../api${path}`, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText || '请求失败');
  return data;
}

function normalizeSymbols(raw) {
  return [...new Set(String(raw || '').split(/[，,\s]+/).map((value) => value.trim().toUpperCase()).filter((value) => /^[A-Z0-9][A-Z0-9.-]{0,23}$/.test(value)))].slice(0, 30);
}

function hasNumber(value) { return value !== null && value !== '' && Number.isFinite(Number(value)); }
function formatNumber(value, digits = 2) { return hasNumber(value) ? Number(value).toFixed(digits) : '—'; }
function formatMoney(value) { return hasNumber(value) ? `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'; }
function formatPercent(value, ratio = false) { return hasNumber(value) ? `${Number(value) > 0 ? '+' : ''}${(Number(value) * (ratio ? 100 : 1)).toFixed(2)}%` : '—'; }
function formatDate(value, includeTime = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '—';
  return new Date(number).toLocaleString('zh-CN', includeTime ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' } : { year: 'numeric', month: '2-digit', day: '2-digit' });
}
function sourceLabel(source) { return source === 'polygon' ? 'Polygon' : source === 'sina' ? '新浪财经' : source === 'finnhub' ? 'Finnhub' : '行情接口'; }
function signalLabel(signal) { return signal === 'BUY' ? '买入' : signal === 'SELL' ? '卖出' : '观望'; }
function signalClass(signal) { return signal === 'BUY' ? 'buy' : signal === 'SELL' ? 'sell' : 'hold'; }
function badge(signal) { const icon = signal === 'BUY' ? '↗' : signal === 'SELL' ? '↘' : '—'; return `<span class="quant-badge quant-badge-${signalClass(signal)}"><b>${icon}</b>${signalLabel(signal)}</span>`; }
function miniSignal(signal) { return `<span class="quant-mini quant-mini-${signalClass(signal)}">${signalLabel(signal)}</span>`; }

function trendLabel(value) {
  if (value === 'ABOVE_SMA50') return '<span class="quant-trend quant-trend-up">高于 SMA50</span>';
  if (value === 'BELOW_SMA50') return '<span class="quant-trend quant-trend-down">低于 SMA50</span>';
  return '<span class="quant-muted">—</span>';
}

function strengthBar(item) {
  const strength = Math.min(100, Math.max(0, Number(item.strength) || 0));
  if (!strength) return '<span class="quant-muted">—</span>';
  return `<span class="quant-strength quant-strength-${signalClass(item.signal)}"><i><b style="width:${strength}%"></b></i><em>${strength}%</em></span>`;
}

function signalRow(item) {
  const change = Number(item.changePercent);
  const changeClass = hasNumber(change) ? (change > 0 ? 'pos' : change < 0 ? 'neg' : '') : '';
  const score = Number(item.combinedScore);
  const status = item.status === 'ok' ? '' : `<span class="quant-row-message">${escapeHtml(item.message || '暂无可用数据')}</span>`;
  const dataInfo = item.status === 'ok' ? `${Number(item.dataPoints) || 0} 根 · ${formatDate(item.asOf)} · ${sourceLabel(item.historySource)}` : '未生成指标';
  return `<tr><td><button class="quant-symbol-link" type="button" data-kline-symbol="${escapeHtml(item.symbol)}" data-kline-period="${escapeHtml($('#period-select').value)}">${escapeHtml(item.symbol)}</button>${item.name && item.name !== item.symbol ? `<span class="quant-name">${escapeHtml(item.name)}</span>` : ''}${status}</td><td class="align-right"><strong>${formatMoney(item.price)}</strong><span class="quant-sub ${changeClass}">${formatPercent(item.changePercent)}</span></td><td class="align-center">${badge(item.signal)}</td><td class="align-center">${strengthBar(item)}</td><td class="align-center"><strong>${formatNumber(item.rsi, 1)}</strong><span class="quant-sub">${miniSignal(item.rsiSignal)}</span></td><td class="align-center"><strong>${formatNumber(item.macd, 4)}</strong><span class="quant-sub">${miniSignal(item.macdSignal)}</span></td><td class="align-center"><strong>${hasNumber(item.bollingerPosition) ? `${formatNumber(item.bollingerPosition, 1)}%` : '—'}</strong><span class="quant-sub">${miniSignal(item.bollingerSignal)}</span></td><td class="align-center">${trendLabel(item.trend)}</td><td class="align-right"><strong class="${score > 0 ? 'pos' : score < 0 ? 'neg' : ''}">${Number.isFinite(score) ? `${score > 0 ? '+' : ''}${score.toFixed(2)}` : '—'}</strong><span class="quant-sub">${dataInfo}</span></td></tr>`;
}

function renderSignals(message = '') {
  const body = $('#signal-body');
  if (state.loading && !state.signals.length) body.innerHTML = Array.from({ length: 6 }, () => '<tr><td colspan="9"><span class="quant-skeleton"></span></td></tr>').join('');
  else if (message) body.innerHTML = `<tr><td colspan="9" class="quant-empty quant-error">${escapeHtml(message)}</td></tr>`;
  else if (!state.signals.length) body.innerHTML = '<tr><td colspan="9" class="quant-empty">自选池暂无分析结果。</td></tr>';
  else body.innerHTML = state.signals.map(signalRow).join('');
  const valid = state.signals.filter((item) => item.status === 'ok');
  $('#buy-count').textContent = valid.filter((item) => item.signal === 'BUY').length;
  $('#sell-count').textContent = valid.filter((item) => item.signal === 'SELL').length;
  $('#hold-count').textContent = valid.filter((item) => item.signal === 'HOLD').length;
  $('#updated-at').textContent = state.updatedAt ? formatDate(state.updatedAt, true) : '尚未分析';
  $('#result-note').textContent = state.signals.length ? `自选池 ${state.signals.length} 个标的，${valid.length} 个已完成` : '保存自选标的后开始分析。';
}

function readConfig() {
  const config = {};
  $$('[data-config]').forEach((input) => { config[input.dataset.config] = Number(input.value); });
  return config;
}

function renderConfig() {
  $$('[data-config]').forEach((input) => { input.value = state.settings.config[input.dataset.config]; });
  const config = state.settings.config;
  $('#rsi-description').textContent = `RSI ≤ ${config.rsiOversold} 视为超卖，RSI ≥ ${config.rsiOverbought} 视为超买，权重 35%。`;
  $('#macd-description').textContent = `${config.macdFast}/${config.macdSlow}/${config.macdSignal} 参数下，快慢线金叉为买入、死叉为卖出，权重 35%。`;
  $('#bollinger-description').textContent = `${config.bollingerPeriod} 日均线 ± ${config.bollingerStdDev} 倍标准差，靠近下轨偏买入、靠近上轨偏卖出，权重 20%。`;
  $('#formula-description').textContent = `综合评分叠加 SMA50 趋势修正；评分 > ${config.buyThreshold} 为买入，评分 < ${config.sellThreshold} 为卖出。`;
}

async function saveSettings({ includeWatchlist = true, message = '设置已保存' } = {}) {
  const symbols = includeWatchlist ? normalizeSymbols($('#symbol-input').value) : state.settings.symbols;
  const payload = { ...state.settings, symbols, period: $('#period-select').value, config: readConfig(), paperInitialCapital: Number($('#paper-capital').value) || state.settings.paperInitialCapital, paperPositionPct: (Number($('#paper-position-pct').value) || state.settings.paperPositionPct * 100) / 100 };
  state.settings = await api('/quant/settings', { method: 'PUT', body: JSON.stringify(payload) });
  renderConfig();
  $('#save-status').textContent = message;
  setTimeout(() => { $('#save-status').textContent = ''; }, 2500);
  return state.settings;
}

function setAnalysisLoading(loading) {
  state.loading = loading;
  $('#analyze-button').disabled = loading;
  $('#refresh-button').disabled = loading;
  $('#analyze-button').textContent = loading ? '分析中…' : '开始分析';
  $('#refresh-button').textContent = loading ? '刷新中…' : '刷新分析';
}

async function runAnalysis() {
  const symbols = normalizeSymbols($('#symbol-input').value);
  if (!symbols.length) return renderSignals('请至少输入一个有效美股代码');
  state.signals = [];
  setAnalysisLoading(true);
  renderSignals();
  let error = '';
  try {
    const query = new URLSearchParams({ symbols: symbols.join(','), period: $('#period-select').value, config: JSON.stringify(state.settings.config) });
    const result = await api(`/analysis?${query}`);
    state.signals = result.signals || [];
    state.updatedAt = result.timestamp || Date.now();
  } catch (reason) { error = reason.message || '量化分析失败'; state.updatedAt = null; }
  finally { setAnalysisLoading(false); renderSignals(error); }
}

function showView(view) {
  const valid = ['dashboard', 'strategy', 'backtest', 'paper'].includes(view) ? view : 'dashboard';
  $$('.quant-nav').forEach((button) => button.classList.toggle('active', button.dataset.view === valid));
  $$('.quant-view').forEach((panel) => panel.classList.toggle('active', panel.dataset.viewPanel === valid));
  const url = new URL(location.href);
  if (valid === 'dashboard') url.searchParams.delete('view'); else url.searchParams.set('view', valid);
  history.replaceState(null, '', url);
}

function backtestTradeRows(item) {
  if (!item.trades?.length) return '<p class="quant-trades-empty">该标的在回测区间内没有触发买卖操作。</p>';
  const rows = item.trades.map((trade, index) => `<tr><td>${index + 1}</td><td>${formatDate(trade.timestamp)}</td><td class="${trade.side === 'BUY' ? 'pos' : 'neg'}">${trade.side === 'BUY' ? '买入' : '卖出'}</td><td class="align-right">${formatMoney(trade.price)}</td><td class="align-right">${formatNumber(trade.shares, 4)}</td><td class="align-right ${hasNumber(trade.pnl) ? (trade.pnl >= 0 ? 'pos' : 'neg') : ''}">${hasNumber(trade.pnl) ? formatMoney(trade.pnl) : '—'}</td></tr>`).join('');
  return `<div class="quant-trades-title"><strong>${escapeHtml(item.symbol)} 买卖操作记录</strong><span>${item.trades.length} 次操作${item.openPosition ? ' · 期末仍持仓' : ''}</span></div><div class="quant-trades-scroll"><table class="quant-trades-table"><thead><tr><th>#</th><th>日期</th><th>方向</th><th class="align-right">成交价</th><th class="align-right">数量</th><th class="align-right">已实现盈亏</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function backtestResultRows(results, period) {
  return results.map((item) => {
    if (item.status !== 'ok') return `<tr><td><strong>${escapeHtml(item.symbol)}</strong></td><td colspan="7" class="quant-error">${escapeHtml(item.message)}</td></tr>`;
    const symbol = escapeHtml(item.symbol);
    return `<tr class="quant-backtest-result"><td><button class="quant-symbol-link" type="button" data-kline-symbol="${symbol}" data-kline-period="${escapeHtml(period)}">${symbol}</button></td><td class="align-right">${formatMoney(item.finalEquity)}</td><td class="align-right ${item.totalReturn >= 0 ? 'pos' : 'neg'}">${formatPercent(item.totalReturn, true)}</td><td class="align-right ${item.buyHoldReturn >= 0 ? 'pos' : 'neg'}">${formatPercent(item.buyHoldReturn, true)}</td><td class="align-right neg">${formatPercent(-item.maxDrawdown, true)}</td><td class="align-right">${item.completedTrades}</td><td>${sourceLabel(item.historySource)}</td><td class="align-center"><button type="button" class="quant-expand-button" data-toggle-trades="${symbol}" aria-expanded="false">展开 <span>⌄</span></button></td></tr><tr class="quant-trade-detail hidden" data-trades-for="${symbol}"><td colspan="8">${backtestTradeRows(item)}</td></tr>`;
  }).join('');
}

function closeKline() {
  state.klineChart?.dispose();
  state.klineChart = null;
  state.klineSymbol = '';
  $('#modal-root').innerHTML = '';
}

function klineOption(candles) {
  const dates = candles.map((item) => new Date(Number(item.timestamp)).toISOString().slice(0, 10));
  const values = candles.map((item) => [Number(item.open), Number(item.close), Number(item.low), Number(item.high)]);
  const volumes = candles.map((item, index) => [index, Number(item.volume) || 0, Number(item.close) >= Number(item.open) ? 1 : -1]);
  return {
    animation: false,
    backgroundColor: 'transparent',
    legend: { show: false },
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' }, backgroundColor: '#171c25', borderColor: '#30394a', textStyle: { color: '#e6edf7' } },
    axisPointer: { link: [{ xAxisIndex: 'all' }], label: { backgroundColor: '#465267' } },
    grid: [{ left: 62, right: 24, top: 18, height: '62%' }, { left: 62, right: 24, top: '75%', height: '14%' }],
    xAxis: [{ type: 'category', data: dates, boundaryGap: true, axisLine: { lineStyle: { color: '#465267' } }, axisLabel: { color: '#8f9bad' }, min: 'dataMin', max: 'dataMax' }, { type: 'category', gridIndex: 1, data: dates, boundaryGap: true, axisLabel: { show: false }, axisLine: { lineStyle: { color: '#465267' } }, axisTick: { show: false }, min: 'dataMin', max: 'dataMax' }],
    yAxis: [{ scale: true, splitLine: { lineStyle: { color: 'rgba(148,163,184,.12)' } }, axisLabel: { color: '#8f9bad' } }, { scale: true, gridIndex: 1, splitNumber: 2, axisLabel: { color: '#8f9bad', formatter: (value) => value >= 1000000 ? `${(value / 1000000).toFixed(1)}M` : `${(value / 1000).toFixed(0)}K` }, splitLine: { show: false } }],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1], start: Math.max(0, 100 - Math.min(100, 90 / candles.length * 100)), end: 100 }, { show: true, xAxisIndex: [0, 1], type: 'slider', bottom: 4, height: 20, borderColor: '#30394a', fillerColor: 'rgba(91,156,255,.16)', textStyle: { color: '#8f9bad' } }],
    visualMap: { show: false, seriesIndex: 1, dimension: 2, pieces: [{ value: 1, color: '#3ddc84' }, { value: -1, color: '#ff7b7b' }] },
    series: [{ name: 'K 线', type: 'candlestick', data: values, itemStyle: { color: '#3ddc84', color0: '#ff7b7b', borderColor: '#3ddc84', borderColor0: '#ff7b7b' } }, { name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: volumes }]
  };
}

async function loadKline(symbol, period) {
  const status = $('#kline-status');
  const host = $('#kline-chart');
  status.textContent = '正在加载真实历史行情…';
  state.klineChart?.dispose();
  state.klineChart = null;
  try {
    const result = await api(`/quant/history/${encodeURIComponent(symbol)}?period=${encodeURIComponent(period)}`);
    status.textContent = `${result.candles.length} 根日 K · ${sourceLabel(result.source)}`;
    if (!globalThis.echarts) throw new Error('图表组件加载失败');
    state.klineChart = globalThis.echarts.init(host, null, { renderer: 'canvas' });
    state.klineChart.setOption(klineOption(result.candles));
  } catch (error) {
    status.textContent = error.message || 'K 线加载失败';
    host.innerHTML = `<div class="quant-kline-error">${escapeHtml(error.message || 'K 线加载失败')}</div>`;
  }
}

function showKline(symbol, period = '1y') {
  state.klineSymbol = symbol;
  const root = $('#modal-root');
  root.innerHTML = `<div class="sm-modal-backdrop quant-kline-backdrop"><div class="sm-modal sm-modal--xl quant-kline-modal" role="dialog" aria-modal="true" aria-labelledby="kline-title"><div class="sm-modal-head"><div><h3 id="kline-title">${escapeHtml(symbol)} · 日 K 线</h3><p id="kline-status">准备加载行情…</p></div><button type="button" class="btn link" data-kline-close>关闭</button></div><div class="quant-kline-toolbar"><label>历史范围 <select id="kline-period"><option value="3m">近 3 个月</option><option value="6m">近 6 个月</option><option value="1y">近 1 年</option><option value="2y">近 2 年</option><option value="5y">近 5 年</option></select></label><span>拖动底部缩放条可查看区间行情</span></div><div class="sm-modal-body quant-kline-body"><div id="kline-chart"></div></div></div></div>`;
  $('#kline-period').value = period;
  root.querySelector('[data-kline-close]').addEventListener('click', closeKline);
  root.querySelector('.quant-kline-backdrop').addEventListener('click', (event) => { if (event.target.classList.contains('quant-kline-backdrop')) closeKline(); });
  $('#kline-period').addEventListener('change', (event) => loadKline(symbol, event.target.value));
  loadKline(symbol, period);
}

async function runBacktest() {
  const button = $('#backtest-button');
  button.disabled = true; button.textContent = '回测中…';
  $('#backtest-body').innerHTML = '<tr><td colspan="8"><span class="quant-skeleton"></span></td></tr>';
  try {
    const result = await api('/quant/backtest', { method: 'POST', body: JSON.stringify({ symbols: state.settings.symbols, period: $('#backtest-period').value, initialCapital: Number($('#backtest-capital').value), config: state.settings.config }) });
    $('#bt-equity').textContent = formatMoney(result.finalEquity);
    $('#bt-return').textContent = formatPercent(result.totalReturn, true);
    $('#bt-return').className = result.totalReturn >= 0 ? 'pos' : 'neg';
    $('#bt-drawdown').textContent = formatPercent(-result.maxDrawdown, true);
    $('#bt-winrate').textContent = `${formatPercent(result.winRate, true)} / ${result.completedTrades}`;
    $('#backtest-note').textContent = `${result.results.filter((item) => item.status === 'ok').length}/${result.results.length} 个标的完成，买入持有同期平均 ${formatPercent(result.buyHoldReturn, true)}`;
    $('#backtest-body').innerHTML = backtestResultRows(result.results, result.period);
  } catch (error) { $('#backtest-body').innerHTML = `<tr><td colspan="8" class="quant-empty quant-error">${escapeHtml(error.message)}</td></tr>`; }
  finally { button.disabled = false; button.textContent = '运行回测'; }
}

function renderPaper(paper) {
  $('#paper-equity').textContent = formatMoney(paper.totalEquity);
  $('#paper-cash').textContent = formatMoney(paper.cash);
  $('#paper-market-value').textContent = formatMoney(paper.holdingsValue);
  $('#paper-return').textContent = formatPercent(paper.totalReturn, true);
  $('#paper-return').className = paper.totalReturn >= 0 ? 'pos' : 'neg';
  $('#paper-note').textContent = paper.updatedAt ? `最后同步 ${formatDate(paper.updatedAt, true)} · 当前 ${paper.holdings.length} 个持仓` : '尚未同步策略信号。';
  $('#paper-holdings-body').innerHTML = paper.holdings.length ? paper.holdings.map((item) => `<tr><td><strong class="quant-symbol">${escapeHtml(item.symbol)}</strong></td><td class="align-right">${formatNumber(item.shares, 4)}</td><td class="align-right">${formatMoney(item.avgCost)}</td><td class="align-right">${formatMoney(item.price)}</td><td class="align-right">${formatMoney(item.marketValue)}</td><td class="align-right ${item.pnl >= 0 ? 'pos' : 'neg'}">${formatMoney(item.pnl)}</td><td class="align-center">${badge(item.signal)}</td></tr>`).join('') : '<tr><td colspan="7" class="quant-empty">当前空仓，等待买入信号。</td></tr>';
  const trades = [...(paper.trades || [])].reverse();
  $('#paper-trades-body').innerHTML = trades.length ? trades.map((item) => `<tr><td>${formatDate(item.timestamp, true)}</td><td><strong>${escapeHtml(item.symbol)}</strong></td><td class="${item.side === 'BUY' ? 'pos' : 'neg'}">${item.side === 'BUY' ? '买入' : '卖出'}</td><td class="align-right">${formatNumber(item.shares, 4)}</td><td class="align-right">${formatMoney(item.price)}</td><td class="align-right">${formatMoney(item.amount)}${hasNumber(item.pnl) ? `<span class="quant-sub ${item.pnl >= 0 ? 'pos' : 'neg'}">盈亏 ${formatMoney(item.pnl)}</span>` : ''}</td></tr>`).join('') : '<tr><td colspan="6" class="quant-empty">暂无模拟交易。</td></tr>';
}

async function loadPaper() { renderPaper(await api('/quant/paper')); }

function applyDipPermissions() {
  $$('.sm-feature-tab').forEach((link) => { const href = link.getAttribute('href') || ''; if (href.includes('tab=qq')) link.hidden = !canDip('tab-qq'); else if (href.includes('/dip/')) link.hidden = !canDip('tab-monitor'); });
}

function bindEvents() {
  $$('.quant-nav').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
  $('#analysis-form').addEventListener('submit', (event) => { event.preventDefault(); runAnalysis(); });
  $('#refresh-button').addEventListener('click', runAnalysis);
  $('#save-watchlist').addEventListener('click', async () => { await saveSettings({ message: '自选池已保存' }); await runAnalysis(); });
  $('#config-reset').addEventListener('click', () => { state.settings.config = { ...DEFAULT_CONFIG }; renderConfig(); });
  $('#config-save').addEventListener('click', async () => { await saveSettings({ includeWatchlist: false, message: '策略参数已保存' }); await runAnalysis(); });
  $('#backtest-form').addEventListener('submit', (event) => { event.preventDefault(); runBacktest(); });
  $('#paper-settings-save').addEventListener('click', () => saveSettings({ includeWatchlist: false, message: '模拟盘设置已保存；重置后初始资金生效' }));
  $('#paper-sync').addEventListener('click', async () => { const button = $('#paper-sync'); button.disabled = true; button.textContent = '同步中…'; try { const result = await api('/quant/paper/sync', { method: 'POST', body: '{}' }); renderPaper(result); } catch (error) { $('#paper-note').textContent = error.message; } finally { button.disabled = false; button.textContent = '同步信号并交易'; } });
  $('#paper-reset').addEventListener('click', async () => { if (!confirm('确定清空全部模拟持仓和交易记录？')) return; const result = await api('/quant/paper/reset', { method: 'POST', body: JSON.stringify({ initialCapital: Number($('#paper-capital').value) }) }); renderPaper(result); });
  document.addEventListener('click', (event) => {
    const symbolButton = event.target.closest('[data-kline-symbol]');
    if (symbolButton) {
      showKline(symbolButton.dataset.klineSymbol, symbolButton.dataset.klinePeriod || '1y');
      return;
    }
    const toggle = event.target.closest('[data-toggle-trades]');
    if (!toggle) return;
    const detail = $$('[data-trades-for]', $('#backtest-body')).find((row) => row.dataset.tradesFor === toggle.dataset.toggleTrades);
    if (!detail) return;
    const expanded = !detail.classList.toggle('hidden');
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.innerHTML = `${expanded ? '收起' : '展开'} <span>${expanded ? '⌃' : '⌄'}</span>`;
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && state.klineSymbol) closeKline(); });
  window.addEventListener('resize', () => state.klineChart?.resize());
}

async function init() {
  await loadPortalContext();
  applyDipPermissions();
  state.settings = await api('/quant/settings');
  $('#symbol-input').value = state.settings.symbols.join(', ');
  $('#period-select').value = state.settings.period;
  $('#backtest-period').value = state.settings.period === '3m' ? '6m' : state.settings.period;
  $('#paper-capital').value = state.settings.paperInitialCapital;
  $('#paper-position-pct').value = Math.round(state.settings.paperPositionPct * 100);
  renderConfig(); bindEvents(); showView(new URLSearchParams(location.search).get('view') || 'dashboard');
  await Promise.all([runAnalysis(), loadPaper()]);
}

init().catch((error) => { $('#signal-body').innerHTML = `<tr><td colspan="9" class="quant-empty quant-error">${escapeHtml(error.message)}</td></tr>`; });
