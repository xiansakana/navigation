export const BONUS_HITS = Object.freeze([10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000]);

export function normalizeBonusHits(value) {
  if (!Array.isArray(value) || value.length > BONUS_HITS.length || value.some(hit => !Number.isSafeInteger(hit) || !BONUS_HITS.includes(hit))) throw new Error('请选择有效的 Bonus hit 档位');
  return [...new Set(value)].sort((a, b) => a - b);
}

export function reportBonusDefenders(report, row) {
  if (!report || report.id !== row.id || report.faction_id !== row.factionId || !Array.isArray(report.bonuses)) throw new Error('Chain report 与记录不匹配或尚不可用');
  const bonuses = new Map();
  for (const bonus of report.bonuses) {
    if (!BONUS_HITS.includes(bonus?.chain) || !Number.isSafeInteger(bonus.defender_id) || bonus.defender_id <= 0) throw new Error('Bonus hit 数据无效');
    if (bonuses.has(bonus.chain)) throw new Error('Bonus hit 档位重复');
    bonuses.set(bonus.chain, { hit: bonus.chain, defenderId: bonus.defender_id });
  }
  return [...bonuses.values()].sort((a, b) => a.hit - b.hit);
}

export function selectedBonusDefenders(row, selection, leaderFilter = 'all') {
  return (selection || []).filter(hit => BONUS_HITS.includes(hit) && hit <= row.hits).map(hit => {
    const bonus = row.bonusDetails?.find(item => item.hit === hit);
    return { hit, defenderId: Number.isSafeInteger(bonus?.defenderId) && bonus.defenderId > 0 ? bonus.defenderId : null, ...(typeof bonus?.isLeader === 'boolean' ? { isLeader: bonus.isLeader, factionId: bonus.factionId, leaderCheckedAt: bonus.leaderCheckedAt } : {}) };
  }).filter(bonus => leaderFilter === 'all' || leaderFilter === 'leader' && bonus.isLeader === true || leaderFilter === 'non-leader' && bonus.isLeader === false);
}

export async function lookupDefenderLeader(defenderId, request, factionCache = new Map()) {
  const { profile } = await request('user/' + defenderId + '/profile');
  if (!profile || profile.id !== defenderId) throw new Error('玩家资料不匹配');
  if (profile.faction_id === null || profile.faction_id === 0) return { isLeader: false, factionId: null };
  if (!Number.isSafeInteger(profile.faction_id) || profile.faction_id <= 0) throw new Error('玩家 faction 未确认');
  let leaderId = factionCache.get(profile.faction_id);
  if (!leaderId) {
    const { basic } = await request('faction/' + profile.faction_id + '/basic');
    if (!basic || basic.id !== profile.faction_id || !Number.isSafeInteger(basic.leader_id) || basic.leader_id <= 0) throw new Error('Faction Leader 未确认');
    leaderId = basic.leader_id; factionCache.set(profile.faction_id, leaderId);
  }
  return { isLeader: leaderId === defenderId, factionId: profile.faction_id };
}
