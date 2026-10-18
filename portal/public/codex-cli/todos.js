(() => {
  const $=id=>document.getElementById(id),labels={pending:'等待执行',waiting_quota:'等待额度',paused:'已暂停',queued:'排队中',running:'执行中',succeeded:'已完成',failed:'需检查',cancelled:'已取消'};
  let state=null,catalog=null,editing='',formRequest='',loading=null,mutating=false,lastRender='';
  const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
  const time=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'等待下次检查';
  const notice=(text,error=false)=>{$('todo-notice').textContent=text;$('todo-notice').classList.toggle('error',error);};
  async function api(path='',method='GET',body){
    const response=await fetch('/api/codex-cli/todos'+path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(response.redirected&&response.url.includes('/login')){location.assign('/login/');throw new Error('请先登录');}
    const data=await response.json();if(!response.ok||!data.ok)throw Object.assign(new Error(data.error || '请求失败'),{status:response.status});return data;
  }
  function choices(select,items,value=''){select.replaceChildren(...items.map(item=>new Option(item.label,item.value)));select.value=value;if(select.selectedIndex<0)select.selectedIndex=0;}
  function efforts(value=''){
    const model=catalog?.models.find(m=>m.id===($('todo-model').value || catalog.qqDefaults.model));
    choices($('todo-effort'),[{value:'',label:'默认'},...(model?.efforts || []).map(value=>({value,label:value}))],value);
  }
  function conversations(value=''){
    choices($('todo-conversation'),[{value:'',label:'执行时新建独立会话'},...(state?.conversations || []).filter(c=>c.project===$('todo-project').value).map(c=>({value:c.id,label:c.title}))],value);
  }
  async function action(row,name,method='POST',body={}){
    if(mutating)return;mutating=true;render();
    try{await api('/'+row.id+(name?'/'+name:''),method,body);notice(name==='pause'?'已暂停，正在执行的任务将停止。':name==='resume'?'已启用，额度可用时自动执行。':'已保存。');await load(true);}
    catch(error){notice(error.message,true);}finally{mutating=false;render();}
  }
  function button(text,callback){const node=el('button',text,'btn ghost');node.type='button';node.disabled=mutating;node.onclick=callback;return node;}
  function render(){
    if(!state)return;
    const p=state.permissions,filter=$('todo-filter').value;
    const snapshot=JSON.stringify([state.todos,p,filter,mutating]);if(snapshot===lastRender)return;lastRender=snapshot;
    const expanded=new Set([...$('todo-list').querySelectorAll('.todo-card')].filter(card=>card.querySelector('details')?.open).map(card=>card.dataset.id));
    const rows=state.todos.filter(row=>filter==='all'||(filter==='done'?row.state==='succeeded':!['succeeded','cancelled'].includes(row.state)));
    const count=key=>state.todos.filter(row=>key.includes(row.state)).length;
    $('todo-summary').textContent=`${count(['pending','waiting_quota','paused'])} 条待办 · ${count(['queued','running'])} 条执行中 · ${count(['succeeded'])} 条完成 · ${count(['failed'])} 条需检查`;
    $('todo-new').hidden=!p.edit;$('todo-new').disabled=mutating;
    const cards=rows.map((row,index)=>{
      const card=el('article',undefined,'todo-card'),heading=el('div',undefined,'todo-card-heading'),info=el('div'),status=el('span',row.state==='paused'&&['queued','running'].includes(row.jobState)?'正在停止':labels[row.state],'todo-state state-'+row.state);
      card.dataset.id=row.id;info.append(el('small',String(index+1).padStart(2,'0')+' / '+row.project,'todo-number'),el('h2',row.title));heading.append(info,status);card.append(heading);
      const details=el('details',undefined,'todo-instruction');details.open=expanded.has(row.id);details.append(el('summary','查看指令'),el('p',row.prompt));card.append(details);
      card.append(el('p',(row.runtime.model || '执行时继承默认模型')+' · '+(row.runtime.effort || '默认强度')+(row.attempts?' · 已执行 '+row.attempts+' 轮':''),'todo-runtime'));
      if(row.note)card.append(el('p',row.note,'todo-note'));
      if(row.state==='waiting_quota')card.append(el('p',(row.resetAt?'预计重置：'+time(row.resetAt)+' · ':'')+'下次复查：'+time(row.nextCheckAt)+'（北京时间）','todo-schedule'));
      const actions=el('div',undefined,'todo-actions'),active=['queued','running'].includes(row.jobState),editable=!row.jobId&&['pending','waiting_quota','paused'].includes(row.state);
      if(p.order&&['pending','waiting_quota','paused'].includes(row.state)){
        const up=button('↑ 上移',()=>action(row,'move','POST',{direction:'up'})),down=button('↓ 下移',()=>action(row,'move','POST',{direction:'down'}));up.setAttribute('aria-label','上移 '+row.title);down.setAttribute('aria-label','下移 '+row.title);actions.append(up,down);
      }
      if(p.edit&&editable)actions.append(button('编辑',()=>open(row)));
      if(p.run&&['paused','failed'].includes(row.state)&&!active)actions.append(button(row.state==='failed'?'重试':'启用自动执行',()=>action(row,'resume')));
      if(p.stop&&['pending','waiting_quota','queued','running','failed'].includes(row.state))actions.append(button(row.state==='failed'?'暂停并跳过':'暂停',()=>action(row,'pause')));
      if(p.viewConversation&&row.conversationId)actions.append(button('查看会话',()=>document.dispatchEvent(new CustomEvent('codex-open-conversation',{detail:row.conversationId}))));
      if(p.edit&&!active&&!['queued','running'].includes(row.state))actions.append(button('删除',()=>action(row,'','DELETE')));
      card.append(actions);return card;
    });
    if(!cards.length){const empty=el('div',undefined,'todo-empty');empty.append(el('h2',filter==='done'?'还没有已完成的待办':'把下一步安排在这里'),el('p','保存指令、选择模型，启用后由服务器等待额度并执行。'));cards.push(empty);}
    $('todo-list').replaceChildren(...cards);
  }
  async function load(force=false){
    if(loading){await loading;if(!force)return;}
    const request=(async()=>{
      try{state=await api();$('todos-tab').hidden=false;render();if(!state.enabled)notice('Codex 总开关未启用，待办会保留，启用后才开始自动执行。');}
      catch(error){if(!state||error.status===403){state=null;$('todos-tab').hidden=true;$('todo-new').hidden=true;$('todo-list').replaceChildren();lastRender='';if(!$('todos-view').hidden)$('settings-tab').click();}notice(error.message,true);}
    })();loading=request;
    try{await request;}finally{if(loading===request)loading=null;}
  }
  function open(row){
    editing=row?.id || '';formRequest=crypto.randomUUID();$('todo-dialog-title').textContent=editing?'编辑待办':'新增待办';$('todo-form-error').textContent='';
    $('todo-title').value=row?.title || '';$('todo-prompt').value=row?.prompt || '';
    choices($('todo-project'),state.projects.map(value=>({value,label:value})),row?.project || state.projects[0]);conversations(row?.conversationId);
    choices($('todo-model'),[{value:'',label:'执行时继承默认模型'},...(catalog?.models || []).map(m=>({value:m.id,label:m.id}))],row?.runtime.model || '');efforts(row?.runtime.effort);
    $('todo-auto').disabled=!state.permissions.run;$('todo-auto').checked=state.permissions.run&&(row?row.state!=='paused':true);$('todo-dialog').showModal();
  }
  $('todo-new').onclick=()=>open();$('todo-cancel').onclick=()=>$('todo-dialog').close();$('todo-project').onchange=()=>conversations();$('todo-model').onchange=()=>efforts();$('todo-filter').onchange=render;
  $('todo-form').onsubmit=async event=>{
    event.preventDefault();$('todo-save').disabled=true;$('todo-form-error').textContent='';
    try{
      await api(editing?'/'+editing:'',editing?'PATCH':'POST',{title:$('todo-title').value,project:$('todo-project').value,prompt:$('todo-prompt').value,conversationId:$('todo-conversation').value,model:$('todo-model').value,effort:$('todo-effort').value,autoRun:$('todo-auto').checked,requestId:formRequest});
      $('todo-dialog').close();notice('待办已保存。');await load(true);
    }catch(error){$('todo-form-error').textContent=error.message;}finally{$('todo-save').disabled=false;}
  };
  document.addEventListener('codex-status',event=>{catalog=event.detail;});
  document.addEventListener('codex-view',event=>{if(event.detail==='todos')void load();});
  setInterval(()=>{if(!document.hidden&&!$('todos-view').hidden&&!mutating)void load();},5000);
  void load();
})();
