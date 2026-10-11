(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const currencies = ['CNY', 'USD', 'HKD', 'JPY', 'MYR', 'EUR', 'GBP', 'SGD'];
  const types = ['支出', '收入', '转账', '还款', '借出', '收回', '退款入账', '已报销', '报销入账'];
  const transferTypes = ['转账', '还款', '借出', '收回'];
  const groups = ['资金账户', '海外资金', '信用账户', '理财账户', '海外理财', '社保公积金等', '充值账户', '应收账户'];
  const icons = { 餐饮:'◡', 购物:'▱', 交通:'↗', 工资:'▤', 住房:'⌂', 娱乐:'♫', 通讯:'☎', 学习:'▥', 医疗:'✚', 转账:'⇄', 还款:'↩', 借出:'⇢', 收回:'⇠', 余额调整:'✎' };
  let me, state, activeTab = 'entries', pageSize = 100, pendingImport = null, snapshots = [], editing = null, loadSequence = 0;
  const now = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19); };
  const money = (n, c = 'CNY') => new Intl.NumberFormat('zh-CN', { style:'currency', currency:c, currencyDisplay:'narrowSymbol', minimumFractionDigits:2, maximumFractionDigits:2 }).format(n);
  const m = (n, c) => '<span data-money>' + esc(money(n, c)) + '</span>';
  const can = p => (me?.permissions || []).some(grant => grant === '*' || grant === 'bookkeeping:*' || grant === 'bookkeeping:' + p || (p.endsWith(':view') && grant === 'bookkeeping:' + p.replace(/:view$/, ':edit')));
  async function api(path, options = {}) {
    const r = await fetch('/api/bookkeeping' + path, { ...options, headers: { ...(options.body && typeof options.body === 'string' ? { 'Content-Type':'application/json' } : {}), ...options.headers } });
    const data = await r.json(); if (!r.ok || data.ok === false) throw new Error(data.error || '请求失败'); return data;
  }
  const write = (path, data, method = 'POST') => api(path, { method, body: JSON.stringify(data) });
  function options(values, selected = '', empty = null) {
    return (empty != null ? '<option value="">' + esc(empty) + '</option>' : '') + values.map(v => {
      const item = typeof v === 'object' ? v : { value:v, label:v };
      return '<option value="' + esc(item.value) + '"' + (String(item.value) === String(selected) ? ' selected' : '') + '>' + esc(item.label) + '</option>';
    }).join('');
  }
  function populate(id, values, empty) { const selected = $(id).value; $(id).innerHTML = options(values, selected, empty); }
  function query() {
    const p = new URLSearchParams();
    for (const [id, key] of [['month','month'], ['book','book'], ['currency','currency'], ['type','type'], ['category','category'], ['account','accountId'], ['search','q']]) if ($(id).value) p.set(key, $(id).value);
    return p;
  }
  function metric(label, value, note = '', className = '', richNote = false) { return '<div class="bk-metric"><p>' + esc(label) + '</p><strong class="' + className + '">' + value + '</strong><small>' + (richNote ? note : esc(note)) + '</small></div>'; }
  function summaryHtml(summary) {
    const parts = Object.entries(summary.totals);
    if (!parts.length) return metric('支出', m(0, $('currency').value || 'CNY'), '当前筛选无账单') + metric('收入', m(0, $('currency').value || 'CNY'));
    return parts.map(([c,t]) => metric(c + ' 支出', m(t.expense,c), '已扣除退款与报销', 'bk-expense') + metric(c + ' 收入', m(t.income,c), '转账、借还款不计入', 'bk-income') + metric(c + ' 结余', m(t.net,c), '收入 − 净支出')).join('');
  }
  function categoriesHtml(items, max = 1000) {
    const list = items.filter(x => x.amount !== 0).slice(0,max), totals = {};
    for (const x of items) if (x.amount > 0) totals[x.currency] = (totals[x.currency] || 0) + x.amount;
    return list.map(x => '<div class="bk-category"><div class="bk-category-title"><span>' + esc(x.category) + ' <small class="bk-muted">' + esc(x.currency) + '</small></span>' + m(x.amount,x.currency) + '</div><div class="bk-bar"><span style="width:' + Math.max(0,Math.min(100,x.amount/(totals[x.currency] || 1)*100)) + '%"></span></div></div>').join('') || '<p class="bk-empty">暂时没有支出记录</p>';
  }
  function renderEntries() {
    $('summary').innerHTML = summaryHtml(state.summary); $('stats-summary').innerHTML = summaryHtml(state.summary);
    $('count').textContent = state.count + ' 笔';
    let lastDay = '';
    $('entry-list').innerHTML = state.entries.map(e => {
      const day = e.date.slice(0,10), title = [e.category,e.subcategory].filter(Boolean).join(' · ');
      let heading = '';
      if (day !== lastDay) { lastDay = day; heading = '<div class="bk-day"><span>' + esc(day) + '</span><span>' + esc(new Date(day + 'T12:00:00').toLocaleDateString('zh-CN',{weekday:'long'})) + '</span></div>'; }
      const expense = ['支出','已报销'].includes(e.type), transfer = transferTypes.includes(e.type) || e.type === '余额调整';
      const account = [e.accountName, e.toAccountName].filter(Boolean).join(' → ');
      const subtitle = [e.date.slice(11,16), account, e.note || e.tags].filter(Boolean).join(' · ');
      return heading + '<button class="bk-entry" data-entry="' + e.id + '"><span class="bk-badge">' + (icons[e.type] || icons[e.category] || '◈') + '</span><span class="bk-entry-main"><strong>' + esc(title) + '</strong><p>' + esc(subtitle) + '</p>' + (e.location ? '<p>⌖ ' + esc(e.location) + '</p>' : '') + '</span><span class="bk-entry-amount ' + (expense?'bk-expense':transfer?'bk-transfer':'bk-income') + '">' + m(expense?-e.amount:e.amount,e.currency) + '<small>' + esc(e.type) + (e.historical?' · 历史':'') + '</small></span></button>';
    }).join('') || '<div class="bk-empty">还没有符合条件的账单<br>记下第一笔，或从 iCost 导入历史记录。</div>';
    $('more').classList.toggle('hidden', state.entries.length >= state.count);
    $('mini-categories').innerHTML = categoriesHtml(state.summary.categories,6); $('categories').innerHTML = categoriesHtml(state.summary.categories);
    renderStats();
  }
  function renderStats() {
    const monthly = !$('month').value, grouped = new Map();
    for (const d of state.summary.days) {
      const date = monthly ? d.date.slice(0,7) : d.date;
      const key = date+' '+d.currency, existing = grouped.get(key) || { date, currency:d.currency, income:0, expense:0 };
      existing.income += d.income; existing.expense += d.expense; grouped.set(key,existing);
    }
    const days = [...grouped.values()];
    $('trend-title').textContent = monthly ? '每月收支' : '每日收支';
    const maxes = {};
    days.forEach(d => { maxes[d.currency] = Math.max(maxes[d.currency] || 1,d.income,d.expense); });
    $('trend').innerHTML = days.map(d => '<div class="bk-chart-row"><span>' + esc(monthly ? d.date : d.date.slice(5)) + '<br>' + esc(d.currency) + '</span><div class="bk-chart-bars"><span class="income" style="width:' + Math.max(0,d.income/maxes[d.currency]*100) + '%"></span><span class="expense" style="width:' + Math.max(0,d.expense/maxes[d.currency]*100) + '%"></span></div><span>' + m(d.income,d.currency) + '<br>' + m(d.expense,d.currency) + '</span></div>').join('') || '<p class="bk-empty">暂无收支趋势</p>';
    const month = $('month').value, budget = state.settings.budgets[month], cny = state.budgetExpense || 0;
    $('budget').innerHTML = month ? (budget ? '<p>' + esc(month) + ' 人民币月预算 ' + m(budget) + ' · 剩余 ' + m(budget-cny) + '</p><div class="bk-bar"><span style="width:' + Math.max(0,Math.min(100,cny/budget*100)) + '%"></span></div>' : '<p class="bk-muted">尚未设置 ' + esc(month) + ' 的人民币预算。</p>') : '<p class="bk-muted">选择月份以查看预算。预算仅针对 CNY 账单。</p>';
  }
  function renderAccounts() {
    const totals = {};
    for (const a of state.accounts) if (a.included) { const t = totals[a.currency] ||= { assets:0, debt:0 }; if (a.balance >= 0) t.assets += a.balance; else t.debt -= a.balance; }
    let metrics = Object.entries(totals).map(([c,t]) => metric(c + ' 净资产',m(t.assets-t.debt,c),'资产 '+m(t.assets,c)+'<br>负债 '+m(t.debt,c),'',true)).join('');
    const missing = Object.keys(totals).filter(c => !state.settings.rates[c]);
    if (Object.keys(totals).length > 1) {
      if (missing.length) metrics += metric('人民币折算净资产','—','待填写汇率：' + missing.join('、'));
      else { const total = Object.entries(totals).reduce((s,[c,t]) => s+(t.assets-t.debt)*state.settings.rates[c],0); metrics += metric('人民币折算净资产',m(total),'采用手动设置汇率'); }
    }
    $('assets-summary').innerHTML = metrics || metric('净资产',m(0),'新增账户，建立资产基准');
    const grouped = {};
    for (const a of state.accounts) (grouped[a.group] ||= []).push(a);
    $('account-groups').innerHTML = Object.entries(grouped).map(([g,list]) => '<details open class="bk-panel bk-account-group"><summary>' + esc(g) + ' · ' + list.length + ' 个账户</summary>' + list.map(a => '<div class="bk-account"><span class="bk-badge">' + (g.includes('信用')?'▤':g.includes('理财')?'▥':g.includes('充值')?'▣':'◈') + '</span><div class="bk-entry-main"><strong>' + esc(a.name) + (!a.included?' <small class="bk-muted">不计入</small>':'') + '</strong><p>' + esc(a.currency + (a.note?' · '+a.note:'')) + '</p>' + (a.creditLimit ? '<p>可用额度 ' + m(a.creditLimit+a.balance,a.currency) + (a.billDay?' · 账单日 '+a.billDay+' 日':'') + (a.dueDay?' · 还款日 '+a.dueDay+' 日':'') + '</p>':'') + '<div class="bk-asset-controls"><button data-account-ledger="' + a.id + '">明细</button>' + (can('accounts:edit')?'<button data-account-edit="' + a.id + '">编辑</button><button data-account-adjust="' + a.id + '">核对余额</button>':'') + '</div></div><div class="bk-entry-amount ' + (a.balance<0?'bk-expense':'') + '">' + m(a.balance,a.currency) + '</div></div>').join('') + '</details>').join('') || '<p class="bk-empty">暂无账户。可新增账户或导入账户快照。</p>';
  }
  async function load(append = false) {
    const seq = ++loadSequence; $('error').classList.add('hidden');
    try {
      const params = query(); params.set('limit',String(pageSize)); params.set('offset',append?String(state.entries.length):'0');
      const data = await api('/state?' + params);
      if (seq !== loadSequence) return;
      if (append) data.entries = state.entries.concat(data.entries);
      state = data;
      populate('book',state.books,'所有账本'); populate('category',state.categories,'所有分类'); populate('account',state.accounts.map(a => ({ value:a.id, label:a.name })),'所有账户');
      renderEntries(); renderAccounts();
    } catch (e) { $('error').textContent = e.message; $('error').classList.remove('hidden'); }
  }
  function tab(name) {
    activeTab = name;
    document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active',b.dataset.tab===name));
    document.querySelectorAll('.bk-view').forEach(v => v.classList.toggle('hidden',v.id!==name+'-view'));
    $('filters').classList.toggle('hidden',name==='accounts');
  }
  function field(name, label, value = '', extra = '') { return '<label>' + esc(label) + '<input name="' + name + '" value="' + esc(value) + '" ' + extra + '></label>'; }
  function select(name, label, values, selected = '', empty = null) { return '<label>' + esc(label) + '<select name="' + name + '" aria-label="' + esc(label) + '">' + options(values,selected,empty) + '</select></label>'; }
  const accountOptions = () => state.accounts.map(a => ({ value:a.id, label:a.name+' · '+a.currency }));
  function openEditor(mode, item = {}) {
    editing = { mode, item }; $('editor-error').textContent = ''; $('save-item').disabled = false;
    $('delete-item').classList.toggle('hidden',!item.id || !['entry','account'].includes(mode) || !can(mode==='entry'?'entries:edit':'accounts:edit'));
    let html = '';
    if (mode === 'entry') {
      $('editor-title').textContent = item.id ? '账单详情' : '记一笔';
      html = select('type','类型',item.type==='余额调整'?[...types,'余额调整']:types,item.type||'支出') + field('amount','金额',item.amount??'','type="number" step="0.01" required') + select('currency','货币',currencies,item.currency||'CNY') + field('date','日期与时间',item.date||now(),'type="datetime-local" step="1" required') + field('category','一级分类',item.category||'餐饮','required maxlength="200" list="category-suggestions"') + field('subcategory','二级分类',item.subcategory,'maxlength="200"') + select('accountId','付款 / 收款账户',accountOptions(),item.accountId,'未关联账户') + select('toAccountId','转入账户',accountOptions(),item.toAccountId,'请选择') + field('toAmount','跨币种到账金额',item.toAmount??'','type="number" min="0.01" step="0.01"') + field('fee','手续费（付款币种）',item.fee||0,'type="number" min="0" step="0.01"') + field('book','账本',item.book||$('book').value||'个人账本','required') + field('tags','标签',item.tags) + field('location','位置',item.location) + field('refund','退款信息（辅助字段）',item.refund||0,'type="number" min="0" step="0.01"') + field('discount','优惠信息（辅助字段）',item.discount||0,'type="number" min="0" step="0.01"') + '<label class="full">备注<textarea name="note" maxlength="5000">' + esc(item.note) + '</textarea></label><datalist id="category-suggestions">' + state.categories.map(c => '<option value="'+esc(c)+'">').join('') + '</datalist>';
      if (item.historical) html += '<p class="bk-form-hint">这是历史导入记录，编辑或删除不会改变资产基准。原导出的跨币种转账没有到账金额。</p>';
    } else if (mode === 'account') {
      $('editor-title').textContent = item.id?'编辑账户':'新增账户';
      html = field('name','账户名称',item.name,'required maxlength="100"') + field('group','资产分组',item.group||'资金账户','required list="group-suggestions"') + select('currency','货币',currencies,item.currency||'CNY') + (item.id?'<p class="bk-form-hint">当前余额 '+m(item.balance,item.currency)+'，如需修改请使用“核对余额”。</p>':field('balance','初始余额（负数为欠款）',0,'type="number" step="0.01" required')) + field('creditLimit','信用额度',item.creditLimit||0,'type="number" min="0" step="0.01"') + field('billDay','账单日（0 表示未设置）',item.billDay||0,'type="number" min="0" max="31"') + field('dueDay','还款日（0 表示未设置）',item.dueDay||0,'type="number" min="0" max="31"') + field('note','账户备注',item.note) + '<label>计入总资产<input type="checkbox" name="included" '+(item.included!==false?'checked':'')+'></label><datalist id="group-suggestions">'+groups.map(g=>'<option value="'+esc(g)+'">').join('')+'</datalist>';
    } else if (mode === 'adjust') {
      $('editor-title').textContent = '核对余额 · ' + item.name;
      html = field('balance','实际余额（'+item.currency+'）',item.balance,'type="number" step="0.01" required') + field('date','调整时间',now(),'type="datetime-local" step="1" required') + field('note','调整原因','手动核对余额') + '<p class="bk-form-hint">保存一条余额调整记录，使账户余额等于填写值，不计入收支。</p>';
    } else {
      $('editor-title').textContent = '预算与汇率';
      html = field('budgetMonth','预算月份',$('month').value||now().slice(0,7),'type="month" required') + field('budget','人民币月预算',state.settings.budgets[$('month').value]||0,'type="number" min="0" step="0.01" required') + currencies.filter(c=>c!=='CNY').map(c=>field('rate_'+c,c+' → CNY（留空不折算）',state.settings.rates[c]||'','type="number" min="0.000001" step="any"')).join('');
    }
    $('editor-fields').innerHTML = html;
    const readonly = mode==='entry' && !can('entries:edit');
    $('editor-fields').querySelectorAll('input,select,textarea').forEach(el=>el.disabled=readonly); $('save-item').classList.toggle('hidden',readonly);
    $('editor').showModal();
    if (mode==='entry') {
      const form = $('editor-form'), t = form.elements.type;
      const update = () => { const transfer = transferTypes.includes(t.value); ['toAccountId','toAmount'].forEach(n=>form.elements[n].closest('label').classList.toggle('hidden',!transfer)); if (!transfer) { form.elements.toAccountId.value=''; form.elements.toAmount.value=''; } };
      t.addEventListener('change',update); update();
      form.elements.accountId.addEventListener('change',()=>{ const a=state.accounts.find(a=>a.id===form.elements.accountId.value); if(a) form.elements.currency.value=a.currency; });
    }
  }
  $('editor-form').addEventListener('submit',async event=>{
    event.preventDefault(); const input = Object.fromEntries(new FormData(event.target)); const { mode,item } = editing; $('save-item').disabled=true;
    try {
      if (mode==='entry') { if (!input.toAmount) delete input.toAmount; await write('/entries'+(item.id?'/'+item.id:''),input,item.id?'PUT':'POST'); }
      else if (mode==='account') { input.included=event.target.elements.included.checked; await write('/accounts'+(item.id?'/'+item.id:''),input,item.id?'PUT':'POST'); }
      else if (mode==='adjust') await write('/accounts/'+item.id+'/adjust',input);
      else { const rates={ CNY:1 }, budgets={...state.settings.budgets}; for(const c of currencies) if(input['rate_'+c]) rates[c]=Number(input['rate_'+c]); budgets[input.budgetMonth]=Number(input.budget); await write('/settings',{rates,budgets},'PUT'); }
      $('editor').close(); await load(); window.portalToast?.success('已保存');
    } catch(e) { $('editor-error').textContent=e.message; } finally { $('save-item').disabled=false; }
  });
  $('delete-item').addEventListener('click',async()=>{
    if(!window.confirm(editing.mode==='entry'?'删除这条账单？新账单会撤销对账户余额的影响。':'删除这个账户？存在关联账单时不能删除。')) return;
    try { await api('/'+(editing.mode==='entry'?'entries':'accounts')+'/'+editing.item.id,{method:'DELETE'}); $('editor').close(); await load(); } catch(e) { $('editor-error').textContent=e.message; }
  });
  $('close-editor').onclick=()=>$('editor').close();
  $('add-entry').onclick=()=>openEditor('entry'); $('add-account').onclick=()=>openEditor('account'); $('settings').onclick=()=>openEditor('settings');
  document.querySelector('.bk-tabs').addEventListener('click',e=>{const b=e.target.closest('[data-tab]');if(b)tab(b.dataset.tab);});
  $('entry-list').addEventListener('click',e=>{const b=e.target.closest('[data-entry]');if(b)openEditor('entry',state.entries.find(x=>x.id===b.dataset.entry));});
  $('account-groups').addEventListener('click',e=>{
    const b=e.target.closest('button'); if(!b)return;
    if(b.dataset.accountLedger){$('account').value=b.dataset.accountLedger;tab('entries');load();}
    if(b.dataset.accountEdit)openEditor('account',state.accounts.find(a=>a.id===b.dataset.accountEdit));
    if(b.dataset.accountAdjust)openEditor('adjust',state.accounts.find(a=>a.id===b.dataset.accountAdjust));
  });
  for(const id of ['month','book','currency','type','category','account'])$(id).addEventListener('change',()=>load());
  let searchTimer; $('search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>load(),250);});
  $('all-dates').onclick=()=>{$('month').value='';load();}; $('more').onclick=()=>load(true);
  $('privacy').onclick=()=>{const on=document.querySelector('.bk-shell').classList.toggle('bk-private');$('privacy').setAttribute('aria-pressed',String(on));$('privacy').textContent=on?'显示金额':'隐藏金额';};
  $('import-shortcut').onclick=()=>tab('import');
  $('snapshot-file').addEventListener('change',async()=>{
    try { const file=$('snapshot-file').files[0]; if(!file){snapshots=[];return;} if(file.size>1024*1024)throw new Error('快照文件过大');const data=JSON.parse(await file.text());snapshots=Array.isArray(data)?data:data.accounts;if(!Array.isArray(snapshots))throw new Error('账户快照应为数组或含 accounts 数组');$('snapshot-status').textContent='已读取 '+snapshots.length+' 个账户快照；确认账单导入时一起保存。'; } catch(e){snapshots=[];$('snapshot-status').textContent=e.message;}
  });
  $('import-file').addEventListener('change',async()=>{
    const file=$('import-file').files[0]; if(!file)return;pendingImport=null;$('confirm-import').classList.add('hidden');$('import-preview').textContent='正在解析账单…';
    try { const data=await api('/import/preview',{method:'POST',body:file,headers:{'Content-Type':'application/octet-stream'}});pendingImport=data;
      $('import-preview').innerHTML='<h3>可导入 '+data.count+' 笔 · 无效 '+data.errorCount+' 行</h3>'+data.warnings.map(w=>'<p class="bk-muted">'+esc(w)+'</p>').join('')+data.errors.map(e=>'<p class="bk-error">第 '+e.line+' 行：'+esc(e.error)+'</p>').join('')+'<p class="bk-muted">预览：'+data.sample.map(e=>esc(e.date.slice(0,10)+' '+e.type+' '+e.category+' '+e.currency+' '+e.amount)).join('<br>')+'</p>';
      $('confirm-import').classList.toggle('hidden',data.errorCount>0||data.count===0);
    }catch(e){$('import-preview').textContent=e.message;}
  });
  $('confirm-import').onclick=async()=>{
    if(!pendingImport)return;$('confirm-import').disabled=true;
    try{const result=await write('/import/confirm',{token:pendingImport.token,accounts:snapshots});$('import-preview').textContent='导入完成：新增 '+result.inserted+' 笔，跳过重复 '+result.duplicates+' 笔，创建 '+result.createdAccounts+' 个账户。';pendingImport=null;$('confirm-import').classList.add('hidden');await load();}catch(e){$('import-preview').textContent=e.message;}finally{$('confirm-import').disabled=false;}
  };
  $('export').onclick=()=>{location.href='/api/bookkeeping/export?'+query();};
  async function boot(){
    try { const r=await fetch('/api/me'); me=await r.json();if(me.isGuest||!me.ok)throw new Error('请登录后访问记账模块');$('owner').textContent=me.username;
      populate('currency',currencies,'全部货币');$('currency').value='CNY';populate('type',[...types,'余额调整'],'所有类型');$('month').value=now().slice(0,7);
      $('extra-filters').open = window.innerWidth > 760;
      for(const [id,p] of [['add-entry','entries:edit'],['add-account','accounts:edit'],['settings','settings:edit'],['import-label','import:edit'],['snapshot-label','accounts:edit'],['export','export:view'],['import-shortcut','import:edit']])$(id).classList.toggle('hidden',!can(p));
      document.querySelector('[data-tab="accounts"]').classList.toggle('hidden',!can('accounts:view'));$('account-filter-label').classList.toggle('hidden',!can('accounts:view'));
      document.querySelector('[data-tab="import"]').classList.toggle('hidden',!can('import:edit')&&!can('export:view'));
      await load();
    }catch(e){$('error').textContent=e.message;$('error').classList.remove('hidden');}
  }
  boot();
})();
