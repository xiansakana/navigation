export function createBookkeepingEntryList({ $, esc, m, money, can, mountEntries, getState, openEditor, copyEntry, removeEntry, openDetails }) {
  const entryList = $('entry-list');
  let swipeStart = null, suppressSwipeClickUntil = 0, view;

  entryList.addEventListener('pointerdown', event => {
    swipeStart = null;
    const row = event.target.closest('.bk-entry-swipe');
    if (event.pointerType !== 'touch' || !row?.querySelector('[data-swipe-action]') || !event.target.closest('[data-entry]')) return;
    swipeStart = { row, x: event.clientX, y: event.clientY, id: event.pointerId };
  });
  entryList.addEventListener('pointercancel', () => { swipeStart = null; });
  entryList.addEventListener('pointerup', event => {
    if (swipeStart?.id !== event.pointerId) return;
    const { row, x, y } = swipeStart;
    swipeStart = null;
    const dx = event.clientX - x;
    if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(event.clientY - y) * 1.5) return;
    const target = row?.querySelector('[data-entry]')?.dataset.entry || '';
    if (dx < 0) view?.reveal(target, 'edit');
    else if (row?.querySelector('[data-copy-entry]')) view?.reveal(target, 'copy');
    else view?.reveal('', 'edit');
    suppressSwipeClickUntil = performance.now() + 350;
  });
  entryList.addEventListener('click', async event => {
    const state = getState();
    const action = event.target.closest('[data-swipe-action]');
    if (action) {
      const id = action.closest('.bk-entry-swipe').querySelector('[data-entry]').dataset.entry;
      const item = state.entries.find(entry => entry.id === id);
      view?.reveal('', 'edit');
      if (!item || !can('entries:edit')) return;
      if (action.dataset.swipeAction === 'edit') openEditor('entry', item);
      else {
        try { await removeEntry(item); } catch (error) {
          $('error').textContent = error.message;
          $('error').classList.remove('hidden');
        }
      }
      return;
    }
    const copy = event.target.closest('[data-copy-entry]');
    if (copy) { view?.reveal('', 'edit'); copyEntry(state.entries.find(entry => entry.id === copy.dataset.copyEntry)); return; }
    const button = event.target.closest('[data-entry]');
    if (!button || performance.now() < suppressSwipeClickUntil) return;
    if (view?.revealedId()) { view.reveal('', 'edit'); return; }
    openDetails(state.entries.find(entry => entry.id === button.dataset.entry));
  });

  function render(state, { converted, missing, dayTotals }) {
    $('count').textContent = state.count + ' 笔';
    const ledgerNote = can('accounts:view') && $('account').value && state.entries.some(entry => entry.balanceEstimated)
      ? (state.accounts.find(account => account.id == $('account').value)?.investment
        ? '<p class="bk-muted bk-ledger-note">证券现金按当前现金、记账流水和证券交收反推。持仓市值见资产页。</p>'
        : '<p class="bk-muted bk-ledger-note">历史余额按当前余额、账单及余额调整反推；截图核对的调整余额按原币显示，其他反推或跨币种估算值标注 ≈。</p>')
      : '';
    view ??= mountEntries(entryList, { money, balanceText: entry => window.bookkeepingBalanceText(entry, m, esc) });
    view.render({
      entries: state.entries, dayTotals, converted, missing, ledgerNote,
      accountId: $('account').value, canViewAccounts: can('accounts:view'), canEdit: can('entries:edit'),
      categoryTree: state.categoryTree
    });
    $('more').classList.toggle('hidden', state.entries.length >= state.count);
  }

  return { render };
}
