(() => {
  const $=id=>document.getElementById(id);let state,scopeRequest=0,loading=false;
  const message=(text,type='')=>{$('message').textContent=text;$('message').className='notice '+type;};
  async function api(path,options={}){
    const response=await fetch('/api/codex-cli/'+path,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...options.headers}});
    if(response.redirected&&response.url.includes('/login')){location.assign('/login/');throw new Error('请先登录');}
    const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error || '请求失败');return data;
  }
  function options(select,items,value){select.replaceChildren(...items.map(item=>new Option(item.label,item.value)));select.value=value;if(select.selectedIndex<0&&select.options.length)select.selectedIndex=0;}
  function model(id){return state.models.find(m=>m.id===id);}
  function efforts(prefix,value=''){
    const selected=prefix==='server'?$('server-model').value:$('runtime-model').value || state.qqDefaults.model;
    const current=model(selected),inherit=prefix==='runtime';
    options($(prefix+'-effort'),[...(inherit?[{value:'',label:'默认（继承服务器或所选模型）'}]:[]),...(current?.efforts || []).map(e=>({value:e,label:e}))],value || (inherit?'':current?.defaultEffort || ''));
  }
  function effective(){
    const chosen=$('runtime-model').value,selected=model(chosen || state.qqDefaults.model);
    const effort=$('runtime-effort').value || (chosen?selected?.defaultEffort:state.qqDefaults.effort) || '模型默认';
    $('effective').textContent='实际运行设置：'+(selected?.id || '未选择')+' · '+effort;
  }
  async function runtime(){
    const token=++scopeRequest;$('runtime-fields').disabled=true;
    try{
      const result=await api('runtime?groupId='+encodeURIComponent($('scope').value));if(token!==scopeRequest)return;
      $('runtime-model').value=result.preference.model;efforts('runtime',result.preference.effort);effective();
      return true;
    }catch(error){if(token===scopeRequest)message(error.message,'error');return false;}
    finally{if(token===scopeRequest)$('runtime-fields').disabled=!state.permissions.editRuntime;}
  }
  async function refresh(){
    if(loading)return;loading=true;$('refresh').disabled=true;message('正在读取服务器状态…');
    try{
      state=await api('status');
      document.dispatchEvent(new CustomEvent('codex-status',{detail:state}));
      $('cli-version').textContent=state.cliVersion;
      $('account').textContent=state.account.loggedIn?'已登录':'未登录';$('account-detail').textContent=[state.account.type,state.account.planType].filter(Boolean).join(' · ');
      $('default-summary').textContent=state.defaults.model;$('default-effort').textContent='推理强度 · '+(state.defaults.effort || '模型默认');
      $('qq-summary').textContent=state.qqDefaults.model;$('qq-detail').textContent=(state.provisioning.enabled?'入口已启用':'入口未启用')+' · '+state.qqDefaults.effort;
      options($('server-model'),state.models.map(m=>({value:m.id,label:m.name+' · '+m.id})),state.defaults.model);efforts('server',state.defaults.effort);
      $('sandbox').textContent=state.safety.sandbox || 'CLI 默认';$('approval').textContent=state.safety.approval || 'CLI 默认';
      $('server-fields').disabled=!state.permissions.editServer;$('save-server').hidden=!state.permissions.editServer;$('server-readonly').hidden=state.permissions.editServer;
      $('override-notice').textContent=state.qqOverrides.model || state.qqOverrides.effort?'QQ 入口存在单独默认覆盖，上方“QQ 入口默认模型”显示实际继承值；你也可以在右侧为自己的会话选择模型。':'QQ 未设置单独模型覆盖时，会继承服务器默认值。QQ任务固定采用非交互审批策略，沙箱为 '+state.qqOverrides.sandbox+'。';
      $('qq-unavailable').hidden=state.permissions.viewRuntime;$('runtime-form').hidden=!state.permissions.viewRuntime;$('save-runtime').hidden=!state.permissions.editRuntime;
      options($('scope'),[{value:'',label:'我的 QQ 私聊'},...state.groups.map(g=>({value:g,label:'群聊 · '+g}))],$('scope').value);
      options($('runtime-model'),[{value:'',label:'默认（继承服务器）'},...state.models.map(m=>({value:m.id,label:m.name+' · '+m.id}))],'');
      const runtimeOk=!state.permissions.viewRuntime || await runtime();
      $('usage-panel').hidden=!state.permissions.viewUsage;
      if(state.permissions.viewUsage){try{$('usage').textContent=(await api('usage')).text;}catch(error){$('usage').textContent=error.message;}}
      $('updated').textContent='最近更新 · '+new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+'（北京时间）';
      if(runtimeOk)message('已连接服务器。模型与强度选项来自当前账号。');
    }catch(error){message(error.message,'error');}
    finally{loading=false;$('refresh').disabled=false;}
  }
  $('server-model').addEventListener('change',()=>efforts('server'));
  $('runtime-model').addEventListener('change',()=>{efforts('runtime');effective();});$('runtime-effort').addEventListener('change',effective);
  $('scope').addEventListener('change',runtime);$('refresh').addEventListener('click',refresh);
  $('server-form').addEventListener('submit',async event=>{
    event.preventDefault();$('save-server').disabled=true;
    try{await api('settings',{method:'PUT',body:JSON.stringify({model:$('server-model').value,effort:$('server-effort').value,version:state.version})});await refresh();message('服务器默认设置已保存，后续任务生效。','success');}catch(error){message(error.message,'error');}finally{$('save-server').disabled=false;}
  });
  $('runtime-form').addEventListener('submit',async event=>{
    event.preventDefault();$('save-runtime').disabled=true;
    try{const result=await api('runtime',{method:'PUT',body:JSON.stringify({groupId:$('scope').value,model:$('runtime-model').value,effort:$('runtime-effort').value})});$('effective').textContent='实际运行设置：'+result.effective.model+' · '+result.effective.effort;message('当前会话的模型设置已保存，QQ与网页同步，后续任务生效。','success');}catch(error){message(error.message,'error');}finally{$('save-runtime').disabled=false;}
  });
  void refresh();
})();
