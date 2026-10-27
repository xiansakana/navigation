(function () {
  'use strict';
  window.createBookkeepingPeriodDock = function ({ $, can }) {
    const selector=$('period-selector'), shell=document.querySelector('.bk-shell');
    const dock=document.createElement('nav');
    dock.id='period-dock';dock.className='bk-period-dock hidden';dock.setAttribute('aria-label','图表时间筛选');
    dock.innerHTML='<button type="button" class="btn ghost" data-period-step="prev" aria-label="上一时间段">←</button><button type="button" class="bk-period-dock-caption" aria-haspopup="dialog" aria-controls="period-dock-editor"><span></span><small>选择时间 ▾</small></button><button type="button" class="btn ghost" data-period-step="next" aria-label="下一时间段">→</button>';
    shell.append(dock);
    const dialog=document.createElement('dialog');
    dialog.id='period-dock-editor';dialog.className='bk-dialog bk-period-dock-editor';dialog.setAttribute('aria-labelledby','period-dock-title');
    dialog.innerHTML='<div class="bk-panel-heading"><h2 id="period-dock-title">选择时间</h2><button type="button" class="btn ghost" aria-label="关闭时间选择">✕</button></div><div class="bk-period-dock-fields"></div><div class="bk-form-actions"><button type="button" class="btn primary">完成</button></div>';
    document.body.append(dialog);
    let activeTab='entries', placeholder=null, frame=0;
    const allowed=()=>activeTab==='stats'?can('analysis:view'):activeTab==='accounts'&&can('accounts:view');
    function sync() {
      const top=Math.max(0,document.querySelector('.navbar')?.getBoundingClientRect().bottom||0);
      const slot=placeholder||selector, visible=allowed() && slot.getBoundingClientRect().bottom<=top;
      dock.classList.toggle('hidden',!visible);
      if(!visible)return;
      const rect=shell.getBoundingClientRect(),style=getComputedStyle(shell);
      dock.style.top=top+'px';dock.style.left=(rect.left+parseFloat(style.paddingLeft||0))+'px';
      dock.style.width=Math.max(0,rect.width-parseFloat(style.paddingLeft||0)-parseFloat(style.paddingRight||0))+'px';
      dock.querySelector('.bk-period-dock-caption span').textContent=$('period-caption').textContent;
      for(const step of ['prev','next'])dock.querySelector('[data-period-step="'+step+'"]').disabled=$('period-'+step).disabled;
    }
    function schedule() {if(!frame)frame=window.requestAnimationFrame(()=>{frame=0;sync();});}
    function capturePosition() {
      if(!allowed() || dock.classList.contains('hidden'))return null;
      const tab=activeTab, threshold=dock.getBoundingClientRect().bottom;
      const panel=[...$(tab+'-view').querySelectorAll(':scope > article,:scope > .bk-two-col,:scope > .bk-account-grid')]
        .map(el=>{const r=el.getBoundingClientRect();return {el,visible:el.getClientRects().length?Math.max(0,Math.min(r.bottom,window.innerHeight)-Math.max(r.top,threshold)):0};})
        .filter(item=>item.visible>0).sort((a,b)=>b.visible-a.visible)[0]?.el;
      if(!panel)return null;
      const top=panel.getBoundingClientRect().top;
      return ()=>window.requestAnimationFrame(()=>{
        if(tab!==activeTab || !panel.isConnected || !panel.getClientRects().length)return;
        window.scrollTo({top:Math.max(0,window.scrollY+panel.getBoundingClientRect().top-top),behavior:'instant'});schedule();
      });
    }
    dock.addEventListener('click',event=>{
      if(!allowed())return;
      const step=event.target.closest('[data-period-step]')?.dataset.periodStep;
      if(step){$('period-'+step).click();return;}
      if(!event.target.closest('.bk-period-dock-caption') || dialog.open)return;
      // Move the existing controls, retaining their listeners, values and saved preferences.
      placeholder=document.createElement('div');placeholder.style.height=selector.getBoundingClientRect().height+'px';
      const style=getComputedStyle(selector);placeholder.style.marginTop=style.marginTop;placeholder.style.marginBottom=style.marginBottom;
      selector.replaceWith(placeholder);dialog.querySelector('.bk-period-dock-fields').append(selector);dialog.showModal();
    });
    dialog.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>dialog.close()));
    dialog.addEventListener('click',event=>{
      const r=dialog.getBoundingClientRect();
      if(event.target===dialog && (event.clientX<r.left || event.clientX>r.right || event.clientY<r.top || event.clientY>r.bottom))dialog.close();
    });
    dialog.addEventListener('close',()=>{
      if(!placeholder)return;
      const restore=capturePosition();placeholder.replaceWith(selector);placeholder=null;restore?.();schedule();
    });
    new MutationObserver(schedule).observe($('period-caption'),{childList:true,characterData:true,subtree:true});
    window.addEventListener('scroll',schedule,{passive:true});window.addEventListener('resize',schedule);window.addEventListener('portal-layout-change',schedule);
    return {capturePosition,setTab(name){activeTab=name;if(dialog.open)dialog.close();sync();},setLoading(value){dock.setAttribute('aria-busy',String(value));dock.querySelector('.bk-period-dock-caption small').textContent=value?'更新中…':'选择时间 ▾';schedule();}};
  };
})();
