import { loadPortalContext, can, canDip } from '../js/portal-auth.js';

const $ = (selector) => document.querySelector(selector);
const state = { status: null, timer: null, chain: null, chainCaptureId: null };

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

function renderChain() {
  const payload = state.chain;
  if (!payload) return;
  const spot = Number(payload.capture.underlying_price);
  const right = $('#chain-right').value;
  const minStrike = Number($('#chain-strike-min').value);
  const maxStrike = Number($('#chain-strike-max').value);
  const minDelta = Number($('#chain-delta-min').value);
  const onlyOtm = $('#chain-otm').checked;
  const rows = payload.quotes.filter((quote) => {
    if (right !== 'all' && quote.right_type !== right) return false;
    if ($('#chain-strike-min').value && quote.strike < minStrike) return false;
    if ($('#chain-strike-max').value && quote.strike > maxStrike) return false;
    if ($('#chain-delta-min').value && Math.abs(Number(quote.delta)) < minDelta) return false;
    if (onlyOtm && !moneyness(quote, spot).otm) return false;
    return true;
  });
  $('#chain-message').textContent = `${payload.capture.market_date} · QQQ ${money(spot)} · ${payload.capture.expiration} 到期 · 显示 ${rows.length}/${payload.quotes.length} 个合约`;
  $('#chain-body').innerHTML = rows.length ? rows.map((quote) => {
    const moneyState = moneyness(quote, spot);
    const mid = (Number(quote.bid) + Number(quote.ask)) / 2;
    const spread = mid > 0 ? (Number(quote.ask) - Number(quote.bid)) / mid : null;
    return `<tr><td><strong>${escapeHtml(String(quote.option_symbol).replace(/^O:/, ''))}</strong></td><td>${quote.right_type === 'C' ? 'Call' : 'Put'}</td><td class="align-right">${money(quote.strike)}</td><td>${moneyState.label}</td><td class="align-right">${money(quote.bid)} × ${Number(quote.bid_size || 0).toLocaleString()}</td><td class="align-right">${money(quote.ask)} × ${Number(quote.ask_size || 0).toLocaleString()}</td><td class="align-right">${spread == null ? '—' : percent(spread)}</td><td class="align-right">${money(quote.last_price)}</td><td class="align-right">${money(quote.open_price)}</td><td class="align-right">${money(quote.high_price)}</td><td class="align-right">${money(quote.low_price)}</td><td class="align-right">${money(quote.prev_close)}</td><td class="align-right">${decimal(quote.delta)}</td><td class="align-right">${decimal(quote.gamma)}</td><td class="align-right">${decimal(quote.theta)}</td><td class="align-right">${decimal(quote.vega)}</td><td class="align-right">${quote.iv == null ? '—' : percent(quote.iv)}</td><td class="align-right">${Number(quote.volume || 0).toLocaleString()}</td><td class="align-right">${Number(quote.open_interest || 0).toLocaleString()}</td><td>${dateTime(quote.last_trade_at)}</td></tr>`;
  }).join('') : '<tr><td colspan="20" class="quant-empty">没有符合当前筛选条件的合约。</td></tr>';
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
    $('#chain-body').innerHTML = '<tr><td colspan="20" class="quant-empty">期权链加载失败。</td></tr>';
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
  ['#chain-right', '#chain-strike-min', '#chain-strike-max', '#chain-delta-min', '#chain-otm']
    .forEach((selector) => $(selector).addEventListener('input', renderChain));
  $('#capture-body').addEventListener('click', (event) => {
    const row = event.target.closest('[data-capture-id]');
    if (!row) return;
    $('#chain-capture').value = row.dataset.captureId;
    loadCaptureDetails(row.dataset.captureId);
    $('#option-chain-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#yolo-backtest-form').addEventListener('submit', runBacktest);
  state.timer = setInterval(() => loadStatus(true), 30000);
}

init().catch((error) => { $('#collector-message').textContent = error.message; $('#collector-message').className = 'yolo-message error'; });
