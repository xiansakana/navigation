import { formatQuantity } from './price-format.js?v=quantity-1';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const amount = (n, cur) => Number.isFinite(n) ? `${cur} ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : n === null ? '待补齐行情' : '—';

function accountMetrics(currency, entries) {
  return `<dl class="sm-account-metrics">${entries.map(([label, value]) =>
    `<div><dt>${label}</dt><dd>${amount(value, currency)}</dd></div>`).join('')}</dl>`;
}

export async function openInvestmentAccounts({ api, openModal, reload, can, toastErr, toastOk }) {
  const layer = openModal('证券账户与记账绑定', '<div class="sm-account-manager">加载中…</div>', '<button type="button" class="btn ghost" data-close>关闭</button>', null, { size: 'trade' });
  const editable = can('accounts', 'edit') && can('cash', 'edit');
  const showAmounts = can('cash');
  const confirm = async (message) => window.portalDialog?.confirm ? window.portalDialog.confirm(message, { title: '账户核对', okText: '确认' }) : window.confirm(message);
  const refresh = async () => {
    try {
      const data = await api('/accounts');
      const root = layer.querySelector('.sm-account-manager');
      if (!root?.isConnected) return;
      root.innerHTML = `<div class="sm-account-toolbar">
          <span class="hint">未归属交易 ${data.unassigned} 条</span>
          <div class="sm-account-toolbar-actions">
            ${data.accounts.length > 1 ? `<button type="button" class="btn ghost" data-account-order-start>调整账户顺序</button>
              <button type="button" class="btn ghost" data-account-order-cancel hidden>取消</button>
              <button type="button" class="btn primary" data-account-order-save hidden>保存顺序</button>` : ''}
            ${editable ? '<button type="button" class="btn primary" data-account-new>＋ 新增证券资金账户</button>' : ''}
          </div>
        </div>
        <details class="sm-account-help"><summary>现金与绑定说明</summary>
          <p class="hint">账户可绑定同币种的记账理财账户。现金按确认基准及后续交易、资金流水计算，总资产为现金加持仓市值。旧手工现金仅作核对快照。已在股票端记录的股息和税费请勿在记账端重复录入。行情随供应商更新，跨页面每 15 秒刷新余额。</p>
          <p class="hint">普通买入使用普通可用现金。抄底资金为账户内预留，成交时选择同币种专用账户和资金用途。外部券商并未冻结资金，导入后出现缺口须先核对。</p>
        </details>
        <div class="sm-account-grid">
        ${data.accounts.map((a) => `<section class="sm-account-card" data-account-card="${esc(a.id)}"><header class="sm-account-card-head">
            <h3>${esc(a.name)} · ${esc(a.currency)}</h3>
            <div class="sm-account-binding">记账绑定：${esc(a.bookkeepingName || '未绑定')} ${a.bookkeepingName ? '<a href="/bookkeeping/" target="_blank" rel="noopener">打开记账</a>' : ''}</div>
          </header>
          <div class="sm-account-order-actions" hidden>
            <button type="button" class="btn ghost sm-btn-sm" data-account-move="-1" aria-label="前移 ${esc(a.name)}">前移</button>
            <button type="button" class="btn ghost sm-btn-sm" data-account-move="1" aria-label="后移 ${esc(a.name)}">后移</button>
          </div>
          ${showAmounts ? accountMetrics(a.currency, [['现金', a.cash], ['持仓市值', a.marketValue], ['总资产', a.equity]]) : ''}
          ${a.reserved != null ? `${accountMetrics(a.currency, [['抄底预留', a.reserved], ['普通可用', a.ordinaryAvailable], ['策略缺口', a.deficit]])}${can('dip-funds', 'edit') && can('cash', 'edit') ? `<div><button type="button" class="btn ghost" data-dip-reserve="${a.id}">划拨／释放抄底资金</button></div>` : ''}` : ''}
          ${showAmounts ? `<p class="hint">现金基准：${amount(a.baselineCash, a.currency)}（${esc(a.baselineAt ? new Date(a.baselineAt).toLocaleString('sv-SE') : '—')}）。${a.oldLedgerBalance != null ? `绑定时旧记账余额 ${amount(a.oldLedgerBalance, a.currency)}，仅供核对。` : ''}${a.missingQuotes?.length ? `缺少行情：${esc(a.missingQuotes.join('、'))}，不显示不完整的总资产。` : ''}</p>` : ''}
          ${editable ? `<div class="sm-account-actions"><button type="button" class="btn ghost" data-account-edit="${a.id}">编辑／核对现金</button>${can('trade', 'edit') ? `<button type="button" class="btn ghost" data-account-assign="${a.id}">归入未归属历史</button>` : ''}${a.bookkeepingId ? `<button type="button" class="btn ghost" data-account-unlink="${a.id}">解除绑定</button>` : ''}</div>` : ''}
          <details><summary>持仓与行情时间</summary>${(a.positions || []).map((p) => `<p>${esc(p.symbol)} ${esc(p.name)} · ${formatQuantity(p.shares)} · ${amount(p.marketValue, a.currency)}<br><small class="hint">报价时间：${esc(p.quoteAsOf || '供应商未提供')} ${p.delayed ? '延时行情' : ''}</small></p>`).join('') || '<p class="hint">暂无已归属持仓</p>'}</details>
          <details><summary>基准后的资金变动（最近50条）</summary>${(a.movements || []).slice(0, 50).map((m) => `<p>${esc(m.date)} · ${esc(m.kind === 'stock' ? '股票' : '记账')} ${esc(m.symbol || m.type)} · ${amount(m.delta, a.currency)}</p>`).join('') || '<p class="hint">暂无变动</p>'}</details></section>`).join('') || '<p class="hint">尚未建立证券账户，旧持仓和现金保持原样。</p>'}
        </div>`;
      const startOrder = root.querySelector('[data-account-order-start]');
      if (startOrder) {
        const grid = root.querySelector('.sm-account-grid');
        const cancelOrder = root.querySelector('[data-account-order-cancel]');
        const saveOrder = root.querySelector('[data-account-order-save]');
        const addAccount = root.querySelector('[data-account-new]');
        let savedCards = [...grid.children];
        let arranging = false;
        let saving = false;
        const updateControls = () => {
          root.classList.toggle('is-arranging', arranging);
          startOrder.hidden = arranging;
          if (addAccount) addAccount.hidden = arranging;
          cancelOrder.hidden = saveOrder.hidden = !arranging;
          cancelOrder.disabled = saving;
          saveOrder.disabled = saving || savedCards.every((card, index) => card === grid.children[index]);
          [...grid.children].forEach((card, index) => {
            card.querySelector('.sm-account-order-actions').hidden = !arranging;
            card.querySelector('[data-account-move="-1"]').disabled = saving || index === 0;
            card.querySelector('[data-account-move="1"]').disabled = saving || index === grid.children.length - 1;
          });
        };
        startOrder.addEventListener('click', () => {
          arranging = true;
          updateControls();
          grid.querySelector('[data-account-move]:not(:disabled)')?.focus({ preventScroll: true });
        });
        cancelOrder.addEventListener('click', () => {
          grid.append(...savedCards);
          arranging = false;
          updateControls();
          startOrder.focus({ preventScroll: true });
        });
        grid.querySelectorAll('[data-account-move]').forEach(button => button.addEventListener('click', () => {
          const card = button.closest('[data-account-card]');
          if (button.dataset.accountMove === '-1') card.previousElementSibling.before(card);
          else card.nextElementSibling.after(card);
          updateControls();
          (button.disabled ? card.querySelector('[data-account-move]:not(:disabled)') : button)?.focus({ preventScroll: true });
        }));
        saveOrder.addEventListener('click', async () => {
          saving = true;
          updateControls();
          try {
            const ids = [...grid.children].map(card => card.dataset.accountCard);
            await api('/accounts/order', { method: 'PUT', body: { ids } });
            savedCards = [...grid.children];
            arranging = false;
            await reload();
            toastOk('账户顺序已保存');
          } catch (error) {
            toastErr(error.message);
          } finally {
            saving = false;
            updateControls();
            (arranging ? saveOrder : startOrder).focus({ preventScroll: true });
          }
        });
      }
      root.querySelector('[data-account-new]')?.addEventListener('click', () => edit());
      root.querySelectorAll('[data-dip-reserve]').forEach((button) => button.addEventListener('click', () => {
        const a = data.accounts.find((row) => row.id === button.dataset.dipReserve);
        openModal('抄底资金预留', `<form class="sm-trade-form"><p>仅调整普通/策略可用额度，不增加现金或资产。外部券商交易仍可能导致缺口。</p><label>调整后预留余额（${esc(a.currency)}）<input name="amount" type="number" min="0" step="0.01" value="${a.reserved}"></label></form>`, null, async (modal) => {
          const amount = modal.querySelector('[name="amount"]').value;
          await api(`/accounts/${a.id}/dip-reserve`, { method: 'PUT', body: { amount } });
          await refresh(); await reload(); return '预留已更新，账户总现金未改变';
        }, { reload: false });
      }));
      root.querySelectorAll('[data-account-edit]').forEach((b) => b.addEventListener('click', () => edit(data.accounts.find((a) => a.id === b.dataset.accountEdit))));
      root.querySelectorAll('[data-account-assign]').forEach((b) => b.addEventListener('click', async () => {
        const account = data.accounts.find((a) => a.id === b.dataset.accountAssign);
        if (!await confirm(`将所有${account.currency}未归属交易归入“${account.name}”？仅在这些交易实际属于此账户时使用。基准之前的历史交易不会再次扣减现金。`)) return;
        try { const result = await api(`/accounts/${account.id}/assign`, { method: 'POST', body: {} }); await reload(); await refresh(); toastOk(`已归属 ${result.count} 条交易`); } catch (e) { toastErr(e.message); }
      }));
      root.querySelectorAll('[data-account-unlink]').forEach((b) => b.addEventListener('click', async () => {
        if (!await confirm('按当前可用报价（可能延时）把总资产保存为记账余额快照，之后不再自动估值；证券账户仍保留当前现金和持仓。请先核对行情，确认解除？')) return;
        try { await api(`/accounts/${b.dataset.accountUnlink}/unlink`, { method: 'POST', body: {} }); await reload(); await refresh(); } catch (e) { toastErr(e.message); }
      }));
    } catch (e) { toastErr(e.message); }
  };
  const edit = async (account) => {
    let options = [];
    try { options = await api('/accounts/bookkeeping-options'); } catch { /* Unbound accounts do not require bookkeeping permission. */ }
    const form = `<form id="investment-form" class="sm-trade-form">
      <label>账户名称<input name="name" required maxlength="100" value="${esc(account?.name || '')}"></label>
      <label>币种<select name="currency" ${account ? 'disabled' : ''}>${['USD', 'CNY', 'HKD'].map(cur => `<option ${cur === (account?.currency || 'USD') ? 'selected' : ''}>${cur}</option>`).join('')}</select></label>
      <label>绑定记账理财账户<select name="bookkeepingId" ${account?.bookkeepingId ? 'disabled' : ''}></select></label>
      <label>确认当前可用现金<input name="baselineCash" type="number" step="0.01" ${account ? '' : 'required'} placeholder="${account ? '不填写则保持现金基准' : '必须填写，仅可用现金'}"></label>
      <label><input name="confirmed" type="checkbox"> 我确认这里填写的是当前可用现金，不是包含持仓的总资产；核对后以当前时间重建现金基准。</label>
      <p class="hint">首次绑定需填写现金。已有交易需另行确认归属；新交易及资金流水只有在基准之后才影响现金。绑定账户的旧总资产不会推算或覆盖现金。</p></form>`;
    const dialog = openModal(account ? '编辑证券账户／核对现金' : '新增证券资金账户', form, null, async (modal) => {
      const fd = modal._formData || new FormData(modal.querySelector('#investment-form'));
      const value = String(fd.get('baselineCash') || '').trim();
      if (value && !fd.get('confirmed')) throw new Error('请先确认现金口径');
      const body = { name: fd.get('name'), currency: account?.currency || fd.get('currency'), bookkeepingId: account?.bookkeepingId || fd.get('bookkeepingId') || null };
      if (value) body.baselineCash = Number(value);
      await api('/accounts' + (account ? '/' + account.id : ''), { method: account ? 'PUT' : 'POST', body });
      await reload(); await refresh(); return '账户已保存';
    }, { reload: false });
    const select = dialog.querySelector('[name="bookkeepingId"]');
    const updateOptions = () => {
      const cur = account?.currency || dialog.querySelector('[name="currency"]').value;
      select.innerHTML = '<option value="">暂不绑定</option>' + options.filter((a) => a.currency === cur && (!a.balanceSource || a.id === account?.bookkeepingId)).map((a) => `<option value="${a.id}" ${a.id === account?.bookkeepingId ? 'selected' : ''}>${esc(a.group)} / ${esc(a.name)}（旧余额 ${amount(a.balance, a.currency)}，仅供核对）</option>`).join('');
      if (account?.bookkeepingId && !options.some((a) => a.id === account.bookkeepingId)) select.innerHTML += `<option value="${account.bookkeepingId}" selected>${esc(account.bookkeepingName || '已绑定账户')}</option>`;
    };
    dialog.querySelector('[name="currency"]')?.addEventListener('change', updateOptions);
    updateOptions();
  };
  await refresh();
}
