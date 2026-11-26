import { createApp, h, type VNode } from 'vue';

interface TradeEditor {
  type: string;
  currency: string;
  accountId: string;
  accounts: { id: string; name: string; currency: string }[];
  canChooseFunding: boolean;
  historical: boolean;
  values: Record<string, string | number>;
  priceStep: string;
}

function option(value: string, label: string, selected?: string) {
  return h('option', { value, selected: value === selected }, label);
}

export function mountTradeEditor(container: HTMLElement, model: TradeEditor) {
  const input = (name: string, attrs = {}) => h('input', { name, value: model.values[name] ?? '', ...attrs });
  const number = (name: string, attrs = {}) => input(name, { type: 'number', step: 'any', ...attrs });
  const label = (title: string | VNode, field: VNode, className?: string, help?: VNode) =>
    h('label', { class: className }, [title, field, help ?? null]);
  const app = createApp(() => h('form', { id: 'trade-form', class: 'sm-form-grid' }, [
    label('类型', h('select', { name: 'type', id: 'trade-type' }, [
      option('buy', '买入', model.type), option('sell', '卖出', model.type),
      option('reinvest', '红利再投资', model.type), option('other', '其它收支', model.type)
    ])),
    model.accounts.length ? label('证券账户', h('select', {
      name: 'account_id', required: true, 'aria-describedby': 'trade-account-hint'
    }, [option('', '请选择实际归属账户', model.accountId), ...model.accounts.map((account) =>
      option(account.id, `${account.name} · ${account.currency}`, model.accountId))]), undefined,
    h('small', { class: 'hint', id: 'trade-account-hint', 'data-trade-account-hint': '', 'aria-live': 'polite' })) : null,
    label('其它类别', input('other_category'), 'field-other'),
    model.canChooseFunding ? label('资金用途', h('select', { name: 'funding' }, [
      option('ordinary', '普通可用现金'), option('dip', '抄底专用资金（卖出则回补资金池）')
    ])) : null,
    h('div', [
      label('代码', input('symbol', { id: 'trade-symbol', autocomplete: 'off', 'aria-describedby': 'trade-instrument-status' })),
      h('div', { id: 'trade-instrument-status', class: 'hint', 'data-instrument-status': '', 'aria-live': 'polite' }),
      h('div', { class: 'sm-instrument-choices', 'data-instrument-choices': '' })
    ]),
    label('名称', input('name', { placeholder: '输入代码后自动填入' })),
    label('币种', h('select', { name: 'currency', id: 'trade-currency' },
      [['USD', '美元'], ['CNY', '人民币'], ['HKD', '港币']].map(([value, title]) =>
        option(value, `${value} ${title}`, model.currency)))),
    label(h('span', { 'data-trade-shares-label': '' }, '数量'), number('shares'), 'field-trade'),
    label(h('span', { 'data-trade-price-label': '' }, '价格'), number('price', { step: model.priceStep }), 'field-trade field-price'),
    label('折算净值（选填）', number('reinvestmentNav', { min: 0 }), 'field-reinvestment',
      h('small', { class: 'hint', 'data-reinvestment-status': '', 'aria-live': 'polite' }, '可按确认日期自动查找，也可填写基金公告指定日期的单位净值。')),
    label('金额', number('total_amount'), 'field-other-amt'),
    label('手续费', number('commission')),
    label('时间', input('trade_date', { type: 'datetime-local' })),
    h('label', { class: 'field-historical' }, [
      h('span', [h('input', { name: 'historicalBackfill', type: 'checkbox', checked: model.historical }), ' 补录历史交易']),
      h('small', { class: 'hint' }, '仅勾选已计入账户余额的交易。补录会更新持仓和盈亏，不重记资金流水；若已绑定记账账户，会按当前估值拆分现金与持仓，保持记账总额不变。')
    ])
  ]));
  app.mount(container);
  return () => app.unmount();
}
