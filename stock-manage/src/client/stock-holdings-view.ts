import { individualHoldingWeight, isHoldingsSortable } from '../../public/js/holdings-table.js';
import {
  MASK, cls, escapeHtml, fmtCommission, fmtCny, fmtMoney, fmtMoneyPair, fmtMoneySigned, fmtPct, fmtUsd, fmtUsdSigned,
  formatLocalDateTime, formatPrice, formatQuantity, fundPriceDigits, holdingTypeLabel, looksLikeAShare
} from './stock-format';

export interface HoldingsRenderDeps {
  getState: () => any;
  getColVis: () => Record<string, boolean>;
  isPnlVisible: () => boolean;
  isQuotesBusy: () => boolean;
  can: (feature: string, action?: string) => boolean;
  canCol: (key: string) => boolean;
}

export function createHoldingsRenderer(deps: HoldingsRenderDeps) {
  const maskCol = (key: string, html: string) => {
    if (!deps.canCol(key)) return MASK;
    return deps.getColVis()[key] !== false ? html : MASK;
  };
  const maskPnlValue = (html: string) => deps.isPnlVisible() ? html : MASK;

  function cell(h: any, key: string, ctx: any) {
    const { optStr, lots, symInner } = ctx;
    const cur = h.currency || (looksLikeAShare(h.symbol) ? 'CNY' : 'USD');
    switch (key) {
      case 'type':
        return maskCol('type', holdingTypeLabel(h));
      case 'account':
        return maskCol('account', escapeHtml(h.accountName || '待归属'));
      case 'symbol':
        return maskCol('symbol', symInner);
      case 'name': {
        const rate = h.etfPremiumPct;
        const timestamp = h.etfPremiumAsOf ? ` · ${formatLocalDateTime(h.etfPremiumAsOf)}` : '';
        const premium = h.type === 'ashare' && Number.isFinite(rate)
          ? ` <small class="sm-etf-premium" title="${escapeHtml(`腾讯行情 ·（成交价 ÷ ${h.fundPremiumBasis || 'IOPV'} − 1）× 100%${timestamp}`)}">溢价 ${rate > 0 ? '+' : ''}${fmtPct(rate)}</small>`
          : '';
        return maskCol('name', escapeHtml(h.name || '—') + premium);
      }
      case 'shares':
        return maskCol('shares', formatQuantity(h.shares));
      case 'cost':
        return maskCol('cost', formatPrice(h.avgCost, cur, h.type === 'fund' ? fundPriceDigits(h.tradeSymbol || h.symbol) : 3) + lots);
      case 'price': {
        const isFund = h.type === 'fund';
        const refreshTarget = deps.can('refresh', 'edit') ? `data-refresh="${escapeHtml(h.tradeSymbol || h.symbol)}"`
          : isFund && deps.can('fund-holdings', 'edit') ? `data-fund-refresh="${h.fundIndex}"` : '';
        const label = isFund ? '更新净值' : '刷新价格';
        const disabled = deps.isQuotesBusy() && deps.can('refresh', 'edit') ? ' disabled' : '';
        const refresh = refreshTarget ? ` <button type="button" class="btn link" ${refreshTarget} title="${label}" aria-label="${label}"${disabled}>↻</button>` : '';
        if (isFund) {
          const nav = h.price == null ? '待更新净值' : formatPrice(h.price, cur, fundPriceDigits(h.tradeSymbol || h.symbol));
          const date = h.quoteAsOf ? `<div class="sm-lots-hint">净值 ${escapeHtml(h.quoteAsOf)}</div>` : '';
          return maskCol('price', `<span>${nav}</span>${refresh}${date}`);
        }
        const sourceLabel = h.quoteSource === 'cboe-delayed-midpoint' ? 'Cboe 延时报价（买卖中间价）'
          : h.quoteSource === 'polygon-daily-delayed' ? 'Polygon 延时日线' : `${h.quoteSource || '供应商'}延时行情`;
        const delayHint = h.delayed
          ? ` <span class="hint" title="${escapeHtml(sourceLabel + (h.quoteAsOf ? `（截至 ${h.quoteAsOf}）` : ''))}">延时</span>`
          : '';
        const sessionLabel = ({
          premarket: '盘前', afterhours: '盘后', overnight: '夜盘',
          'no-premarket': '盘前暂无报价', 'no-afterhours': '盘后暂无报价',
          'no-overnight': '夜盘暂无报价', 'no-overnight-afterhours': '夜盘暂无报价 · 显示盘后价'
        } as any)[h.quoteSession];
        const sessionMove = h.quoteSession === 'afterhours' && h.quoteSessionChangePct != null
          ? ` · 较今收 ${fmtPct(h.quoteSessionChangePct)}` : '';
        const sessionHint = sessionLabel
          ? `<div class="sm-lots-hint" title="${escapeHtml(h.quoteAsOf || '')}">${sessionLabel}${h.delayed && !String(h.quoteSession).startsWith('no-') ? '延时' : ''}${sessionMove}</div>` : '';
        return maskCol('price', `<span>${formatPrice(h.price, cur)}</span>${sessionHint ? '' : delayHint}${refresh}${sessionHint}`);
      }
      case 'pnl':
        return maskCol('pnl', h.pnl == null ? '—' : `<span class="${cls(h.pnl)}">${fmtMoneySigned(h.pnl, cur)}</span>`);
      case 'pnlPct':
        return maskCol('pnlPct', h.pnlPct == null ? '—' : fmtPct(h.pnlPct));
      case 'dailyPnl':
        return maskCol('dailyPnl', h.dailyPnl == null ? '—' : `<span class="${cls(h.dailyPnl)}">${fmtMoneySigned(h.dailyPnl, cur)}</span>`);
      case 'dailyPnlPct':
        return maskCol('dailyPnlPct', h.dailyPnlPct == null ? '—' : fmtPct(h.dailyPnlPct));
      case 'position': {
        const native = h.marketValueNative != null ? h.marketValueNative : h.marketValue;
        const tip = cur === 'CNY' ? ` title="折合 ${fmtUsd(h.marketValue)}"` : '';
        return maskCol('position', `<span${tip}>${fmtMoney(native, cur)}</span>`);
      }
      case 'weight':
        return maskCol('weight', fmtPct(h.weight));
      case 'optinfo':
        return maskCol('optinfo', optStr);
      case 'note': {
        const text = escapeHtml(h.note || '');
        const display = text ? `<span class="sm-holding-note-text" title="${text}">${text}</span>` : '';
        const edit = deps.can('holding-note', 'edit')
          ? `<button type="button" class="btn link" data-edit-note="${escapeHtml(h.tradeSymbol || h.symbol)}"
              data-account="${escapeHtml(h.accountId || '')}">${text ? '编辑' : '添加'}</button>`
          : '';
        return maskCol('note', display + edit || '—');
      }
      case 'actions': {
        const symbol = escapeHtml(h.tradeSymbol || h.symbol);
        const account = escapeHtml(h.accountId);
        const tradeActions = deps.can('row-trade', 'edit') ? `
          <button type="button" class="btn link" data-trade="buy" data-symbol="${symbol}" data-account="${account}">买</button>
          <button type="button" class="btn link" data-trade="sell" data-symbol="${symbol}" data-account="${account}">卖</button>` : '';
        const historyAction = deps.can('row-trade', 'edit') && deps.can('trades') ?
          `<button type="button" class="btn link" data-history="${symbol}">记录</button>` : '';
        const snapshotActions = h.type === 'fund' && h.editableSnapshot && deps.can('fund-holdings', 'edit') ? `
          <button type="button" class="btn link" data-fund-edit="${h.fundIndex}">编辑期初</button>
          <button type="button" class="btn link" data-fund-delete="${h.fundIndex}">移除</button>` : '';
        return maskCol('actions', (tradeActions + historyAction + snapshotActions).trim() || '—');
      }
      default:
        return MASK;
    }
  }

  function pnlCellClass(key: string, h: any) {
    if (key === 'pnl') return cls(h.pnl);
    if (key === 'pnlPct') return cls(h.pnlPct);
    if (key === 'dailyPnl') return cls(h.dailyPnl);
    if (key === 'dailyPnlPct') return cls(h.dailyPnlPct);
    return '';
  }

  function rowCell(h: any, col: any, group: any) {
    const groupSymbol = escapeHtml(h.tradeSymbol || h.symbol);
    const canGroup = deps.can('meta', 'edit');
    if (col.key === 'weight') {
      const individual = individualHoldingWeight(h);
      if (group.individualWeight) return maskCol('weight', fmtPct(individual));
      if (group.items.length === 1) return cell(h, 'weight', {});
      return maskCol('weight', `<div class="sm-lots-hint">单项 ${fmtPct(individual)}</div>`);
    }
    const opt = h.optionInfo;
    const optStr = opt ? `${opt.type} ${formatPrice(opt.strike, 'USD')} · ${opt.expiration}` : '—';
    const lots = h.costLots?.length > 1 ? `<div class="sm-lots-hint">${h.costLots.length} 笔合计</div>` : '';
    const symbol = `<strong class="sm-holding-symbol">${escapeHtml(h.symbol)}</strong>`;
    const symInner = canGroup ? `
      <span class="sm-symbol-controls">
        ${symbol}
        <span class="sm-symbol-drag" draggable="true" data-drag="${groupSymbol}" title="拖动此手柄到另一行的代码，合并为同一标的" aria-label="拖拽合并">⠿</span>
        ${h.groupWith ? `<button type="button" class="btn link sm-clear-group" data-clear-group="${groupSymbol}" title="恢复自动分组">↺</button>` : ''}
      </span>` : symbol;
    return cell(h, col.key, { optStr, lots, symInner });
  }

  function rowCellClass(h: any, col: any) {
    return [pnlCellClass(col.key, h), col.key === 'name' ? 'sm-holding-name' : ''].filter(Boolean).join(' ');
  }

  function rowCellAttrs(h: any, col: any) {
    const canGroup = deps.can('meta', 'edit');
    const attrs: any = { 'data-label': col.label };
    if (canGroup && col.key === 'symbol') attrs['data-group-drop'] = h.tradeSymbol || h.symbol;
    return attrs;
  }

  function groupSummaryCell(group: any, expanded: boolean, col: any, cols: any[]) {
    const state = deps.getState();
    const shown = (key: string) => cols.some((c) => c.key === key) && deps.getColVis()[key] !== false;
    const control = ['symbol', 'name', 'type', 'actions'].find(shown) || cols.find((c) => deps.getColVis()[c.key] !== false)?.key || cols[0]?.key;
    const symbol = shown('symbol') ? `${escapeHtml(group.key)} · ` : '';
    const first = group.anchor;
    const usdCnyRate = Number(state?.usdCnyRate);
    const dropTarget = shown('symbol') && deps.can('meta', 'edit')
      ? ` data-group-drop="${escapeHtml(first.tradeSymbol || first.symbol)}"` : '';
    const toggle = `<button type="button" class="btn link sm-group-toggle" data-toggle-holding-group="${escapeHtml(group.key)}"
      aria-expanded="${expanded}"${dropTarget}><span aria-hidden="true">${expanded ? '▾' : '▸'}</span> ${symbol}合计 <small>（${group.items.length} 项）</small></button>`;
    const key = col.key;
    const metric = group.summary?.[key];
    const label = escapeHtml(col.label);
    const meta = key === 'weight' ? fmtPct(first.weight) : '';
    if (!metric && !meta && key !== control) {
      return { attrs: { class: 'sm-group-empty', 'aria-hidden': 'true' }, html: '' };
    }
    let value = meta;
    if (metric) {
      const cny = Number.isFinite(metric.value) && Number.isFinite(usdCnyRate) && usdCnyRate > 0
        ? metric.value * usdCnyRate : null;
      const formatted = key.endsWith('Pct') ? fmtPct(metric.value)
        : fmtMoneyPair(metric.value, cny as any, key === 'position' ? fmtMoney : fmtMoneySigned);
      const partial = metric.count > 0 && metric.count < group.items.length
        ? `<div class="sm-lots-hint" title="仅统计有可用数据的持仓">部分统计 ${metric.count}/${group.items.length}</div>` : '';
      value = `<span class="${key === 'position' ? '' : cls(metric.value)}">${formatted}</span>${partial}`;
    }
    return {
      attrs: { 'data-label': label, ...(key === control ? { class: 'sm-group-control' } : {}) },
      html: `${key === control ? toggle : ''}${value ? maskCol(key, value) : ''}`
    };
  }

  function cashCell(col: any, cashPct: number) {
    const state = deps.getState();
    const cashEq = Number.isFinite(state?.summary?.cashUsdEq) ? state.summary.cashUsdEq : state?.cash;
    const key = col.key;
    const wrap = (content: string) => maskCol(key, content);
    if (key === 'type' || key === 'name') return wrap('现金');
    if (key === 'symbol') return wrap('CASH');
    if (key === 'position') return wrap(`${fmtUsd(state.cashUsd)} · ${fmtCny(state.cashCny)}${state.cashHkd ? ' · ' + fmtMoney(state.cashHkd, 'HKD') : ''}`);
    if (key === 'cost') return wrap(`折合 ${fmtUsd(cashEq)}`);
    if (key === 'weight') return wrap(fmtPct(cashPct));
    return wrap('—');
  }

  return { cell, rowCell, rowCellClass, rowCellAttrs, groupSummaryCell, cashCell, isSortable: isHoldingsSortable };
}
