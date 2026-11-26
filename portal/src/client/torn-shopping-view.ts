import { createApp, h, shallowRef } from 'vue';

export interface ShoppingResultRow {
  name?: string;
  itemId?: number | string;
  source?: string;
  error?: string;
  matches?: number;
}

export interface ShoppingHistoryRow {
  name: string;
  link: string;
  source: string;
  price: number;
  quantity: number;
  detectedAt: number;
}

const source = (value?: string) => value === 'market' ? '市场' : '巴扎';

export function mountShoppingView(hosts: { results: HTMLElement; history: HTMLElement }) {
  const results = shallowRef<ShoppingResultRow[]>([]);
  const history = shallowRef<ShoppingHistoryRow[]>([]);

  const resultApp = createApp(() => results.value.length ? results.value.map((row, index) => h('p', { key: String(row.itemId ?? index) },
    `${row.name || row.itemId} · ${source(row.source)} · ${row.error || '发现 ' + row.matches + ' 条低价'}`)) : []);
  resultApp.mount(hosts.results);

  const historyApp = createApp(() => history.value.length ? history.value.map((row, index) => h('p', { key: row.detectedAt + ':' + index }, [
    h('a', { href: row.link, target: '_blank', rel: 'noopener noreferrer' },
      `${row.name} · ${source(row.source)} $${row.price} × ${row.quantity} · ${new Date(row.detectedAt * 1000).toLocaleString('sv-SE')} ↗`)
  ])) : []);
  historyApp.mount(hosts.history);

  return {
    renderResults(next: ShoppingResultRow[]) { results.value = next; },
    renderHistory(next: ShoppingHistoryRow[]) { history.value = next; },
    dispose() { resultApp.unmount(); historyApp.unmount(); }
  };
}
