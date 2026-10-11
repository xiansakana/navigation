(function(){
  const $=id=>document.getElementById(id);
  let accounts=[];
  async function api(path,body,method='GET') {
    const r=await fetch('/api/bookkeeping/qq'+path,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
    const data=await r.json();if(!r.ok||!data.ok)throw new Error(data.error||'请求失败');return data;
  }
  function render(data){
    $('qq-status').textContent=data.qqId?'已绑定 QQ：'+data.qqId:'尚未绑定 QQ';
    $('qq-groups').value=(data.settings.groups||[]).join(', ');
    $('qq-aliases').value=Object.entries(data.settings.aliases||{}).map(([a,n])=>a+'='+n).join('\n');
    $('qq-account').value=data.settings.defaultAccountId||'';
  }
  window.initQqBookkeeping=(can,state)=>{
    $('qq-open').classList.toggle('hidden',!can('qq:edit')||!can('entries:edit')||!can('accounts:view'));
    accounts=state.accounts||[];
  };
  $('qq-open').onclick=async()=>{
    $('qq-error').textContent='';$('qq-code-text').textContent='';
    $('qq-account').replaceChildren(new Option('每次指令指定账户',''),...accounts.filter(a=>!a.archived).map(a=>new Option(a.name+' · '+a.currency,a.id)));
    try{render(await api(''));$('qq-dialog').showModal();}catch(e){window.portalToast?.error(e.message);}
  };
  $('qq-close').onclick=()=>$('qq-dialog').close();
  $('qq-code').onclick=async()=>{try{const d=await api('/code',{},'POST');$('qq-code-text').textContent='请在10分钟内私聊机器人发送：绑定记账 '+d.code;}catch(e){$('qq-error').textContent=e.message;}};
  $('qq-refresh').onclick=async()=>{try{render(await api(''));}catch(e){$('qq-error').textContent=e.message;}};
  $('qq-unbind').onclick=async()=>{if(!confirm('解绑 QQ 并清除指令偏好？已有账单会保留。'))return;try{await api('',null,'DELETE');render(await api(''));$('qq-code-text').textContent='';}catch(e){$('qq-error').textContent=e.message;}};
  $('qq-form').onsubmit=async e=>{e.preventDefault();$('qq-save').disabled=true;try{render(await api('',{defaultAccountId:$('qq-account').value,groups:$('qq-groups').value,aliases:$('qq-aliases').value},'PUT'));$('qq-error').textContent='已保存';}catch(e){$('qq-error').textContent=e.message;}finally{$('qq-save').disabled=false;}};
  const dialog=$('qq-dialog');let outside=false;
  const isOutside=e=>{const r=dialog.getBoundingClientRect();return e.target===dialog&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom);};
  dialog.onpointerdown=e=>{outside=isOutside(e);};dialog.onclick=e=>{if(outside&&isOutside(e))dialog.close();outside=false;};
})();
