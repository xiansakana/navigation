// Presentation metadata for selected luck pillars; birth/solar-term calculations stay on the server.
const stems = '甲乙丙丁戊己庚辛壬癸';
const branches = '子丑寅卯辰巳午未申酉戌亥';
const elements = ['木', '火', '土', '金', '水'];
const hidden = ['癸', '己癸辛', '甲丙戊', '乙', '戊乙癸', '丙庚戊', '丁己', '己丁乙', '庚壬戊', '辛', '戊辛丁', '壬甲'];
const branchElements = '水土木木土火火土金金土水';
const naYin = ['海中金', '炉中火', '大林木', '路旁土', '剑锋金', '山头火', '涧下水', '城头土', '白蜡金', '杨柳木', '泉中水', '屋上土', '霹雳火', '松柏木', '长流水', '沙中金', '山下火', '平地木', '壁上土', '金箔金', '覆灯火', '天河水', '大驿土', '钗钏金', '桑柘木', '大溪水', '沙中土', '天上火', '石榴木', '大海水'];
const gods = [['比肩', '劫财'], ['食神', '伤官'], ['偏财', '正财'], ['七杀', '正官'], ['偏印', '正印']];
const shortGods = { 比肩: '比', 劫财: '劫', 食神: '食', 伤官: '伤', 偏财: '才', 正财: '财', 七杀: '杀', 正官: '官', 偏印: '枭', 正印: '印' };
const jiaZi = Array.from({ length: 60 }, (_, i) => stems[i % 10] + branches[i % 12]);

export function stemGod(dayMaster, stem) {
  if (typeof dayMaster !== 'string' || dayMaster.length !== 1 || typeof stem !== 'string' || stem.length !== 1) return '';
  const day = stems.indexOf(dayMaster), other = stems.indexOf(stem);
  if (day < 0 || other < 0) return '';
  return gods[(Math.floor(other / 2) - Math.floor(day / 2) + 5) % 5][day % 2 === other % 2 ? 0 : 1];
}

export function flowPillar(ganZhi, dayMaster) {
  const index = jiaZi.indexOf(ganZhi);
  if (index < 0 || typeof dayMaster !== 'string' || dayMaster.length !== 1 || !stems.includes(dayMaster)) return null;
  const gan = ganZhi[0], zhi = ganZhi[1], branch = branches.indexOf(zhi);
  return { ganZhi, gan, zhi, elements: [elements[Math.floor(stems.indexOf(gan) / 2)], branchElements[branch]],
    tenGod: stemGod(dayMaster, gan), hidden: [...hidden[branch]].map(g => ({ gan: g, element: elements[Math.floor(stems.indexOf(g) / 2)], tenGod: stemGod(dayMaster, g) })),
    naYin: naYin[Math.floor(index / 2)], xunKong: ['戌亥', '申酉', '午未', '辰巳', '寅卯', '子丑'][Math.floor(index / 10)] };
}

export function shortGod(god) { return shortGods[god] || ''; }

export function selectedFlow(chart, cycleIndex, year) {
  const cycles = chart.luck.cycles;
  const index = Math.max(0, Math.min(cycles.length - 1, cycleIndex));
  const cycle = cycles[index], selected = cycle.years.find(y => y.year === year) || cycle.years[0];
  return { cycleIndex: index, cycle, year: selected,
    columns: [{ ...flowPillar(selected.ganZhi, chart.dayMaster), label: '流年', flow: true, caption: String(selected.year) },
      { ...flowPillar(cycle.ganZhi, chart.dayMaster), label: '大运', flow: true, caption: cycle.index === 0 ? '童限' : `${cycle.startYear}起` },
      ...chart.pillars] };
}
