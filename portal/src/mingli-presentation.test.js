import test from 'node:test';
import assert from 'node:assert/strict';
import calendar from 'lunar-javascript';
import { flowPillar, stemGod, shortGod, selectedFlow } from '../public/mingli/chart-presentation.js';
import { calculateChart } from './mingli-chart.js';

test('selected luck pillar metadata agrees with the calendar engine for all 60 pillars and 10 day masters', () => {
  const { LunarUtil } = calendar;
  for (const day of '甲乙丙丁戊己庚辛壬癸') {
    for (let i = 0; i < 60; i++) {
      const ganZhi = '甲乙丙丁戊己庚辛壬癸'[i % 10] + '子丑寅卯辰巳午未申酉戌亥'[i % 12];
      const p = flowPillar(ganZhi, day);
      assert.equal(p.tenGod, LunarUtil.SHI_SHEN[day + ganZhi[0]]);
      assert.deepEqual(p.elements, [LunarUtil.WU_XING_GAN[ganZhi[0]], LunarUtil.WU_XING_ZHI[ganZhi[1]]]);
      assert.deepEqual(p.hidden.map(h => h.gan), LunarUtil.ZHI_HIDE_GAN[ganZhi[1]]);
      for (const h of p.hidden) assert.equal(h.tenGod, LunarUtil.SHI_SHEN[day + h.gan]);
      assert.equal(p.naYin, LunarUtil.NAYIN[ganZhi]);
      assert.equal(p.xunKong, LunarUtil.getXunKong(ganZhi));
      assert.ok(shortGod(p.tenGod));
    }
  }
  assert.equal(flowPillar('童限', '甲'), null);
  assert.equal(flowPillar('甲丑', '甲'), null);
  assert.equal(flowPillar('甲子', ''), null);
  assert.equal(stemGod('', '甲'), '');
});

test('year/cycle comparison works with persisted charts, changes selection and preserves natal/source data', () => {
  const chart = calculateChart({ year: 2001, month: 7, day: 26, hour: 14, minute: 30, gender: 1 });
  const before = JSON.stringify(chart);
  const cycle = chart.luck.cycles[2], year = cycle.years[4];
  const flow = selectedFlow(chart, 2, year.year);
  assert.deepEqual(flow.columns.map(p => p.label), ['流年', '大运', '年柱', '月柱', '日柱', '时柱']);
  assert.equal(flow.columns[0].ganZhi, year.ganZhi);
  assert.equal(flow.columns[1].ganZhi, cycle.ganZhi);
  assert.deepEqual(flow.columns.slice(2), chart.pillars);
  assert.equal(selectedFlow(chart, 3, year.year).year.year, chart.luck.cycles[3].years[0].year);
  const childhood = selectedFlow(chart, 0, chart.luck.cycles[0].startYear);
  assert.equal(childhood.columns[1].caption, '童限'); assert.equal(childhood.columns[1].gan, undefined);
  assert.equal(JSON.stringify(chart), before);
});
