(function () {
  'use strict';
  const groups = {
    category:{label:'类型与分类',fields:['type','category','subcategory']},
    book:{label:'账本',fields:['book']},date:{label:'时间',fields:['date']},
    amount:{label:'金额',fields:['amount']},currency:{label:'货币',fields:['currency']},
    account:{label:'账户与到账金额',fields:['accountId','currency','toAccountId','toAmount']},
    note:{label:'备注',fields:['note']},tags:{label:'标签',fields:['tags']},
    location:{label:'位置',fields:['location']},fee:{label:'手续费',fields:['fee']},
    refund:{label:'退款信息',fields:['refund']},discount:{label:'优惠信息',fields:['discount']}
  };
  window.bookkeepingDetailGroups = groups;
  window.createBookkeepingDetails = function ({$,esc,m,can,api,getState,tab,openEditor,remove}) {
    let current = null, generation = 0;
    const row = (key,label,value,extra='') => '<button type="button" class="bk-detail-row" data-detail-field="'+key+'" '+(!can('entries:edit')?'disabled':'')+'><span>'+esc(label)+'</span><span class="bk-detail-value">'+value+(extra?'<small>'+extra+'</small>':'')+'</span>'+(can('entries:edit')?'<span class="bk-detail-arrow" aria-hidden="true">›</span>':'')+'</button>';
    function render() {
      if (!current) return;
      const e=current,transfer=['转账','还款','借出','收回'].includes(e.type),expense=['支出','已报销'].includes(e.type);
      const category=[e.category,e.subcategory].filter(Boolean).join(' · ');
      const equivalent=e.currency!=='CNY'?(e.fxMissing?'CNY 等效待获取':'≈ '+m(e.cnyAmount,'CNY')):'';
      const balance=can('accounts:view')&&e.balanceCurrency?'<p class="bk-muted">本笔后余额 '+(e.balanceAfter==null?'待核对':(e.balanceEstimated?'≈ ':'')+m(e.balanceAfter,e.balanceCurrency))+'</p>':'';
      $('entry-detail-view').innerHTML='<div class="bk-detail-heading"><button class="btn ghost" data-detail-action="back">← 返回明细</button><h2 tabindex="-1" id="entry-detail-title">账单详情</h2></div><article class="bk-panel bk-detail-hero"><p>'+esc(e.type)+' · '+esc(category)+'</p><strong class="'+(expense?'bk-expense':transfer?'bk-transfer':'bk-income')+'">'+m(expense?-e.amount:e.amount,e.currency)+'</strong>'+(equivalent?'<p class="bk-muted">'+equivalent+'</p>':'')+balance+'</article>'+
        (can('entries:edit')?'<div class="bk-detail-actions"><details><summary class="btn ghost">编辑</summary><div class="bk-detail-edit-menu">'+Object.entries(groups).map(([key,g])=>'<button class="btn ghost" data-detail-field="'+key+'">'+esc(g.label)+'</button>').join('')+'</div></details><button class="btn ghost bk-detail-delete" data-detail-action="delete">删除</button></div>':'')+
        '<div class="bk-detail-grid"><article class="bk-panel bk-detail-card">'+row('category','类型与分类',esc(e.type+' · '+category))+row('book','账本',esc(e.book))+row('date','时间',esc(e.date.replace('T',' ')))+row('amount','金额',m(e.amount,e.currency),equivalent)+row('currency','货币',esc(e.currency),e.historicalRate?'1 '+esc(e.currency)+' = '+esc(e.historicalRate)+' CNY · 汇率日 '+esc(e.rateDate):'')+row('account',transfer?'转出 → 转入账户':'账户',esc([e.accountName,e.toAccountName].filter(Boolean).join(' → ')||'未关联账户'),transfer&&e.toAmount!=null?'到账 '+m(e.toAmount,getState()?.accounts.find(a=>a.id===e.toAccountId)?.currency||e.currency):'')+'</article><article class="bk-panel bk-detail-card">'+row('note','备注',esc(e.note||'无'))+row('tags','标签',esc(e.tags||'无'))+row('location','位置',esc(e.location||'无'))+row('fee','手续费',m(e.fee||0,e.currency))+row('refund','退款信息（辅助）',m(e.refund||0,e.currency))+row('discount','优惠信息（辅助）',m(e.discount||0,e.currency))+'</article></div><p class="bk-muted">'+(can('entries:edit')?'点击对应项目即可单独修改。':'当前为只读模式。')+(e.historical?' 这是历史导入记录，修改不会重复影响账户余额基准。':'')+'</p><p id="detail-error" class="bk-error" role="alert"></p>';
    }
    function open(entry) {
      if (!entry) return;
      generation++;current=entry;render();tab('entry-detail');$('entry-detail-title').focus({preventScroll:true});$('entry-detail-view').scrollIntoView({block:'start'});
    }
    async function refresh(id) {
      const ticket=++generation;
      const data=await api('/entries/'+encodeURIComponent(id));
      if(ticket!==generation || current?.id!==id)return;
      current={...getState()?.entries.find(e=>e.id===id),...data.entry};render();
    }
    $('entry-detail-view').addEventListener('click',async event=>{
      const field=event.target.closest('[data-detail-field]');
      if(field && can('entries:edit') && groups[field.dataset.detailField]) {
        $('entry-detail-view').querySelectorAll('details[open]').forEach(d=>d.open=false);
        openEditor('entry',current,field.dataset.detailField);return;
      }
      const action=event.target.closest('[data-detail-action]')?.dataset.detailAction;
      if(action==='back'){generation++;tab('entries');}
      if(action==='delete' && can('entries:edit')) {
        try {if(await remove(current)){generation++;current=null;tab('entries');}}catch(error){$('detail-error').textContent=error.message;}
      }
    });
    return {open,refresh};
  };
})();
