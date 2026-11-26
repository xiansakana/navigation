(function () {
  'use strict';
  const icons = { 餐饮:'◡', 购物:'▱', 交通:'↗', 工资:'▤', 住房:'⌂', 娱乐:'♫', 通讯:'☎', 学习:'▥', 医疗:'✚', 转账:'⇄', 还款:'↩', 借出:'⇢', 收回:'⇠', 余额调整:'✎' };
  window.createBookkeepingEntryList = function ({ $, esc, m, can, transferTypes, getState, openEditor, copyEntry, removeEntry, openDetails }) {
    const entryList=$('entry-list');
    let swipeStart=null, revealedRow=null, suppressSwipeClickUntil=0;
    function revealSwipe(row, direction) {
      revealedRow?.classList.remove('bk-copy-revealed','bk-edit-revealed');
      revealedRow=row;
      row?.classList.add(direction==='copy'?'bk-copy-revealed':'bk-edit-revealed');
    }
    entryList.addEventListener('pointerdown',event=>{
      swipeStart=null;
      const row=event.target.closest('.bk-entry-swipe');
      if(event.pointerType!=='touch' || !row?.querySelector('[data-swipe-action]') || !event.target.closest('[data-entry]'))return;
      swipeStart={row,x:event.clientX,y:event.clientY,id:event.pointerId};
    });
    entryList.addEventListener('pointercancel',()=>{swipeStart=null;});
    entryList.addEventListener('pointerup',event=>{
      if(swipeStart?.id!==event.pointerId)return;
      const {row,x,y}=swipeStart;
      swipeStart=null;
      const dx=event.clientX-x;
      if(Math.abs(dx)<45 || Math.abs(dx)<Math.abs(event.clientY-y)*1.5)return;
      revealSwipe(dx<0 || row.querySelector('[data-copy-entry]')?row:null,dx>0?'copy':'edit');
      suppressSwipeClickUntil=performance.now()+350;
    });
    entryList.addEventListener('click',async event=>{
      const state=getState();
      const action=event.target.closest('[data-swipe-action]');
      if(action){
        const id=action.closest('.bk-entry-swipe').querySelector('[data-entry]').dataset.entry;
        const item=state.entries.find(e=>e.id===id);
        revealSwipe(null);
        if(!item || !can('entries:edit'))return;
        if(action.dataset.swipeAction==='edit')openEditor('entry',item);
        else {
          try {await removeEntry(item);} catch(error) {
            $('error').textContent=error.message;
            $('error').classList.remove('hidden');
          }
        }
        return;
      }
      const copy=event.target.closest('[data-copy-entry]');
      if(copy){revealSwipe(null);copyEntry(state.entries.find(e=>e.id===copy.dataset.copyEntry));return;}
      const button=event.target.closest('[data-entry]');
      if(!button || performance.now()<suppressSwipeClickUntil)return;
      if(revealedRow?.isConnected){revealSwipe(null);return;}
      openDetails(state.entries.find(e=>e.id===button.dataset.entry));
    });

    function render(state, { converted, missing, dayTotals }) {
      $('count').textContent = state.count + ' 笔';
      let lastDay = '';
      const ledgerNote=can('accounts:view') && $('account').value && state.entries.some(e=>e.balanceEstimated)?(state.accounts.find(a=>a.id===$('account').value)?.investment?'<p class="bk-muted bk-ledger-note">证券现金按当前现金、记账流水和证券交收反推。持仓市值见资产页。</p>':'<p class="bk-muted bk-ledger-note">历史余额按当前余额、账单及余额调整反推；截图核对的调整余额按原币显示，其他反推或跨币种估算值标注 ≈。</p>'):'';
      const openEntryId=revealedRow?.querySelector('[data-entry]')?.dataset.entry;
      const openDirection=revealedRow?.classList.contains('bk-copy-revealed')?'copy':'edit';
      $('entry-list').innerHTML = ledgerNote + (state.entries.map(e => {
        const day = e.date.slice(0,10), title = [e.category,e.subcategory].filter(Boolean).join(' · ');
        let heading = '';
        if (day !== lastDay) {
          lastDay=day;
          const total=dayTotals.get(day)||{income:0,expense:0},net=Math.round((total.income-total.expense)*100)/100;
          const daily=missing.length||!converted?'<span>CNY 合计待补齐汇率</span>':'<span class="bk-day-currency">CNY</span><span>收入 '+m(total.income,'CNY')+'</span><span>净支出 '+m(total.expense,'CNY')+'</span><span class="'+(net<0?'bk-expense':'bk-income')+'">结余 '+m(net,'CNY')+'</span>';
          heading='<div class="bk-day" data-day="'+esc(day)+'"><span class="bk-day-date"><time datetime="'+esc(day)+'">'+esc(day)+'</time><span>'+esc(new Date(day+'T12:00:00').toLocaleDateString('zh-CN',{weekday:'long'}))+'</span></span><span class="bk-day-totals" aria-label="当日 CNY 合计">'+daily+'</span></div>';
        }
        const expense = ['支出','已报销'].includes(e.type), transfer = transferTypes.includes(e.type) || e.type === '余额调整';
        const account = [e.accountName, e.toAccountName].filter(Boolean).join(' → ');
        const subtitle = [e.date.slice(11,16), account, e.note || e.tags].filter(Boolean).join(' · ');
        const balance=can('accounts:view') && $('account').value && e.balanceCurrency?'<small class="bk-ledger-balance">'+window.bookkeepingBalanceText(e,m,esc)+'</small>':'';
        const copyable = can('entries:edit') && e.type !== '余额调整';
        const copyAction = copyable ? '<button type="button" class="btn ghost bk-copy-action" data-copy-entry="'+esc(e.id)+'">复制</button>' : '';
        const editActions = can('entries:edit') ? '<div class="bk-swipe-edit-actions"><button type="button" class="btn ghost" data-swipe-action="edit">编辑</button><button type="button" class="btn ghost bk-detail-delete" data-swipe-action="delete">删除</button></div>' : '';
        return heading + '<div class="bk-entry-swipe">' + copyAction + editActions + '<button class="bk-entry" data-entry="' + esc(e.id) + '"><span class="bk-badge">' + esc(icons[e.type] || state.categoryTree?.find(c=>c.kind===(e.type==='收入'?'income':'expense') && c.name===(e.subcategory||e.category) && (e.subcategory?state.categoryTree.some(p=>p.id===c.parentId && p.name===e.category):!c.parentId))?.icon || icons[e.category] || '◈') + '</span><span class="bk-entry-main"><strong>' + esc(title) + '</strong><p>' + esc(subtitle) + '</p>' + (e.location ? '<p>⌖ ' + esc(e.location) + '</p>' : '') + '</span><span class="bk-entry-amount ' + (expense?'bk-expense':transfer?'bk-transfer':'bk-income') + '">' + m(expense?-e.amount:e.amount,e.currency) + (e.currency!=='CNY'?'<small>'+ (e.fxMissing?'CNY 等效待获取': '≈ '+m(expense?-e.cnyAmount:e.cnyAmount,'CNY')+' · 汇率日 '+esc(e.rateDate))+'</small>':'') + '<small>' + esc(e.type) + (e.historical?' · 历史':'') + '</small>' + balance + '</span></button></div>';
      }).join('') || '<div class="bk-empty">还没有符合条件的账单<br>记下第一笔，或从 iCost 导入历史记录。</div>');
      const openEntry=openEntryId && [...$('entry-list').querySelectorAll('[data-entry]')].find(button=>button.dataset.entry===openEntryId);
      revealSwipe(openEntry ? openEntry.closest('.bk-entry-swipe') : null,openDirection);
      $('more').classList.toggle('hidden', state.entries.length >= state.count);
    }

    return { render };
  };
})();
