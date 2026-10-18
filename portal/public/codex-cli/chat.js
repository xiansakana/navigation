(() => {
  const $=id=>document.getElementById(id),labels={queued:'排队中',running:'执行中',succeeded:'已完成',failed:'失败',cancelled:'已停止',history:'历史记录'};
  let list=[],projects=[],permissions={},selected='',current=null,jobs=[],catalog=null,enabled=false,sending=false,reading=false,lastSnapshot='',retry=null;
  const drafts=new Map();let sessionsCursor='',historyCursor='',listExpanded=false,historyExpanded=false;
  const sourceLabel=c=>c.source==='qq'?'QQ'+(c.groupId?' 群聊':' 私聊'):({web:'网页',knowledge:'知识库',cli:'服务器 CLI'}[c.source]||c.source);
  function notice(text,error=false){$('chat-notice').textContent=text;$('chat-notice').classList.toggle('error',error);}
  async function api(path='',method='GET',body) {
    const response=await fetch('/api/codex-cli/conversations'+path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(response.redirected&&response.url.includes('/login')){location.assign('/login/');throw new Error('请先登录');}
    const data=await response.json();if(!response.ok||!data.ok){if(response.status===403&&!path){$('workspace-tab').hidden=true;if(!$('workspace').hidden)view(false);}throw new Error(data.error || '请求失败');}return data;
  }
  function view(workspace) {
    const name=workspace===true?'workspace':workspace===false?'settings':workspace;
    $('workspace').hidden=name!=='workspace';$('settings-view').hidden=name!=='settings';$('todos-view').hidden=name!=='todos';
    for(const id of ['workspace','settings','todos']){$(id+'-tab').classList.toggle('active',id===name);$(id+'-tab').setAttribute('aria-pressed',String(id===name));}
    history.replaceState(null,'',location.pathname+location.search+(name==='workspace'?'':'#'+name));
    document.dispatchEvent(new CustomEvent('codex-view',{detail:name}));
  }
  $('workspace-tab').onclick=()=>view(true);$('settings-tab').onclick=()=>view(false);$('todos-tab').onclick=()=>view('todos');
  document.addEventListener('codex-open-conversation',event=>{view(true);void refreshList().then(()=>select(event.detail)).catch(error=>notice(error.message,true));});
  function node(tag,text,className) {const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
  function markdown(text) {
    const el=node('div',undefined,'markdown');
    if(window.marked&&window.DOMPurify)el.innerHTML=DOMPurify.sanitize(marked.parse(text),{FORBID_TAGS:['img','video','audio','iframe','style','form','input','button'],FORBID_ATTR:['style','id','name']});
    else el.textContent=text;
    el.querySelectorAll('a').forEach(a=>{a.target='_blank';a.rel='noopener noreferrer';});return el;
  }
  function renderList() {
    const query=$('session-search').value.trim().toLowerCase(),archived=$('show-archived').checked;
    const source=$('session-source').value;
    const visible=list.filter(c=>c.archived===archived&&(!source||c.source===source)&&(!query||(c.title+' '+c.project+' '+sourceLabel(c)).toLowerCase().includes(query)));
    $('sessions').replaceChildren(...visible.map(c=>{
      const button=node('button',undefined,'session-entry'+(c.id===selected?' selected':''));button.type='button';button.setAttribute('aria-pressed',String(c.id===selected));
      button.append(node('strong',c.title),node('span',`${c.project} · ${sourceLabel(c)}${c.state?' · '+(labels[c.state] || c.state):''}`));
      button.onclick=()=>select(c.id);return button;
    }));
    $('sessions-notice').textContent=visible.length?`${visible.length} 个${archived?'已归档':''}会话`:query?'没有匹配的会话':archived?'暂无归档会话':'还没有会话，点击新建开始。';
  }
  function controls() {
    const active=jobs.some(j=>['queued','running'].includes(j.state)),allowed=enabled&&!!current&&!current.readOnly&&!current.archived&&permissions.send&&!active&&!sending&&!!catalog;
    $('send-chat').disabled=!allowed;$('chat-prompt').disabled=!allowed;
    $('chat-model').disabled=!allowed;$('chat-effort').disabled=!allowed;
    $('rename-chat').hidden=!current||current.readOnly||!permissions.manage;$('archive-chat').hidden=!current||current.readOnly||!permissions.manage;
    $('archive-chat').disabled=active;$('archive-chat').textContent=current?.archived?'恢复会话':'归档';
    $('stop-chat').hidden=current?.readOnly||!active||!permissions.stop;$('task-state').textContent=active?labels[jobs.find(j=>['queued','running'].includes(j.state)).state]:current?.readOnly?'原入口管理 · 此处只读':current?.archived?'已归档':'';
  }
  function renderMessages() {
    const scroll=$('chat-scroll'),nearBottom=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<100;
    const snapshot=JSON.stringify(jobs);if(snapshot===lastSnapshot)return;lastSnapshot=snapshot;
    const rows=[];
    for(const job of jobs) {
      const user=node('article',undefined,'chat-message user-message');user.append(node('div','你','message-author'),node('div',job.prompt==='__usage__'?'查询账户额度':job.prompt==='__sync__'?'同步项目':job.prompt,'user-text'));rows.push(user);
      const agent=node('article',undefined,'chat-message assistant-message');agent.append(node('div','⌘ Codex','message-author'));
      if(job.progress.length) {
        const details=node('details',undefined,'task-progress');details.append(node('summary',`${labels[job.state]} · ${job.progress.length} 条执行记录`));
        for(const event of job.progress)details.append(event.kind==='message'?markdown(event.text):node('p',event.text));
        agent.append(details);
      }
      if(job.result)agent.append(markdown(job.result));
      else if(['queued','running'].includes(job.state))agent.append(node('p',job.cancel?'正在停止，保留已有修改…':job.state==='queued'?'已加入队列，等待当前任务完成…':'正在处理，可展开执行记录查看进度。','working-indicator'));
      const runtime=job.runtime || {},meta=[labels[job.state],runtime.model,runtime.effort,job.commit_sha?'Git '+job.commit_sha.slice(0,12):'',new Date(job.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})].filter(Boolean).join(' · ');
      agent.append(node('p',meta,'message-meta'));rows.push(agent);
    }
    if(!rows.length){const empty=node('div',undefined,'chat-empty');empty.append(node('span','⌘','empty-icon'),node('h3','准备就绪'),node('p','发送问题、讨论方案，或描述你希望 Codex 完成的项目任务。'));rows.push(empty);}
    $('messages').replaceChildren(...rows);if(nearBottom)scroll.scrollTop=scroll.scrollHeight;
  }
  async function detail(id=selected,older=false) {
    if(!id)return;
    const data=await api('/'+encodeURIComponent(id)+'?archived='+$('show-archived').checked+(older&&historyCursor?'&cursor='+encodeURIComponent(historyCursor):''));if(id!==selected)return;
    current=data.conversation;if(older)historyExpanded=true;jobs=(older||historyExpanded)?[...data.jobs,...jobs].filter((j,i,a)=>a.findIndex(x=>x.id===j.id)===i).sort((a,b)=>a.created_at-b.created_at):data.jobs;if(older||!historyExpanded)historyCursor=data.nextCursor||'';$('history-more').hidden=!historyCursor;$('chat-title').textContent=current.title;
    $('chat-meta').textContent=`${current.project} · ${sourceLabel(current)} · ${current.readOnly?'原入口管理，此处只读':'历史对话持续保留'}`;
    renderMessages();controls();
  }
  async function select(id) {
    if(sending)return;
    if(selected)drafts.set(selected,$('chat-prompt').value);
    selected=id;historyExpanded=false;historyCursor='';current=null;jobs=[];lastSnapshot='';$('chat-prompt').value=drafts.get(id) || '';controls();renderList();notice('');
    try{await detail(id);$('chat-scroll').scrollTop=$('chat-scroll').scrollHeight;}catch(error){notice(error.message,true);$('messages').replaceChildren();}
  }
  async function refreshList(more=false) {
    const data=await api('?archived='+$('show-archived').checked+(more&&sessionsCursor?'&cursor='+encodeURIComponent(sessionsCursor):''));if(more)listExpanded=true;list=(more||listExpanded)?[...data.conversations,...(more?list:data.permissions.serverHistory?list.filter(c=>c.source==='cli'):[])].filter((c,i,a)=>a.findIndex(x=>x.id===c.id)===i).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)):data.conversations;if(more||!listExpanded)sessionsCursor=data.nextCursor||'';$('sessions-more').hidden=!sessionsCursor;if(data.warning)notice(data.warning,true);projects=data.projects;permissions=data.permissions;enabled=data.enabled;
    $('new-chat').hidden=!permissions.create;$('new-chat').disabled=!data.enabled;
    $('new-project').replaceChildren(...projects.map(p=>new Option(p,p)));renderList();controls();
    if(selected&&!list.some(c=>c.id===selected)){selected='';current=null;jobs=[];lastSnapshot='';$('messages').replaceChildren();$('chat-title').textContent='会话不可用';controls();}
    if(!selected&&list.some(c=>c.archived===$('show-archived').checked))await select(list.find(c=>c.archived===$('show-archived').checked).id);
    if(!data.enabled)notice('服务器 Codex 入口未启用，当前只能查看历史。');
  }
  function efforts() {
    const model=catalog?.models.find(m=>m.id===($('chat-model').value || catalog.qqDefaults.model));
    $('chat-effort').replaceChildren(new Option('默认',''),...(model?.efforts || []).map(e=>new Option(e,e)));
  }
  document.addEventListener('codex-status',event=>{
    const old=$('chat-model').value,effort=$('chat-effort').value;catalog=event.detail;
    $('chat-model').replaceChildren(new Option('默认 · '+catalog.qqDefaults.model,''),...catalog.models.map(m=>new Option(m.id,m.id)));
    $('chat-model').value=old;efforts();if([...$('chat-effort').options].some(o=>o.value===effort))$('chat-effort').value=effort;controls();
  });
  $('chat-model').onchange=efforts;$('session-search').oninput=renderList;$('session-source').onchange=renderList;$('show-archived').onchange=()=>{listExpanded=false;renderList();void refreshList().catch(e=>notice(e.message,true));};
  $('sessions-more').onclick=async()=>{$('sessions-more').disabled=true;try{await refreshList(true);}catch(e){notice(e.message,true);}finally{$('sessions-more').disabled=false;}};
  $('history-more').onclick=async()=>{$('history-more').disabled=true;try{await detail(selected,true);}catch(e){notice(e.message,true);}finally{$('history-more').disabled=false;}};
  $('new-chat').onclick=()=>$('new-dialog').showModal();$('cancel-new').onclick=()=>$('new-dialog').close();
  $('new-form').onsubmit=async event=>{
    event.preventDefault();$('create-chat').disabled=true;
    try{const data=await api('','POST',{project:$('new-project').value});$('new-dialog').close();$('show-archived').checked=false;await refreshList();await select(data.conversation.id);notice('新会话已创建。');}catch(error){notice(error.message,true);$('new-dialog').close();}finally{$('create-chat').disabled=false;}
  };
  $('rename-chat').onclick=()=>{$('new-title').value=current.title;$('rename-dialog').showModal();};$('cancel-rename').onclick=()=>$('rename-dialog').close();
  $('rename-form').onsubmit=async event=>{
    event.preventDefault();$('save-title').disabled=true;
    try{await api('/'+selected,'PATCH',{title:$('new-title').value});$('rename-dialog').close();await refreshList();await detail();}catch(error){notice(error.message,true);$('rename-dialog').close();}finally{$('save-title').disabled=false;}
  };
  $('archive-chat').onclick=async()=>{try{await api('/'+selected,'PATCH',{archived:!current.archived});await refreshList();await detail();}catch(error){notice(error.message,true);}};
  $('stop-chat').onclick=async()=>{$('stop-chat').disabled=true;try{await api('/'+selected+'/stop','POST',{});notice('已请求停止，正在保存任务状态。');await detail();}catch(error){notice(error.message,true);}finally{$('stop-chat').disabled=false;}};
  $('chat-prompt').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!$('send-chat').disabled)$('chat-form').requestSubmit();}};
  $('chat-form').onsubmit=async event=>{
    event.preventDefault();const prompt=$('chat-prompt').value.trim();if(!prompt||!current||sending)return;
    const id=selected,body={prompt,model:$('chat-model').value,effort:$('chat-effort').value},key=JSON.stringify([id,body]);
    const requestId=retry?.key===key?retry.requestId:crypto.randomUUID();retry={key,requestId};sending=true;controls();notice('正在提交任务…');
    try{await api('/'+id+'/messages','POST',{...body,requestId});retry=null;drafts.delete(id);$('chat-prompt').value='';notice('任务已接收，可以在这里查看进度。');await refreshList();await detail(id);}catch(error){notice(error.message+'；可再次发送重试。',true);}finally{sending=false;controls();}
  };
  async function poll() {
    if(reading||sending||document.hidden)return;reading=true;
    try{await refreshList();await detail();}catch(error){notice(error.message,true);}finally{reading=false;}
  }
  if(location.hash==='#todos')view('todos');else if(location.hash==='#settings')view(false);
  void refreshList().catch(error=>{notice(error.message,true);$('sessions-notice').textContent=error.message;});
  setInterval(()=>void poll(),3000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void poll();});
})();
