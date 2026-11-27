import { formatPrice } from '../../public/js/price-format.js';

export function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any
  )[character]);
}
export function hasNumber(value: any) { return value !== null && value !== '' && Number.isFinite(Number(value)); }
export function formatNumber(value: any, digits = 2) { return hasNumber(value) ? Number(value).toFixed(digits) : '—'; }
export function formatMoney(value: any) {
  return hasNumber(value) ? `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
}
export function formatPercent(value: any, ratio = false) {
  return hasNumber(value) ? `${Number(value) > 0 ? '+' : ''}${(Number(value) * (ratio ? 100 : 1)).toFixed(2)}%` : '—';
}
export function formatDate(value: any, includeTime = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '—';
  const date = new Date(number);
  return includeTime ? date.toLocaleString('sv-SE') : date.toLocaleDateString('sv-SE');
}
export function sourceLabel(source: string) {
  return source === 'polygon' ? 'Polygon' : source === 'yahoo' ? 'Yahoo' : source === 'sina' ? '新浪财经' : source === 'finnhub' ? 'Finnhub' : '行情接口';
}
export function periodLabel(period: string) {
  return ({ '3m': '近 3 个月', '6m': '近 6 个月', '1y': '近 1 年', '2y': '近 2 年', '5y': '近 5 年' } as any)[period] || period || '—';
}
export function signalLabel(signal: string) { return signal === 'BUY' ? '买入' : signal === 'SELL' ? '卖出' : '观望'; }
export function signalClass(signal: string) { return signal === 'BUY' ? 'buy' : signal === 'SELL' ? 'sell' : 'hold'; }
export function badge(signal: string) {
  const icon = signal === 'BUY' ? '↗' : signal === 'SELL' ? '↘' : '—';
  return `<span class="quant-badge quant-badge-${signalClass(signal)}"><b>${icon}</b>${signalLabel(signal)}</span>`;
}
export function miniSignal(signal: string) {
  return `<span class="quant-mini quant-mini-${signalClass(signal)}">${signalLabel(signal)}</span>`;
}
export function trendLabel(value: string) {
  if (value === 'ABOVE_SMA50') return '<span class="quant-trend quant-trend-up">高于 SMA50</span>';
  if (value === 'BELOW_SMA50') return '<span class="quant-trend quant-trend-down">低于 SMA50</span>';
  return '<span class="quant-muted">—</span>';
}
export function strengthBar(item: any) {
  const strength = Math.min(100, Math.max(0, Number(item.strength) || 0));
  if (!strength) return '<span class="quant-muted">—</span>';
  return `<span class="quant-strength quant-strength-${signalClass(item.signal)}"><i><b style="width:${strength}%"></b></i><em>${strength}%</em></span>`;
}
export function signalRow(item: any, canHistory: boolean, period: string) {
  const change = Number(item.changePercent);
  const changeClass = hasNumber(change) ? (change > 0 ? 'pos' : change < 0 ? 'neg' : '') : '';
  const score = Number(item.combinedScore);
  const status = item.status === 'ok' ? '' : `<span class="quant-row-message">${escapeHtml(item.message || '暂无可用数据')}</span>`;
  const dataInfo = item.status === 'ok'
    ? `${Number(item.dataPoints) || 0} 根 · ${formatDate(item.asOf)} · ${sourceLabel(item.historySource)}` : '未生成指标';
  const symbol = escapeHtml(item.symbol);
  const symbolCell = canHistory
    ? `<button class="quant-symbol-link" type="button" data-kline-symbol="${symbol}" data-kline-period="${escapeHtml(period)}">${symbol}</button>`
    : `<strong>${symbol}</strong>`;
  return `<tr><td>${symbolCell}${item.name && item.name !== item.symbol ? `<span class="quant-name">${escapeHtml(item.name)}</span>` : ''}${status}</td><td class="align-right"><strong>${formatPrice(item.price, 'USD')}</strong><span class="quant-sub ${changeClass}">${formatPercent(item.changePercent)}</span></td><td class="align-center">${badge(item.signal)}</td><td class="align-center">${strengthBar(item)}</td><td class="align-center"><strong>${formatNumber(item.rsi, 1)}</strong><span class="quant-sub">${miniSignal(item.rsiSignal)}</span></td><td class="align-center"><strong>${formatNumber(item.macd, 4)}</strong><span class="quant-sub">${miniSignal(item.macdSignal)}</span></td><td class="align-center"><strong>${hasNumber(item.bollingerPosition) ? `${formatNumber(item.bollingerPosition, 1)}%` : '—'}</strong><span class="quant-sub">${miniSignal(item.bollingerSignal)}</span></td><td class="align-center">${trendLabel(item.trend)}</td><td class="align-right"><strong class="${score > 0 ? 'pos' : score < 0 ? 'neg' : ''}">${Number.isFinite(score) ? `${score > 0 ? '+' : ''}${score.toFixed(2)}` : '—'}</strong><span class="quant-sub">${dataInfo}</span></td></tr>`;
}

export function renderSignalBody(host: HTMLElement, ctx: any) {
  const { signals, loading, error, canHistory, period } = ctx;
  if (loading && !signals.length) {
    host.innerHTML = Array.from({ length: 6 }, () => '<tr><td colspan="9"><span class="quant-skeleton"></span></td></tr>').join('');
  } else if (error) {
    host.innerHTML = `<tr><td colspan="9" class="quant-empty quant-error">${escapeHtml(error)}</td></tr>`;
  } else if (!signals.length) {
    host.innerHTML = '<tr><td colspan="9" class="quant-empty">自选池暂无分析结果。</td></tr>';
  } else {
    host.innerHTML = signals.map((item: any) => signalRow(item, canHistory, period)).join('');
  }
}

export function backtestTradeRows(item: any) {
  if (!item.trades?.length) return '<p class="quant-trades-empty">该标的在回测区间内没有触发买卖操作。</p>';
  const rows = item.trades.map((trade: any, index: number) => `<tr><td>${index + 1}</td><td>${formatDate(trade.timestamp)}</td><td class="${trade.side === 'BUY' ? 'pos' : 'neg'}">${trade.side === 'BUY' ? '买入' : '卖出'}</td><td class="align-right">${formatPrice(trade.price, 'USD')}</td><td class="align-right">${formatNumber(trade.shares, 4)}</td><td class="align-right ${hasNumber(trade.pnl) ? (trade.pnl >= 0 ? 'pos' : 'neg') : ''}">${hasNumber(trade.pnl) ? formatMoney(trade.pnl) : '—'}</td></tr>`).join('');
  return `<div class="quant-trades-title"><strong>${escapeHtml(item.symbol)} 买卖操作记录</strong><span>${item.trades.length} 次操作${item.openPosition ? ' · 期末仍持仓' : ''}</span></div><div class="quant-trades-scroll"><table class="quant-trades-table"><thead><tr><th>#</th><th>日期</th><th>方向</th><th class="align-right">成交价</th><th class="align-right">数量</th><th class="align-right">已实现盈亏</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function backtestResultRows(results: any[], period: string, canHistory: boolean) {
  return results.map((item: any) => {
    if (item.status !== 'ok') return `<tr><td><strong>${escapeHtml(item.symbol)}</strong></td><td colspan="7" class="quant-error">${escapeHtml(item.message)}</td></tr>`;
    const symbol = escapeHtml(item.symbol);
    const symbolCell = canHistory
      ? `<button class="quant-symbol-link" type="button" data-kline-symbol="${symbol}" data-kline-period="${escapeHtml(period)}">${symbol}</button>`
      : `<strong>${symbol}</strong>`;
    return `<tr class="quant-backtest-result"><td>${symbolCell}</td><td class="align-right">${formatMoney(item.finalEquity)}</td><td class="align-right ${item.totalReturn >= 0 ? 'pos' : 'neg'}">${formatPercent(item.totalReturn, true)}</td><td class="align-right ${item.buyHoldReturn >= 0 ? 'pos' : 'neg'}">${formatPercent(item.buyHoldReturn, true)}</td><td class="align-right neg">${formatPercent(-item.maxDrawdown, true)}</td><td class="align-right">${item.completedTrades}</td><td>${sourceLabel(item.historySource)}</td><td class="align-center"><button type="button" class="quant-expand-button" data-toggle-trades="${symbol}" aria-expanded="false">展开 <span>⌄</span></button></td></tr><tr class="quant-trade-detail hidden" data-trades-for="${symbol}"><td colspan="8"><div class="quant-detail-chart-head"><strong>${symbol} 收益率曲线</strong><span>买卖标记显示在策略曲线上</span></div><div class="quant-return-chart" data-return-chart="${symbol}"></div>${backtestTradeRows(item)}</td></tr>`;
  }).join('');
}

export function returnChartOption(curve: any[], initialCapital: number, trades: any[] = []) {
  const dates = curve.map((point) => new Date(Number(point.timestamp)).toISOString().slice(0, 10));
  const strategy = curve.map((point) => Number.isFinite(Number(point.strategyReturn))
    ? Number(point.strategyReturn) * 100 : (Number(point.equity) / initialCapital - 1) * 100);
  const buyHold = curve.map((point) => Number.isFinite(Number(point.buyHoldReturn))
    ? Number(point.buyHoldReturn) * 100 : (Number(point.buyHoldEquity) / initialCapital - 1) * 100);
  const byTimestamp = new Map(curve.map((point, index) => [Number(point.timestamp), index]));
  const markers = trades.map((trade) => {
    const index = byTimestamp.get(Number(trade.timestamp));
    if (!Number.isInteger(index)) return null;
    return {
      name: trade.side === 'BUY' ? '买入' : '卖出',
      coord: [dates[index as number], strategy[index as number]],
      value: trade.side === 'BUY' ? '买' : '卖',
      itemStyle: { color: trade.side === 'BUY' ? '#3ddc84' : '#ff7b7b' },
      label: { color: '#fff', fontSize: 9 }
    };
  }).filter(Boolean);
  return {
    animation: false,
    tooltip: { trigger: 'axis', valueFormatter: (value: any) => `${Number(value).toFixed(2)}%` },
    legend: { top: 4, textStyle: { color: '#8f9bad' }, data: ['策略收益', '买入持有'] },
    grid: { left: 58, right: 22, top: 42, bottom: 42 },
    xAxis: { type: 'category', data: dates, boundaryGap: false, axisLabel: { color: '#8f9bad' }, axisLine: { lineStyle: { color: '#465267' } } },
    yAxis: { type: 'value', axisLabel: { color: '#8f9bad', formatter: '{value}%' }, splitLine: { lineStyle: { color: 'rgba(148,163,184,.12)' } } },
    dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 4, borderColor: '#30394a', textStyle: { color: '#8f9bad' } }],
    series: [
      { name: '策略收益', type: 'line', data: strategy, showSymbol: false, smooth: false, lineStyle: { width: 2, color: '#5b9cff' }, itemStyle: { color: '#5b9cff' }, markPoint: { symbolSize: 34, data: markers } },
      { name: '买入持有', type: 'line', data: buyHold, showSymbol: false, lineStyle: { width: 1.5, type: 'dashed', color: '#f5b942' }, itemStyle: { color: '#f5b942' } }
    ]
  };
}

export function renderReturnChart(key: string, host: HTMLElement | null, curve: any[], initialCapital: number, trades: any[] = [], charts?: Map<string, any>) {
  charts?.get(key)?.dispose();
  if (!(globalThis as any).echarts || !host || !curve?.length) return;
  const chart = (globalThis as any).echarts.init(host, null, { renderer: 'canvas' });
  chart.setOption(returnChartOption(curve, initialCapital, trades));
  charts?.set(key, chart);
}

export function renderBacktestHistory(host: HTMLElement, items: any[], activeId: string, canDelete: boolean) {
  host.innerHTML = items.length
    ? items.map((item) => {
      const symbols = (item.symbols || []).join(', ');
      const active = item.id === activeId ? ' active' : '';
      const range = item.from && item.to ? `${formatDate(item.from)} — ${formatDate(item.to)}` : periodLabel(item.period);
      const deleteButton = canDelete
        ? `<button class="btn link quant-history-delete" type="button" data-delete-backtest="${escapeHtml(item.id)}">删除</button>`
        : '';
      return `<article class="quant-history-item${active}"><button type="button" class="quant-history-open" data-load-backtest="${escapeHtml(item.id)}"><span><strong>${periodLabel(item.period)} · ${escapeHtml(symbols)}</strong><small>${formatDate(Date.parse(item.createdAt), true)} · 实际区间 ${range}</small></span><span class="${Number(item.totalReturn) >= 0 ? 'pos' : 'neg'}">${formatPercent(item.totalReturn, true)}</span></button>${deleteButton}</article>`;
    }).join('')
    : '<p class="quant-trades-empty">暂无已保存的回测。</p>';
}

export function renderPaper(holdingsHost: HTMLElement, tradesHost: HTMLElement, paper: any) {
  holdingsHost.innerHTML = paper.holdings.length ? paper.holdings.map((item: any) => `<tr><td><strong class="quant-symbol">${escapeHtml(item.symbol)}</strong></td><td class="align-right">${formatNumber(item.shares, 4)}</td><td class="align-right">${formatPrice(item.avgCost, 'USD')}</td><td class="align-right">${formatPrice(item.price, 'USD')}</td><td class="align-right">${formatMoney(item.marketValue)}</td><td class="align-right ${item.pnl >= 0 ? 'pos' : 'neg'}">${formatMoney(item.pnl)}</td><td class="align-center">${badge(item.signal)}</td></tr>`).join('') : '<tr><td colspan="7" class="quant-empty">当前空仓，等待买入信号。</td></tr>';
  const trades = [...(paper.trades || [])].reverse();
  tradesHost.innerHTML = trades.length ? trades.map((item: any) => `<tr><td>${formatDate(item.timestamp, true)}</td><td><strong>${escapeHtml(item.symbol)}</strong></td><td class="${item.side === 'BUY' ? 'pos' : 'neg'}">${item.side === 'BUY' ? '买入' : '卖出'}</td><td class="align-right">${formatNumber(item.shares, 4)}</td><td class="align-right">${formatPrice(item.price, 'USD')}</td><td class="align-right">${formatMoney(item.amount)}${hasNumber(item.pnl) ? `<span class="quant-sub ${item.pnl >= 0 ? 'pos' : 'neg'}">盈亏 ${formatMoney(item.pnl)}</span>` : ''}</td></tr>`).join('') : '<tr><td colspan="6" class="quant-empty">暂无模拟交易。</td></tr>';
}

export function klineOption(candles: any[]) {
  const dates = candles.map((item) => new Date(Number(item.timestamp)).toISOString().slice(0, 10));
  const values = candles.map((item) => [Number(item.open), Number(item.close), Number(item.low), Number(item.high)]);
  const volumes = candles.map((item, index) => [index, Number(item.volume) || 0, Number(item.close) >= Number(item.open) ? 1 : -1]);
  const signed = (value: number, digits = 2) => `${value >= 0 ? '+' : ''}${Number(value).toFixed(digits)}`;
  return {
    animation: false,
    backgroundColor: 'transparent',
    legend: { show: false },
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' }, backgroundColor: '#171c25', borderColor: '#30394a', textStyle: { color: '#e6edf7' }, formatter: (params: any) => {
      const list = Array.isArray(params) ? params : [params];
      const candleParam = list.find((item: any) => item.seriesName === 'K 线') || list[0];
      const index = Number(candleParam?.dataIndex);
      const candle = values[index];
      if (!candle) return '';
      const base = index > 0 ? values[index - 1][1] : candle[0];
      const change = candle[1] - base;
      const pct = base ? change / base * 100 : 0;
      const volume = Number(candles[index]?.volume);
      return `${dates[index]}<br/>开 ${formatPrice(candle[0])}　高 ${formatPrice(candle[3])}<br/>低 ${formatPrice(candle[2])}　收 ${formatPrice(candle[1])}<br/><span style="color:${change >= 0 ? '#3ddc84' : '#ff7b7b'}">涨跌 ${signed(change, 3)} (${signed(pct)}%)</span>${Number.isFinite(volume) ? `<br/>成交量 ${volume.toLocaleString()}` : ''}`;
    } },
    axisPointer: { link: [{ xAxisIndex: 'all' }], label: { backgroundColor: '#465267' } },
    grid: [{ left: 62, right: 24, top: 18, height: '62%' }, { left: 62, right: 24, top: '75%', height: '14%' }],
    xAxis: [{ type: 'category', data: dates, boundaryGap: true, axisLine: { lineStyle: { color: '#465267' } }, axisLabel: { color: '#8f9bad' }, min: 'dataMin', max: 'dataMax' }, { type: 'category', gridIndex: 1, data: dates, boundaryGap: true, axisLabel: { show: false }, axisLine: { lineStyle: { color: '#465267' } }, axisTick: { show: false }, min: 'dataMin', max: 'dataMax' }],
    yAxis: [{ scale: true, splitLine: { lineStyle: { color: 'rgba(148,163,184,.12)' } }, axisLabel: { color: '#8f9bad', formatter: (value: number) => formatPrice(value) } }, { scale: true, gridIndex: 1, splitNumber: 2, axisLabel: { color: '#8f9bad', formatter: (value: number) => value >= 1000000 ? `${(value / 1000000).toFixed(1)}M` : `${(value / 1000).toFixed(0)}K` }, splitLine: { show: false } }],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1], start: Math.max(0, 100 - Math.min(100, 90 / candles.length * 100)), end: 100, zoomOnMouseWheel: false, moveOnMouseWheel: false, moveOnMouseMove: true }, { show: true, xAxisIndex: [0, 1], type: 'slider', bottom: 4, height: 20, borderColor: '#30394a', fillerColor: 'rgba(91,156,255,.16)', textStyle: { color: '#8f9bad' } }],
    visualMap: { show: false, seriesIndex: 1, dimension: 2, pieces: [{ value: 1, color: '#3ddc84' }, { value: -1, color: '#ff7b7b' }] },
    series: [{ name: 'K 线', type: 'candlestick', data: values, itemStyle: { color: '#3ddc84', color0: '#ff7b7b', borderColor: '#3ddc84', borderColor0: '#ff7b7b' } }, { name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: volumes }]
  };
}
