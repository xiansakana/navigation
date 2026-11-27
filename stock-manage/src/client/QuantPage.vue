<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { can, canDip, loadPortalContext } from '../../public/js/portal-auth.js';
import {
  backtestResultRows, formatDate, formatMoney, formatNumber, formatPercent, hasNumber,
  renderBacktestHistory, renderPaper as renderPaperTables, renderReturnChart, renderSignalBody
} from './quant-views';
import KlineModal from './KlineModal.vue';

const DEFAULT_CONFIG = Object.freeze({
  rsiPeriod: 14, rsiOverbought: 58, rsiOversold: 42, macdFast: 12, macdSlow: 26, macdSignal: 9,
  bollingerPeriod: 20, bollingerStdDev: 2, buyThreshold: 0.25, sellThreshold: -0.3
});

async function api(path: string, options: any = {}) {
  const response = await fetch(`../api${path}`, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText || '请求失败');
  return data;
}

function normalizeSymbols(raw: string) {
  return [...new Set(String(raw || '').split(/[，,\s]+/).map((value) => value.trim().toUpperCase())
    .filter((value) => /^[A-Z0-9][A-Z0-9.-]{0,23}$/.test(value)))].slice(0, 30);
}

const ctxTick = ref(0);
const canP = (feature: string, action = 'view') => { ctxTick.value; return can(feature, action); };
const canDipP = (feature: string, action = 'view') => { ctxTick.value; return canDip(feature, action); };

const views = [
  { id: 'dashboard', perm: 'quant-dashboard' },
  { id: 'strategy', perm: 'quant-strategy' },
  { id: 'backtest', perm: 'quant-backtest' },
  { id: 'paper', perm: 'quant-paper' }
];
const view = ref('dashboard');
const availableViews = computed(() => { ctxTick.value; return views.filter((item) => can(item.perm)).map((item) => item.id); });

const settings = ref<any>(null);
const config = reactive<any>({ ...DEFAULT_CONFIG });
const signals = ref<any[]>([]);
const signalsLoading = ref(false);
const signalsError = ref('');
const updatedAt = ref<number | null>(null);
const symbolsInput = ref('');
const backtestSymbolsInput = ref('');
const period = ref('1y');
const backtestPeriod = ref('1y');
const backtestCapital = ref(100000);
const paperCapital = ref(100000);
const paperPositionPct = ref(10);
const saveStatus = ref('');
const paper = ref<any>({ holdings: [], trades: [] });
const paperBusy = ref(false);
const paperNote = ref('尚未同步策略信号。');
const backtestHistory = ref<any[]>([]);
const activeBacktestId = ref('');
const backtestResult = ref<any>(null);
const overviewVisible = ref(false);
const backtestBusy = ref(false);
const backtestNote = ref('设置资金和范围后运行回测。');
const kline = ref<{ symbol: string; period: string } | null>(null);

const signalBodyEl = ref<HTMLElement | null>(null);
const historyHostEl = ref<HTMLElement | null>(null);
const backtestBodyEl = ref<HTMLElement | null>(null);
const overviewCardEl = ref<HTMLElement | null>(null);
const overviewChartEl = ref<HTMLElement | null>(null);
const paperHoldingsEl = ref<HTMLElement | null>(null);
const paperTradesEl = ref<HTMLElement | null>(null);
const charts = new Map<string, any>();

const signalStats = computed(() => {
  const valid = signals.value.filter((item) => item.status === 'ok');
  return {
    buy: valid.filter((item) => item.signal === 'BUY').length,
    sell: valid.filter((item) => item.signal === 'SELL').length,
    hold: valid.filter((item) => item.signal === 'HOLD').length,
    updated: updatedAt.value ? formatDate(updatedAt.value, true) : '尚未分析',
    note: signals.value.length ? `自选池 ${signals.value.length} 个标的，${valid.length} 个已完成` : '保存自选标的后开始分析。'
  };
});

const configDescriptions = computed(() => ({
  rsi: `RSI ≤ ${config.rsiOversold} 视为超卖，RSI ≥ ${config.rsiOverbought} 视为超买，权重 35%。`,
  macd: `${config.macdFast}/${config.macdSlow}/${config.macdSignal} 参数下，快慢线金叉为买入、死叉为卖出，权重 35%。`,
  bollinger: `${config.bollingerPeriod} 日均线 ± ${config.bollingerStdDev} 倍标准差，靠近下轨偏买入、靠近上轨偏卖出，权重 20%。`,
  formula: `综合评分叠加 SMA50 趋势修正；评分 > ${config.buyThreshold} 为买入，评分 < ${config.sellThreshold} 为卖出。`
}));

const backtestStats = computed(() => {
  const result = backtestResult.value;
  if (!result) return { equity: '—', total: '—', totalClass: '', drawdown: '—', winrate: '—' };
  return {
    equity: formatMoney(result.finalEquity),
    total: formatPercent(result.totalReturn, true),
    totalClass: result.totalReturn >= 0 ? 'pos' : 'neg',
    drawdown: formatPercent(-result.maxDrawdown, true),
    winrate: `${formatPercent(result.winRate, true)} / ${result.completedTrades}`
  };
});

const paperStats = computed(() => {
  const current = paper.value || {};
  return {
    equity: formatMoney(current.totalEquity),
    cash: formatMoney(current.cash),
    marketValue: formatMoney(current.holdingsValue),
    total: formatPercent(current.totalReturn, true),
    totalClass: current.totalReturn >= 0 ? 'pos' : 'neg'
  };
});

function setSymbolInputs(value: string, source: string | null = null) {
  if (symbolsInput.value !== value && source !== 'watchlist') symbolsInput.value = value;
  if (backtestSymbolsInput.value !== value && source !== 'backtest') backtestSymbolsInput.value = value;
  if (settings.value) settings.value.symbols = normalizeSymbols(value);
}

function showView(requested: string) {
  const valid = availableViews.value.includes(requested) ? requested : availableViews.value[0];
  if (!valid) return;
  view.value = valid;
  const url = new URL(location.href);
  if (valid === 'dashboard') url.searchParams.delete('view'); else url.searchParams.set('view', valid);
  history.replaceState(null, '', url);
}

function renderSignals() {
  if (!signalBodyEl.value) return;
  renderSignalBody(signalBodyEl.value, {
    signals: signals.value,
    loading: signalsLoading.value,
    error: signalsError.value,
    canHistory: canP('quant-history'),
    period: period.value
  });
}

async function runAnalysis() {
  const list = normalizeSymbols(symbolsInput.value);
  signalsError.value = '';
  if (!list.length) { signalsError.value = '请至少输入一个有效美股代码'; renderSignals(); return; }
  signals.value = [];
  signalsLoading.value = true;
  renderSignals();
  try {
    const query = new URLSearchParams({ symbols: list.join(','), period: period.value, config: JSON.stringify(config) });
    const result = await api(`/analysis?${query}`);
    signals.value = result.signals || [];
    updatedAt.value = result.timestamp || Date.now();
  } catch (reason: any) {
    signalsError.value = reason.message || '量化分析失败';
    updatedAt.value = null;
  } finally {
    signalsLoading.value = false;
    renderSignals();
  }
}

async function saveSettings({ scope = 'watchlist', source = 'watchlist', message = '设置已保存' }: any = {}) {
  const payload: any = { scope };
  if (scope === 'watchlist') {
    payload.symbols = normalizeSymbols(source === 'backtest' ? backtestSymbolsInput.value : symbolsInput.value);
    payload.period = source === 'backtest' ? settings.value.period : period.value;
  } else if (scope === 'config') {
    payload.config = { ...config };
  } else {
    payload.paperInitialCapital = Number(paperCapital.value) || settings.value.paperInitialCapital;
    payload.paperPositionPct = (Number(paperPositionPct.value) || settings.value.paperPositionPct * 100) / 100;
  }
  settings.value = await api('/quant/settings', { method: 'PUT', body: JSON.stringify(payload) });
  setSymbolInputs((settings.value.symbols || []).join(', '));
  saveStatus.value = message;
  setTimeout(() => { saveStatus.value = ''; }, 2500);
  return settings.value;
}

async function loadBacktestHistory() {
  const result = await api('/quant/backtests?limit=20');
  backtestHistory.value = result.items || [];
  renderHistory();
}

function renderHistory() {
  if (!historyHostEl.value) return;
  renderBacktestHistory(historyHostEl.value, backtestHistory.value, activeBacktestId.value, canP('quant-backtest-delete', 'edit'));
}

function renderPaper() {
  if (!paperHoldingsEl.value || !paperTradesEl.value) return;
  renderPaperTables(paperHoldingsEl.value, paperTradesEl.value, paper.value);
}

async function loadPaper() {
  paper.value = await api('/quant/paper');
  paperNote.value = paper.value.updatedAt
    ? `最后同步 ${formatDate(paper.value.updatedAt, true)} · 当前 ${paper.value.holdings.length} 个持仓`
    : '尚未同步策略信号。';
  renderPaper();
}

function renderBacktestResult(result: any) {
  activeBacktestId.value = result.id || '';
  backtestResult.value = result;
  backtestNote.value = `${result.results.filter((item: any) => item.status === 'ok').length}/${result.results.length} 个标的完成，`
    + `${(result.period ? ({ '3m': '近 3 个月', '6m': '近 6 个月', '1y': '近 1 年', '2y': '近 2 年', '5y': '近 5 年' } as any)[result.period] : result.period) || result.period}`
    + `${result.from && result.to ? `，实际区间 ${formatDate(result.from)} 至 ${formatDate(result.to)}` : ''}`
    + `，买入持有同期平均 ${formatPercent(result.buyHoldReturn, true)}`;
  charts.forEach((chart) => chart.dispose());
  charts.clear();
  nextTick(() => {
    if (backtestBodyEl.value) backtestBodyEl.value.innerHTML = backtestResultRows(result.results, result.period, canP('quant-history'));
    overviewVisible.value = true;
    nextTick(() => {
      if (overviewChartEl.value) renderReturnChart('overview', overviewChartEl.value, result.equityCurve, result.initialCapital, [], charts);
    });
    renderHistory();
  });
  if (result.results?.length) setSymbolInputs(result.results.map((item: any) => item.symbol).join(', '));
  if (result.period) backtestPeriod.value = result.period;
  if (result.initialCapital) backtestCapital.value = result.initialCapital;
}

function clearBacktestResult() {
  activeBacktestId.value = '';
  backtestResult.value = null;
  overviewVisible.value = false;
  charts.forEach((chart) => chart.dispose());
  charts.clear();
  backtestNote.value = '设置资金和范围后运行回测。';
  if (backtestBodyEl.value) backtestBodyEl.value.innerHTML = '<tr><td colspan="8" class="quant-empty">尚未运行回测</td></tr>';
}

async function runBacktest() {
  if (backtestBusy.value) return;
  backtestBusy.value = true;
  if (backtestBodyEl.value) backtestBodyEl.value.innerHTML = '<tr><td colspan="8"><span class="quant-skeleton"></span></td></tr>';
  try {
    const list = normalizeSymbols(backtestSymbolsInput.value);
    if (!list.length) throw new Error('请至少输入一个有效美股代码');
    const result = await api('/quant/backtest', {
      method: 'POST',
      body: JSON.stringify({ symbols: list, period: backtestPeriod.value, initialCapital: Number(backtestCapital.value), config })
    });
    backtestHistory.value.unshift({
      id: result.id, createdAt: result.createdAt, period: result.period,
      symbols: result.results.map((item: any) => item.symbol), initialCapital: result.initialCapital,
      finalEquity: result.finalEquity, totalReturn: result.totalReturn, buyHoldReturn: result.buyHoldReturn,
      completedTrades: result.completedTrades, from: result.from, to: result.to
    });
    backtestHistory.value = backtestHistory.value.slice(0, 20);
    renderBacktestResult(result);
  } catch (error: any) {
    if (backtestBodyEl.value) backtestBodyEl.value.innerHTML = `<tr><td colspan="8" class="quant-empty quant-error">${error.message}</td></tr>`;
  } finally {
    backtestBusy.value = false;
  }
}

async function loadBacktest(id: string) {
  try {
    renderBacktestResult(await api(`/quant/backtests/${encodeURIComponent(id)}`));
  } catch (error: any) {
    backtestNote.value = error.message;
  }
}

async function deleteBacktest(id: string) {
  const ok = (window as any).portalDialog?.confirm
    ? await (window as any).portalDialog.confirm('确定删除这条历史回测记录？', { title: '删除确认', danger: true, okText: '删除' })
    : window.confirm('确定删除这条历史回测记录？');
  if (!ok) return;
  try {
    await api(`/quant/backtests/${encodeURIComponent(id)}`, { method: 'DELETE' });
    backtestHistory.value = backtestHistory.value.filter((item) => item.id !== id);
    if (activeBacktestId.value === id) clearBacktestResult();
    renderHistory();
  } catch (error: any) {
    backtestNote.value = error.message;
  }
}

function onBacktestClick(event: any) {
  const deleteBtn = event.target.closest('[data-delete-backtest]');
  if (deleteBtn) { void deleteBacktest(deleteBtn.dataset.deleteBacktest); return; }
  const loadBtn = event.target.closest('[data-load-backtest]');
  if (loadBtn) { void loadBacktest(loadBtn.dataset.loadBacktest); return; }
  const klineBtn = event.target.closest('[data-kline-symbol]');
  if (klineBtn) {
    kline.value = { symbol: klineBtn.dataset.klineSymbol, period: klineBtn.dataset.klinePeriod || '1y' };
    return;
  }
  const toggle = event.target.closest('[data-toggle-trades]');
  if (!toggle || !backtestBodyEl.value) return;
  const detail = [...backtestBodyEl.value.querySelectorAll('[data-trades-for]')]
    .find((row: any) => row.dataset.tradesFor === toggle.dataset.toggleTrades) as HTMLElement | undefined;
  if (!detail) return;
  const expanded = !detail.classList.toggle('hidden');
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.innerHTML = `${expanded ? '收起' : '展开'} <span>${expanded ? '⌃' : '⌄'}</span>`;
  const symbol = toggle.dataset.toggleTrades;
  if (expanded) {
    const item = backtestResult.value?.results?.find((row: any) => row.symbol === symbol);
    renderReturnChart(`symbol:${symbol}`, detail.querySelector('[data-return-chart]'), item?.equityCurve, item?.initialCapital, item?.trades, charts);
  } else {
    charts.get(`symbol:${symbol}`)?.dispose();
    charts.delete(`symbol:${symbol}`);
  }
}

async function syncPaper() {
  if (paperBusy.value) return;
  paperBusy.value = true;
  try {
    paper.value = await api('/quant/paper/sync', { method: 'POST', body: '{}' });
    paperNote.value = paper.value.updatedAt
      ? `最后同步 ${formatDate(paper.value.updatedAt, true)} · 当前 ${paper.value.holdings.length} 个持仓`
      : '尚未同步策略信号。';
    renderPaper();
  } catch (error: any) {
    paperNote.value = error.message;
  } finally {
    paperBusy.value = false;
  }
}

async function resetPaper() {
  const ok = (window as any).portalDialog?.confirm
    ? await (window as any).portalDialog.confirm('确定清空全部模拟持仓和交易记录？', { title: '重置模拟盘', danger: true, okText: '重置' })
    : window.confirm('确定清空全部模拟持仓和交易记录？');
  if (!ok) return;
  paper.value = await api('/quant/paper/reset', { method: 'POST', body: JSON.stringify({ initialCapital: Number(paperCapital.value) }) });
  renderPaper();
}

function onSignalClick(event: any) {
  const button = event.target.closest('[data-kline-symbol]');
  if (!button) return;
  kline.value = { symbol: button.dataset.klineSymbol, period: button.dataset.klinePeriod || '1y' };
}

function resetConfig() {
  Object.assign(config, DEFAULT_CONFIG);
}

function onResize() { charts.forEach((chart) => chart.resize()); }

onMounted(async () => {
  await loadPortalContext();
  ctxTick.value++;
  try {
    settings.value = await api('/quant/settings');
    Object.assign(config, settings.value.config || {});
    symbolsInput.value = (settings.value.symbols || []).join(', ');
    backtestSymbolsInput.value = symbolsInput.value;
    period.value = settings.value.period || '1y';
    backtestPeriod.value = settings.value.backtestPeriod || (settings.value.period === '3m' ? '6m' : settings.value.period) || '1y';
    backtestCapital.value = settings.value.backtestInitialCapital || 100000;
    paperCapital.value = settings.value.paperInitialCapital;
    paperPositionPct.value = Math.round(settings.value.paperPositionPct * 100);
    showView(new URLSearchParams(location.search).get('view') || 'dashboard');
    const tasks: Promise<any>[] = [];
    if (canP('quant-analysis-run', 'edit')) tasks.push(runAnalysis());
    if (canP('quant-paper')) tasks.push(loadPaper());
    if (canP('quant-backtest')) tasks.push(loadBacktestHistory());
    await Promise.all(tasks);
  } catch (error: any) {
    signalsError.value = error.message;
    if (signalBodyEl.value) renderSignals();
  } finally {
    renderSignals();
    renderPaper();
    renderHistory();
    if (!backtestResult.value && backtestBodyEl.value) {
      backtestBodyEl.value.innerHTML = '<tr><td colspan="8" class="quant-empty">尚未运行回测</td></tr>';
    }
    window.navigationSkeleton?.finish?.();
  }
  window.addEventListener('resize', onResize);
});

onUnmounted(() => {
  charts.forEach((chart) => chart.dispose());
  charts.clear();
  window.removeEventListener('resize', onResize);
});

watch([signals, signalsLoading, signalsError], () => renderSignals());
watch(paper, () => renderPaper(), { deep: false });
watch(backtestHistory, () => renderHistory());
</script>

<template>
  <nav class="sm-feature-tabs" aria-label="股票功能">
    <a class="sm-feature-tab" href="/stock-manage/">持仓</a>
    <a v-if="canDipP('tab-monitor')" class="sm-feature-tab" href="/stock-manage/dip/">抄底监控</a>
    <a v-if="canP('tab-quant')" class="sm-feature-tab active" href="/stock-manage/quant/">量化分析</a>
  </nav>

  <div class="quant-shell">
    <aside class="quant-sidebar">
      <div class="quant-brand"><span>↗</span><div><strong>QUANT</strong><small>REAL MARKET</small></div></div>
      <nav aria-label="量化分析功能">
        <button class="quant-nav" :class="{ active: view === 'dashboard' }" v-if="canP('quant-dashboard')" type="button" @click="showView('dashboard')"><span>▦</span><b>Dashboard</b><small>信号总览</small></button>
        <button class="quant-nav" :class="{ active: view === 'strategy' }" v-if="canP('quant-strategy')" type="button" @click="showView('strategy')"><span>⌁</span><b>Strategy</b><small>策略参数</small></button>
        <button class="quant-nav" :class="{ active: view === 'backtest' }" v-if="canP('quant-backtest')" type="button" @click="showView('backtest')"><span>◫</span><b>Backtest</b><small>历史回测</small></button>
        <button class="quant-nav" :class="{ active: view === 'paper' }" v-if="canP('quant-paper')" type="button" @click="showView('paper')"><span>◎</span><b>模拟盘</b><small>虚拟交易</small></button>
      </nav>
      <p>真实证券行情<br>研究用途，不构成投资建议</p>
    </aside>

    <div class="quant-content">
      <section class="quant-view" :class="{ active: view === 'dashboard' }">
        <header class="quant-header">
          <div><div class="quant-eyebrow">REAL MARKET · DAILY SIGNALS</div><h1>量化仪表盘</h1><p>自选标的独立于真实持仓，可随时修改并保存到服务器。</p></div>
          <button v-if="canP('quant-analysis-run', 'edit')" class="btn ghost" type="button" :disabled="signalsLoading" @click="runAnalysis">{{ signalsLoading ? '刷新中…' : '刷新分析' }}</button>
        </header>
        <form class="quant-toolbar" @submit.prevent="runAnalysis">
          <label class="quant-symbol-field"><span>分析标的</span><input v-model="symbolsInput" autocomplete="off" placeholder="AAPL, MSFT, NVDA" @input="setSymbolInputs(symbolsInput, 'watchlist')"></label>
          <label><span>历史范围</span><select v-model="period"><option value="3m">近 3 个月</option><option value="6m">近 6 个月</option><option value="1y">近 1 年</option><option value="2y">近 2 年</option><option value="5y">近 5 年</option></select></label>
          <button v-if="canP('quant-watchlist', 'edit')" class="btn ghost" type="button" @click="saveSettings({ scope: 'watchlist', source: 'watchlist', message: '自选池已保存' }).then(runAnalysis)">保存自选池</button>
          <button v-if="canP('quant-analysis-run', 'edit')" class="btn primary" type="submit" :disabled="signalsLoading">{{ signalsLoading ? '分析中…' : '开始分析' }}</button>
        </form>
        <p class="quant-save-status">{{ saveStatus }}</p>
        <section class="quant-summary" aria-label="信号概览">
          <article class="quant-stat quant-stat-buy"><span>↗</span><div><small>买入信号</small><strong>{{ signalStats.buy }}</strong></div></article>
          <article class="quant-stat quant-stat-sell"><span>↘</span><div><small>卖出信号</small><strong>{{ signalStats.sell }}</strong></div></article>
          <article class="quant-stat quant-stat-hold"><span>—</span><div><small>观望</small><strong>{{ signalStats.hold }}</strong></div></article>
          <article class="quant-stat"><span>◷</span><div><small>更新时间</small><strong class="quant-time">{{ signalStats.updated }}</strong></div></article>
        </section>
        <section class="quant-card">
          <div class="quant-card-head"><div><h2>策略信号</h2><p>{{ signalStats.note }}</p></div><span class="quant-live-dot"><i></i>真实行情</span></div>
          <div class="quant-table-wrap" @click="onSignalClick">
            <table class="quant-table">
              <thead><tr><th>标的</th><th class="align-right">价格 / 日涨跌</th><th class="align-center">综合信号</th><th class="align-center">强度</th><th class="align-center">RSI</th><th class="align-center">MACD</th><th class="align-center">布林位置</th><th class="align-center">趋势</th><th class="align-right">评分 / 数据</th></tr></thead>
              <tbody id="signal-body" ref="signalBodyEl"></tbody>
            </table>
          </div>
        </section>
      </section>

      <section class="quant-view" :class="{ active: view === 'strategy' }">
        <header class="quant-header"><div><div class="quant-eyebrow">STRATEGY CONFIGURATION</div><h1>策略参数</h1><p>Dashboard、Backtest 与模拟盘共用并持久化这一组参数。</p></div></header>
        <section class="quant-card quant-config">
          <div class="quant-card-head"><div><h2>技术指标</h2><p>修改后保存策略，下一次分析立即生效。</p></div></div>
          <div class="quant-config-grid">
            <label><span>RSI 周期</span><input v-model.number="config.rsiPeriod" type="number" min="2" max="50" step="1"></label>
            <label><span>RSI 超买</span><input v-model.number="config.rsiOverbought" type="number" min="51" max="95" step="1"></label>
            <label><span>RSI 超卖</span><input v-model.number="config.rsiOversold" type="number" min="5" max="49" step="1"></label>
            <label><span>MACD 快线</span><input v-model.number="config.macdFast" type="number" min="2" max="50" step="1"></label>
            <label><span>MACD 慢线</span><input v-model.number="config.macdSlow" type="number" min="3" max="100" step="1"></label>
            <label><span>MACD 信号线</span><input v-model.number="config.macdSignal" type="number" min="2" max="50" step="1"></label>
            <label><span>布林带周期</span><input v-model.number="config.bollingerPeriod" type="number" min="5" max="100" step="1"></label>
            <label><span>布林标准差</span><input v-model.number="config.bollingerStdDev" type="number" min="0.5" max="5" step="0.1"></label>
            <label><span>买入阈值</span><input v-model.number="config.buyThreshold" type="number" min="0" max="1" step="0.05"></label>
            <label><span>卖出阈值</span><input v-model.number="config.sellThreshold" type="number" min="-1" max="0" step="0.05"></label>
          </div>
          <div class="quant-config-actions">
            <button class="btn ghost" type="button" v-if="canP('quant-config', 'edit')" @click="resetConfig">恢复默认</button>
            <button class="btn primary" type="button" v-if="canP('quant-config', 'edit')" @click="saveSettings({ scope: 'config', message: '策略参数已保存' }).then(runAnalysis)">保存策略</button>
          </div>
        </section>
        <section class="quant-card quant-explain">
          <div class="quant-card-head"><div><h2>策略说明</h2><p>与参考项目保持同一信号组合，行情替换为真实股票接口。</p></div></div>
          <div class="quant-explain-grid">
            <article><span class="quant-index">01</span><h3>RSI 相对强弱</h3><p>{{ configDescriptions.rsi }}</p></article>
            <article><span class="quant-index">02</span><h3>MACD 动能交叉</h3><p>{{ configDescriptions.macd }}</p></article>
            <article><span class="quant-index">03</span><h3>布林带位置</h3><p>{{ configDescriptions.bollinger }}</p></article>
          </div>
          <p class="quant-formula">{{ configDescriptions.formula }}</p>
        </section>
      </section>

      <section class="quant-view" :class="{ active: view === 'backtest' }">
        <header class="quant-header"><div><div class="quant-eyebrow">HISTORICAL SIMULATION</div><h1>策略回测</h1><p>可在此同步编辑分析标的，按等权方式回测并与买入持有比较。</p></div></header>
        <form class="quant-toolbar" @submit.prevent="runBacktest">
          <label class="quant-symbol-field"><span>分析标的</span><input v-model="backtestSymbolsInput" autocomplete="off" placeholder="AAPL, MSFT, NVDA" @input="setSymbolInputs(backtestSymbolsInput, 'backtest')"></label>
          <label><span>初始资金（USD）</span><input v-model.number="backtestCapital" type="number" min="1000" step="1000"></label>
          <label><span>回测范围</span><select v-model="backtestPeriod"><option value="6m">近 6 个月</option><option value="1y">近 1 年</option><option value="2y">近 2 年</option><option value="5y">近 5 年</option></select></label>
          <button v-if="canP('quant-watchlist', 'edit')" class="btn ghost" type="button" @click="saveSettings({ scope: 'watchlist', source: 'backtest', message: '回测标的已同步保存' })">保存标的</button>
          <button v-if="canP('quant-backtest-run', 'edit')" class="btn primary" type="submit" :disabled="backtestBusy">{{ backtestBusy ? '回测中…' : '运行回测' }}</button>
        </form>
        <section class="quant-card">
          <div class="quant-card-head"><div><h2>历史回测记录</h2><p>结果按登录用户保存在服务器数据库中，可重新查看或删除。</p></div><span class="quant-live-dot">{{ backtestHistory.length }} 条记录</span></div>
          <div class="quant-backtest-history" ref="historyHostEl" @click="onBacktestClick"></div>
        </section>
        <section class="quant-summary">
          <article class="quant-stat"><span>$</span><div><small>期末权益</small><strong>{{ backtestStats.equity }}</strong></div></article>
          <article class="quant-stat"><span>↗</span><div><small>策略收益</small><strong :class="backtestStats.totalClass">{{ backtestStats.total }}</strong></div></article>
          <article class="quant-stat"><span>≋</span><div><small>最大回撤</small><strong>{{ backtestStats.drawdown }}</strong></div></article>
          <article class="quant-stat"><span>✓</span><div><small>胜率 / 平仓</small><strong>{{ backtestStats.winrate }}</strong></div></article>
        </section>
        <section class="quant-card" :class="{ hidden: !overviewVisible }" ref="overviewCardEl">
          <div class="quant-card-head"><div><h2>组合累计收益率</h2><p>策略组合与同期等权买入持有对比。</p></div></div>
          <div class="quant-return-chart quant-return-chart--overview" ref="overviewChartEl"></div>
        </section>
        <section class="quant-card">
          <div class="quant-card-head"><div><h2>分标的结果</h2><p>{{ backtestNote }}</p></div></div>
          <div class="quant-table-wrap" @click="onBacktestClick">
            <table class="quant-table">
              <thead><tr><th>标的</th><th class="align-right">期末权益</th><th class="align-right">策略收益</th><th class="align-right">买入持有</th><th class="align-right">最大回撤</th><th class="align-right">平仓次数</th><th>行情源</th><th class="align-center">交易记录</th></tr></thead>
              <tbody id="backtest-body" ref="backtestBodyEl"></tbody>
            </table>
          </div>
        </section>
      </section>

      <section class="quant-view" :class="{ active: view === 'paper' }">
        <header class="quant-header">
          <div><div class="quant-eyebrow">PAPER TRADING</div><h1>模拟盘</h1><p>根据保存的策略与自选池执行虚拟交易，与真实持仓完全隔离。</p></div>
          <div class="quant-header-actions">
            <button v-if="canP('quant-paper-reset', 'edit')" class="btn ghost" type="button" @click="resetPaper">重置模拟盘</button>
            <button v-if="canP('quant-paper-sync', 'edit')" class="btn primary" type="button" :disabled="paperBusy" @click="syncPaper">{{ paperBusy ? '同步中…' : '同步信号并交易' }}</button>
          </div>
        </header>
        <div class="quant-paper-settings">
          <label><span>初始资金（USD）</span><input v-model.number="paperCapital" type="number" min="1000" step="1000"></label>
          <label><span>单次仓位</span><input v-model.number="paperPositionPct" type="number" min="1" max="100" step="1"><em>%</em></label>
          <button v-if="canP('quant-paper-settings', 'edit')" class="btn ghost" type="button" @click="saveSettings({ scope: 'paper', message: '模拟盘设置已保存；重置后初始资金生效' })">保存设置</button>
        </div>
        <section class="quant-summary">
          <article class="quant-stat"><span>$</span><div><small>总权益</small><strong>{{ paperStats.equity }}</strong></div></article>
          <article class="quant-stat"><span>◈</span><div><small>可用现金</small><strong>{{ paperStats.cash }}</strong></div></article>
          <article class="quant-stat"><span>▤</span><div><small>持仓市值</small><strong>{{ paperStats.marketValue }}</strong></div></article>
          <article class="quant-stat"><span>%</span><div><small>累计收益</small><strong :class="paperStats.totalClass">{{ paperStats.total }}</strong></div></article>
        </section>
        <section class="quant-card">
          <div class="quant-card-head"><div><h2>模拟持仓</h2><p>{{ paperNote }}</p></div></div>
          <div class="quant-table-wrap">
            <table class="quant-table"><thead><tr><th>标的</th><th class="align-right">数量</th><th class="align-right">成本</th><th class="align-right">现价</th><th class="align-right">市值</th><th class="align-right">浮动盈亏</th><th class="align-center">当前信号</th></tr></thead><tbody ref="paperHoldingsEl"></tbody></table>
          </div>
        </section>
        <section class="quant-card">
          <div class="quant-card-head"><div><h2>模拟交易记录</h2><p>最多保留最近 500 笔。</p></div></div>
          <div class="quant-table-wrap">
            <table class="quant-table"><thead><tr><th>时间</th><th>标的</th><th>方向</th><th class="align-right">数量</th><th class="align-right">价格</th><th class="align-right">金额 / 盈亏</th></tr></thead><tbody ref="paperTradesEl"></tbody></table>
          </div>
        </section>
      </section>
    </div>
  </div>

  <KlineModal v-if="kline" :symbol="kline.symbol" :period="kline.period" @close="kline = null" />
</template>
