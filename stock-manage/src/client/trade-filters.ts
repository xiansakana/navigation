import { createApp, h } from 'vue';

interface TradeFilters {
  accountId: string;
  accounts: { id: string; name: string; currency: string }[];
  assetTypes: Record<string, string>;
  summary: boolean;
  values: Record<string, string>;
}

export function mountTradeFilters(container: HTMLElement, model: TradeFilters) {
  const option = (key: string, label: string, current: string) =>
    h('option', { value: key, selected: key === current }, label);
  const select = (field: string, label: string, options: [string, string][]) =>
    h('select', { 'data-filter': field, 'aria-label': label },
      options.map(([key, name]) => option(key, name, model.values[field])));
  const input = (field: string, attrs = {}) =>
    h('input', { 'data-filter': field, value: model.values[field], ...attrs });

  const app = createApp(() => h('div', { class: 'sm-trade-filter-fields' }, [
    model.accounts.length ? h('select', { id: 'trade-account-filter', 'aria-label': '证券账户' }, [
      option('', '全部账户', model.accountId),
      option('unassigned', '待归属交易', model.accountId),
      ...model.accounts.map((account) => option(account.id, `${account.name} · ${account.currency}`, model.accountId))
    ]) : null,
    input('symbol', { placeholder: '代码' }),
    model.summary ? null : select('type', '交易方向', [['all', '全部方向'], ['buy', '买入'], ['sell', '卖出'], ['other', '其它']]),
    select('assetType', '证券类型', [['all', '全部证券类型'], ...Object.entries(model.assetTypes)]),
    input('otherCategory', { placeholder: '其它类别' }),
    input('start', { type: 'date', 'aria-label': '开始日期' }),
    h('span', { class: 'sm-muted' }, '至'),
    input('end', { type: 'date', 'aria-label': '结束日期' }),
    h('button', { type: 'button', class: 'btn ghost sm-btn-sm', id: 'filter-reset' }, '重置')
  ]));
  app.mount(container);
  return () => app.unmount();
}
