import { tradeCalendarDate, tradeCurrency, parseOptionInfo, roundMoney } from './trades.js';
import { tradeAssetType } from '../public/js/trade-asset-type.js';

const leveraged = new Set(('TQQQ SQQQ SOXL SOXS NVDL NVDU NVDX NVDQ NVDS TSLL TSLT TSLQ TSLS TSDD CONL CONI MSTU MSTX MSTZ UPRO SPXL SPXS TECL TECS FNGU FNGD LABU LABD YINN YANG CWEB TNA TZA BOIL KOLD TMF TMV QLD QID SSO SDS AMZU AMZD AAPU AAPD GGLL GGLS METU PLTU PTIR USD AGQ AMDD AMDL AMDS BABX DAMD GDXU NVD ORCX PLTD SOFX UCO UGL UVIX UVXY ZSL').split(' '));
const category = (t) => tradeAssetType(t) === 'stock' && leveraged.has(String(t.symbol).toUpperCase()) ? 'leveraged' : tradeAssetType(t);
const number = (value) => Number(value) || 0;
const money = (value) => roundMoney(value);
const holdBucket = (days) => days < 1 ? 'under1' : days < 8 ? '1to7' : days < 31 ? '8to30' : days < 91 ? '31to90' : 'over90';

export function validateReviewRange(start = '', end = '') {
  for (const date of [start, end]) {
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw new Error('请输入有效日期');
  }
  if (start && end && start > end) throw new Error('开始日期不能晚于结束日期');
}

function stats(records) {
  const wins = records.filter((r) => r.pnl > 0.000001);
  const losses = records.filter((r) => r.pnl < -0.000001);
  const profit = wins.reduce((s, r) => s + r.pnl, 0);
  const loss = -losses.reduce((s, r) => s + r.pnl, 0);
  return {
    count: records.length, wins: wins.length, losses: losses.length, flat: records.length - wins.length - losses.length,
    winRate: records.length ? wins.length / records.length * 100 : null,
    profit: money(profit), loss: money(loss), net: money(profit - loss),
    avgWin: wins.length ? money(profit / wins.length) : null,
    avgLoss: losses.length ? money(loss / losses.length) : null,
    profitFactor: loss ? profit / loss : null
  };
}

function groupStats(records, key) {
  const groups = new Map();
  for (const r of records) {
    const value = key(r);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(r);
  }
  return [...groups].map(([key, rows]) => ({ key, ...stats(rows) })).sort((a, b) => a.net - b.net);
}

/** Match the complete history up to end; apply the window only at realization.
 * Use recorded amounts (not displayed prices) and allocate both fees by quantity.
 * No account equity/market values are inferred from turnover or remaining cost.
 */
export function computeTradeReview(trades, options = {}) {
  const { startDate = '', endDate = '', symbol = '', assetType = 'all', otherCategory = '' } = options;
  validateReviewRange(startDate, endDate);
  const symbolFilter = String(symbol).trim().toUpperCase();
  const included = (t) => (!symbolFilter || String(t.symbol || '').toUpperCase().includes(symbolFilter))
    && (assetType === 'all' || tradeAssetType(t) === assetType)
    && (t.type !== 'other' || !otherCategory || String(t.other_category || '').includes(otherCategory));
  const inWindow = (day) => day && (!startDate || day >= startDate) && (!endDate || day <= endDate);
  const history = trades.filter(included).map((t, index) => ({ ...t, index, day: tradeCalendarDate(t.trade_date), currency: tradeCurrency(t), category: category(t) }))
    .filter((t) => t.day && (!endDate || t.day <= endDate))
    .sort((a, b) => new Date(a.trade_date) - new Date(b.trade_date) || (a.type === 'buy' ? 0 : 1) - (b.type === 'buy' ? 0 : 1) || a.index - b.index);
  const currencies = [...new Set(history.map((t) => t.currency))].sort();
  const reports = currencies.map((currency) => {
    const rows = history.filter((t) => t.currency === currency);
    const queue = new Map();
    const sales = [], fragments = [], other = [], unmatched = [], invalid = [];
    const duplicateKeys = new Map();
    let windowFees = 0, duplicateCount = 0, duplicateAmount = 0;
    for (const t of rows) {
      const window = inWindow(t.day);
      if (t.type === 'other') {
        if (!window) continue;
        other.push({ key: t.other_category || '其它', pnl: number(t.total_amount) - number(t.commission) });
        const key = JSON.stringify([t.trade_date, t.symbol, t.name, t.other_category, t.total_amount, t.commission]);
        if (duplicateKeys.has(key)) { duplicateCount++; duplicateAmount += number(t.total_amount) - number(t.commission); }
        duplicateKeys.set(key, true);
        continue;
      }
      if (window) windowFees += number(t.commission);
      const qty = number(t.shares);
      if (!(qty > 0) || !['buy', 'sell'].includes(t.type)) {
        if (window) invalid.push({ id: t.id, symbol: t.symbol, date: t.day });
        continue;
      }
      const key = String(t.symbol || '').toUpperCase();
      const inventoryKey = JSON.stringify([t.account_id || '', key]);
      if (!queue.has(inventoryKey)) queue.set(inventoryKey, []);
      const lots = queue.get(inventoryKey);
      if (t.type === 'buy') { lots.push({ trade: t, remaining: qty }); continue; }
      let remaining = qty, cost = 0, gross = 0, fees = 0, holding = 0, matched = 0;
      while (remaining > 1e-8 && lots.length) {
        const lot = lots[0], b = lot.trade, bought = number(b.shares);
        const q = Math.min(remaining, lot.remaining);
        const buyAmount = number(b.total_amount) * q / bought;
        const proceeds = number(t.total_amount) * q / qty;
        const fee = number(b.commission) * q / bought + number(t.commission) * q / qty;
        const days = (new Date(t.trade_date) - new Date(b.trade_date)) / 86400000;
        const info = parseOptionInfo(key);
        const dte = info ? Math.round((Date.parse(info.expiration) - Date.parse(b.day)) / 86400000) : null;
        const dteBucket = dte == null ? '' : dte < 0 ? 'invalid' : dte <= 1 ? '0to1' : dte <= 7 ? '2to7' : dte <= 30 ? '8to30' : dte <= 90 ? '31to90' : 'over90';
        if (window) fragments.push({ pnl: proceeds - buyAmount - fee, dteBucket, category: t.category });
        cost += buyAmount; gross += proceeds - buyAmount; fees += fee; holding += days * q; matched += q;
        remaining -= q; lot.remaining -= q;
        if (lot.remaining < 1e-8) lots.shift();
      }
      if (window) {
        if (remaining > 1e-8) unmatched.push({ id: t.id, symbol: key, name: t.name, date: t.day, shares: remaining, proceeds: money(number(t.total_amount) * remaining / qty) });
        if (matched > 1e-8) sales.push({ id: t.id, symbol: key, name: t.name || key, date: t.day, category: t.category,
          underlying: parseOptionInfo(key)?.underlying || key, matched, complete: remaining < 1e-8,
          cost, gross, fees, pnl: gross - fees, holding: holding / matched });
      }
    }
    const complete = sales.filter((s) => s.complete);
    const tradeStats = stats(complete);
    const realized = money(sales.reduce((s, r) => s + r.pnl, 0));
    const realizedFees = money(sales.reduce((s, r) => s + r.fees, 0));
    const open = [...queue].flatMap(([inventoryKey, lots]) => lots.length ? [{ symbol: JSON.parse(inventoryKey)[1], accountId: JSON.parse(inventoryKey)[0],
      shares: lots.reduce((s, l) => s + l.remaining, 0),
      cost: money(lots.reduce((s, l) => s + number(l.trade.total_amount) * l.remaining / number(l.trade.shares), 0)),
      buyFees: money(lots.reduce((s, l) => s + number(l.trade.commission) * l.remaining / number(l.trade.shares), 0)) }] : []);
    const otherNet = money(other.reduce((s, r) => s + r.pnl, 0));
    const losses = complete.filter((s) => s.pnl < 0);
    const bigLosses = losses.filter((s) => s.pnl <= -500);
    const smallWins = complete.filter((s) => s.pnl > 0.000001 && s.pnl <= 50);
    const bins = [
      ['≤−500', (n) => n <= -500], ['−500～−200', (n) => n > -500 && n <= -200],
      ['−200～−50', (n) => n > -200 && n <= -50], ['−50～0', (n) => n > -50 && n < 0],
      ['持平', (n) => Math.abs(n) <= 0.000001], ['0～50', (n) => n > 0.000001 && n <= 50],
      ['50～200', (n) => n > 50 && n <= 200], ['200～500', (n) => n > 200 && n <= 500], ['>500', (n) => n > 500]
    ].map(([key, test]) => ({ key, ...stats(complete.filter((s) => test(Math.abs(s.pnl) <= 0.000001 ? 0 : s.pnl))) }));
    const assets = groupStats(sales, (s) => s.category);
    const option = assets.find((g) => g.key === 'option');
    const lossWinRatio = tradeStats.avgWin && tradeStats.avgLoss ? tradeStats.avgLoss / tradeStats.avgWin : null;
    const insights = [];
    if (!tradeStats.count) insights.push('本区间没有完整匹配的卖出记录，暂不判断交易表现。');
    else if (tradeStats.count < 20) insights.push('本区间完整卖出记录少于20条，样本较小，避免据此认定策略有稳定优势。');
    if (lossWinRatio > 1) insights.push(`平均亏损是平均盈利的 ${lossWinRatio.toFixed(2)} 倍，应先控制单次风险和仓位，再追求胜率。`);
    if (option?.net < 0) insights.push('本区间期权净亏损。建议缩小方向性期权预算，按策略检验扣费后的期望；延长到期日不保证改善结果。');
    if (assets.some((g) => g.key === 'leveraged')) insights.push('杠杆、反向及波动率产品单独管理风险；具体产品的每日目标不能直接外推为长期累计倍数。');
    if (tradeStats.profitFactor != null && tradeStats.profitFactor < 1) insights.push('盈利金额不足以覆盖亏损金额，优先复盘最大亏损记录，检查加仓、退出条件及集中风险。');
    insights.push('每次开仓预先记录失效条件、退出计划与账户风险预算；同一标的的加仓合并计算风险。这里没有账户净值，不能计算账户收益率或最佳仓位。');
    return { currency, ...tradeStats, realized, realizedFees, windowFees: money(windowFees), otherNet,
      realizedWithOther: money(realized + otherNet),
      openCost: money(open.reduce((s, r) => s + r.cost, 0)), openBuyFees: money(open.reduce((s, r) => s + r.buyFees, 0)), open,
      partialSales: sales.length - complete.length, unmatched, invalid,
      duplicateCount, duplicateAmount: money(duplicateAmount),
      bigLossCount: bigLosses.length, bigLossAmount: money(-bigLosses.reduce((s, r) => s + r.pnl, 0)),
      bigLossShare: tradeStats.loss ? -bigLosses.reduce((s, r) => s + r.pnl, 0) / tradeStats.loss * 100 : null,
      smallWinCount: smallWins.length, smallWinShare: tradeStats.wins ? smallWins.length / tradeStats.wins * 100 : null,
      assets, bins, holding: groupStats(complete, (s) => holdBucket(s.holding)),
      dte: groupStats(fragments.filter((f) => f.category === 'option'), (f) => f.dteBucket),
      months: groupStats(sales, (s) => s.date.slice(0, 7)).sort((a, b) => a.key.localeCompare(b.key)),
      symbols: groupStats(sales, (s) => s.symbol).map((g) => ({ ...g, name: sales.find((s) => s.symbol === g.key)?.name || g.key })),
      optionUnderlying: groupStats(sales.filter((s) => s.category === 'option'), (s) => s.underlying),
      other: groupStats(other, (s) => s.key),
      worst: [...sales].sort((a, b) => a.pnl - b.pnl).slice(0, 10).map((s) => ({ ...s, pnl: money(s.pnl), cost: money(s.cost), fees: money(s.fees) })),
      insights };
  });
  return { startDate, endDate, firstDate: history[0]?.day || null, lastDate: history.at(-1)?.day || null, currencies: reports };
}
