import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVisualEvidence, visualChartAppendix } from './knowledge-visual-evidence.js';
import { extractKnowledgeCases } from './mingli-knowledge-store.js';

const frames = [{ name: 'frame-9.jpg', time: 839.628 }], pillars = ['壬辰', '壬寅', '甲寅', '庚午'];
test('visual proof requires an explicit marker, valid ordered pillars and a real frame', () => {
  const raw = { notes: '详细画面笔记', charts: [null, { frame: 'fake.jpg', pillars, marker: '元男' }, { frame: 'frame-9.jpg', pillars, marker: '女儿' }, { frame: 'frame-9.jpg', pillars: ['甲丑', ...pillars.slice(1)], marker: '元男' }, { frame: 'frame-9.jpg', pillars, marker: '元男', time: 9999 }] };
  const parsed = parseVisualEvidence('```json\n' + JSON.stringify(raw) + '\n```', frames);
  assert.equal(parsed.charts.length, 1); assert.equal(parsed.charts[0].time, frames[0].time);
  const appendix = visualChartAppendix(parsed.charts, 'a'.repeat(32));
  assert.match(appendix, /00:13:59/); assert.match(appendix, /frames\/frame-9.jpg/);
  assert.equal(extractKnowledgeCases(appendix)[0].gender, 1);
  assert.equal(parseVisualEvidence('未返回JSON的画面文字', frames).structured, false);
});
test('opposite screen markers for the same pillars preserve a visible conflict', () => {
  const charts = ['元男', '元女'].map(marker => ({ pillars, marker, gender: marker === '元男' ? 1 : 0, frame: 'frame-9.jpg', time: 839.628 }));
  const c = extractKnowledgeCases(visualChartAppendix(charts, 'a'.repeat(32)))[0];
  assert.equal(c.gender, null); assert.equal(c.genderConflict, true);
});

test('two comparison charts on one frame stay distinct even with identical natal pillars', () => {
  const charts = ['元男', '元女'].map((marker, i) => ({ pillars, marker, frame: 'frame-9.jpg', subject: i ? '女方' : '男方', position: i ? '右盘' : '左盘', relation: 'comparison' }));
  const parsed = parseVisualEvidence(JSON.stringify({ notes: '同屏合婚对比', charts }), frames);
  assert.equal(parsed.charts.length, 2);
  const appendix = visualChartAppendix(parsed.charts, 'a'.repeat(32)), cases = extractKnowledgeCases(appendix);
  assert.equal(cases.length, 2);
  assert.deepEqual(cases.map(c => c.gender), [1, 0]);
  assert.ok(cases.every(c => !c.genderConflict));
  assert.deepEqual(cases.map(c => c.subject), ['男方', '女方']);
  assert.match(appendix, /左盘/); assert.match(appendix, /右盘/);
  assert.equal((appendix.match(/frames\/frame-9.jpg/g) || []).length, 2);
});

test('same-person versions retain contradictions and unknown relations never fabricate comparison identities', () => {
  for (const relation of ['same_person_versions', 'unknown', 'invalid']) {
    const charts = ['元男', '元女'].map((marker, i) => ({ pillars, marker, frame: 'frame-9.jpg', subject: '命主', position: i ? '右盘' : '左盘', relation }));
    const parsed = parseVisualEvidence(JSON.stringify({ notes: '不同版本', charts }), frames);
    const appendix = visualChartAppendix(parsed.charts, 'a'.repeat(32));
    assert.doesNotMatch(appendix, /对比对象：/);
    assert.equal(extractKnowledgeCases(appendix)[0].genderConflict, true);
  }
});
