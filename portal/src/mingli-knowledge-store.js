import crypto from 'node:crypto';
import { flowPillar } from '../public/mingli/chart-presentation.js';
import { STEMS, BRANCHES, PILLARS } from '../public/mingli/filter-options.js';
import { caseFilterSql } from './mingli-filters.js';

const VERSION = 'knowledge-bazi-v2';
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const pair = `[${STEMS}][${BRANCHES}]`;
const clean = text => text.replace(/[*`_]/g, '');
function genderEvidence(lines, offsets, index, start, end) {
  const evidence = [];
  const chartStart = text => /(?:四柱|八字|乾造|坤造)\s*[:：]?\s*[甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥]|年柱.*月柱.*日柱.*时柱/.test(clean(text));
  const previousChart = lines.slice(Math.max(0, start - 1), index).some(chartStart);
  for (let j = previousChart ? index : Math.max(start, index - 3); j < Math.min(end, index + 12); j++) {
    const line = clean(lines[j]).trim(), plain = line.replace(/^(?:#+\s*|[-+>]\s*)/, '');
    if (j > index && chartStart(line)) break;
    const labelled = /^(?:画面性别标记|性别依据|命主性别|性别|日主标记|日元标记|画面标记)\s*[:：]/.test(plain);
    const standalone = /^(?:元\s*[男女]|男命|女命|乾造|坤造)(?:\s|[：:，,。；;（(]|$)/.test(plain);
    if (!(j === index || j === start && /^#/.test(line) || labelled || standalone)) continue;
    if (/待核对|模糊|看不清|无法辨认|不确定|未确认/.test(line)) continue;
    const female = /女命|坤造|元\s*女/.test(line) || labelled && /[:：]\s*女(?:\s|[（(，,。；;]|$)/.test(line);
    const male = /男命|乾造|元\s*男/.test(line) || labelled && /[:：]\s*男(?:\s|[（(，,。；;]|$)/.test(line);
    if (female) evidence.push({ gender: 0, text: line, offset: offsets[j] });
    if (male) evidence.push({ gender: 1, text: line, offset: offsets[j] });
  }
  return evidence;
}
function resolveGender(evidence) { const values = new Set(evidence.map(e => e.gender)); return { gender: values.size === 1 ? [...values][0] : null, genderConflict: values.size > 1 }; }

// Extract only explicitly ordered natal pillars. Dates, luck rows and ASR fragments are not inferred.
export function extractKnowledgeCases(notes) {
  const lines = notes.split('\n'), offsets = [], scopes = [], stack = []; let offset = 0, headingIndex = -1;
  for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  for (let i = 0; i < lines.length; i++) {
    const match = /^(#{1,6})\s+(.+)$/.exec(lines[i]);
    if (match) {
      const level = match[1].length;
      while (stack.length && stack.at(-1).level >= level) stack.pop().end = i;
      if ([2, 3].includes(level)) headingIndex++;
      stack.push({ index: i, level, end: lines.length, anchor: headingIndex >= 0 ? 'kb-heading-' + headingIndex : '', isCase: /案例|命例|例[一二三四五六七八九十\d]/.test(match[2]) });
    }
    scopes[i] = stack.findLast(s => s.isCase);
  }
  const found = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = clean(lines[i]), next = lines.slice(i, i + 4).map(clean).join('\n');
    let values;
    if (/(?:四柱|八字|乾造|坤造)/.test(line) && !/^\s*#/.test(line)) {
      const tail = line.replace(/^.*?(?:四柱|八字|乾造|坤造)\s*[:：]?\s*/, '');
      const match = new RegExp(String.raw`^(${pair})[\s、，,|/；;]*(${pair})[\s、，,|/；;]*(${pair})[\s、，,|/；;]*(${pair})(?![${STEMS}${BRANCHES}])`).exec(tail);
      if (match) values = match.slice(1, 5);
    }
    if (!values && /年柱/.test(line)) {
      const labelled = new RegExp(String.raw`年柱\s*[:：]?\s*(${pair})[\s、，,；;|]*月柱\s*[:：]?\s*(${pair})[\s、，,；;|]*日柱\s*[:：]?\s*(${pair})[\s、，,；;|]*时柱\s*[:：]?\s*(${pair})`).exec(next);
      if (labelled) values = labelled.slice(1, 5);
      else if (/年柱\s*\|\s*月柱\s*\|\s*日柱\s*\|\s*时柱/.test(line)) {
        const rows = lines.slice(i + 1, i + 5).map(clean).filter(l => !/^\s*\|?[\s:|\-]+$/.test(l));
        const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        const row = cells(rows[0] || '');
        if (row.length === 4 && row.every(c => new RegExp(`^${pair}$`).test(c))) values = row;
        else {
          const second = cells(rows[1] || '');
          if (row.length === 4 && second.length === 4 && row.every(c => c.length === 1 && STEMS.includes(c)) && second.every(c => c.length === 1 && BRANCHES.includes(c))) values = row.map((c, j) => c + second[j]);
        }
      }
    }
    if (!values) continue;
    const key = values.join(''), previous = found.get(key);
    const scope = scopes[i], heading = scope?.index ?? -1;
    const start = heading < 0 ? Math.max(0, i - 2) : heading;
    const end = scope?.end ?? Math.min(lines.length, i + 24);
    const contextStart = offsets[start], contextEnd = offsets[end] ?? notes.length;
    const context = notes.slice(contextStart, Math.min(contextEnd, contextStart + 30000)).trimEnd();
    const evidence = genderEvidence(lines, offsets, i, start, end);
    const gender = resolveGender(evidence);
    const title = heading >= 0 ? clean(lines[heading].replace(/^#+\s*/, '')).slice(0, 160) : '八字案例 ' + values.join(' ');
    const valid = values.every(p => flowPillar(p, values[2][0]));
    const reference = { title, offset: offsets[i], sectionOffset: offsets[start], anchor: scope?.anchor || '' };
    if (previous) {
      previous.occurrences.push(offsets[i]);
      if (!previous.references.some(r => r.sectionOffset === reference.sectionOffset)) {
        previous.references.push(reference);
        const combined = previous.context + '\n\n--- 同一四柱的另一处来源 ---\n\n' + context;
        previous.context = combined.slice(0, 30000); previous.excerptTruncated ||= combined.length > 30000;
      }
      previous.genderEvidence.push(...evidence);
      Object.assign(previous, resolveGender(previous.genderEvidence));
      continue;
    }
    found.set(key, { key, title, pairs: values, ...gender, genderEvidence: evidence, context, offset: offsets[i], occurrences: [offsets[i]], references: [reference],
      anchor: scope?.anchor || '', excerptTruncated: contextEnd - contextStart > 30000,
      timeLabel: context.match(/(?:讲解[：:]?\s*)?(\d{1,2}:\d{2}(?::\d{2})?(?:[—–~-]\d{1,2}:\d{2}(?::\d{2})?)?)/)?.[1] || '',
      validation: valid ? '四柱干支有效；自动提取，尚未人工核对' : '存在无效干支，需对照原文核对' });
  }
  return [...found.values()].map(item => ({ ...item, validation: item.validation + (item.genderConflict ? '；性别依据冲突，需核对' : '') }));
}

export function createKnowledgeCaseStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS mingli_knowledge_cases (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,document_id TEXT NOT NULL,case_key TEXT NOT NULL,
    title TEXT NOT NULL,birth_json TEXT NOT NULL,chart_json TEXT NOT NULL,notes TEXT NOT NULL,metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(user_id,document_id,case_key));
    CREATE INDEX IF NOT EXISTS mingli_knowledge_owner ON mingli_knowledge_cases(user_id,document_id);
    CREATE TABLE IF NOT EXISTS mingli_knowledge_index (
      user_id TEXT NOT NULL,document_id TEXT NOT NULL,content_hash TEXT NOT NULL,source_stamp TEXT NOT NULL,PRIMARY KEY(user_id,document_id));`);
  const read = row => {
    if (!row) return row;
    const metadata = JSON.parse(row.metadata_json);
    return { id: row.id, title: row.title, documentId: row.document_id, documentTitle: row.document_title,
      topic: row.topic, sourceUrl: '/knowledge/?document=' + row.document_id + (metadata.anchor ? '#' + metadata.anchor : ''), originalUrl: row.source_url,
      birth: JSON.parse(row.birth_json), chart: JSON.parse(row.chart_json), notes: row.notes,
      ...metadata, createdAt: row.created_at, updatedAt: row.updated_at };
  };
  const joined = ` FROM mingli_knowledge_cases c JOIN knowledge_documents d ON d.id=c.document_id AND d.user_id=c.user_id
    WHERE c.user_id=? AND d.status IN ('ready','failed') AND d.notes<>''`;
  function syncDocument(row) {
    return db.transaction(() => {
      const digest = hash(VERSION + JSON.stringify([row.title, row.topic, row.tags_json, row.notes, row.source_url]));
      const stamp = VERSION + ':' + row.revision + ':' + row.updated_at;
      if (db.prepare('SELECT content_hash FROM mingli_knowledge_index WHERE user_id=? AND document_id=?').get(row.user_id, row.id)?.content_hash === digest) {
        db.prepare('UPDATE mingli_knowledge_index SET source_stamp=? WHERE user_id=? AND document_id=?').run(stamp, row.user_id, row.id); return;
      }
      const active = ['ready', 'failed'].includes(row.status) && row.notes;
      const cases = active ? extractKnowledgeCases(row.notes) : [];
      const keys = new Set(cases.map(c => c.key));
      for (const old of db.prepare('SELECT id,case_key FROM mingli_knowledge_cases WHERE user_id=? AND document_id=?').all(row.user_id, row.id)) {
        if (!keys.has(old.case_key)) db.prepare('DELETE FROM mingli_knowledge_cases WHERE user_id=? AND id=?').run(row.user_id, old.id);
      }
      for (const item of cases) {
        const id = hash(row.user_id + ':' + row.id + ':' + item.key).slice(0, 32), now = new Date().toISOString();
        const chart = { dayMaster: item.pairs[2][0], pillars: item.pairs.map((p, i) => ({ ...(flowPillar(p, item.pairs[2][0]) || { ganZhi: p, gan: p[0], zhi: p[1] }), label: PILLARS[i] })) };
        const metadata = { validation: item.validation, genderEvidence: item.genderEvidence, genderConflict: item.genderConflict, timeLabel: item.timeLabel, offset: item.offset, anchor: item.anchor, excerptTruncated: item.excerptTruncated, occurrences: item.occurrences, references: item.references, tags: JSON.parse(row.tags_json), parserVersion: VERSION };
        db.prepare(`INSERT INTO mingli_knowledge_cases(id,user_id,document_id,case_key,title,birth_json,chart_json,notes,metadata_json,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,document_id,case_key) DO UPDATE SET title=excluded.title,birth_json=excluded.birth_json,
          chart_json=excluded.chart_json,notes=excluded.notes,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`)
          .run(id, row.user_id, row.id, item.key, item.title, JSON.stringify({ gender: item.gender, location: '' }), JSON.stringify(chart), item.context, JSON.stringify(metadata), now, now);
      }
      db.prepare('INSERT INTO mingli_knowledge_index VALUES(?,?,?,?) ON CONFLICT(user_id,document_id) DO UPDATE SET content_hash=excluded.content_hash,source_stamp=excluded.source_stamp').run(row.user_id, row.id, digest, stamp);
    })();
  }
  const removeDocument = (uid, id) => {
    db.prepare('DELETE FROM mingli_knowledge_cases WHERE user_id=? AND document_id=?').run(uid, id);
    db.prepare('DELETE FROM mingli_knowledge_index WHERE user_id=? AND document_id=?').run(uid, id);
  };
  function sync(uid) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_documents'").get()) return;
    db.transaction(() => {
      const rows = db.prepare("SELECT id,revision,updated_at FROM knowledge_documents WHERE user_id=? AND status IN ('ready','failed') AND notes<>''").all(uid);
      const ids = new Set(rows.map(r => r.id));
      for (const old of db.prepare('SELECT document_id FROM mingli_knowledge_index WHERE user_id=?').all(uid)) if (!ids.has(old.document_id)) removeDocument(uid, old.document_id);
      for (const row of rows) {
        const stamp = VERSION + ':' + row.revision + ':' + row.updated_at;
        if (db.prepare('SELECT source_stamp FROM mingli_knowledge_index WHERE user_id=? AND document_id=?').get(uid, row.id)?.source_stamp !== stamp) syncDocument(db.prepare('SELECT * FROM knowledge_documents WHERE user_id=? AND id=?').get(uid, row.id));
      }
    })();
  }
  return {
    syncDocument, removeDocument,
    list(uid, { search = '', filters = {}, documentId = '', offset = 0, limit = 30 } = {}) {
      sync(uid);
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_documents'").get()) return { cases: [], total: 0, offset, limit, documents: [], uniqueCharts: 0 };
      let where = joined; const args = [uid];
      if (search) { const value = '%' + String(search).slice(0, 100).replace(/[!%_]/g, '!$&') + '%'; where += " AND (c.title LIKE ? ESCAPE '!' OR c.notes LIKE ? ESCAPE '!' OR d.title LIKE ? ESCAPE '!' OR d.tags_json LIKE ? ESCAPE '!')"; args.push(value, value, value, value); }
      if (documentId) { if (!/^[a-f0-9]{32}$/.test(documentId)) throw new Error('来源筛选无效'); where += ' AND c.document_id=?'; args.push(documentId); }
      const advanced = caseFilterSql(filters);
      // Both tables have notes; evaluate advanced clauses against the derived case only.
      for (const clause of advanced.clauses) where += ' AND (' + clause.replace(/\bnotes\b/g, 'c.notes') + ')';
      args.push(...advanced.args);
      const counts = db.prepare('SELECT count(*) AS total,count(DISTINCT c.case_key) AS uniqueCharts' + where).get(...args);
      const cases = db.prepare('SELECT c.*,d.title AS document_title,d.topic,d.source_url' + where + ' ORDER BY c.updated_at DESC,c.id LIMIT ? OFFSET ?').all(...args, limit, offset).map(read);
      const documents = db.prepare('SELECT d.id,d.title,count(*) AS count' + joined + ' GROUP BY d.id ORDER BY d.title').all(uid);
      return { cases, ...counts, documents, offset, limit };
    },
    get(uid, id) {
      sync(uid);
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_documents'").get()) return null;
      return read(db.prepare('SELECT c.*,d.title AS document_title,d.topic,d.source_url' + joined + ' AND c.id=?').get(uid, id));
    }
  };
}
