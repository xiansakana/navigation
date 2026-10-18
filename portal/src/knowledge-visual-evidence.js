const STEMS = '甲乙丙丁戊己庚辛壬癸', BRANCHES = '子丑寅卯辰巳午未申酉戌亥';
const MARKERS = { 元男: 1, 元女: 0, 乾造: 1, 坤造: 0 };
export function parseVisualEvidence(text, frames) {
  let result;
  try { result = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { return { notes: text, charts: [], structured: false }; }
  if (!result || typeof result.notes !== 'string' || !Array.isArray(result.charts)) return { notes: text, charts: [], structured: false };
  const charts = [];
  for (const chart of result.charts.slice(0, 100)) {
    if (!chart || typeof chart !== 'object') continue;
    const frame = frames.find(f => f.name === chart.frame);
    if (!frame || !Number.isFinite(frame.time) || frame.time < 0 || !Object.hasOwn(MARKERS, chart.marker) || !Array.isArray(chart.pillars) || chart.pillars.length !== 4) continue;
    if (!chart.pillars.every(p => typeof p === 'string' && p.length === 2 && STEMS.includes(p[0]) && BRANCHES.includes(p[1]) && STEMS.indexOf(p[0]) % 2 === BRANCHES.indexOf(p[1]) % 2)) continue;
    charts.push({ pillars: chart.pillars, marker: chart.marker, gender: MARKERS[chart.marker], frame: frame.name, time: frame.time });
  }
  return { notes: result.notes, charts, structured: true };
}
export function visualChartAppendix(charts, documentId) {
  if (!/^[a-f0-9]{32}$/.test(documentId || '')) return '';
  const unique = new Map();
  for (const c of charts) unique.set(c.pillars.join('') + ':' + c.marker, c);
  if (!unique.size) return '';
  return '\n\n## 画面核对依据\n\n以下保留模型从同屏命盘识别的四柱与性别原始标记，供回看核对；冲突不擅自消除。\n' + [...unique.values()].map((c, i) => {
    const time = new Date(Math.round(c.time * 1000)).toISOString().slice(11, 19);
    return `\n### 画面案例 ${i + 1}：${c.pillars.join(' ')}\n\n四柱：${c.pillars.join('、')}。\n画面性别标记：${c.marker}（${c.gender === 1 ? '男命' : '女命'}；截图 [${time}](/api/knowledge/documents/${documentId}/frames/${c.frame})）。\n`;
  }).join('');
}
