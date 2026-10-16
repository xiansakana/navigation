import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { prepareWenZhenImport } from './mingli-import.js';
import { createMingliStore } from './mingli-store.js';
import { calculateChart } from './mingli-chart.js';

const id = '11111111-1111-4111-8111-111111111111';
const sample = (patch = {}) => ({ guid: id, name: '测试命例', sex: 2, solarTime: '2005-12-23 09:00:00', sunTime: '2005-12-23 08:37:00',
  birthDay: '2005-12-23 09:00:00', lunarTime: '2005-11-23 09:00:00', location: '出生地备注', bz: '乙 酉 戊 子 辛 巳 壬 辰',
  star: true, groupGuid: 'group-a', type: 1, isdel: 0, unknowhour: 0, unknowminute: 0, xls: 0, hw: 0, bjtime: 0,
  sourceNotes: { content: '实际事件\n<script>只作为文字保存</script>', feedbackData: '{"year":2020}' }, ...patch });
const bundle = (...cases) => ({ format: 'navigation-wenzhen-v1', capturedAt: '2026-10-17T00:00:00Z',
  settings: { midnight: false }, groups: [{ id: 'group-a', name: '家人' }], cases });

test('import translates gender, preserves civil birth and source clock, groups, stars and notes', () => {
  const result = prepareWenZhenImport(bundle(sample({ parentGuid: 'must-not-copy', token: 'must-not-copy' })));
  assert.deepEqual(result.errors, []);
  const row = result.rows[0];
  assert.equal(row.birth.gender, 0); assert.equal(row.birth.sect, 1);
  assert.equal(row.chart.solar, '2005-12-23 09:00:00'); assert.equal(row.chart.clock, '2005-12-23 08:37:00');
  assert.deepEqual(row.chart.pillars.map(p => p.ganZhi), ['乙酉', '戊子', '辛巳', '壬辰']);
  assert.equal(row.source.matched, true); assert.deepEqual(row.tags, ['问真导入', '家人', '星标']);
  assert.match(row.notes, /实际事件/); assert.match(row.notes, /只作为文字保存/);
  assert.ok(!JSON.stringify(row).includes('must-not-copy'));
});

test('preview reports invalid/unknown times, duplicate IDs and incompatible flags without guessing', () => {
  for (const patch of [{ sex: 0 }, { unknowhour: 1 }, { unknowminute: 1 }, { isdel: 1 }, { hw: 1 }, { xls: 1 }, { bjtime: 1 }, { solarTime: '2005-02-30 08:00:00' }, { sunTime: 'bad' }, { bz: '' }]) {
    const p = prepareWenZhenImport(bundle(sample(patch)));
    assert.equal(p.errors.length, 1); assert.equal(p.rows.length, 0);
  }
  const duplicate = prepareWenZhenImport(bundle(sample(), sample()));
  assert.equal(duplicate.errors.length, 1); assert.match(duplicate.errors[0].error, /重复/);
  assert.throws(() => prepareWenZhenImport({ format: 'unknown', cases: [] }));
});

test('source clock respects day/solar-term boundaries and does not shift luck onset', () => {
  const raw = { year: 2024, month: 2, day: 4, hour: 16, minute: 28, gender: 1, sect: 1 };
  const civil = calculateChart(raw), recorded = calculateChart({ ...raw, recordedSolarTime: '2024-02-04 13:14:00' });
  assert.deepEqual(recorded.pillars.slice(0, 2), civil.pillars.slice(0, 2));
  assert.equal(recorded.luck.start, civil.luck.start);
  for (const time of ['2024-02-30 01:00:00', '2024-02-04 24:00:00', '2020-01-01 00:00:00', '2024-02-04 08:10:30']) {
    assert.throws(() => calculateChart({ ...raw, recordedSolarTime: time }));
  }
  assert.throws(() => calculateChart({ ...raw, trueSolar: true, longitude: 120, recordedSolarTime: '2024-02-04 13:14:00' }));
});

test('import migrates an existing schema, is transactional, idempotent and user scoped', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE mingli_cases (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,birth_json TEXT NOT NULL,chart_json TEXT NOT NULL,tags_json TEXT NOT NULL,notes TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)');
  try {
    const store = createMingliStore(db), data = bundle(sample());
    const preview = store.importWenZhen('a', data);
    assert.equal(preview.matched, 1); assert.equal(store.list('a').total, 0);
    const imported = store.importWenZhen('a', data, true); assert.equal(imported.imported, 1);
    const item = store.get('a', imported.ids[0]);
    assert.equal(item.source.key, id); assert.equal(item.source.notes.content, sample().sourceNotes.content);
    store.save('a', { ...item, birth: item.birth, name: '自己修改的名称', notes: '自己添加的笔记' }, item.id);
    const second = store.importWenZhen('a', data, true);
    assert.equal(second.imported, 0); assert.equal(second.duplicates, 1);
    assert.equal(store.get('a', item.id).notes, '自己添加的笔记');
    assert.equal(store.get('a', item.id).source.original.name, '测试命例');
    assert.equal(store.importWenZhen('b', data, true).imported, 1);
    assert.equal(store.get('b', item.id), undefined);
    const normal = store.save('a', { name: '普通命例', birth: item.birth, tags: [], notes: '' });
    assert.equal(normal.source, null);
    const mismatch = bundle(sample({ guid: '22222222-2222-4222-8222-222222222222', bz: '乙酉戊子辛巳癸巳' }));
    assert.equal(store.importWenZhen('a', mismatch).mismatches, 1);
    assert.throws(() => store.importWenZhen('a', mismatch, true), /不一致/);
    const invalid = bundle(sample({ guid: '33333333-3333-4333-8333-333333333333' }), sample({ unknowhour: 1 }));
    assert.throws(() => store.importWenZhen('a', invalid, true), /无效案例/);
    assert.equal(store.list('a').total, 2);
    createMingliStore(db); assert.equal(store.list('a').total, 2);
  } finally { db.close(); }
});
