(function () {
  'use strict';
  window.createBookkeepingScope=function({$,esc,can,write,load,capturePosition}) {
    const host=document.createElement('section');host.id='analysis-scope';host.className='bk-analysis-scope hidden';$('filters').before(host);
    let tab='entries',scope={options:[],enabled:false,selectedAccountIds:[]},draft=null,revision=0,pending=Promise.resolve(),error='';
    function visibility(){host.classList.toggle('hidden',!can('accounts:view')||!['stats','accounts'].includes(tab)||!scope.options.length);}
    function render(value=scope) {
      scope=value||scope;
      const open=host.querySelector('details')?.open,focused=host.contains(document.activeElement)?(document.activeElement.id==='exclude-social-accounts'?'master':document.activeElement.getAttribute('data-scope-account')):null;
      const enabled=draft?.enabled??scope.enabled, selected=new Set(draft?.accountIds??scope.selectedAccountIds);
      host.innerHTML='<label class="bk-check"><input type="checkbox" id="exclude-social-accounts" '+(enabled?'checked':'')+'>排除社保公积金等账户</label><details'+(open?' open':'')+'><summary>选择排除账户</summary><div class="bk-scope-options">'+scope.options.map(a=>'<label class="bk-check"><input type="checkbox" data-scope-account="'+esc(a.id)+'" '+(selected.has(a.id)?'checked':'')+' '+(!enabled?'disabled':'')+'>'+esc(a.name)+'</label>').join('')+'</div></details><p class="bk-muted">'+(enabled?'已排除 '+selected.size+' 个账户；统一用于统计和资产看板、走势。':'当前不排除，包含全部账户。')+' 明细原始记录不变，统计穿透时沿用此筛选。</p><p class="bk-error" role="alert">'+esc(error)+'</p>';
      if(focused)(focused==='master'?$('exclude-social-accounts'):host.querySelector('[data-scope-account="'+focused+'"]'))?.focus({preventScroll:true});
      visibility();
    }
    host.addEventListener('change',()=>{
      const enabled=$('exclude-social-accounts').checked, ids=[...host.querySelectorAll('[data-scope-account]:checked')].map(e=>e.dataset.scopeAccount);
      const value={enabled,accountIds:ids.length===scope.options.length?null:ids};draft={enabled,accountIds:ids};error='';
      host.querySelectorAll('[data-scope-account]').forEach(input=>input.disabled=!enabled);
      const ticket=++revision,restore=capturePosition();host.setAttribute('aria-busy','true');
      pending=pending.catch(()=>{}).then(()=>write('/analysis-scope',value,'PUT'));
      pending.then(async()=>{
        if(ticket!==revision)return;draft=null;await load();restore?.();host.setAttribute('aria-busy','false');
      }).catch(async e=>{
        if(ticket!==revision)return;draft=null;error=e.message;await load();render();host.setAttribute('aria-busy','false');
      });
    });
    return {render,setTab(name){tab=name;visibility();}};
  };
})();
