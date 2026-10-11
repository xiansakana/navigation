const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
const pct = (n) => Number.isFinite(n) ? n.toFixed(1) + '%' : '—';
const labels = { stock: '股票与非杠杆ETF', leveraged: '杠杆／反向及波动率产品', option: '期权', ashare: 'A股', other: '其它收支', under1: '不足24小时', '1to7': '1至不足8天', '8to30': '8至不足31天', '31to90': '31至不足91天', over90: '91天及以上', '0to1': '0–1天', '2to7': '2–7天', invalid: '日期需核对' };

function table(headings, rows) {
  return `<div class="sm-table-wrap sm-table-wrap--modal"><table class="sm-table"><thead><tr>${headings.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map((r) => `<tr>${r.map((v, i) => `<td data-label="${escapeHtml(headings[i])}">${escapeHtml(v)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headings.length}" class="empty">暂无数据</td></tr>`}</tbody></table></div>`;
}

function bars(rows, count = false) {
  const maximum = Math.max(1, ...rows.map((r) => Math.abs(count ? r.count : r.net)));
  return `<div class="sm-review-bars">${rows.length ? rows.map((r) => {
    const value = count ? r.count : r.net;
    return `<div class="sm-review-bar-row"><span>${escapeHtml(labels[r.key] || r.key)}</span><div class="sm-review-bar-track"><div class="sm-review-bar ${r.net < 0 ? 'is-loss' : ''}" style="width:${Math.max(0, Math.abs(value) / maximum * 100)}%"></div></div><strong>${count ? value : fmt(value)}</strong></div>`;
  }).join('') : '<p class="hint">暂无数据</p>'}</div>`;
}

export function renderTradeReview(report, selectedCurrency = '', visible = true) {
  const current = report.currencies.find((r) => r.currency === selectedCurrency) || report.currencies.find((r) => r.currency === 'USD') || report.currencies[0];
  const controls = `<div class="sm-review-controls"><span>复盘区间：${escapeHtml(report.startDate || '最早记录')} 至 ${escapeHtml(report.endDate || '最新记录')}</span><select data-review-currency aria-label="复盘币种">${report.currencies.map((r) => `<option ${r === current ? 'selected' : ''}>${escapeHtml(r.currency)}</option>`).join('')}</select><div class="sm-review-presets">${[['all', '全部'], ['year', '今年'], ['90', '近90天'], ['30', '近30天']].map(([key, name]) => `<button type="button" class="btn ghost sm-btn-sm" data-review-range="${key}">${name}</button>`).join('')}</div></div>`;
  if (!visible) return controls + '<p class="hint">盈亏数据已隐藏。开启盈亏显示后查看复盘。</p>';
  if (!current) return controls + '<p class="empty">当前筛选条件下暂无交易记录。</p>';
  const r = current;
  const amount = (n) => `${r.currency === 'CNY' ? '¥' : '$'}${fmt(n)}`;
  const card = (title, value, note = '') => `<div class="sm-review-card"><span>${title}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></div>`;
  const summaryTable = (groups, names = labels) => table(['分组', '记录数', '胜率', '盈利金额', '亏损金额', '净盈亏'], groups.map((g) => [names[g.key] || g.key, g.count, pct(g.winRate), amount(g.profit), amount(g.loss), amount(g.net)]));
  const symbolRows = [...r.symbols.slice(0, 10), ...r.symbols.slice(-10).reverse()].filter((g, i, all) => all.findIndex((x) => x.key === g.key) === i);
  return `${controls}<div class="sm-review-cards">
    ${card('已实现净盈亏', amount(r.realized), '扣除已卖出部分对应的双边费用')}
    ${card('胜率', pct(r.winRate), `${r.count}条完整匹配卖出；${r.wins}赢／${r.losses}亏／${r.flat}平`)}
    ${card('平均盈利／平均亏损', `${amount(r.avgWin)} / ${amount(r.avgLoss)}`)}
    ${card('盈利因子', fmt(r.profitFactor), '盈利金额 ÷ 亏损金额，超过1才覆盖亏损')}
    ${card('其它收支', amount(r.otherNet), '按所选区间收支记录计算')}
    ${card('已实现盈亏＋其它收支', amount(r.realizedWithOther), '不含剩余持仓浮动盈亏')}
  </div><p class="hint">卖出记录计数包含分批卖出，不能等同于独立策略或完整往返交易次数；品种分组净盈亏含可匹配的部分卖出，胜率仅按完整匹配卖出计算。</p>
  <div class="sm-review-charts"><section><h3>品种净盈亏（${escapeHtml(r.currency)}）</h3>${bars(r.assets)}</section><section><h3>卖出盈亏金额分布（${escapeHtml(r.currency)}）</h3>${bars(r.bins, true)}</section><section><h3>期权标的净盈亏</h3>${bars(r.optionUnderlying.slice(0, 8))}</section><section><h3>月度已实现盈亏</h3>${bars(r.months)}</section></div>
  <p class="hint">${r.smallWinCount}条盈利记录赚取不超过50 ${escapeHtml(r.currency)}，占盈利记录${pct(r.smallWinShare)}；${r.bigLossCount}条亏损记录至少亏500 ${escapeHtml(r.currency)}，占亏损金额${pct(r.bigLossShare)}。金额阈值按当前币种计算。</p>
  <details open><summary>品种表现</summary>${summaryTable(r.assets)}</details>
  <details><summary>代码与名称（净盈亏最低与最高，各至多10个）</summary>${table(['代码', '名称', '卖出记录数', '净盈亏'], symbolRows.map((g) => [g.key, g.name, g.count, amount(g.net)]))}</details>
  <details><summary>持有时间分布</summary>${summaryTable(r.holding)}<p class="hint">按卖出时已匹配买入的数量加权平均持有时间分组。表现不同不代表延长持有即可改善同一交易。</p></details>
  <details><summary>期权买入时距到期日</summary>${summaryTable(r.dte, { '0to1': '0–1天', '2to7': '2–7天', '8to30': '8–30天', '31to90': '31–90天', over90: '91天及以上', invalid: '日期需核对' })}<p class="hint">此处记录数是FIFO匹配片段数，到期日按应用时区日期粗分，不能与卖出记录数直接比较。</p></details>
  <details><summary>最大亏损卖出记录（至多10条）</summary>${table(['日期', '代码', '名称', '匹配买入成本', '净盈亏'], r.worst.filter((s) => s.pnl < 0).map((s) => [s.date, s.symbol, s.name, amount(s.cost), amount(s.pnl)]))}</details>
  <details><summary>其它收支与手续费</summary>${table(['类别', '记录数', '净金额'], r.other.map((g) => [g.key, g.count, amount(g.net)]))}<p class="hint">区间内实际支付的交易手续费：${amount(r.windowFees)}；本区间已卖出部分对应的双边费用：${amount(r.realizedFees)}，已计入已实现净盈亏，两者不可再叠加扣除。跨期买入会令两者不同。截至区间末尚未卖出部分的买入手续费为${amount(r.openBuyFees)}，可能发生在区间之前。</p></details>
  <section class="sm-review-notes"><h3>本区间复盘建议</h3><ul>${r.insights.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul><p class="hint">由记录计算的规则提示，不预测未来收益；不按历史最优结果自动推荐标的。</p></section>
  <section class="sm-review-notes"><h3>数据核对与核算口径</h3><p>${r.unmatched.length ? `有${r.unmatched.length}条卖出存在缺失买入成本；未匹配收入未计为利润，相关记录不纳入胜率。` : '所选区间全部卖出均可匹配买入成本。'}${r.invalid.length ? `另有${r.invalid.length}条无效数量记录需要核对。` : ''}</p>
  ${r.unmatched.length ? table(['日期', '代码', '未匹配数量', '未匹配收入'], r.unmatched.map((s) => [s.date, s.symbol, s.shares, amount(s.proceeds)])) : ''}
  <p>${r.duplicateCount ? `其它收支有${r.duplicateCount}条额外的完全相同记录，净金额${amount(r.duplicateAmount)}，可能为同时间入账的不同流水，已保留并提示核对。` : '本区间未发现完全相同的其它收支行。'}</p>
  <p class="hint">先匹配区间末之前的完整交易历史，再按卖出日期筛选已实现盈亏，采用记录金额并按数量分配买卖手续费；币种分别统计。区间末剩余买入成本${amount(r.openCost)}不是当前市值或亏损。缺少账户净值、出入金和区间末估值，不能计算账户总收益率、年化收益或账户最大回撤。</p></section>`;
}
