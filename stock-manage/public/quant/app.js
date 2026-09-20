import { loadPortalContext, canDip } from '../js/portal-auth.js';

const $ = (selector, root = document) => root.querySelector(selector);
const CONFIG_KEY = 'stock-manage:quant-config:v1';
const PREFS_KEY = 'stock-manage:quant-prefs:v1';

const DEFAULT_CONFIG = Object.freeze({
  rsiPeriod: 14,
  rsiOverbought: 58,
  rsiOversold: 42,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  bollingerPeriod: 20,
  bollingerStdDev: 2,
  buyThreshold: 0.25,
  sellThreshold: -0.3
});

const savedConfig = loadJson(CONFIG_KEY, {});

const state = {
  config: { ...DEFAULT_CONFIG, ...savedConfig },
  period: loadJson(PREFS_KEY, {}).period || '1y',
  symbols: [],
  signals: [],
  loading: false,
  updatedAt: null
};

function loadJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

async function api(path) {
  const response = await fetch(`../api${path}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText || '请求失败');
  return data;
}

function normalizeSymbols(raw) {
  return [...new Set(String(raw || '')
    .split(/[，,\s]+/)
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean))]
    .slice(0, 30);
}

function signalLabel(signal) {
  return signal === 'BUY' ? '买入' : signal === 'SELL' ? '卖出' : '观望';
}

function signalClass(signal) {
  return signal === 'BUY' ? 'buy' : signal === 'SELL' ? 'sell' : 'hold';
}

function formatPrice(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? `$${number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
    : '—';
}

function hasNumber(value) {
  return value !== null && value !== '' && Number.isFinite(Number(value));
}

function formatNumber(value, digits = 2) {
  return hasNumber(value) ? Number(value).toFixed(digits) : '—';
}

function formatDate(value, includeTime = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '—';
  return new Date(number).toLocaleString('zh-CN', includeTime
    ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function trendLabel(value) {
  if (value === 'ABOVE_SMA50') return '<span class="quant-trend quant-trend-up">高于 SMA50</span>';
  if (value === 'BELOW_SMA50') return '<span class="quant-trend quant-trend-down">低于 SMA50</span>';
  return '<span class="quant-muted">—</span>';
}

function miniSignal(signal) {
  return `<span class="quant-mini quant-mini-${signalClass(signal)}">${signalLabel(signal)}</span>`;
}

function badge(signal) {
  const icon = signal === 'BUY' ? '↗' : signal === 'SELL' ? '↘' : '—';
  return `<span class="quant-badge quant-badge-${signalClass(signal)}"><b>${icon}</b>${signalLabel(signal)}</span>`;
}

function sourceLabel(source) {
  return source === 'polygon' ? 'Polygon' : source === 'finnhub' ? 'Finnhub' : '行情接口';
}

function strengthBar(signal) {
  const strength = Math.min(100, Math.max(0, Number(signal.strength) || 0));
  if (!strength) return '<span class="quant-muted">—</span>';
  return `<span class="quant-strength quant-strength-${signalClass(signal.signal)}"><i><b style="width:${strength}%"></b></i><em>${strength}%</em></span>`;
}

function signalRow(signal) {
  const change = Number(signal.changePercent);
  const hasChange = hasNumber(signal.changePercent);
  const changeClass = hasChange ? (change > 0 ? 'pos' : change < 0 ? 'neg' : '') : '';
  const changeText = hasChange ? `${change > 0 ? '+' : ''}${change.toFixed(2)}%` : '—';
  const score = Number(signal.combinedScore);
  const scoreClass = Number.isFinite(score) ? (score > 0 ? 'pos' : score < 0 ? 'neg' : '') : '';
  const status = signal.status === 'ok' ? ''
    : `<span class="quant-row-message">${escapeHtml(signal.message || '暂无可用数据')}</span>`;
  const dataInfo = signal.status === 'ok'
    ? `${Number(signal.dataPoints) || 0} 根 · ${formatDate(signal.asOf)} · ${sourceLabel(signal.historySource)}`
    : '未生成指标';
  return `<tr>
    <td><strong class="quant-symbol">${escapeHtml(signal.symbol)}</strong>${signal.name && signal.name !== signal.symbol ? `<span class="quant-name">${escapeHtml(signal.name)}</span>` : ''}${status}</td>
    <td class="align-right"><strong>${formatPrice(signal.price)}</strong><span class="quant-sub ${changeClass}">${changeText}</span></td>
    <td class="align-center">${badge(signal.signal)}</td>
    <td class="align-center">${strengthBar(signal)}</td>
    <td class="align-center"><strong>${formatNumber(signal.rsi, 1)}</strong><span class="quant-sub">${miniSignal(signal.rsiSignal)}</span></td>
    <td class="align-center"><strong>${formatNumber(signal.macd, 4)}</strong><span class="quant-sub">${miniSignal(signal.macdSignal)}</span></td>
    <td class="align-center"><strong>${hasNumber(signal.bollingerPosition) ? `${Number(signal.bollingerPosition).toFixed(1)}%` : '—'}</strong><span class="quant-sub">${miniSignal(signal.bollingerSignal)}</span></td>
    <td class="align-center">${trendLabel(signal.trend)}</td>
    <td class="align-right"><strong class="${scoreClass}">${Number.isFinite(score) ? `${score > 0 ? '+' : ''}${score.toFixed(2)}` : '—'}</strong><span class="quant-sub">${dataInfo}</span></td>
  </tr>`;
}

function renderSignals(message = '') {
  const body = $('#signal-body');
  if (state.loading && !state.signals.length) {
    body.innerHTML = Array.from({ length: 6 }, () => '<tr><td colspan="9"><span class="quant-skeleton"></span></td></tr>').join('');
  } else if (message) {
    body.innerHTML = `<tr><td colspan="9" class="quant-empty quant-error">${escapeHtml(message)}</td></tr>`;
  } else if (!state.signals.length) {
    body.innerHTML = '<tr><td colspan="9" class="quant-empty">暂无分析结果。请输入美股代码，或先在持仓页添加美股正股。</td></tr>';
  } else {
    body.innerHTML = state.signals.map(signalRow).join('');
  }

  const validSignals = state.signals.filter((signal) => signal.status === 'ok');
  $('#buy-count').textContent = validSignals.filter((signal) => signal.signal === 'BUY').length;
  $('#sell-count').textContent = validSignals.filter((signal) => signal.signal === 'SELL').length;
  $('#hold-count').textContent = validSignals.filter((signal) => signal.signal === 'HOLD').length;
  $('#updated-at').textContent = state.updatedAt ? formatDate(state.updatedAt, true) : '尚未分析';
  const failed = state.signals.length - validSignals.length;
  $('#result-note').textContent = state.signals.length
    ? `共 ${state.signals.length} 个标的，${validSignals.length} 个已完成${failed ? `，${failed} 个暂无数据` : ''}`
    : '读取当前美股持仓后自动分析，也可输入自选代码。';
}

function renderConfig() {
  document.querySelectorAll('[data-config]').forEach((input) => {
    input.value = state.config[input.dataset.config];
  });
  $('#period-select').value = state.period;
  $('#rsi-description').textContent = `RSI ≤ ${state.config.rsiOversold} 视为超卖买入，RSI ≥ ${state.config.rsiOverbought} 视为超买卖出，综合权重 35%。`;
  $('#macd-description').textContent = `${state.config.macdFast}/${state.config.macdSlow}/${state.config.macdSignal} 参数下，快慢线金叉为买入、死叉为卖出，综合权重 35%。`;
  $('#bollinger-description').textContent = `${state.config.bollingerPeriod} 日均线 ± ${state.config.bollingerStdDev} 倍标准差，靠近下轨偏买入、靠近上轨偏卖出，综合权重 20%。`;
  $('#formula-description').textContent = `综合评分 = RSI×0.35 + MACD×0.35 + 布林带×0.20 + SMA50/动能修正；评分 > ${state.config.buyThreshold} 为买入，评分 < ${state.config.sellThreshold} 为卖出。`;
}

function readConfigForm() {
  const next = {};
  document.querySelectorAll('[data-config]').forEach((input) => {
    next[input.dataset.config] = Number(input.value);
  });
  return next;
}

function setLoading(loading) {
  state.loading = loading;
  $('#analyze-button').disabled = loading;
  $('#refresh-button').disabled = loading;
  $('#analyze-button').textContent = loading ? '分析中…' : '开始分析';
  $('#refresh-button').textContent = loading ? '刷新中…' : '刷新分析';
}

async function runAnalysis(symbols = state.symbols, period = state.period) {
  state.symbols = symbols;
  state.period = period;
  state.signals = [];
  localStorage.setItem(PREFS_KEY, JSON.stringify({ period }));
  setLoading(true);
  renderSignals();
  let errorMessage = '';
  try {
    const query = new URLSearchParams({
      symbols: symbols.join(','),
      period,
      config: JSON.stringify(state.config)
    });
    const result = await api(`/analysis?${query}`);
    state.signals = Array.isArray(result.signals) ? result.signals : [];
    state.config = { ...state.config, ...(result.config || {}) };
    state.updatedAt = Number(result.timestamp) || Date.now();
    renderConfig();
  } catch (error) {
    errorMessage = error.message || '量化分析失败';
    state.updatedAt = null;
  } finally {
    setLoading(false);
    renderSignals(errorMessage);
  }
}

function applyDipPermissions() {
  document.querySelectorAll('.sm-feature-tab').forEach((link) => {
    const href = link.getAttribute('href') || '';
    if (href.includes('tab=qq')) link.hidden = !canDip('tab-qq');
    else if (href.includes('/dip/')) link.hidden = !canDip('tab-monitor');
  });
}

function bindEvents() {
  $('#analysis-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const symbols = normalizeSymbols($('#symbol-input').value);
    runAnalysis(symbols, $('#period-select').value);
  });
  $('#refresh-button').addEventListener('click', () => runAnalysis(state.symbols, state.period));
  $('#config-toggle').addEventListener('click', () => {
    $('#config-panel').classList.toggle('hidden');
    $('#config-toggle').classList.toggle('active', !$('#config-panel').classList.contains('hidden'));
  });
  $('#config-reset').addEventListener('click', () => {
    state.config = { ...DEFAULT_CONFIG };
    renderConfig();
  });
  $('#config-apply').addEventListener('click', () => {
    state.config = readConfigForm();
    localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config));
    renderConfig();
    runAnalysis(state.symbols, state.period);
  });
}

async function init() {
  await loadPortalContext();
  applyDipPermissions();
  renderConfig();
  bindEvents();
  setLoading(true);
  try {
    const portfolio = await api('/portfolio');
    state.symbols = [...new Set((portfolio.holdings || [])
      .filter((holding) => holding.type !== 'option' && !/^\d{6}$/.test(String(holding.symbol)))
      .map((holding) => String(holding.symbol).toUpperCase()))];
    $('#symbol-input').value = state.symbols.join(', ');
    await runAnalysis(state.symbols, state.period);
  } catch (error) {
    renderSignals(error.message || '读取持仓失败');
    setLoading(false);
  }
}

init();
