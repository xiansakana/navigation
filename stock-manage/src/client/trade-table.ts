import { createApp, h } from 'vue';

interface TradeRow {
  id: string;
  date: string;
  direction: string;
  historical: boolean;
  assetType: string;
  symbol: string;
  name: string;
  account: string;
  currency: string;
  shares: string;
  price: string;
  amount: string;
  commission: string;
}

interface TradeTable {
  rows: TradeRow[];
  canEdit: boolean;
  error?: string;
}

const headers = ['时间', '交易方向', '类型', '代码', '名称', '币种', '股数', '价格', '金额', '手续费', '操作'];

export function mountTradeTable(container: HTMLElement, { rows, canEdit, error }: TradeTable) {
  const app = createApp(() => {
    const body = rows.map((row) => {
      const values = [row.date, row.direction, row.assetType, row.symbol, row.name, row.currency,
        row.shares, row.price, row.amount, row.commission];
      const cells = values.map((value, index) => {
        const label = headers[index];
        if (label === '交易方向' && row.historical) {
          return h('td', { 'data-label': label }, [value, h('div', { class: 'hint' }, '历史补录')]);
        }
        if (label === '名称') {
          return h('td', { 'data-label': label, class: 'sm-trade-name' },
            [value, row.account ? h('div', { class: 'sm-trade-account-name' }, row.account) : null]);
        }
        return h('td', { 'data-label': label }, value);
      });
      const actions = canEdit ? [
        h('button', { type: 'button', class: 'btn link', 'data-edit': row.id }, '编辑'),
        ' ',
        h('button', { type: 'button', class: 'btn link', 'data-del': row.id }, '删除')
      ] : '—';
      return h('tr', { key: row.id }, [...cells, h('td', { 'data-label': '操作' }, actions)]);
    });
    return h('table', { class: 'sm-table' }, [
      h('thead', [h('tr', headers.map(label => h('th', { class: label === '名称' ? 'sm-trade-name' : undefined }, label)))]),
      h('tbody', body.length ? body : [
        h('tr', [h('td', { colspan: headers.length, class: 'empty' }, error ? [h('span', { role: 'alert' }, error)] : '暂无记录')])
      ])
    ]);
  });
  app.mount(container);
  return () => app.unmount();
}
