import { createApp, h, shallowRef } from 'vue';

const icons: Record<string, string> = {
  餐饮: '◡', 购物: '▱', 交通: '↗', 工资: '▤', 住房: '⌂', 娱乐: '♫', 通讯: '☎', 学习: '▥',
  医疗: '✚', 转账: '⇄', 还款: '↩', 借出: '⇢', 收回: '⇠', 余额调整: '✎'
};

export interface EntriesModel {
  entries: any[];
  dayTotals: Map<string, { income: number; expense: number }>;
  converted: any;
  missing: string[];
  ledgerNote: string;
  accountId: string;
  canViewAccounts: boolean;
  canEdit: boolean;
  categoryTree?: any[];
}

interface Helpers {
  money(value: number, currency: string): string;
  balanceText(entry: any): string;
}

const empty: EntriesModel = {
  entries: [], dayTotals: new Map(), converted: null, missing: [], ledgerNote: '', accountId: '', canViewAccounts: false, canEdit: false
};

export function mountBookkeepingEntries(host: HTMLElement, helpers: Helpers) {
  const model = shallowRef<EntriesModel>(empty);
  const revealed = shallowRef<{ id: string; direction: 'copy' | 'edit' }>({ id: '', direction: 'edit' });

  const money = (value: number, currency: string) => h('span', { 'data-money': '' }, helpers.money(value, currency));

  const iconFor = (entry: any, state: EntriesModel) => {
    if (icons[entry.type]) return icons[entry.type];
    const kind = entry.type === '收入' ? 'income' : 'expense';
    const tree = state.categoryTree || [];
    const node = tree.find((item: any) => item.kind === kind && item.name === (entry.subcategory || entry.category)
      && (entry.subcategory
        ? tree.some((parent: any) => parent.id === item.parentId && parent.name === entry.category)
        : !item.parentId));
    return node?.icon || icons[entry.category] || '◈';
  };

  const app = createApp(() => {
    const state = model.value;
    const nodes: ReturnType<typeof h>[] = [];
    if (state.ledgerNote) nodes.push(h('p', { class: 'bk-muted bk-ledger-note', innerHTML: state.ledgerNote }));
    let lastDay = '';
    for (const entry of state.entries) {
      const day = entry.date.slice(0, 10);
      if (day !== lastDay) {
        lastDay = day;
        const total = state.dayTotals.get(day) || { income: 0, expense: 0 };
        const net = Math.round((total.income - total.expense) * 100) / 100;
        const daily = state.missing.length || !state.converted
          ? [h('span', 'CNY 合计待补齐汇率')]
          : [
            h('span', { class: 'bk-day-currency' }, 'CNY'),
            h('span', ['收入 ', money(total.income, 'CNY')]),
            h('span', ['净支出 ', money(total.expense, 'CNY')]),
            h('span', { class: net < 0 ? 'bk-expense' : 'bk-income' }, ['结余 ', money(net, 'CNY')])
          ];
        nodes.push(h('div', { key: 'day-' + day, class: 'bk-day', 'data-day': day }, [
          h('span', { class: 'bk-day-date' }, [
            h('time', { datetime: day }, day),
            h('span', new Date(day + 'T12:00:00').toLocaleDateString('zh-CN', { weekday: 'long' }))
          ]),
          h('span', { class: 'bk-day-totals', 'aria-label': '当日 CNY 合计' }, daily)
        ]));
      }
      const expense = ['支出', '已报销'].includes(entry.type);
      const transfer = ['转账', '还款', '借出', '收回', '余额调整'].includes(entry.type);
      const title = [entry.category, entry.subcategory].filter(Boolean).join(' · ');
      const account = [entry.accountName, entry.toAccountName].filter(Boolean).join(' → ');
      const subtitle = [entry.date.slice(11, 16), account, entry.note || entry.tags].filter(Boolean).join(' · ');
      const balance = state.canViewAccounts && state.accountId && entry.balanceCurrency;
      const copyable = state.canEdit && entry.type !== '余额调整';
      const direction = revealed.value.id === entry.id ? revealed.value.direction : '';
      nodes.push(h('div', {
        key: 'entry-' + entry.id,
        class: ['bk-entry-swipe', direction === 'copy' ? 'bk-copy-revealed' : direction === 'edit' ? 'bk-edit-revealed' : null]
      }, [
        copyable ? h('button', { type: 'button', class: 'btn ghost bk-copy-action', 'data-copy-entry': entry.id }, '复制') : null,
        state.canEdit ? h('div', { class: 'bk-swipe-edit-actions' }, [
          h('button', { type: 'button', class: 'btn ghost', 'data-swipe-action': 'edit' }, '编辑'),
          h('button', { type: 'button', class: 'btn ghost bk-detail-delete', 'data-swipe-action': 'delete' }, '删除')
        ]) : null,
        h('button', { class: 'bk-entry', 'data-entry': entry.id }, [
          h('span', { class: 'bk-badge' }, iconFor(entry, state)),
          h('span', { class: 'bk-entry-main' }, [
            h('strong', title),
            h('p', subtitle),
            entry.location ? h('p', '⌖ ' + entry.location) : null
          ]),
          h('span', { class: ['bk-entry-amount', expense ? 'bk-expense' : transfer ? 'bk-transfer' : 'bk-income'] }, [
            money(expense ? -entry.amount : entry.amount, entry.currency),
            entry.currency !== 'CNY'
              ? h('small', entry.fxMissing ? 'CNY 等效待获取' : '≈ ' + helpers.money(expense ? -entry.cnyAmount : entry.cnyAmount, 'CNY') + ' · 汇率日 ' + entry.rateDate)
              : null,
            h('small', entry.type + (entry.historical ? ' · 历史' : '')),
            balance ? h('small', { class: 'bk-ledger-balance', innerHTML: helpers.balanceText(entry) }) : null
          ])
        ])
      ]));
    }
    if (!state.entries.length) nodes.push(h('div', { class: 'bk-empty' }, ['还没有符合条件的账单', h('br'), '记下第一笔，或从 iCost 导入历史记录。']));
    return nodes;
  });
  app.mount(host);

  return {
    render(next: EntriesModel) { model.value = next; },
    reveal(id: string, direction: 'copy' | 'edit' = 'edit') { revealed.value = { id, direction }; },
    revealedId() { return revealed.value.id; },
    dispose() { app.unmount(); }
  };
}
