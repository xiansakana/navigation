import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeCaseStore, extractKnowledgeCases } from './mingli-knowledge-store.js';
import { createKnowledgeStore } from './knowledge-store.js';
import { createMingliStore } from './mingli-store.js';
import { handleMingliApi } from './mingli.js';
import { getDatabase, closeDatabase } from '../../shared/db/index.js';

const notes = `# 课程笔记
## 案例一：结果与备选分开
**讲解：05:15—14:10。**
女命四柱：**丁巳、辛亥、壬午、乙巳**。
案例陈述：2002年结婚。2003年仅为备选，未独立验证。
### 原始分析
作者认为：印受损，需扶身；不等于已证实。
## 案例二：同宫换象
讲解：22:01—30:24。
男命四柱：甲子、戊辰、己丑、癸酉。
实际结果与候选须分别记录。
## 复习
大运：甲子、乙丑、丙寅、丁卯。
流年：甲子、乙丑、丙寅、丁卯。`;
const upload = { title: '测试课程', topic: '婚期', tags: ['案例'], bytes: 24, originalName: 'lesson.mp4', mimeType: 'video/mp4', backend: 'codex' };
function ready(db, store, uid = 'a', text = notes) {
  const document = store.create(uid, upload);
  db.prepare("UPDATE knowledge_documents SET status='ready',notes=?,revision=1 WHERE id=?").run(text, document.id);
  return store.get(uid, document.id);
}

test('extract explicit ordered natal cases with evidence, uncertainty and no invented birth dates', () => {
  const cases = extractKnowledgeCases(notes);
  assert.equal(cases.length, 2);
  assert.deepEqual(cases[0].pairs, ['丁巳', '辛亥', '壬午', '乙巳']);
  assert.equal(cases[0].gender, 0); assert.equal(cases[1].gender, 1);
  assert.equal(cases[0].timeLabel, '05:15—14:10');
  assert.match(cases[0].context, /2003年仅为备选/); assert.match(cases[0].context, /未独立验证/);
  assert.doesNotMatch(cases[0].context, /同宫换象/); assert.equal(cases[0].anchor, 'kb-heading-0');
  assert.equal(cases[0].offset, notes.indexOf('女命四柱'));
  assert.equal(extractKnowledgeCases('四柱：甲子 乙丑 丙寅').length, 0);
  assert.equal(extractKnowledgeCases('大运：甲子 乙丑 丙寅 丁卯\n流年：甲子 乙丑 丙寅 丁卯').length, 0);
  const duplicate = extractKnowledgeCases(notes + '\n四柱：丁巳 辛亥 壬午 乙巳');
  assert.equal(duplicate.length, 2); assert.equal(duplicate[0].occurrences.length, 2);
  const repeated = extractKnowledgeCases(notes + '\n## 案例三：另一个观点\n女命四柱：丁巳、辛亥、壬午、乙巳。\n保留第二处原文分析。');
  assert.equal(repeated.length, 2); assert.equal(repeated[0].references.length, 2); assert.match(repeated[0].context, /保留第二处原文分析/);
  assert.match(extractKnowledgeCases('四柱：甲丑 乙丑 丙寅 丁卯')[0].validation, /无效/);
});

test('extract labelled and table layouts while preserving year-month-day-hour order', () => {
  for (const text of [
    '年柱：甲子，月柱：戊辰，日柱：己丑，时柱：癸酉',
    '| 年柱 | 月柱 | 日柱 | 时柱 |\n|---|---|---|---|\n|甲子|戊辰|己丑|癸酉|',
    '男命\n| 年柱 | 月柱 | 日柱 | 时柱 |\n|---|---|---|---|\n|甲|戊|己|癸|\n|子|辰|丑|酉|'
  ]) assert.deepEqual(extractKnowledgeCases(text)[0].pairs, ['甲子', '戊辰', '己丑', '癸酉']);
  assert.equal(extractKnowledgeCases('四柱：甲子 戊辰 己丑 癸酉')[0].gender, null);
});

test('visual 元男/元女 markers stay bound to their chart, preserve proof and never infer from children', () => {
  const notes = '## 案例一\n四柱：壬辰、壬寅、甲寅、庚午。\n画面性别标记：元男（截图 00:13:59）。\n讲解提到女儿、妻子和女命的另一种规则。\n## 案例二\n四柱：丁巳、辛亥、壬午、乙巳。\n画面性别标记：元女（截图 00:20:10）。';
  const cases = extractKnowledgeCases(notes);
  assert.equal(cases[0].gender, 1); assert.equal(cases[1].gender, 0);
  assert.match(cases[0].genderEvidence[0].text, /元男.*13:59/);
  assert.equal(extractKnowledgeCases('## 案例一\n四柱：壬辰、壬寅、甲寅、庚午。\n作者说生了一个女儿。')[0].gender, null);
  assert.equal(extractKnowledgeCases('四柱：壬辰、壬寅、甲寅、庚午。\n画面性别标记：元男（模糊待核对）。')[0].gender, null);
  const neighbour = extractKnowledgeCases('四柱：壬辰、壬寅、甲寅、庚午。\n画面性别标记：元男。\n四柱：丁巳、辛亥、壬午、乙巳。');
  assert.equal(neighbour[0].gender, 1); assert.equal(neighbour[1].gender, null);
});

test('later visual proof fills unknown gender while contradictory proof stays unresolved', () => {
  const base = '## 案例一\n四柱：壬辰、壬寅、甲寅、庚午。\n', male = '## 画面案例一\n四柱：壬辰、壬寅、甲寅、庚午。\n画面性别标记：元男（截图 00:13:59）。\n';
  assert.equal(extractKnowledgeCases(base + male)[0].gender, 1);
  const conflict = extractKnowledgeCases(base + male + male.replaceAll('元男', '元女'))[0];
  assert.equal(conflict.gender, null); assert.equal(conflict.genderConflict, true); assert.match(conflict.validation, /性别依据冲突/);
  assert.equal(conflict.genderEvidence.length, 2);
});

test('read 元男/元女 from the day pillar cell in four-column and labelled-row tables', () => {
  const a = extractKnowledgeCases('| 年柱 | 月柱 | 日柱 | 时柱 |\n|---|---|---|---|\n|壬辰|壬寅|甲寅|庚午|\n|偏印|偏印|元男|七杀|')[0];
  assert.equal(a.gender, 1); assert.match(a.genderEvidence[0].text, /元男/);
  const b = extractKnowledgeCases('| 项目 | 年柱 | 月柱 | 日柱 | 时柱 |\n|---|---|---|---|---|\n|四柱|丁巳|辛亥|壬午|乙巳|\n|十神|正财|正印|元女|伤官|')[0];
  assert.equal(b.gender, 0); assert.deepEqual(b.pairs, ['丁巳','辛亥','壬午','乙巳']);
  const c = extractKnowledgeCases('| 年柱 | 月柱 | 日柱 | 时柱 |\n|---|---|---|---|\n|壬辰|壬寅|甲寅|庚午|\n|元女|偏印|日主|七杀|')[0];
  assert.equal(c.gender, null, 'a marker in a different column cannot label the owner');
});

test('backfill, deduplication, filtering, edits and deletion synchronize without touching personal cases', () => {
  const db = new Database(':memory:');
  try {
    const knowledge = createKnowledgeStore(db), cases = createKnowledgeCaseStore(db), personal = createMingliStore(db);
    personal.save('a', { name: '个人案例', birth: { year: 2005, month: 12, day: 23, hour: 8, minute: 37, gender: 1 }, tags: [], notes: '不可改写' });
    const before = JSON.stringify(personal.list('a'));
    let document = ready(db, knowledge); ready(db, knowledge, 'b');
    const initial = cases.list('a'); assert.equal(initial.total, 2); assert.equal(initial.uniqueCharts, 2);
    const first = initial.cases.find(c => c.birth.gender === 0);
    assert.match(first.sourceUrl, new RegExp(document.id + '#kb-heading-0$'));
    assert.equal(first.chart.solar, undefined); assert.equal(first.chart.luck, undefined); assert.equal(first.birth.year, undefined);
    assert.equal(cases.list('a', { filters: { gender: 0, characters: ['壬'], relations: ['clash:巳亥'] } }).total, 1);
    assert.equal(cases.list('a', { search: '备选' }).total, 1);
    assert.equal(cases.list('a', { limit: 1, offset: 1 }).cases.length, 1);
    assert.equal(cases.list('a', { documentId: document.id }).total, 2);
    assert.equal(cases.get('b', first.id), undefined);
    assert.deepEqual(cases.list('a').cases, initial.cases);
    document = knowledge.edit('a', document.id, { ...upload, title: '更新标题', notes: notes.replace('2002年结婚', '2002年结婚，仍待核对'), revision: document.revision });
    assert.match(cases.get('a', first.id).notes, /仍待核对/); assert.equal(cases.get('a', first.id).documentTitle, '更新标题');
    assert.equal(cases.get('a', first.id).createdAt, first.createdAt);
    document = knowledge.edit('a', document.id, { ...upload, notes: '不再含四柱。', revision: document.revision });
    assert.equal(db.prepare('SELECT count(*) AS n FROM mingli_knowledge_cases WHERE user_id=?').get('a').n, 0);
    knowledge.edit('a', document.id, { ...upload, notes, revision: document.revision });
    assert.equal(cases.list('a').total, 2);
    knowledge.remove('a', document.id); assert.equal(cases.list('a').total, 0);
    assert.equal(cases.list('b').total, 2); assert.equal(JSON.stringify(personal.list('a')), before);
  } finally { db.close(); }
});

test('worker completion records cases immediately and same chart from separate sources retains provenance', () => {
  const db = new Database(':memory:');
  try {
    const knowledge = createKnowledgeStore(db), cases = createKnowledgeCaseStore(db);
    const doc = knowledge.create('a', upload); knowledge.enqueue('a', doc.id);
    const job = knowledge.claim('a', ['codex']); assert.ok(job);
    assert.equal(knowledge.finish('a', doc.id, job.lease, { notes, duration: 90, language: 'zh', transcript: [], frames: [], provenance: {} }), true);
    assert.equal(db.prepare('SELECT count(*) AS n FROM mingli_knowledge_cases').get().n, 2);
    ready(db, knowledge); assert.equal(cases.list('a').total, 4); assert.equal(cases.list('a').uniqueCharts, 2);
    db.prepare("UPDATE knowledge_documents SET status='deleting' WHERE id=?").run(doc.id);
    assert.equal(cases.list('a').total, 2);
  } finally { db.close(); }
});

test('knowledge case endpoints enforce both source and module permissions, including revocation and owner isolation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingli-knowledge-')), previous = process.env.NAVIGATION_DB_PATH;
  process.env.NAVIGATION_DB_PATH = path.join(dir, 'db.sqlite');
  const base = ['mingli:view', 'mingli:knowledge:view', 'mingli:knowledge:filter', 'knowledge:view', 'knowledge:notes:view'];
  async function call(route = '/knowledge-cases', uid = 'a', permissions = base, isGuest = false) {
    let status, result;
    await handleMingliApi({ method: 'GET', headers: {} }, { setHeader() {} }, new URL('http://localhost/api/mingli' + route), { userId: uid, permissions, isGuest }, (_, s, r) => { status = s; result = r; });
    return { status, result };
  }
  try {
    const knowledge = createKnowledgeStore(getDatabase()); ready(getDatabase(), knowledge);
    const response = await call(); assert.equal(response.status, 200); assert.equal(response.result.total, 2);
    const id = response.result.cases[0].id;
    for (const removed of ['mingli:view', 'mingli:knowledge:view', 'knowledge:view', 'knowledge:notes:view']) {
      for (const route of ['/knowledge-cases', '/knowledge-cases/' + id]) assert.equal((await call(route, 'a', base.filter(p => p !== removed))).status, 403);
    }
    assert.equal((await call('/knowledge-cases', 'a', base, true)).status, 403);
    assert.equal((await call('/knowledge-cases', 'b')).result.total, 0);
    assert.equal((await call('/knowledge-cases/' + id, 'b')).status, 404);
    const filtered = '/knowledge-cases?filters=' + encodeURIComponent(JSON.stringify({ gender: 0 }));
    assert.equal((await call(filtered)).result.total, 1);
    assert.equal((await call(filtered, 'a', base.filter(p => p !== 'mingli:knowledge:filter'))).status, 403);
    assert.equal((await call('/knowledge-cases?filters=%7B')).status, 400);
    assert.equal((await call('/knowledge-cases?documentId=invalid')).status, 400);
  } finally {
    closeDatabase(); if (previous === undefined) delete process.env.NAVIGATION_DB_PATH; else process.env.NAVIGATION_DB_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
