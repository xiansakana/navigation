(() => {
  const $ = id => document.getElementById(id), names = { salary: '扣工资', training: '员工训练', stock: '库存' };
  const fields = { salary: [['days','离线超过（天）',0,3650]], training: [['hours','提前提醒（小时）',0,24]], stock: [['low','库存下限（%）',0,100],['high','库存上限（%）',0,100]] };
  const explanations = { salary: '员工 last action 距今超过所设天数时提醒；同一次离线只提醒一次。', training: '按 18:00 TCT 结算、每日新增次数等于星级计算，超过 20 次上限时提前提醒。例如 9★、12/20，预计溢出 1 次。每个结算日提醒一次，额外 Trainer 加成未计入。', stock: '总现货库存 ÷ 仓库容量；低于下限或高于上限时提醒。正常后再次越界会重新提醒；无库存的服务型公司不触发。' };
  let state, tab = 'application', dirty = false, loading = false;
  async function api(path, method='GET', body) { const r = await fetch('/api/torn-company-alerts/' + path, { method, credentials:'same-origin', ...(body ? {headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)} : {}) }); const d = await r.json(); if(!r.ok || !d.ok) throw Error(d.error || '读取失败'); return d; }
  function text(tag, value, root) { const e=document.createElement(tag);e.textContent=value;root.append(e);return e; }
  function select(value) {
    tab = value in names && state?.permissions.kinds[value] ? value : 'application'; dirty=false;
    $('company-application').hidden=tab!=='application';$('company-operations').hidden=tab==='application';
    document.querySelectorAll('[data-company-tab]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.companyTab===tab)));
    if(tab!=='application') render();
  }
  function render() {
    for(const kind of Object.keys(names)) document.querySelector('[data-company-tab="'+kind+'"]').hidden=!state.permissions.kinds[kind];
    if(tab==='application')return;
    $('ops-title').textContent=names[tab];$('ops-explanation').textContent=explanations[tab];$('ops-notification-link').href='/notifications/#company-'+tab+'-notifications';
    const rule=state.config.rules[tab], edit=state.permissions.configure && state.permissions.kinds[tab]?.edit;
    if(!dirty){
      $('ops-enabled').checked=rule.enabled;$('ops-interval').value=state.config.intervalSeconds;
      $('ops-watchers').replaceChildren();for(const w of state.roster){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.value=w.id;input.checked=state.config.watcherIds.includes(w.id);input.disabled=!edit||!state.permissions.accounts;label.append(input,document.createTextNode(' '+w.label));$('ops-watchers').append(label);}
      $('ops-thresholds').replaceChildren();for(const [key,label,min,max] of fields[tab]){const wrap=document.createElement('div');wrap.className='field';text('label',label,wrap);const input=document.createElement('input');input.type='number';input.min=min;input.max=max;input.step='any';input.required=true;input.dataset.rule=key;input.value=rule[key];input.disabled=!edit;wrap.append(input);$('ops-thresholds').append(wrap);}
    }
    $('ops-enabled').disabled=$('ops-interval').disabled=!edit;$('ops-save').hidden=!edit;$('ops-start').hidden=$('ops-stop').hidden=!state.permissions.control;
    $('ops-start').disabled=state.state.running||state.state.busy;$('ops-stop').disabled=!state.state.running;
    const s=state.state;$('ops-status').textContent=(s.running?'运行中':'已停止')+' · 完成 '+s.rounds+' 轮'+(s.error?' · '+s.error:'')+(s.notificationError?' · '+s.notificationError:'');
    $('ops-rows').replaceChildren();for(const r of s.rows.filter(r=>r.kind===tab))text('p',(r.label||r.watcherId)+' · '+(r.error||r.companyName+' · 命中 '+r.matches+' 项'+(tab==='training'?' · '+r.rating+'★ · Trains: '+r.trains+' / 20':'')),$('ops-rows'));
    $('ops-history').replaceChildren();for(const r of state.history.filter(r=>r.kind===tab)){const e=text('article',new Date(r.detectedAt*1000).toLocaleString('sv-SE')+' · '+r.watcherLabel+' · '+r.message,$('ops-history'));e.style.whiteSpace='pre-wrap';const a=text('a','查看公司',e);a.href=r.link;a.target='_blank';a.rel='noopener noreferrer';}if(!$('ops-history').childNodes.length)text('p','暂无提醒记录',$('ops-history'));
  }
  async function load(){if(loading)return;loading=true;try{state=await api('state');render();}catch(e){$('ops-status').textContent=e.message;}finally{loading=false;}}
  $('company-tabs').addEventListener('click',e=>{const b=e.target.closest('[data-company-tab]');if(b){location.hash=b.dataset.companyTab;select(b.dataset.companyTab);}});
  $('ops-form').oninput=()=>{dirty=true;};
  $('ops-form').onsubmit=async e=>{e.preventDefault();try{const rule={enabled:$('ops-enabled').checked};for(const el of $('ops-thresholds').querySelectorAll('input'))rule[el.dataset.rule]=Number(el.value);await api('config','POST',{rules:{[tab]:rule},...(state.permissions.accounts?{watcherIds:[...$('ops-watchers').querySelectorAll('input:checked')].map(e=>e.value)}:{}),intervalSeconds:Number($('ops-interval').value)});dirty=false;await load();$('ops-status').textContent+=' · 已保存，请启动经营提醒';}catch(e){$('ops-status').textContent=e.message;}};
  for(const action of ['start','stop'])$('ops-'+action).onclick=async()=>{try{await api(action,'POST',{});await load();}catch(e){$('ops-status').textContent=e.message;}};
  window.addEventListener('hashchange',()=>select(location.hash.slice(1)));
  load().then(()=>select(location.hash.slice(1)));setInterval(()=>{if(!document.hidden)load();},5000);
})();
