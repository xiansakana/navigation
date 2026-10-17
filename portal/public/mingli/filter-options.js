export const STEMS = '甲乙丙丁戊己庚辛壬癸';
export const BRANCHES = '子丑寅卯辰巳午未申酉戌亥';
export const PILLARS = ['年柱', '月柱', '日柱', '时柱'];
// A relation matches distinct natal positions, irrespective of adjacency or transformation.
export const RELATIONS = [
  ['stem-combine', '天干五合', 'gan', ['甲己', '乙庚', '丙辛', '丁壬', '戊癸']],
  ['branch-combine', '地支六合', 'zhi', ['子丑', '寅亥', '卯戌', '辰酉', '巳申', '午未']],
  ['hidden-combine', '地支暗合', 'zhi', ['寅丑', '卯申', '午亥']],
  ['triple-combine', '地支三合', 'zhi', ['申子辰', '巳酉丑', '寅午戌', '亥卯未']],
  ['season-combine', '地支三会', 'zhi', ['寅卯辰', '巳午未', '申酉戌', '亥子丑']],
  ['clash', '地支六冲', 'zhi', ['子午', '丑未', '寅申', '卯酉', '辰戌', '巳亥']],
  ['break', '地支六破', 'zhi', ['子酉', '卯午', '申巳', '寅亥', '辰丑', '未戌']],
  ['punish', '地支相刑', 'zhi', ['子卯', '辰辰', '午午', '酉酉', '亥亥', '寅巳申', '丑戌未']],
  ['harm', '地支六害', 'zhi', ['子未', '丑午', '寅巳', '申亥', '卯辰', '酉戌']]
];
