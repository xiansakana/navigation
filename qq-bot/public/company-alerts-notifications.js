// Same account-list interaction for each company business; keep independent settings.
[['salary','扣工资'],['training','员工训练'],['stock','库存']].forEach(([kind,name]) => {
  const host=document.getElementById('company-'+kind+'-notifications');
  if(!host)return;
  let state,busy=false;
  const prefix='company-'+kind;
  const accounts=()=>state.watchers?.length?state.watchers:[{id:'',label:'默认通知配置',settings:state.settings}];
  async function request(method='GET',body){
    const response=await fetch('/api/torn-company-alerts/'+kind+'/notifications'+(method==='POST'?'/test':''),{method,credentials:'same-origin',...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
    if(response.status===403&&method==='GET'){host.hidden=true;return null;}
    const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||name+'通知操作失败');return data;
  }
  function render(){
    host.hidden=false;
    host.innerHTML='<article class="business-card" data-source="'+prefix+'"><div class="business-card-head"><div><h3>Torn · '+name+'</h3><p>独立监听账号</p></div><a href="/torn-toolbox/company/#'+kind+'">打开监控 →</a></div><p class="biz-hint">各账号独立配置 QQ / Slack 和通知目标；测试使用该账号已保存的配置。</p>'
      +accounts().map((account,index)=>'<section class="biz-watcher" data-account-index="'+index+'"><div class="biz-watcher-head"><h4>'+bizEscape(account.label)+'</h4><button type="button" class="biz-link" data-action="'+prefix+'-test">测试此账号</button></div><div class="biz-global"><label class="biz-check"><input data-company-'+kind+'-channel="qq" type="checkbox"'+(account.settings.qq.enabled?' checked':'')+'> QQ</label><label class="biz-check"><input data-company-'+kind+'-channel="slack" type="checkbox"'+(account.settings.slack.enabled?' checked':'')+'> Slack</label></div>'+bizTargets(account.settings.targets,prefix+'-'+index)+'</section>').join('')
      +'<div class="biz-actions"><button type="button" class="test-btn compact" data-action="'+prefix+'-save">保存提醒配置</button></div></article>';
    host.querySelectorAll('input,select').forEach(e=>{e.disabled=busy||!state.permissions.save;});
    host.querySelectorAll('button').forEach(e=>{e.disabled=busy||!(e.dataset.action===prefix+'-test'?state.permissions.test:state.permissions.save);});
  }
  function read(){
    host.querySelectorAll('[data-account-index]').forEach(section=>{
      const value={qq:{enabled:section.querySelector('[data-company-'+kind+'-channel="qq"]').checked},slack:{enabled:section.querySelector('[data-company-'+kind+'-channel="slack"]').checked},targets:bizReadTargets(section.querySelector('.biz-targets'))};
      if(state.watchers?.length)state.watchers[Number(section.dataset.accountIndex)].settings=value;else state.settings=value;
    });
  }
  async function load(){
    if(busy)return;
    try{const data=await request();if(data){state=data;render();}}
    catch(error){host.hidden=false;host.textContent=name+'通知读取失败：'+error.message;}
  }
  host.addEventListener('change',event=>{
    if(event.target.dataset.field!=='type')return;
    const row=event.target.closest('.biz-target'),group=event.target.value==='group';
    ['groupId','atUserId'].forEach(field=>{row.querySelector('[data-field="'+field+'"]').hidden=!group;});row.querySelector('[data-field="userId"]').hidden=group;
  });
  host.addEventListener('click',async event=>{
    const button=event.target.closest('button[data-action]');if(!button||!state||button.disabled||busy)return;
    const action=button.dataset.action,isTest=action===prefix+'-test';
    if(!(isTest?state.permissions.test:state.permissions.save))return;
    read();
    const section=button.closest('[data-account-index]'),account=section&&accounts()[Number(section.dataset.accountIndex)];
    if(action==='add-target'||action==='remove-target'){
      if(!account)return;
      if(action==='add-target')account.settings.targets.push({id:prefix+'-'+Date.now(),type:'group',groupId:'',userId:'',atUserId:''});
      else account.settings.targets.splice(Array.from(section.querySelectorAll('.biz-target')).indexOf(button.closest('.biz-target')),1);
      render();return;
    }
    busy=true;host.querySelectorAll('button,input,select').forEach(e=>{e.disabled=true;});
    let saved=0;
    try{
      if(isTest){await request('POST',account?.id?{watcherId:account.id}:undefined);toast(name+'测试通知已发送（使用已保存配置）');}
      else if(action===prefix+'-save'){
        for(const item of accounts()){await request('PUT',item.id?{watcherId:item.id,settings:item.settings}:item.settings);saved++;}
        toast(name+'提醒配置已保存');
      }
    }catch(error){toast((saved?'已保存 '+saved+' 个账号，其余未保存：':'')+error.message,true);}
    finally{busy=false;render();}
  });
  document.getElementById('business-refresh').addEventListener('click',load);
  load();
});
