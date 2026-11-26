import { createApp, h, shallowRef } from 'vue';

export interface ChainProblem {
  id: number | string;
  reason: string;
}

export interface ChainFaction {
  id: number | string;
  name: string;
  leaderName?: string;
  leaderId?: number | string;
  respect: number;
  previousRespect?: number;
  lastAliveAt?: number;
}

export interface ChainHistoryRow extends ChainFaction {
  kind: string;
  detectedAt: number;
  destroyedConfirmedAt?: number;
}

const time = (value?: number) => value ? new Date(value * 1000).toLocaleString('sv-SE') : '—';
const profileLink = (label: string, href: string) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label);
const factionLink = (row: ChainFaction) => profileLink(row.name + ' [' + row.id + ']',
  'https://www.torn.com/factions.php?step=profile&ID=' + Number(row.id));
const leaderLink = (row: ChainFaction) => profileLink((row.leaderName || 'Leader') + ' [' + row.leaderId + ']',
  'https://www.torn.com/profiles.php?XID=' + Number(row.leaderId));

export function mountChainView(hosts: { rows: HTMLElement; history: HTMLElement }) {
  const factions = shallowRef<{ faction: ChainFaction; problem: string }[]>([]);
  const history = shallowRef<ChainHistoryRow[]>([]);

  const rowApp = createApp(() => factions.value.map(({ faction, problem }) => {
    const change = Number.isSafeInteger(faction.previousRespect) ? faction.respect - (faction.previousRespect as number) : null;
    const cells: (string | ReturnType<typeof h>)[] = [
      factionLink(faction), leaderLink(faction), faction.respect.toLocaleString(),
      change === null ? '基线' : (change > 0 ? '+' : '') + change, time(faction.lastAliveAt),
      problem || (faction.respect === 0 ? 'respect 已清零，尚未标记摧毁' : 'API 确认存活')
    ];
    return h('tr', { key: String(faction.id), 'data-faction-id': faction.id },
      cells.map((content, index) => h('td', { 'data-label': ['帮派', 'Leader', 'respect', '变化', '最近存活', '核验说明'][index] }, content)));
  }));
  rowApp.mount(hosts.rows);

  const historyApp = createApp(() => history.value.length ? history.value.map(row => h('article', { key: row.kind + ':' + row.id, class: 'chain-row' }, [
    h('div', [
      h('strong', [row.kind === 'respect-zero' ? 'respect 已清零 · ' : '已确认摧毁 · ', factionLink(row)]),
      h('p', `最后存活 ${time(row.lastAliveAt)} · ${row.kind === 'respect-zero' ? '发现清零' : '发现摧毁'} ${time(row.detectedAt)} · respect ${row.previousRespect ?? '未知'} → ${row.respect}`),
      h('p', (row.kind === 'respect-zero' ? row.destroyedConfirmedAt ? '后续已确认摧毁：' + time(row.destroyedConfirmedAt) + '。' : '已触发清零提醒，API 尚未标记摧毁。' : '') + '原因未知；未判定为 Bonus 导致。')
    ]),
    leaderLink(row)
  ])) : [h('p', '暂无 respect 清零或确认摧毁记录。')]);
  historyApp.mount(hosts.history);

  return {
    renderRows(rows: ChainFaction[], problems: ChainProblem[] = []) {
      factions.value = rows.map(faction => ({ faction, problem: new Map(problems.map(row => [String(row.id), row.reason])).get(String(faction.id)) || '' }));
    },
    renderHistory(rows: ChainHistoryRow[]) { history.value = rows; },
    dispose() { rowApp.unmount(); historyApp.unmount(); }
  };
}
