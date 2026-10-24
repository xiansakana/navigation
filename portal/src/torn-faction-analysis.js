export const DAY = 86400;
export const FACTION_DEFAULTS = { apiKey: '', minRespect: 0, maxRespect: null, batchSize: 10, historyMode: 'full', historyDays: 365, dropMode: 'daily', dailyDropPct: 50, peakDropPct: 50, minDifference: 0, maxDifference: null };

export function factionConfig(input, previous = FACTION_DEFAULTS) {
  const result = { ...FACTION_DEFAULTS, ...previous };
  for (const [key, min, max] of [['minRespect', 0, 2147483647], ['maxRespect', 0, 2147483647], ['batchSize', 1, 50], ['historyDays', 2, 3650], ['minDifference', -10000, 10000], ['maxDifference', -10000, 10000]]) {
    if (!(key in input)) continue;
    if (['maxRespect', 'minDifference', 'maxDifference'].includes(key) && (input[key] === '' || input[key] === null)) { result[key] = null; continue; }
    if (!['string', 'number'].includes(typeof input[key]) || input[key] === '' || !Number.isSafeInteger(Number(input[key])) || Number(input[key]) < min || Number(input[key]) > max) throw new Error('筛选范围或批次数值无效');
    result[key] = Number(input[key]);
  }
  for (const key of ['dailyDropPct', 'peakDropPct']) if (key in input) {
    if (!['number', 'string'].includes(typeof input[key]) || input[key] === '' || !Number.isFinite(Number(input[key])) || Number(input[key]) <= 0 || Number(input[key]) > 100) throw new Error('降幅百分比必须大于 0 且不超过 100');
    result[key] = Number(input[key]);
  }
  for (const [key, values] of [['historyMode', ['full', 'window']], ['dropMode', ['daily', 'peak', 'both']]]) if (key in input) {
    if (!values.includes(input[key])) throw new Error('筛选方式无效'); result[key] = input[key];
  }
  if (result.maxRespect !== null && result.maxRespect < result.minRespect || result.minDifference !== null && result.maxDifference !== null && result.maxDifference < result.minDifference) throw new Error('上限不能小于下限');
  if ('apiKey' in input) {
    result.apiKey = String(input.apiKey || '').trim();
    if (result.apiKey && !/^[A-Za-z0-9]{16}$/.test(result.apiKey)) throw new Error('API Key 应为 16 位字母或数字');
  }
  return result;
}

export function historicNetworth(data, requestedDay) {
  const point = data.personalstats?.find?.(row => row.name === 'networth');
  if (!point || !Number.isSafeInteger(point.value) || !Number.isSafeInteger(point.timestamp) || point.timestamp <= 0) throw new Error('API 未返回有效的历史 networth');
  return { day: requestedDay, value: point.value, timestamp: point.timestamp, exactDay: Math.floor(point.timestamp / DAY) === requestedDay };
}

export function analyzeFactionHistory(points, { today, lastAction, daysInFaction }, config) {
  const B = Number.isSafeInteger(lastAction) && lastAction > 0 && lastAction <= (today + 1) * DAY ? today - Math.floor(lastAction / DAY) : null;
  const C = Number.isSafeInteger(daysInFaction) && daysInFaction >= 0 ? daysInFaction : null;
  const sorted = [...points].sort((a, b) => a.day - b.day);
  const common = { B, C, samples: sorted.length, firstDay: sorted[0]?.day, lastDay: sorted.at(-1)?.day, scope: config.historyMode };
  if (B === null || B < 0 || C === null || sorted.length < 2 || sorted.at(-1).day !== today || sorted.some((point, i) => !point.exactDay || !Number.isSafeInteger(point.value) || i && point.day !== sorted[i - 1].day + 1)) return { ...common, status: 'unknown', reason: '历史缺失、日期粒度不足或身份时间数据无效，不能确认具体下跌日' };
  const suffixMax = new Array(sorted.length); suffixMax[sorted.length - 1] = sorted.at(-1).value;
  for (let i = sorted.length - 2; i >= 0; i--) suffixMax[i] = Math.max(sorted[i].value, suffixMax[i + 1]);
  let peak = sorted[0].value, latest = null;
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1].value, value = sorted[i].value;
    const dailyPct = previous > 0 ? (previous - value) / previous * 100 : null;
    const peakPct = peak > 0 ? (peak - value) / peak * 100 : null;
    const dailyPass = dailyPct !== null && dailyPct + 1e-9 >= config.dailyDropPct;
    const peakPass = peakPct !== null && peakPct + 1e-9 >= config.peakDropPct;
    if (value < previous && (config.dropMode === 'daily' ? dailyPass : config.dropMode === 'peak' ? peakPass : dailyPass && peakPass) && suffixMax[i] < peak) latest = { dropDay: sorted[i].day, peakBefore: peak, beforeValue: previous, dropValue: value, dailyPct, peakPct };
    peak = Math.max(peak, value);
  }
  if (!latest) return { ...common, status: 'excluded', reason: '扫描范围内没有满足降幅且此后始终未回到下跌前最高点的事件' };
  const A = today - latest.dropDay, difference = A - B;
  const joinedBefore = C >= A, differencePass = (config.minDifference === null || difference >= config.minDifference) && (config.maxDifference === null || difference <= config.maxDifference);
  return { ...common, ...latest, A, difference, status: joinedBefore && differencePass ? 'match' : 'excluded', reason: !joinedBefore ? 'C < A：在帮派时间短于下跌至今时间' : !differencePass ? 'A−B 超出配置范围' : '降幅、未恢复高点、C≥A 和 A−B 均符合配置' };
}
