/** 自动分组：期权取标的代码，股票取 symbol */
export function rawTicker(h) {
  const sym = String(h.tradeSymbol || h.symbol || '').trim().toUpperCase();
  if (h.type === 'option' || /^[A-Z]+\d{6}[CP]/i.test(sym)) {
    const m = sym.match(/^([A-Z]+)\d{6}[CP]/i);
    if (m) return m[1];
  }
  return sym;
}

export function effectiveGroupKey(h) {
  const manual = String(h.groupWith || '').trim().toUpperCase();
  if (manual) return manual;
  return rawTicker(h);
}

/** stock < ashare < option，便于类型排序 */
export function typeRank(type) {
  if (type === 'stock') return 0;
  if (type === 'ashare' || type === 'fund') return 1;
  if (type === 'hkstock') return 2;
  if (type === 'option') return 3;
  return 4;
}

/** 组内主类型：优先非期权（正股 / A股） */
export function groupPrimaryType(items) {
  if (!items?.length) return 'stock';
  const nonOpt = items.find((h) => h.type !== 'option');
  return nonOpt?.type || items[0].type || 'stock';
}

/** 组内：先股票后期权，再按代码 */
export function compareHoldingsRows(a, b) {
  const ua = effectiveGroupKey(a);
  const ub = effectiveGroupKey(b);
  if (ua !== ub) return ua.localeCompare(ub);
  const oa = a.type === 'option' ? 1 : 0;
  const ob = b.type === 'option' ? 1 : 0;
  if (oa !== ob) return oa - ob;
  return a.symbol.localeCompare(b.symbol);
}

function groupWeight(items) {
  return items[0]?.weight ?? 0;
}

export function individualHoldingWeight(holding) {
  if (holding.marketValue == null) return null;
  const weight = holding.groupMarketValue === 0
    ? holding.weight
    : holding.weight * holding.marketValue / holding.groupMarketValue;
  return Number.isFinite(weight) ? weight : null;
}

const numericSorts = new Set(['pnl', 'pnlPct', 'dailyPnl', 'dailyPnlPct', 'position']);
const accountCollator = new Intl.Collator('zh-CN', { numeric: true });
export const isHoldingsSortable = key => numericSorts.has(key) || ['account', 'symbol', 'type', 'weight'].includes(key);

function comparable(a, b, dir, compare = (x, y) => x - y) {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
  return compare(a, b) * dir;
}

function groupMetric(items, key, rates) {
  let total = 0, basis = 0, count = 0;
  const isRate = key.endsWith('Pct');
  const daily = key === 'dailyPnlPct' || key === 'dailyPnl';
  for (const h of items) {
    const position = h.price === 0 ? null : h.marketValue;
    const fx = h.currency === 'HKD' ? rates.usdHkdRate : h.currency === 'CNY' ? rates.usdCnyRate : 1;
    const amount = daily ? h.dailyPnl : h.pnl;
    if (isRate) {
      if (!Number.isFinite(h[key])) continue;
      if (items.length === 1) return { value: h[key], count: 1 };
      const nativeBasis = daily ? h.marketValueNative - amount : h.costBasisNative ?? h.cost;
      if (!Number.isFinite(nativeBasis) || nativeBasis <= 0 || !Number.isFinite(amount) || !(fx > 0)
        || (daily && !Number.isFinite(h.marketValueNative))) continue;
      basis += nativeBasis / fx;
      total += amount / fx;
    } else {
      const value = key === 'position' ? position : fx > 0 && Number.isFinite(amount) ? amount / fx : null;
      if (!Number.isFinite(value)) continue;
      total += value;
    }
    count++;
  }
  const value = count ? (isRate ? total / basis * 100 : total) : null;
  return { value, count };
}

export function summarizeHoldingsGroup(items, rates = {}, sortKey) {
  const keys = items.length > 1 ? numericSorts : numericSorts.has(sortKey) ? [sortKey] : [];
  return Object.fromEntries([...keys].map(key => [key, groupMetric(items, key, rates)]));
}

export function buildHoldingsGroups(rows, sortKey, sortDir, rates = {}) {
  const sorted = [...rows].sort(compareHoldingsRows);
  if (sortKey === 'account') {
    return sorted.sort((a, b) => comparable(a.accountName || null, b.accountName || null, sortDir,
      (x, y) => accountCollator.compare(x, y)) || String(a.accountId || '').localeCompare(String(b.accountId || ''))
      || compareHoldingsRows(a, b)).map(h => ({ key: effectiveGroupKey(h), items: [h], individualWeight: true }));
  }
  const groupMap = new Map();
  for (const h of sorted) {
    const key = effectiveGroupKey(h);
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(h);
  }
  const summaries = new Map([...groupMap].map(([key, items]) => [key, summarizeHoldingsGroup(items, rates, sortKey)]));
  const keys = [...groupMap.keys()].sort((a, b) => {
    const itemsA = groupMap.get(a);
    const itemsB = groupMap.get(b);
    const wa = groupWeight(itemsA);
    const wb = groupWeight(itemsB);
    const ta = typeRank(groupPrimaryType(itemsA));
    const tb = typeRank(groupPrimaryType(itemsB));

    if (numericSorts.has(sortKey)) {
      return comparable(summaries.get(a)[sortKey].value, summaries.get(b)[sortKey].value, sortDir) || a.localeCompare(b);
    }
    if (sortKey === 'symbol') {
      return a.localeCompare(b) * sortDir;
    }
    if (sortKey === 'type') {
      if (ta !== tb) return (ta - tb) * sortDir;
      // 同类型内按仓位从高到低
      if (wa !== wb) return wb - wa;
      return a.localeCompare(b);
    }
    // weight（默认）：仓位为主，类型为辅
    if (wa !== wb) return (wa - wb) * sortDir;
    if (ta !== tb) return ta - tb;
    return a.localeCompare(b);
  });
  return keys.map((key) => {
    const items = groupMap.get(key);
    const ordered = sortKey === 'weight' && items.length > 1
      ? [...items].sort((a, b) => comparable(individualHoldingWeight(a), individualHoldingWeight(b), sortDir))
      : items;
    return { key, items: ordered, anchor: items[0], summary: summaries.get(key) };
  });
}

export function toggleTableSort(current, key) {
  if (current.key === key) return { key, dir: current.dir === 1 ? -1 : 1 };
  if (key === 'weight' || numericSorts.has(key)) return { key, dir: -1 };
  return { key, dir: 1 };
}

export function sortMark(current, key) {
  if (current.key !== key) return '';
  return current.dir === 1 ? ' ▲' : ' ▼';
}
