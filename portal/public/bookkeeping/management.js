(function () {
  'use strict';
  window.createBookkeepingManagement = function ({ $, esc, can, api, write, load, field, select, options, getState, openEditor }) {
    document.body.insertAdjacentHTML('beforeend','<dialog id="manager-editor" class="bk-dialog"><form id="manager-form"><div class="bk-panel-heading"><h2 id="manager-title"></h2><button type="button" class="btn ghost" id="manager-close" aria-label="关闭管理窗口">✕</button></div><div id="manager-fields" class="bk-form-grid"></div><p id="manager-error" class="bk-error" role="alert"></p><div class="bk-form-actions"><button class="btn primary" id="manager-save">保存</button></div></form></dialog>');
    let editing, busy = false;
    const state = () => getState();
    const categories = () => state().categoryTree || [];
    const groups = () => state().accountGroups || [];
    const kindOf = type => type==='收入'?'income':['支出','已报销','退款入账','报销入账'].includes(type)?'expense':null;
    const button = (action,id,label) => '<button type="button" class="btn ghost" data-manage="'+action+'" data-id="'+id+'">'+label+'</button>';
    function categoryRow(c) {
      return '<div class="bk-catalog-row"><div><strong>'+esc(c.icon)+' '+esc(c.name)+'</strong><small class="bk-muted">'+c.count+' 笔'+(c.archived?' · 已停用':'')+'</small></div>'+(can('categories:edit')?'<div class="bk-manage-actions">'+button('edit-category',c.id,'编辑')+(!c.parentId?button('child',c.id,'＋ 二级'):'')+button('toggle-category',c.id,c.archived?'启用':'停用')+button('category-up',c.id,'↑')+button('category-down',c.id,'↓')+button('merge-category',c.id,'合并')+(!c.count?button('delete-category',c.id,'删除'):'')+'</div>':'')+'</div>';
    }
    function render() {
      const all = categories(), visible = c => !c.archived || $('show-archived-categories').checked;
      $('catalog-list').innerHTML = all.filter(c=>!c.parentId && c.kind===$('catalog-kind').value && visible(c)).map(c=>'<article class="bk-panel">'+categoryRow(c)+'<div class="bk-subcategories">'+all.filter(s=>s.parentId===c.id && visible(s)).map(categoryRow).join('')+'</div></article>').join('') || '<p class="bk-empty">暂无分类，可新增一级分类。</p>';
      $('group-manager').innerHTML = '<div class="bk-panel-heading"><h3>资产分组</h3>'+button('new-group','','＋ 分组')+'</div>'+groups().map(g=>'<div class="bk-catalog-row"><strong>'+esc(g.name)+' <small class="bk-muted">'+g.count+' 个账户</small></strong><div class="bk-manage-actions">'+button('edit-group',g.id,'编辑')+button('group-up',g.id,'↑')+button('group-down',g.id,'↓')+button('merge-group',g.id,'合并')+(!g.count?button('delete-group',g.id,'删除'):'')+'</div></div>').join('')+'<p class="bk-muted">分组合并只移动账户，不改变余额或账单。</p>';
    }
    function open(mode,item={}) {
      editing={mode,item}; $('manager-error').textContent=''; $('manager-save').disabled=false;
      let html='', title='';
      if(mode==='category') {
        title=item.id?'编辑分类':'新增分类';
        html=field('name','分类名称',item.name||'','required maxlength="100"')+field('icon','分类图标',item.icon||'◈','maxlength="20"');
        if(item.parentId) html+=select('parentId','所属一级分类',categories().filter(c=>!c.parentId && c.kind===item.kind && !c.archived).map(c=>({value:c.id,label:c.name})),item.parentId);
        html+='<p class="bk-form-hint">重命名或移动二级分类会同步更新关联账单；金额和账户余额保持不变。</p>';
      } else if(mode==='group') {title=item.id?'编辑分组':'新增分组';html=field('name','分组名称',item.name||'','required maxlength="100"');}
      else {
        const cat=mode==='merge-category'; title='合并 '+item.name;
        const targets=cat?categories().filter(c=>c.id!==item.id && c.kind===item.kind && !!c.parentId===!!item.parentId && !c.archived && (!c.parentId || !categories().find(p=>p.id===c.parentId)?.archived)):groups().filter(g=>g.id!==item.id);
        if(!targets.length){window.portalToast?.error('请先新增可合并的目标');return;}
        html=select('targetId','合并到',targets.map(c=>({value:c.id,label:(c.parentId?categories().find(p=>p.id===c.parentId).name+' / ':'')+c.name})),targets[0].id)+'<p class="bk-form-hint">保存后原'+(cat?'分类及其关联账单将归入目标分类':'分组内账户将归入目标分组')+'，原目录移除。请核对目标后保存。</p>';
      }
      $('manager-title').textContent=title; $('manager-fields').innerHTML=html; $('manager-editor').showModal();
    }
    async function perform(fn) {
      if(busy)return;busy=true;
      try {await fn();await load();window.portalToast?.success('已保存');}catch(e){$('error').textContent=e.message;$('error').classList.remove('hidden');}finally{busy=false;}
    }
    async function move(list,item,delta,path,siblings=list) {
      const index=siblings.findIndex(c=>c.id===item.id), other=siblings[index+delta];if(!other)return;
      const ids=list.map(c=>c.id), i=ids.indexOf(item.id), j=ids.indexOf(other.id);[ids[i],ids[j]]=[ids[j],ids[i]];
      await write(path,{ids},'PUT');
    }
    async function action(event) {
      const b=event.target.closest('[data-manage]');if(!b)return;
      const a=b.dataset.manage, id=b.dataset.id;
      const isCategory=a.includes('category')||a==='child', item=(isCategory?categories():groups()).find(c=>c.id===id);
      if(!can(isCategory?'categories:edit':'accounts:edit'))return;
      if(a==='new-group')return open('group');
      if(a==='edit-group')return open('group',item);
      if(a==='edit-category')return open('category',item);
      if(a==='child')return open('category',{parentId:id,kind:item.kind});
      if(a.startsWith('merge-'))return open(a,item);
      await perform(async()=>{
        if(a==='toggle-category')await write('/categories/'+id,{...item,archived:!item.archived},'PUT');
        else if(a.startsWith('delete-')){if(!window.confirm('删除未使用的'+(isCategory?'分类（包括其二级分类）':'分组')+'？'))return;await api('/'+(isCategory?'categories':'groups')+'/'+id,{method:'DELETE'});}
        else await move(isCategory?categories():groups(),item,a.endsWith('up')?-1:1,'/'+(isCategory?'categories':'groups')+'/order',isCategory?categories().filter(c=>c.kind===item.kind && c.parentId===item.parentId):groups());
      });
    }
    $('manager-form').onsubmit=async e=>{
      e.preventDefault();$('manager-save').disabled=true;
      const {mode,item}=editing, input=Object.fromEntries(new FormData(e.target));
      try {
        if(mode.startsWith('merge-'))await write('/'+(mode==='merge-category'?'categories':'groups')+'/'+item.id+'/merge',input);
        else await write('/'+(mode==='category'?'categories':'groups')+(item.id?'/'+item.id:''),mode==='category'?{...item,...input,kind:item.kind||$('catalog-kind').value}:input,item.id?'PUT':'POST');
        await load();$('manager-editor').close();window.portalToast?.success('已保存');
      }catch(err){$('manager-error').textContent=err.message;}finally{$('manager-save').disabled=false;}
    };
    $('manager-close').onclick=()=>$('manager-editor').close();
    $('add-category').onclick=()=>open('category',{kind:$('catalog-kind').value});
    $('catalog-list').onclick=action;$('group-manager').onclick=action;
    $('catalog-kind').onchange=render;$('show-archived-categories').onchange=render;
    $('manage-groups').onclick=()=>$('group-manager').classList.toggle('hidden');
    $('asset-group').onchange=()=>load();$('show-archived-accounts').onchange=()=>load();
    let timer;$('asset-search').oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>load(),200);};
    $('account-groups').addEventListener('click',e=>{
      const b=e.target.closest('[data-asset-action]');if(!b)return;
      const item=state().accounts.find(a=>a.id===b.dataset.id), action=b.dataset.assetAction;
      if(action==='repay'){if(can('entries:edit'))openEditor('entry',{type:'还款',toAccountId:item.id,currency:item.currency,category:'还款',amount:Math.max(0,-item.balance)});return;}
      if(!can('accounts:edit'))return;
      perform(async()=>{
        if(action==='archive')await write('/accounts/'+item.id+'/archive',{archived:!item.archived});
        else await move(state().accounts,item,action==='up'?-1:1,'/accounts/order',state().accounts.filter(a=>a.group===item.group));
      });
    });
    function accountActions(a) {
      return '<button data-asset-action="archive" data-id="'+a.id+'">'+(a.archived?'恢复':'归档')+'</button><button data-asset-action="up" data-id="'+a.id+'" aria-label="上移 '+esc(a.name)+'">↑</button><button data-asset-action="down" data-id="'+a.id+'" aria-label="下移 '+esc(a.name)+'">↓</button>'+(!a.archived && a.accountType==='信用卡' && can('entries:edit')?'<button data-asset-action="repay" data-id="'+a.id+'">还款</button>':'');
    }
    function bindCategoryPicker(form,item) {
      const primary=form.elements.category, sub=form.elements.subcategory, type=form.elements.type;
      function updateSub(initial=false) {
        const root=categories().find(c=>c.kind===kindOf(type.value) && !c.parentId && c.name===primary.value);
        const selected=initial?item.subcategory:sub.value;
        sub.innerHTML=options(categories().filter(c=>c.parentId===root?.id && (!c.archived || (item.id && item.subcategory===c.name && item.category===primary.value))).map(c=>c.name),selected,'无二级分类');
      }
      function update(initial=false) {
        const kind=kindOf(type.value), selected=initial?item.category:primary.value;
        const list=kind?categories().filter(c=>c.kind===kind && !c.parentId && (!c.archived || (item.id && kindOf(item.type)===kind && c.name===item.category))).map(c=>c.name):(item.id && item.type===type.value && item.category?[...new Set([item.category,type.value])]:[type.value]);
        primary.innerHTML=options(list,selected); primary.required=true; updateSub(initial);
      }
      primary.onchange=()=>updateSub();type.addEventListener('change',()=>update());update(true);
    }
    return {render,accountActions,bindCategoryPicker};
  };
})();
