/** 自动分组：期权取标的代码，股票取 symbol */
export function rawTicker(h) {
  const sym = String(h.symbol || '').trim().toUpperCase();
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
  if (type === 'ashare') return 1;
  if (type === 'option') return 2;
  return 3;
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

export function buildHoldingsGroups(rows, sortKey, sortDir) {
  const sorted = [...rows].sort(compareHoldingsRows);
  const groupMap = new Map();
  for (const h of sorted) {
    const key = effectiveGroupKey(h);
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(h);
  }
  const keys = [...groupMap.keys()].sort((a, b) => {
    const itemsA = groupMap.get(a);
    const itemsB = groupMap.get(b);
    const wa = groupWeight(itemsA);
    const wb = groupWeight(itemsB);
    const ta = typeRank(groupPrimaryType(itemsA));
    const tb = typeRank(groupPrimaryType(itemsB));

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
  return keys.map((key) => ({ key, items: groupMap.get(key) }));
}

export function toggleTableSort(current, key) {
  if (current.key === key) return { key, dir: current.dir === 1 ? -1 : 1 };
  // 仓位默认从高到低；类型/代码默认正序
  if (key === 'weight') return { key, dir: -1 };
  return { key, dir: 1 };
}

export function sortMark(current, key) {
  if (current.key !== key) return '';
  return current.dir === 1 ? ' ▲' : ' ▼';
}
