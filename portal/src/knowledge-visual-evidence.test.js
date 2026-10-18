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
