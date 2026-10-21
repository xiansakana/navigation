const STEMS = '甲乙丙丁戊己庚辛壬癸', BRANCHES = '子丑寅卯辰巳午未申酉戌亥';
const MARKERS = { 元男: 1, 元女: 0, 乾造: 1, 坤造: 0 };
const label = value => typeof value === 'string' ? value.replace(/[^\p{L}\p{N} _（）()-]/gu, '').trim().slice(0, 60) : '';
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
    const relation = ['comparison', 'same_person_versions'].includes(chart.relation) ? chart.relation : 'unknown';
    charts.push({ pillars: chart.pillars, marker: chart.marker, gender: MARKERS[chart.marker], frame: frame.name, time: frame.time,
      subject: label(chart.subject), position: label(chart.position), relation });
  }
  return { notes: result.notes, charts, structured: true };
}
export function visualChartAppendix(charts, documentId) {
  if (!/^[a-f0-9]{32}$/.test(documentId || '')) return '';
  const unique = new Map();
  for (const c of charts) unique.set(c.pillars.join('') + ':' + c.marker + ':' + (c.subject || c.position || ''), c);
  if (!unique.size) return '';
  return '\n\n## 画面核对依据\n\n以下逐盘保留四柱、性别标记、对象和位置。多盘可能属于人物对比或同人版本修正；先判断对象关系，再核对冲突，关系不明时不合并人物。\n' + [...unique.values()].map((c, i) => {
    const time = new Date(Math.round(c.time * 1000)).toISOString().slice(11, 19);
    const subject = label(c.subject || c.position), position = label(c.position);
    const identity = c.relation === 'comparison' && subject ? `对比对象：${subject}\n` : '';
    const relation = c.relation === 'comparison' ? '对比命盘，按对象分别记录' : c.relation === 'same_person_versions' ? '同一命主的不同版本，差异待核对' : '对象关系未确认，不据此认定为同一人';
    return `\n### 画面案例 ${i + 1}：${subject ? subject + ' · ' : ''}${c.pillars.join(' ')}\n\n${identity}四柱：${c.pillars.join('、')}。\n画面性别标记：${c.marker}（${c.gender === 1 ? '男命' : '女命'}；截图 [${time}](/api/knowledge/documents/${documentId}/frames/${c.frame})）。\n命盘关系：${relation}。${position ? '画面位置：' + position + '。' : ''}\n`;
  }).join('');
}
