import { STEMS, BRANCHES, RELATIONS } from '../public/mingli/filter-options.js';

const relationMap = new Map(RELATIONS.flatMap(([id, , field, values]) => values.map(value => [id + ':' + value, { field, value }])));
const allowed = new Set(['gender', 'location', 'solarFrom', 'solarTo', 'notes', 'pillars', 'characters', 'relations', 'relationMode']);
const literalLike = value => '%' + value.replace(/[!%_]/g, '!$&') + '%';

export function parseCaseFilters(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    if (raw.length > 6000) throw new Error('高级筛选条件过长');
    try { raw = JSON.parse(raw); } catch { throw new Error('高级筛选格式无效'); }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !allowed.has(k))) throw new Error('高级筛选格式无效');
  const f = {};
  if (raw.gender !== undefined && raw.gender !== '') {
    if (![0, 1, '0', '1'].includes(raw.gender)) throw new Error('性别筛选无效');
    f.gender = Number(raw.gender);
  }
  if (raw.location !== undefined) {
    if (typeof raw.location !== 'string' || raw.location.length > 100) throw new Error('出生地区筛选无效');
    if (raw.location.trim()) f.location = raw.location.trim();
  }
  for (const key of ['solarFrom', 'solarTo']) {
    if (!raw[key]) continue;
    if (typeof raw[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw[key])) throw new Error('出生日期筛选无效');
    const date = new Date(raw[key] + 'T00:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw[key] || raw[key] < '1901-01-01' || raw[key] > '2099-12-31') throw new Error('出生日期筛选无效');
    f[key] = raw[key];
  }
  if (f.solarFrom && f.solarTo && f.solarFrom > f.solarTo) throw new Error('出生日期起始不能晚于结束');
  if (raw.notes) {
    if (!['yes', 'no'].includes(raw.notes)) throw new Error('笔记筛选无效');
    f.notes = raw.notes;
  }
  if (raw.pillars !== undefined) {
    if (!Array.isArray(raw.pillars) || raw.pillars.length !== 4) throw new Error('四柱筛选需包含四组干支');
    f.pillars = raw.pillars.map(p => {
      if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => !['gan', 'zhi'].includes(k))) throw new Error('四柱筛选无效');
      const pair = {};
      for (const [key, choices] of [['gan', STEMS], ['zhi', BRANCHES]]) {
        if (!p[key]) continue;
        if (typeof p[key] !== 'string' || p[key].length !== 1 || !choices.includes(p[key])) throw new Error('四柱干支筛选无效');
        pair[key] = p[key];
      }
      return pair;
    });
    if (!f.pillars.some(p => Object.keys(p).length)) delete f.pillars;
  }
  for (const [key, max, valid] of [['characters', 22, c => typeof c === 'string' && c.length === 1 && (STEMS + BRANCHES).includes(c)], ['relations', relationMap.size, c => relationMap.has(c)]]) {
    if (raw[key] === undefined) continue;
    if (!Array.isArray(raw[key]) || raw[key].length > max || raw[key].some(c => !valid(c))) throw new Error(key === 'characters' ? '任意干支筛选无效' : '干支关系筛选无效');
    if (raw[key].length) f[key] = [...new Set(raw[key])];
  }
  if (raw.relationMode !== undefined && !['all', 'any'].includes(raw.relationMode)) throw new Error('关系匹配方式无效');
  if (f.relations) f.relationMode = raw.relationMode || 'all';
  return f;
}

export function caseFilterSql(raw) {
  const filters = parseCaseFilters(raw), clauses = [], args = [];
  const add = (sql, ...values) => { clauses.push(sql); args.push(...values); };
  if (filters.gender !== undefined) add("json_extract(birth_json, '$.gender') = ?", filters.gender);
  if (filters.location) add("json_extract(birth_json, '$.location') LIKE ? ESCAPE '!'", literalLike(filters.location));
  if (filters.solarFrom) add("substr(json_extract(chart_json, '$.solar'), 1, 10) >= ?", filters.solarFrom);
  if (filters.solarTo) add("substr(json_extract(chart_json, '$.solar'), 1, 10) <= ?", filters.solarTo);
  if (filters.notes) add(filters.notes === 'yes' ? "length(trim(notes, char(9)||char(10)||char(13)||' ')) > 0" : "length(trim(notes, char(9)||char(10)||char(13)||' ')) = 0");
  filters.pillars?.forEach((p, i) => {
    for (const [key, value] of Object.entries(p)) add(`json_extract(chart_json, '$.pillars[${i}].${key}') = ?`, value);
  });
  // Counts make 辰辰 require two actual natal branches; a single 辰 cannot match itself.
  const occurrence = (field, count) => `(SELECT count(*) FROM json_each(chart_json, '$.pillars') p WHERE json_extract(p.value, '$.${field}') = ?) >= ${count}`;
  for (const char of filters.characters || []) add(occurrence(STEMS.includes(char) ? 'gan' : 'zhi', 1), char);
  if (filters.relations) {
    const groups = filters.relations.map(id => {
      const { field, value } = relationMap.get(id), counts = new Map();
      for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
      return '(' + [...counts].map(([char, count]) => { args.push(char); return occurrence(field, count); }).join(' AND ') + ')';
    });
    clauses.push('(' + groups.join(filters.relationMode === 'any' ? ' OR ' : ' AND ') + ')');
  }
  return { filters, clauses, args };
}
