(() => {
const $=id=>document.getElementById(id); let dirty=false, permission={};
async function api(path,method='GET',body){const r=await fetch('/api/torn-shopping/'+path,{method,headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||'操作失败');return d;}
let catalog = [], catalogLoaded = false;
function row(item={}) {
  const div=document.createElement('div');div.className='chain-fields';div.dataset.itemId=item.id;
  const title=document.createElement('strong');title.className='shopping-item-title';title.textContent=item.name+' (ID: '+item.id+')';div.append(title);
  for(const field of ['id','name']){const i=document.createElement('input');i.type='hidden';i.dataset.field=field;i.value=item[field];div.append(i);}
  for(const [field,label] of [['market','市场最高价'],['bazaar','巴扎最高价']]){const l=document.createElement('label'),i=document.createElement('input');l.textContent=label;i.dataset.field=field;i.value=item[field]??'';i.type='number';i.min=1;i.step=1;i.disabled=!permission.configure;l.append(i);div.append(l);}
  const b=document.createElement('button');b.textContent='移除';b.type='button';b.disabled=!permission.configure;b.onclick=()=>{div.remove();dirty=true;renderCatalog();};div.append(b);$('items').append(div);
}
function renderCatalog(){
  const selected=new Set(Array.from($('items').children,div=>Number(div.dataset.itemId))),query=$('item-search').value.trim().toLowerCase();
  const rows=catalog.filter(item=>!query||item.name.toLowerCase().includes(query)||String(item.id).includes(query));
  $('item-options').replaceChildren(...rows.map(item=>{const button=document.createElement('button');button.type='button';button.setAttribute('role','option');button.setAttribute('aria-selected',String(selected.has(item.id)));button.textContent=item.name+' (ID: '+item.id+')'+(selected.has(item.id)?' ✓':'');button.disabled=!permission.configure||!permission.items||selected.has(item.id);button.onclick=()=>{row(item);dirty=true;renderCatalog();};return button;}));
  if(!rows.length){const p=document.createElement('p');p.textContent='没有匹配物品';$('item-options').append(p);}
}
function closePicker(){$('item-dropdown').hidden=true;$('add').setAttribute('aria-expanded','false');}
$('add').onclick=async()=>{
  if(!permission.configure||!permission.items)return;
  try{if(!catalogLoaded){$('message').textContent='正在读取物品目录…';const d=await api('items');catalog=d.items;catalogLoaded=true;$('message').textContent='已加载 '+catalog.length+' 种物品';}
    const open=$('item-dropdown').hidden;$('item-dropdown').hidden=!open;$('add').setAttribute('aria-expanded',String(open));if(open){renderCatalog();$('item-search').focus();}
  }catch(e){$('message').textContent=e.message;}
};
$('item-search').oninput=renderCatalog;
document.addEventListener('click',event=>{if(!$('item-picker').contains(event.target))closePicker();});
$('item-picker').addEventListener('keydown',event=>{if(event.key==='Escape'){closePicker();$('add').focus();}});

async function refresh(){try{const d=await api('state');permission=d.permissions;if(!dirty){$('interval').value=d.config.intervalSeconds;$('apiInterval').value=d.config.apiIntervalSeconds;$('items').replaceChildren();d.config.items.forEach(row);}for(const id of ['keys','interval','apiInterval','save','add'])$(id).disabled=!permission.configure;$('add').disabled=!permission.configure||!permission.items;$('items').querySelectorAll('input,button').forEach(n=>n.disabled=!permission.configure);if(!permission.configure||!permission.items)closePicker();
$('start').disabled=!permission.control||d.state.running||d.state.busy;$('stop').disabled=!permission.control||!d.state.running;$('clear').disabled=!permission.clear;
$('status').textContent=`${d.state.running?'运行中':'已停止'} · 已保存 ${d.config.keyCount} 个Key · ${d.state.rounds}轮 · 下轮 ${d.state.nextScanAt?new Date(d.state.nextScanAt*1000).toLocaleTimeString():'—'} · ${d.state.error||d.state.notificationError||''}`;
$('results').replaceChildren(...(d.state.rows||[]).map(r=>{const p=document.createElement('p');p.textContent=`${r.name||r.itemId} · ${r.source==='market'?'市场':'巴扎'} · ${r.error||'发现 '+r.matches+' 条低价'}`;return p;}));$('history').replaceChildren(...d.history.map(r=>{const p=document.createElement('p'),a=document.createElement('a');a.href=r.link;a.target='_blank';a.rel='noopener noreferrer';a.textContent=`${r.name} · ${r.source==='market'?'市场':'巴扎'} $${r.price} × ${r.quantity} · ${new Date(r.detectedAt*1000).toLocaleString()} ↗`;p.append(a);return p;}));}catch(e){$('message').textContent=e.message;}}
$('form').oninput=()=>{dirty=true;};$('form').onsubmit=async e=>{e.preventDefault();try{const items=Array.from($('items').children,div=>Object.fromEntries(Array.from(div.querySelectorAll('input'),i=>[i.dataset.field,i.value])));await api('config','POST',{items,intervalSeconds:$('interval').value,apiIntervalSeconds:$('apiInterval').value,...($('keys').value.trim()?{apiKeys:$('keys').value.trim()}:{})});dirty=false;catalogLoaded=false;$('keys').value='';closePicker();$('message').textContent='已保存，请启动';await refresh();}catch(e){$('message').textContent=e.message;}};
for(const id of ['start','stop','clear'])$(id).onclick=async()=>{if(id==='clear'&&!confirm('清空历史？去重保留。'))return;try{await api(id==='clear'?'history':id,id==='clear'?'DELETE':'POST');await refresh();}catch(e){$('message').textContent=e.message;}};
refresh();setInterval(()=>{if(!document.hidden)refresh();},5000);
})();