import { calculateChart } from './mingli-chart.js';

const ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const clean = (value, max = 200) => String(value ?? '').trim().slice(0, max);
function sourceTime(value) {
  const s = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00$/.test(s)) throw new Error('出生时间缺失、格式无效或含未支持的秒数');
  return s;
}
function noteText(raw) {
  const notes = raw.sourceNotes || {};
  return [['content', '原站笔记'], ['feedbackData', '事件记录'], ['bzData', '命盘记录'], ['feedbackStruct', '事件结构'], ['bzStruct', '命盘结构']]
    .filter(([key]) => typeof notes[key] === 'string' && notes[key].trim())
    .map(([key, title]) => title + '\n' + notes[key].trim()).join('\n\n');
}

export function prepareWenZhenImport(bundle) {
  if (!bundle || bundle.format !== 'navigation-wenzhen-v1' || !Array.isArray(bundle.cases) || !bundle.cases.length || bundle.cases.length > 1000) throw new Error('请使用 navigation-wenzhen-v1 案例文件（1—1000 条）');
  if (!Array.isArray(bundle.groups) || bundle.groups.length > 200) throw new Error('案例分组格式无效');
  const groups = new Map(bundle.groups.map(g => [g?.id, clean(g?.name, 30)]));
  const seen = new Set(), rows = [], errors = [];
  bundle.cases.forEach((raw, index) => {
    try {
      if (!raw || typeof raw !== 'object' || !ID.test(raw.guid || '')) throw new Error('原站案例 ID 无效');
      const key = raw.guid.toLowerCase();
      if (seen.has(key)) throw new Error('文件内案例 ID 重复');
      seen.add(key);
      if (raw.isdel) throw new Error('已删除的原站案例不导入');
      if (raw.unknowhour || raw.unknowminute) throw new Error('时辰或分钟不详，需人工核对');
      if (![1, 2].includes(raw.sex)) throw new Error('原站性别必须为 1（男）或 2（女）');
      if (raw.hw || raw.xls || raw.bjtime) throw new Error('海外、夏令时或时间换算标志需人工核对');
      const name = clean(raw.name, 80);
      if (!name) throw new Error('案例名称为空');
      const solar = sourceTime(raw.solarTime || raw.birthDay), recordedSolarTime = sourceTime(raw.sunTime || solar);
      const [year, month, day, hour, minute] = solar.match(/\d+/g).map(Number);
      const birth = { calendar: 'solar', year, month, day, hour, minute, gender: raw.sex === 1 ? 1 : 0, sect: bundle.settings?.midnight === true ? 2 : 1, yunSect: 1, location: clean(raw.location, 100), recordedSolarTime };
      const chart = calculateChart(birth), expected = clean(raw.bz).replace(/\s/g, '');
      const actual = chart.pillars.map(p => p.ganZhi).join('');
      if (!/^[甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥]{8}$/.test(expected)) throw new Error('缺少可核验的原站四柱');
      const group = groups.get(raw.groupGuid), notes = noteText(raw);
      if (notes.length > 20000) throw new Error('笔记超过 20000 字，需先拆分');
      const tags = ['问真导入', ...(group && group !== '全部' ? [group] : []), ...(raw.star ? ['星标'] : []), ...(expected !== actual ? ['四柱待核对'] : [])];
      // Explicit allowlist excludes source-account credentials and arbitrary payload fields.
      const source = { provider: 'wenzhen', key, capturedAt: clean(bundle.capturedAt, 40),
        original: Object.fromEntries(['guid', 'name', 'sex', 'birthDay', 'solarTime', 'sunTime', 'lunarTime', 'isLeapMonth', 'leapMonth', 'location', 'type', 'groupGuid', 'bz', 'star', 'timetype', 'unknowhour', 'unknowminute', 'xls', 'hw', 'bjtime', 'editdate'].map(k => [k, raw[k] ?? null])),
        group: group || '', originalPillars: expected, matched: expected === actual,
        notes: Object.fromEntries(['content', 'feedbackData', 'bzData', 'feedbackStruct', 'bzStruct'].map(k => [k, typeof raw.sourceNotes?.[k] === 'string' ? raw.sourceNotes[k] : ''])) };
      rows.push({ name, birth: chart.input, chart, tags, notes, source });
    } catch (e) { errors.push({ row: index + 1, error: e.message }); }
  });
  return { rows, errors, total: bundle.cases.length };
}
