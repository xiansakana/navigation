(() => {
const $=id=>document.getElementById(id); let dirty=false, permission={};
let historyRows=[],historyPage=1,historyPageSize=20;
let revision=0,activeReads=0,configuredRows,displayedResults,displayedHistory,view;
const viewReady=import('../../generated/torn-shopping-view.js?v=1').then(({mountShoppingView})=>{view=mountShoppingView({results:$('results'),history:$('history')});});
function renderHistory(){
  const total=historyRows.length,pages=Math.max(1,Math.ceil(total/historyPageSize));
  historyPage=Math.min(historyPage,pages);
  if(!view)return;
  view.renderHistory(historyRows.slice((historyPage-1)*historyPageSize,historyPage*historyPageSize));
  $('history-page-info').textContent=`共 ${total} 条 · 第 ${historyPage}/${pages} 页`;
  $('history-prev').disabled=historyPage<=1;$('history-next').disabled=historyPage>=pages;
}
$('history-prev').onclick=()=>{if(historyPage>1){historyPage--;renderHistory();}};
$('history-next').onclick=()=>{if(historyPage*historyPageSize<historyRows.length){historyPage++;renderHistory();}};
$('history-page-size').onchange=()=>{historyPageSize=Number($('history-page-size').value);historyPage=1;renderHistory();};
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

async function renderState({config,state,history,permissions}){
  await viewReady;
  permission=permissions;
  if(!dirty){
    $('interval').value=config.intervalSeconds;
    $('apiInterval').value=config.apiIntervalSeconds;
    const snapshot=JSON.stringify(config.items);
    if(snapshot!==configuredRows){
      configuredRows=snapshot;
      $('items').replaceChildren();
      config.items.forEach(row);
    }
  }
  for(const id of ['keys','interval','apiInterval','save'])$(id).disabled=!permission.configure;
  $('add').disabled=!permission.configure||!permission.items;
  $('items').querySelectorAll('input,button').forEach(n=>n.disabled=!permission.configure);
  if(!permission.configure||!permission.items)closePicker();
  $('start').disabled=!permission.control||state.running||state.busy;
  $('stop').disabled=!permission.control||!state.running;
  $('clear').disabled=!permission.clear;
  const nextScan=state.nextScanAt?new Date(state.nextScanAt*1000).toLocaleString('sv-SE'):'—';
  $('status').textContent=`${state.running?'运行中':'已停止'} · 已保存 ${config.keyCount} 个Key · ${state.rounds}轮 · 下轮 ${nextScan} · ${state.error||state.notificationError||''}`;
  const results=state.rows||[],resultsSnapshot=JSON.stringify(results);
  if(resultsSnapshot!==displayedResults){
    displayedResults=resultsSnapshot;
    view.renderResults(results);
  }
  const historySnapshot=JSON.stringify(history);
  if(historySnapshot!==displayedHistory){
    displayedHistory=historySnapshot;
    historyRows=history;
    renderHistory();
  }
}
async function refresh(){
  const request=++revision;
  activeReads++;
  try{
    const data=await api('state');
    if(request===revision)await renderState(data);
  }catch(e){
    if(request===revision)$('message').textContent=e.message;
  }finally{
    activeReads--;
  }
}
$('form').oninput=()=>{dirty=true;};$('form').onsubmit=async e=>{e.preventDefault();try{const items=Array.from($('items').children,div=>Object.fromEntries(Array.from(div.querySelectorAll('input'),i=>[i.dataset.field,i.value])));await api('config','POST',{items,intervalSeconds:$('interval').value,apiIntervalSeconds:$('apiInterval').value,...($('keys').value.trim()?{apiKeys:$('keys').value.trim()}: {})});dirty=false;configuredRows=undefined;catalogLoaded=false;$('keys').value='';closePicker();$('message').textContent='已保存，请启动';await refresh();}catch(e){$('message').textContent=e.message;}};
for(const id of ['start','stop','clear'])$(id).onclick=async()=>{if(id==='clear'&&!(await window.portalUI.confirm('清空历史？去重保留。',{title:'清空历史',danger:true,okText:'清空'})))return;try{await api(id==='clear'?'history':id,id==='clear'?'DELETE':'POST');await refresh();}catch(e){$('message').textContent=e.message;}};
function refreshVisible(){if(!document.hidden&&!activeReads)void refresh();}
void refresh();
document.addEventListener('visibilitychange',refreshVisible);
setInterval(refreshVisible,5000);
})();
