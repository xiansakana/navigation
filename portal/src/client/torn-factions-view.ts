import { createApp, h, shallowRef } from 'vue';

export interface FactionRow {
  id: number | string;
  name: string;
  respect?: number;
  status?: string;
  leaderName?: string;
  leaderId?: number | string;
  analysisDay?: number;
  checkedAt?: number;
  lastDay?: number;
  dropDay?: number;
  A?: number;
  B?: number;
  C?: number;
  difference?: number;
  dailyAmount?: number;
  peakAmount?: number;
  loadedDays?: number;
  totalDays?: number;
  historyBatch?: number;
  peakBefore?: number;
  beforeValue?: number;
  dropValue?: number;
  firstDay?: number;
  historyStart?: number;
  reason?: string;
}

const day = (value?: number) => Number.isInteger(value) ? new Date(Number(value) * 86400000).toISOString().slice(0, 10) : '—';
const value = (number?: number) => Number.isFinite(number) ? Number(number).toLocaleString() : '—';
const labels: Record<string, string> = { waiting: '待扫描', scanning: '扫描中', match: '命中', excluded: '已排除', unknown: '待确认' };
const profile = (label: string, href: string) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label);

export function mountFactionsView(host: HTMLElement) {
  const rows = shallowRef<FactionRow[]>([]);
  const listComplete = shallowRef(true);
  const today = shallowRef<number | undefined>();

  const app = createApp(() => rows.value.length ? rows.value.map(row => {
    const details: [string, string][] = [
      ['核验基准日（TCT）', day(row.analysisDay ?? (row.checkedAt ? Math.floor(row.checkedAt / 86400) : row.lastDay))],
      ['下跌日（TCT）', day(row.dropDay)], ['A（天）', value(row.A)], ['B（天）', value(row.B)], ['C（天）', value(row.C)],
      ['A−B（天）', value(row.difference)], ['单日减少（Torn $）', value(row.dailyAmount)], ['距高点减少（Torn $）', value(row.peakAmount)],
      ['历史进度', `${row.loadedDays || 0}/${row.totalDays || '—'} · 第 ${row.historyBatch || 0} 批（自动续批）`],
      ['下跌前高点', value(row.peakBefore)], ['下跌前一日', value(row.beforeValue)], ['下跌日净资产', value(row.dropValue)],
      ['扫描范围', `${day(row.firstDay ?? row.historyStart)} 至 ${day(row.lastDay ?? today.value)}`]
    ];
    return h('article', { key: String(row.id), class: 'faction-result' }, [
      h('h4', [profile(`${row.name} [${row.id}]`, 'https://www.torn.com/factions.php?step=profile&ID=' + row.id),
        ` · respect ${value(row.respect)} · ${labels[row.status || ''] || row.status || ''}`]),
      profile(`Leader ${row.leaderName || ''} [${row.leaderId || ''}]`, 'https://www.torn.com/profiles.php?XID=' + row.leaderId),
      h('dl', details.map(([name, text]) => h('div', { key: name }, [h('dt', name), h('dd', text)]))),
      h('p', row.reason || '—')
    ]);
  }) : [h('p', listComplete.value ? '当前筛选没有结果。' : '启动后先读取完整帮派列表，再按 respect 升序扫描。')]);
  app.mount(host);

  return {
    render(next: FactionRow[], options: { listComplete?: boolean; today?: number } = {}) {
      rows.value = next;
      if (options.listComplete !== undefined) listComplete.value = options.listComplete;
      if (options.today !== undefined) today.value = options.today;
    },
    dispose() { app.unmount(); }
  };
}
