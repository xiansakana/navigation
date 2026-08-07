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

export function buildHoldingsGroups(rows, sortKey, sortDir) {
  const sorted = [...rows].sort(compareHoldingsRows);
  const groupMap = new Map();
  for (const h of sorted) {
    const key = effectiveGroupKey(h);
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(h);
  }
  const keys = [...groupMap.keys()].sort((a, b) => {
    if (sortKey === 'symbol') return a.localeCompare(b) * sortDir;
    const wa = groupMap.get(a)[0]?.weight ?? 0;
    const wb = groupMap.get(b)[0]?.weight ?? 0;
    if (wa !== wb) return (wa - wb) * sortDir;
    return a.localeCompare(b) * sortDir;
  });
  return keys.map((key) => ({ key, items: groupMap.get(key) }));
}

export function toggleTableSort(current, key) {
  if (current.key === key) return { key, dir: current.dir === 1 ? -1 : 1 };
  return { key, dir: 1 };
}

export function sortMark(current, key) {
  if (current.key !== key) return '';
  return current.dir === 1 ? ' ▲' : ' ▼';
}
