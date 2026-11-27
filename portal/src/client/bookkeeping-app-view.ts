import { createApp, h, reactive, watch, Teleport } from 'vue';

export { mountBookkeepingEntries } from './bookkeeping-entries-view';

export type BookkeepingTab = 'entries' | 'stats' | 'accounts' | 'catalog' | 'import' | 'entry-detail';

export interface MiniCategory {
  category: string;
  currency: string;
  amount: number;
  count?: number;
}

interface EditorState {
  open: boolean;
  title: string;
  error: string;
  fieldEditor: boolean;
  deletable: boolean;
  saveHidden: boolean;
}

export interface BookkeepingShellState {
  owner: string;
  tab: BookkeepingTab;
  loading: boolean;
  privacy: boolean;
  miniCategories: MiniCategory[];
  miniEquivalent: boolean;
  editor: EditorState;
}

export interface PeriodHooks {
  reload(): void;
  clearFocus(): void;
  save(value: any): void;
}

export interface BookkeepingPeriods {
  query(): { start?: string; end?: string };
  choose(kind: string, reload?: boolean): void;
  focusDate(data: any): void;
  hydrate(value: any): void;
  restore(): void;
  configure(hooks: PeriodHooks): void;
}

export interface BookkeepingShell {
  state: BookkeepingShellState;
  periods: BookkeepingPeriods;
  setOwner(text: string): void;
  setTab(name: BookkeepingTab): void;
  setLoading(value: boolean): void;
  setMiniCategories(items: MiniCategory[], equivalent: boolean): void;
  editor: {
    open(options: { title: string; fieldEditor?: boolean; deletable?: boolean; saveHidden?: boolean }): void;
    close(): void;
    markClosed(): void;
    setError(message: string): void;
  };
}

const symbols: Record<string, string> = { CNY: '¥', USD: 'US$', HKD: 'HK$', JPY: 'JP¥', MYR: 'RM', EUR: '€', GBP: '£', SGD: 'S$' };
const amountFormatter = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (value: number, currency = 'CNY') =>
  (value < 0 ? '-' : '') + (symbols[currency] || currency + ' ') + amountFormatter.format(Math.abs(value));

const iso = (value: Date) => new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const currentDate = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).map(part => [part.type, part.value] as [string, string]));
  return parts.year + '-' + parts.month + '-' + parts.day;
};
const today = currentDate();

const field = (id: string) => document.getElementById(id) as HTMLInputElement | null;
const valueOf = (id: string) => field(id)?.value ?? '';

interface PeriodController extends BookkeepingPeriods {
  init(): void;
  step(direction: number): void;
  apply(): void;
}

function createPeriods(): PeriodController {
  let rangeStart = today, rangeEnd = today;
  let hooks: PeriodHooks = { reload() {}, clearFocus() {}, save() {} };
  function update(reload = true) {
    const kind = valueOf('period-kind');
    const anchor = new Date((valueOf('period-anchor') || today) + 'T12:00:00');
    let start = '', end = '';
    if (kind === 'range') {
      start = valueOf('range-start'); end = valueOf('range-end');
      if (reload) { rangeStart = start; rangeEnd = end; }
    } else if (kind !== 'all') {
      const a = new Date(anchor), b = new Date(anchor);
      if (kind === 'week') { a.setDate(a.getDate() - ((a.getDay() + 6) % 7)); b.setTime(a.getTime()); b.setDate(b.getDate() + 6); }
      if (kind === 'month') { a.setDate(1); b.setMonth(b.getMonth() + 1, 0); }
      if (kind === 'year') { a.setMonth(0, 1); b.setMonth(11, 31); }
      start = iso(a); end = iso(b);
      if (field('range-start')) field('range-start')!.value = start;
      if (field('range-end')) field('range-end')!.value = end;
    }
    if (field('month')) field('month')!.value = kind === 'month' ? start.slice(0, 7) : '';
    document.getElementById('period-range')?.classList.toggle('hidden', kind !== 'range');
    document.getElementById('period-anchor-label')?.classList.toggle('hidden', ['range', 'all'].includes(kind));
    for (const id of ['period-prev', 'period-next']) {
      const button = document.getElementById(id) as HTMLButtonElement | null;
      if (button) button.disabled = ['range', 'all'].includes(kind);
    }
    const caption = document.getElementById('period-caption');
    if (caption) caption.textContent = kind === 'all' ? '全部日期' : start + ' ～ ' + end;
    document.querySelectorAll('[data-period]').forEach(button => button.classList.toggle('active', (button as HTMLElement).dataset.period === kind));
    if (reload) { hooks.save({ kind, anchor: valueOf('period-anchor'), rangeStart, rangeEnd }); hooks.clearFocus(); hooks.reload(); }
  }
  function choose(kind: string, reload = true) {
    if (kind === 'range') {
      if (field('range-start')) field('range-start')!.value = rangeStart;
      if (field('range-end')) field('range-end')!.value = rangeEnd;
    }
    if (field('period-kind')) field('period-kind')!.value = kind;
    update(reload);
  }
  function step(direction: number) {
    const a = new Date(valueOf('period-anchor') + 'T12:00:00'), kind = valueOf('period-kind');
    if (kind === 'week') a.setDate(a.getDate() + 7 * direction);
    if (kind === 'month') { a.setDate(1); a.setMonth(a.getMonth() + direction); }
    if (kind === 'year') { a.setDate(1); a.setFullYear(a.getFullYear() + direction); }
    if (field('period-anchor')) field('period-anchor')!.value = iso(a);
    update();
  }
  function query() {
    const kind = valueOf('period-kind');
    if (kind === 'all') return {};
    return { start: valueOf('range-start'), end: valueOf('range-end') };
  }
  function focusDate(data: any) {
    if (!data.day && !data.month) return;
    const previous = query();
    const start = data.day || data.month + '-01';
    const end = data.day || new Date(Date.UTC(Number(data.month.slice(0, 4)), Number(data.month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    if (field('period-kind')) field('period-kind')!.value = 'range';
    if (field('range-start')) field('range-start')!.value = previous.start && previous.start > start ? previous.start : start;
    if (field('range-end')) field('range-end')!.value = previous.end && previous.end < end ? previous.end : end;
    update(false);
  }
  function hydrate(value: any) {
    if (!value) return;
    rangeStart = value.rangeStart || today; rangeEnd = value.rangeEnd || today;
    if (field('period-anchor')) field('period-anchor')!.value = value.anchor || today;
    if (field('period-kind')) field('period-kind')!.value = value.kind;
    if (field('range-start')) field('range-start')!.value = rangeStart;
    if (field('range-end')) field('range-end')!.value = rangeEnd;
    update(false);
  }
  return {
    query, choose, focusDate, hydrate, step,
    restore: () => update(false),
    apply: () => update(),
    configure(next: PeriodHooks) { hooks = next; },
    init() { if (field('period-anchor')) field('period-anchor')!.value = today; update(false); }
  };
}

export function mountBookkeepingShell(host: HTMLElement): BookkeepingShell {
  const state = reactive<BookkeepingShellState>({
    owner: '',
    tab: 'entries',
    loading: false,
    privacy: false,
    miniCategories: [],
    miniEquivalent: false,
    editor: { open: false, title: '记一笔', error: '', fieldEditor: false, deletable: false, saveHidden: false }
  });

  const periods = createPeriods();

  const miniList = () => {
    const items = state.miniCategories || [];
    const list = items.filter(item => item.amount !== 0).slice(0, 6);
    const totals: Record<string, number> = {};
    for (const item of items) if (item.amount > 0) totals[item.currency] = (totals[item.currency] || 0) + item.amount;
    if (!list.length) return [h('p', { class: 'bk-empty' }, '暂时没有支出记录')];
    return list.map(item => h('button', {
      key: item.category + '-' + item.currency,
      class: 'bk-category bk-category-drill',
      'data-drill': JSON.stringify({ category: item.category, currency: state.miniEquivalent ? valueOf('currency') : item.currency, flow: 'expense' })
    }, [
      h('div', { class: 'bk-category-title' }, [
        h('span', null, [item.category + ' ', h('small', { class: 'bk-muted' }, item.currency)]),
        h('span', { 'data-money': '' }, money(item.amount, item.currency))
      ]),
      h('div', { class: 'bk-bar' }, [h('span', { style: 'width:' + Math.max(0, Math.min(100, item.amount / (totals[item.currency] || 1) * 100)) + '%' })])
    ]));
  };

  const periodButton = (kind: string, label: string, active = false) => h('button', {
    type: 'button',
    'data-period': kind,
    class: active ? 'active' : '',
    onClick: () => periods.choose(kind)
  }, label);

  const periodSection = () => h('section', { id: 'period-selector', class: 'bk-period-selector' }, [
    h('input', { type: 'hidden', id: 'month' }),
    h('input', { type: 'hidden', id: 'period-kind', value: 'month' }),
    h('div', { id: 'period-buttons', class: 'bk-period-buttons', role: 'group', 'aria-label': '日期范围模式' }, [
      periodButton('week', '周'), periodButton('month', '月', true), periodButton('year', '年'), periodButton('all', '全部'), periodButton('range', '范围')
    ]),
    h('div', { class: 'bk-period-navigation' }, [
      h('button', { id: 'period-prev', class: 'btn ghost', 'aria-label': '上一时间段', onClick: () => periods.step(-1) }, '←'),
      h('span', { id: 'period-caption' }),
      h('button', { id: 'period-next', class: 'btn ghost', 'aria-label': '下一时间段', onClick: () => periods.step(1) }, '→')
    ]),
    h('div', { class: 'bk-filters' }, [
      h('div', { id: 'period-anchor-label', class: 'bk-anchor-field' }, [
        h('label', { for: 'period-anchor' }, '定位日期'),
        h('div', { class: 'bk-anchor-row' }, [
          h('input', { type: 'date', id: 'period-anchor', 'aria-label': '定位日期', value: today, onChange: () => periods.apply() }),
          h('button', { type: 'button', id: 'period-today', class: 'btn ghost', 'aria-label': '定位到今天', onClick: () => { if (field('period-anchor')) field('period-anchor')!.value = currentDate(); periods.apply(); } }, '今天')
        ])
      ]),
      h('div', { id: 'period-range', class: 'bk-period-range hidden' }, [
        h('label', null, ['开始日期', h('input', { type: 'date', id: 'range-start', 'aria-label': '开始日期', onChange: () => periods.apply() })]),
        h('label', null, ['结束日期', h('input', { type: 'date', id: 'range-end', 'aria-label': '结束日期', onChange: () => periods.apply() })])
      ])
    ])
  ]);

  const filtersSection = () => h('section', { class: 'bk-filters', id: 'filters' }, [
    h('label', null, ['货币', h('select', { id: 'currency', 'aria-label': '货币' })]),
    h('label', { class: 'bk-search' }, ['搜索', h('input', { type: 'search', id: 'search', placeholder: '备注、分类、账户、标签或位置' })]),
    h('details', { class: 'bk-extra-filters', id: 'extra-filters', open: true }, [
      h('summary', null, '更多筛选'),
      h('div', { class: 'bk-extra-fields' }, [
        h('label', null, ['账本', h('select', { id: 'book', 'aria-label': '账本' })]),
        h('label', null, ['类型', h('select', { id: 'type', 'aria-label': '类型' })]),
        h('label', null, ['分类', h('select', { id: 'category', 'aria-label': '分类' })]),
        h('label', { id: 'account-filter-label' }, ['账户', h('select', { id: 'account', 'aria-label': '账户' })]),
        h('button', { class: 'btn ghost', id: 'all-dates' }, '全部日期'),
        h('button', { type: 'button', class: 'btn ghost', id: 'reset-filters' }, '重置')
      ])
    ])
  ]);

  const entriesView = () => h('section', { id: 'entries-view', class: 'bk-view' }, [
    h('div', { id: 'summary', class: 'bk-summary' }),
    h('div', { class: 'bk-two-col' }, [
      h('article', { class: 'bk-panel' }, [
        h('div', { class: 'bk-panel-heading' }, [h('h2', null, '账单明细'), h('span', { id: 'count', class: 'bk-muted' })]),
        h('p', { id: 'list-status', class: 'bk-muted', role: 'status' }, state.loading ? '正在加载账单…' : ''),
        h('div', { id: 'entry-list' }),
        h('button', { class: 'btn ghost hidden', id: 'more' }, '加载更多')
      ]),
      h('aside', { class: 'bk-panel bk-aside' }, [
        h('h2', null, '支出去哪了'),
        h('p', { class: 'bk-muted' }, '退款与报销冲减支出；转账不计入收支。'),
        h('div', { id: 'mini-categories' }, miniList()),
        h('div', { class: 'bk-guide' }, [
          h('span', null, '✦'),
          h('h3', null, '从 iCost 继续记录'),
          h('p', null, '导入历史账单，保留分类、账户、备注与位置。历史导入与账户余额基准分开核对。'),
          h('button', { class: 'btn ghost hidden', id: 'import-shortcut' }, '导入账单 →')
        ])
      ])
    ])
  ]);

  const statsView = () => h('section', { id: 'stats-view', class: 'bk-view hidden' }, [
    h('div', { id: 'stats-summary', class: 'bk-summary' }),
    h('article', { class: 'bk-panel bk-analysis-panel' }, [
      h('h2', null, '账单总结与消费建议'),
      h('p', { class: 'bk-muted' }, '基于当前筛选账单生成；建议金额是可调整的节支目标。'),
      h('div', { id: 'spending-insights' })
    ]),
    h('article', { class: 'bk-panel bk-analysis-panel' }, [
      h('h2', null, '收支走势与累计结余'),
      h('p', { class: 'bk-muted' }, '收入、净支出和累计账单结余统一按账单日期的历史汇率折算为 CNY 总计。累计结余不等于净资产；点击图中数据点可查看对应账单。'),
      h('div', { id: 'billing-charts' })
    ]),
    h('div', { class: 'bk-two-col' }, [
      h('article', { class: 'bk-panel', id: 'trend-panel' }, [
        h('h2', { id: 'trend-title' }, '每日收支'),
        h('p', { class: 'bk-muted' }, '所有原始币种按账单日期的历史参考汇率折算为 CNY 总计'),
        h('div', { id: 'trend' })
      ]),
      h('article', { class: 'bk-panel' }, [
        h('h2', null, '分类支出'),
        h('div', { id: 'categories' }),
        h('div', { class: 'bk-income-section' }, [
          h('h2', null, '分类收入'),
          h('p', { class: 'bk-muted' }, '按账单日期历史汇率汇总为 CNY；占比按正向分类收入计算。退款、报销回款和转账不计入收入。点击分类查看账单。'),
          h('div', { id: 'income-categories' })
        ])
      ])
    ]),
    h('article', { class: 'bk-panel bk-settings' }, [
      h('h2', null, '预算与汇率'),
      h('div', { id: 'budget' }),
      h('p', { class: 'bk-muted' }, '自动获取与股票管理同来源的参考汇率（Finnhub → FRED → Yahoo），显示原始数据日期；失败时使用手动备用值或历史缓存。'),
      h('div', { id: 'fx-rates', class: 'bk-fx-rates' }),
      h('p', { id: 'fx-status', class: 'bk-muted', role: 'status' }),
      h('div', { class: 'bk-heading-actions' }, [
        h('button', { class: 'btn ghost hidden', id: 'settings' }, '设置预算与备用汇率'),
        h('button', { class: 'btn ghost hidden', id: 'refresh-fx' }, '更新参考汇率')
      ])
    ])
  ]);

  const accountsView = () => h('section', { id: 'accounts-view', class: 'bk-view hidden' }, [
    h('div', { class: 'bk-panel-heading' }, [
      h('div', null, [
        h('h2', null, '资产账户'),
        h('p', { class: 'bk-muted' }, '总资产、负债与净资产仅包含“计入总资产”的账户。归档仅隐藏账户，仍按该设置计入总资产。')
      ]),
      h('button', { class: 'btn primary hidden', id: 'add-account', disabled: true }, '＋ 新增账户')
    ]),
    h('div', { id: 'assets-summary', class: 'bk-summary' }),
    h('article', { id: 'asset-overview', class: 'bk-panel bk-analysis-panel hidden' }, [
      h('div', { id: 'asset-chart-tabs', class: 'bk-asset-chart-tabs', role: 'tablist', 'aria-label': '资产图表' }, [
        h('button', { type: 'button', id: 'asset-tab-balance', role: 'tab', 'data-asset-chart': 'balance', 'aria-selected': 'true', 'aria-controls': 'asset-overview-charts' }, '资产余额走势'),
        h('button', { type: 'button', id: 'asset-tab-returns', role: 'tab', 'data-asset-chart': 'returns', 'aria-selected': 'false', 'aria-controls': 'asset-overview-charts', tabindex: '-1', hidden: true }, '证券收益走势')
      ]),
      h('p', { id: 'asset-overview-note', class: 'bk-muted' }),
      h('div', { id: 'asset-overview-charts', role: 'tabpanel', 'aria-labelledby': 'asset-tab-balance' })
    ]),
    h('details', { class: 'bk-fx-assets' }, [
      h('summary', null, '折算汇率与来源'),
      h('div', { id: 'asset-fx-rates', class: 'bk-fx-rates' }),
      h('button', { class: 'btn ghost hidden', id: 'refresh-asset-fx' }, '更新参考汇率')
    ]),
    h('div', { class: 'bk-filters' }, [
      h('label', null, ['资产分组', h('select', { id: 'asset-group', 'aria-label': '资产分组筛选' })]),
      h('label', { class: 'bk-search' }, ['查找账户', h('input', { id: 'asset-search', type: 'search', placeholder: '账户名称或备注' })]),
      h('label', { class: 'bk-check' }, [h('input', { id: 'show-archived-accounts', type: 'checkbox' }), '显示归档账户']),
      h('button', { class: 'btn ghost hidden', id: 'manage-groups' }, '管理分组')
    ]),
    h('div', { id: 'group-manager', class: 'bk-panel hidden' }),
    h('div', { id: 'account-groups', class: 'bk-account-grid' }),
    h('p', { class: 'bk-muted' }, '截图余额作为初始基准；导入的历史账单不重复影响余额。新记账、编辑和删除新账单会联动账户余额。')
  ]);

  const catalogView = () => h('section', { id: 'catalog-view', class: 'bk-view hidden' }, [
    h('div', { class: 'bk-panel-heading' }, [
      h('div', null, [
        h('h2', null, '分类管理'),
        h('p', { class: 'bk-muted' }, '支出与收入分别管理。重命名或合并同步关联账单；笔数涵盖全部日期和账本。')
      ]),
      h('button', { id: 'add-category', class: 'btn primary hidden', disabled: true }, '＋ 一级分类')
    ]),
    h('div', { class: 'bk-filters' }, [
      h('label', null, ['分类类型', h('select', { id: 'catalog-kind', 'aria-label': '分类类型' }, [
        h('option', { value: 'expense' }, '支出'),
        h('option', { value: 'income' }, '收入')
      ])]),
      h('label', { class: 'bk-check' }, [h('input', { id: 'show-archived-categories', type: 'checkbox' }), '显示停用分类'])
    ]),
    h('div', { id: 'catalog-list', class: 'bk-account-grid' })
  ]);

  const importView = () => h('section', { id: 'import-view', class: 'bk-view hidden' }, [
    h('div', { class: 'bk-two-col' }, [
      h('article', { class: 'bk-panel' }, [
        h('div', { class: 'bk-import-icon' }, '⇧'),
        h('h2', null, '导入 iCost 账单'),
        h('p', { class: 'bk-muted' }, '选择 iCost 导出的 .xlsx 文件，先预览，再保存到当前登录用户。重复导入会跳过已存在的记录。'),
        h('label', { class: 'bk-file hidden', id: 'import-label' }, ['选择账单文件', h('input', { type: 'file', id: 'import-file', accept: '.xlsx' })]),
        h('label', { class: 'bk-file hidden', id: 'snapshot-label' }, ['可选：账户余额快照 JSON', h('input', { type: 'file', id: 'snapshot-file', accept: '.json' })]),
        h('p', { class: 'bk-muted', id: 'snapshot-status' }, '快照仅创建尚不存在的账户，不覆盖已有余额。'),
        h('div', { id: 'import-preview', role: 'status' }),
        h('div', { id: 'import-review' }),
        h('p', { id: 'import-review-status', class: 'bk-muted', role: 'status' }),
        h('button', { type: 'button', class: 'btn ghost hidden', id: 'review-import' }, '计算余额预览'),
        h('button', { class: 'btn primary hidden', id: 'confirm-import' }, '确认导入')
      ]),
      h('article', { class: 'bk-panel' }, [
        h('div', { class: 'bk-import-icon' }, '⇩'),
        h('h2', null, '导出账单'),
        h('p', { class: 'bk-muted' }, '导出当前筛选的明细，采用 iCost 的列顺序。该格式供查看和迁移，不能保证可用于 iCost 数据恢复。跨币种到账额与余额基准请另行备份。'),
        h('button', { class: 'btn ghost hidden', id: 'export' }, '导出筛选账单 .xlsx'),
        h('hr'),
        h('h3', null, '统计口径'),
        h('p', { class: 'bk-muted' }, '收入计入收入；支出与已报销计入支出；退款入账和报销入账冲减支出。转账、还款、借出、收回和余额调整不计入收支，手续费计入支出。退款、优惠字段保留为辅助信息。')
      ])
    ])
  ]);

  const editorDialog = () => h('dialog', { id: 'editor', class: ['bk-dialog', state.editor.fieldEditor ? 'bk-field-editor' : ''] }, [
    h('form', { id: 'editor-form' }, [
      h('div', { class: 'bk-panel-heading' }, [
        h('h2', { id: 'editor-title' }, state.editor.title),
        h('button', { type: 'button', class: 'btn ghost', id: 'close-editor', 'aria-label': '关闭' }, '✕')
      ]),
      h('div', { id: 'editor-fields', class: 'bk-form-grid' }),
      h('p', { id: 'editor-error', class: 'bk-error', role: 'alert' }, state.editor.error),
      h('div', { class: 'bk-form-actions' }, [
        h('button', { type: 'button', class: ['btn ghost', state.editor.deletable ? '' : 'hidden'], id: 'delete-item' }, '删除'),
        h('button', { class: ['btn primary', state.editor.saveHidden ? 'hidden' : ''], type: 'submit', id: 'save-item' }, '保存')
      ])
    ])
  ]);

  const qqDialog = () => h('dialog', { id: 'qq-dialog', class: 'bk-dialog' }, [
    h('form', { id: 'qq-form' }, [
      h('div', { class: 'bk-panel-heading' }, [
        h('h2', null, 'QQ记账'),
        h('button', { type: 'button', class: 'btn ghost', id: 'qq-close', 'aria-label': '关闭QQ记账' }, '✕')
      ]),
      h('p', { id: 'qq-status', class: 'bk-muted' }),
      h('div', { class: 'bk-form-actions' }, [
        h('button', { type: 'button', class: 'btn ghost', id: 'qq-code' }, '生成绑定码'),
        h('button', { type: 'button', class: 'btn ghost', id: 'qq-refresh' }, '刷新绑定状态'),
        h('button', { type: 'button', class: 'btn ghost', id: 'qq-unbind' }, '解绑')
      ]),
      h('p', { id: 'qq-code-text', class: 'bk-muted', style: 'overflow-wrap:anywhere' }),
      h('div', { class: 'bk-form-grid' }, [
        h('label', null, ['默认账户', h('select', { id: 'qq-account' })]),
        h('label', null, ['允许记账的群号', h('input', { id: 'qq-groups', placeholder: '多个群号用逗号分隔；留空仅私聊' })]),
        h('label', { class: 'full' }, ['账户别名（每行一个：简称=完整账户名）', h('textarea', { id: 'qq-aliases', rows: '4', placeholder: '微信=资金账户-微信' })])
      ]),
      h('p', { class: 'bk-muted' }, '私聊机器人：记账 支出 35 餐饮 微信'),
      h('p', { class: 'bk-muted' }, '收入：记账 收入 5000 工资 支付宝'),
      h('p', { class: 'bk-muted' }, '转账：转账 500 微信 到 支付宝'),
      h('p', { class: 'bk-muted' }, '支持 日期=2026-10-10、备注=午餐、币种=HKD；跨币种转账须加 到账=金额。'),
      h('p', { class: 'bk-muted' }, '群聊请先添加群号，再 @机器人 发送指令；群内回执只显示结果与编号。'),
      h('p', { class: 'bk-muted' }, '位置卡片只关联一笔：私聊可先发位置再记账，群聊先 @机器人 记账定位，再分享位置。'),
      h('p', { class: 'bk-muted' }, '漏位置会提醒补充；发送“跳过定位”继续记账，或在指令后加 定位=跳过。'),
      h('p', { class: 'bk-muted' }, '超过10分钟可发送“补充位置 完整编号”，再分享位置卡片。'),
      h('p', { class: 'bk-muted' }, '撤销账单：撤销 完整编号。只能撤销自己通过 QQ 创建的账单。'),
      h('p', { id: 'qq-error', class: 'bk-error', role: 'status' }),
      h('div', { class: 'bk-form-actions' }, [h('button', { type: 'submit', class: 'btn primary', id: 'qq-save' }, '保存QQ设置')])
    ])
  ]);

  const root = () => [
    h('header', { class: 'bk-heading' }, [
      h('div', null, [
        h('a', { href: '/', class: 'bk-back' }, '← 我的服务'),
        h('p', { class: 'bk-eyebrow' }, '每一笔，都有迹可循'),
        h('h1', null, ['我的账本 ', h('span', { id: 'owner' }, state.owner)]),
        h('p', { class: 'bk-muted' }, '记录生活，也看清资产的来去。')
      ]),
      h('div', { class: 'bk-heading-actions' }, [
        h('button', { class: 'btn ghost hidden', id: 'qq-open' }, 'QQ记账'),
        h('button', {
          class: 'btn ghost', id: 'privacy', 'aria-pressed': String(state.privacy),
          onClick: () => { state.privacy = !state.privacy; }
        }, state.privacy ? '显示金额' : '隐藏金额'),
        h('button', { class: 'btn primary hidden', id: 'add-entry', disabled: true }, '＋ 记一笔')
      ])
    ]),
    h('p', { class: 'bk-error hidden', id: 'error', role: 'alert' }),
    h('nav', { class: 'bk-tabs', 'aria-label': '记账导航' }, [
      h('button', { 'data-tab': 'entries', class: 'active' }, '☷ 明细'),
      h('button', { 'data-tab': 'stats' }, '◔ 统计'),
      h('button', { 'data-tab': 'accounts', class: 'hidden' }, '▣ 资产'),
      h('button', { 'data-tab': 'catalog', class: 'hidden' }, '◈ 分类'),
      h('button', { 'data-tab': 'import', class: 'hidden' }, '⇄ 导入导出')
    ]),
    periodSection(),
    h('section', { id: 'analysis-scope', class: 'bk-analysis-scope hidden' }),
    filtersSection(),
    h('div', { id: 'drill-context', class: 'bk-drill-context hidden' }, [
      h('span', { id: 'drill-label' }),
      h('button', { class: 'btn ghost', id: 'return-stats' }, '← 返回统计')
    ]),
    entriesView(),
    statsView(),
    accountsView(),
    catalogView(),
    importView(),
    h('section', { id: 'entry-detail-view', class: 'bk-view bk-detail-view hidden', 'aria-labelledby': 'entry-detail-title' }),
    h('div', { id: 'period-dock-slot' }),
    h(Teleport, { to: 'body' }, [editorDialog(), qqDialog()])
  ];

  const app = createApp({ render: root });
  app.mount(host);

  const applyTab = () => {
    const name = state.tab;
    document.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', (button as HTMLElement).dataset.tab === (name === 'entry-detail' ? 'entries' : name)));
    document.querySelectorAll('.bk-view').forEach(view => view.classList.toggle('hidden', view.id !== name + '-view'));
    document.getElementById('filters')?.classList.toggle('hidden', ['accounts', 'catalog', 'entry-detail'].includes(name));
    document.getElementById('period-selector')?.classList.toggle('hidden', ['catalog', 'entry-detail'].includes(name));
  };

  watch(() => state.tab, applyTab, { flush: 'sync', immediate: true });
  watch(() => state.privacy, value => document.querySelector('.bk-shell')?.classList.toggle('bk-private', value), { flush: 'sync' });
  watch(() => state.loading, value => document.querySelector('.bk-shell')?.setAttribute('aria-busy', String(value)), { flush: 'sync' });
  watch(() => state.editor.open, open => {
    const dialog = document.getElementById('editor') as HTMLDialogElement | null;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, { flush: 'sync' });

  periods.init();

  return {
    state,
    periods,
    setOwner(text: string) { state.owner = text; },
    setTab(name: BookkeepingTab) { state.tab = name; },
    setLoading(value: boolean) { state.loading = value; },
    setMiniCategories(items: MiniCategory[], equivalent: boolean) { state.miniCategories = items || []; state.miniEquivalent = equivalent; },
    editor: {
      open(options) {
        state.editor.error = '';
        state.editor.title = options.title;
        state.editor.fieldEditor = !!options.fieldEditor;
        state.editor.deletable = !!options.deletable;
        state.editor.saveHidden = !!options.saveHidden;
        state.editor.open = true;
      },
      close() { state.editor.open = false; },
      markClosed() { state.editor.open = false; },
      setError(message: string) { state.editor.error = message; }
    }
  };
}

