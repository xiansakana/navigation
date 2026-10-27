(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const currencies = ['CNY', 'USD', 'HKD', 'JPY', 'MYR', 'EUR', 'GBP', 'SGD'];
  const types = ['支出', '收入', '转账', '还款', '借出', '收回', '退款入账', '已报销', '报销入账'];
  const transferTypes = ['转账', '还款', '借出', '收回'];
  const icons = { 餐饮:'◡', 购物:'▱', 交通:'↗', 工资:'▤', 住房:'⌂', 娱乐:'♫', 通讯:'☎', 学习:'▥', 医疗:'✚', 转账:'⇄', 还款:'↩', 借出:'⇢', 收回:'⇠', 余额调整:'✎' };
  let me, state, activeTab = 'entries', pageSize = 100, pendingImport = null, snapshots = [], editing = null, loadSequence = 0;
  const now = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19); };
  const symbols={CNY:'¥',USD:'US$',HKD:'HK$',JPY:'JP¥',MYR:'RM',EUR:'€',GBP:'£',SGD:'S$'};
  const money = (n,c='CNY') => (n<0?'-':'')+(symbols[c]||c+' ')+new Intl.NumberFormat('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Math.abs(n));
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
    for(const [key,value] of Object.entries({...periods.query(),...analysis.query()}))if(value)p.set(key,value);
    return p;
  }
  function metric(label, value, note = '', className = '', richNote = false, drill = null) { const tag=drill?'button':'div'; return '<'+tag+' class="bk-metric"'+(drill?analysis.attr(drill):'')+'><p>' + esc(label) + '</p><strong class="' + className + '">' + value + '</strong><small>' + (richNote ? note : esc(note)) + '</small></'+tag+'>'; }
  function summaryHtml(summary, equivalent=false) {
    const parts = Object.entries(summary.totals);
    if (!parts.length) return metric('支出', m(0, equivalent?'CNY':$('currency').value || 'CNY'), '当前筛选无账单','bk-expense') + metric('收入', m(0, equivalent?'CNY':$('currency').value || 'CNY'),'','bk-income') + metric('结余', m(0, equivalent?'CNY':$('currency').value || 'CNY'));
    return parts.map(([c,t]) => metric(c + ' 支出', m(t.expense,c), '已扣除退款与报销 · 点击查看', 'bk-expense',false,{currency:equivalent?$('currency').value:c,flow:'expense'}) + metric(c + ' 收入', m(t.income,c), '转账、借还款不计入 · 点击查看', 'bk-income',false,{currency:equivalent?$('currency').value:c,flow:'income'}) + metric(c + ' 结余', m(t.net,c), '收入 − 净支出 · 点击查看','',false,{currency:equivalent?$('currency').value:c,flow:'net'})).join('');
  }
  function categoriesHtml(items, max = 1000, equivalent=false, flow='expense') {
    const list = items.filter(x => x.amount !== 0).slice(0,max), totals = {};
    for (const x of items) if (x.amount > 0) totals[x.currency] = (totals[x.currency] || 0) + x.amount;
    return list.map(x => '<button class="bk-category bk-category-drill"'+analysis.attr({category:x.category,currency:equivalent?$('currency').value:x.currency,flow})+'><div class="bk-category-title"><span>' + esc(x.category) + ' <small class="bk-muted">' + esc(x.currency) + '</small>'+(flow==='income'?'<small> · '+x.count+' 笔 · '+(x.amount>0?(x.amount/(totals[x.currency]||1)*100).toFixed(1)+'%':'冲减')+'</small>':'')+'</span>' + m(x.amount,x.currency) + '</div><div class="bk-bar"><span style="width:' + Math.max(0,Math.min(100,x.amount/(totals[x.currency] || 1)*100)) + '%"></span></div></button>').join('') || '<p class="bk-empty">'+(flow==='income'?'暂无非零分类收入':'暂时没有支出记录')+'</p>';
  }
  function renderEntries() {
    const converted=state.equivalentSummary||state.analysis?.equivalentSummary, missing=state.conversionMissing||state.analysis?.billing.missingCurrencies||[];
    const dayTotals=new Map((converted?.days||[]).filter(day=>day.currency==='CNY').map(day=>[day.date,day]));
    const summary=missing.length?'<p class="bk-muted">缺少 '+esc(missing.join('、'))+' 历史汇率，CNY 汇总待补齐。</p>':summaryHtml(converted||state.summary,true);
    $('summary').innerHTML=summary;
    const statistics=state.analysis?.equivalentSummary||converted||state.summary;
    $('stats-summary').innerHTML=state.analysis?.billing.missingCurrencies.length?'<p class="bk-muted">统计范围历史汇率待补齐。</p>':summaryHtml(statistics,true);
    $('count').textContent = state.count + ' 笔';
    let lastDay = '';
    const ledgerNote=can('accounts:view') && $('account').value && state.entries.some(e=>e.balanceEstimated)?(state.accounts.find(a=>a.id===$('account').value)?.investment?'<p class="bk-muted bk-ledger-note">本页展示记账流水；证券账户总资产包含持仓估值，不由这些流水反推历史余额。现金和持仓详情请打开资产页的证券明细。</p>':'<p class="bk-muted bk-ledger-note">历史余额按当前余额、账单及余额调整反推；截图核对的调整余额按原币显示，其他反推或跨币种估算值标注 ≈。</p>'):'';
    $('entry-list').innerHTML = ledgerNote + (state.entries.map(e => {
      const day = e.date.slice(0,10), title = [e.category,e.subcategory].filter(Boolean).join(' · ');
      let heading = '';
      if (day !== lastDay) {
        lastDay=day;
        const total=dayTotals.get(day)||{income:0,expense:0},net=Math.round((total.income-total.expense)*100)/100;
        const daily=missing.length||!converted?'<span>CNY 合计待补齐汇率</span>':'<span class="bk-day-currency">CNY</span><span>收入 '+m(total.income,'CNY')+'</span><span>净支出 '+m(total.expense,'CNY')+'</span><span class="'+(net<0?'bk-expense':'bk-income')+'">结余 '+m(net,'CNY')+'</span>';
        heading='<div class="bk-day" data-day="'+esc(day)+'"><span class="bk-day-date"><time datetime="'+esc(day)+'">'+esc(day)+'</time><span>'+esc(new Date(day+'T12:00:00').toLocaleDateString('zh-CN',{weekday:'long'}))+'</span></span><span class="bk-day-totals" aria-label="当日 CNY 合计">'+daily+'</span></div>';
      }
      const expense = ['支出','已报销'].includes(e.type), transfer = transferTypes.includes(e.type) || e.type === '余额调整';
      const account = [e.accountName, e.toAccountName].filter(Boolean).join(' → ');
      const subtitle = [e.date.slice(11,16), account, e.note || e.tags].filter(Boolean).join(' · ');
      const balance=can('accounts:view') && $('account').value && e.balanceCurrency?'<small class="bk-ledger-balance">本笔后余额 '+(e.balanceAfter==null?'待核对':(e.balanceEstimated?'≈ ':'')+m(e.balanceAfter,e.balanceCurrency))+'</small>':'';
      return heading + '<button class="bk-entry" data-entry="' + e.id + '"><span class="bk-badge">' + (icons[e.type] || state.categoryTree?.find(c=>c.kind===(e.type==='收入'?'income':'expense') && c.name===(e.subcategory||e.category) && (e.subcategory?state.categoryTree.some(p=>p.id===c.parentId && p.name===e.category):!c.parentId))?.icon || icons[e.category] || '◈') + '</span><span class="bk-entry-main"><strong>' + esc(title) + '</strong><p>' + esc(subtitle) + '</p>' + (e.location ? '<p>⌖ ' + esc(e.location) + '</p>' : '') + '</span><span class="bk-entry-amount ' + (expense?'bk-expense':transfer?'bk-transfer':'bk-income') + '">' + m(expense?-e.amount:e.amount,e.currency) + (e.currency!=='CNY'?'<small>'+ (e.fxMissing?'CNY 等效待获取': '≈ '+m(expense?-e.cnyAmount:e.cnyAmount,'CNY')+' · 汇率日 '+esc(e.rateDate))+'</small>':'') + '<small>' + esc(e.type) + (e.historical?' · 历史':'') + '</small>' + balance + '</span></button>';
    }).join('') || '<div class="bk-empty">还没有符合条件的账单<br>记下第一笔，或从 iCost 导入历史记录。</div>');
    $('more').classList.toggle('hidden', state.entries.length >= state.count);
    $('mini-categories').innerHTML = categoriesHtml(state.equivalentSummary?.categories || state.summary.categories,6,!!state.equivalentSummary); $('categories').innerHTML = categoriesHtml(statistics.categories,1000,true);
    $('income-categories').innerHTML=state.analysis?.billing.missingCurrencies.length?'<p class="bk-empty">缺少历史汇率，分类收入待折算。</p>':categoriesHtml(statistics.incomeCategories || [],1000,true,'income');
    renderStats();
  }
  function renderStats() {
    const monthly = state.analysis?.billing.granularity==='month', grouped = new Map();
    for (const d of state.analysis?.billing.points || []) {
      const date = monthly ? d.date.slice(0,7) : d.date;
      const key = date+' '+d.currency, existing = grouped.get(key) || { date, currency:d.currency, income:0, expense:0 };
      existing.income += d.income; existing.expense += d.expense; grouped.set(key,existing);
    }
    const days = [...grouped.values()];
    $('trend-title').textContent = monthly ? '每月收支' : '每日收支';
    const maxes = {};
    days.forEach(d => { maxes[d.currency] = Math.max(maxes[d.currency] || 1,d.income,d.expense); });
    $('trend').innerHTML = days.map(d => '<button class="bk-chart-row"'+analysis.attr({currency:$('currency').value,month:d.date.slice(0,7),...(monthly?{}:{day:d.date}),flow:'net'})+'><span>' + esc(monthly ? d.date : d.date.slice(5)) + '<br>' + esc(d.currency) + '</span><div class="bk-chart-bars"><span class="income" style="width:' + Math.max(0,d.income/maxes[d.currency]*100) + '%"></span><span class="expense" style="width:' + Math.max(0,d.expense/maxes[d.currency]*100) + '%"></span></div><span>' + m(d.income,d.currency) + '<br>' + m(d.expense,d.currency) + '</span></button>').join('') || '<p class="bk-empty">暂无收支趋势</p>';
    const month = $('month').value, budget = state.settings.budgets[month], cny = state.budgetExpense || 0;
    $('budget').innerHTML = month && budget && state.budgetExpense==null?'<p class="bk-muted">历史汇率尚未补齐，暂不能核算 CNY 预算消耗。</p>':month ? (budget ? '<p>' + esc(month) + ' 人民币月预算 ' + m(budget) + ' · 剩余 ' + m(budget-cny) + '</p><div class="bk-bar"><span style="width:' + Math.max(0,Math.min(100,cny/budget*100)) + '%"></span></div>' : '<p class="bk-muted">尚未设置 ' + esc(month) + ' 的人民币预算。</p>') : '<p class="bk-muted">选择月份以查看预算。预算仅针对 CNY 账单。</p>';
    renderFx(); analysis.render();
  }
  function renderFx() {
    const quotes = state.fx?.quotes || {}, sources = { fixed:'固定', finnhub:'Finnhub', fred:'FRED', yahoo:'Yahoo', manual:'手动备用' };
    const used = new Set([...state.accounts.map(a => a.currency), ...Object.keys(state.summary.totals)]);
    const html = currencies.filter(c => c !== 'CNY' && (used.has(c) || quotes[c])).map(c => {
      const q = quotes[c];
      return '<div class="bk-fx-rate"><strong>' + c + ' → CNY</strong><span>' + (q ? '1 ' + c + ' = ' + Number(q.rate.toFixed(6)) + ' CNY' : '暂无可用汇率') + '</span><small>' + (q ? esc(sources[q.source] || q.source) + (q.stale ? ' · 历史缓存' : '') + (q.asOf ? ' · 数据日 ' + esc(q.asOf) : '') + (q.fetchedAt ? ' · 获取于 ' + esc(new Date(q.fetchedAt).toLocaleString('zh-CN',{hour12:false})) : '') : '可更新汇率或填写手动备用值') + '</small></div>';
    }).join('');
    for (const id of ['fx-rates','asset-fx-rates']) $(id).innerHTML = html || '<p class="bk-muted">正在获取参考汇率…</p>';
  }
  async function refreshFx(manual = false) {
    for (const id of ['refresh-fx','refresh-asset-fx']) { $(id).disabled = true; $(id).textContent = '获取汇率中…'; }
    try {
      const data = await api(manual ? '/fx/refresh' : '/fx', manual ? { method:'POST' } : {});
      state.fx = data.fx; await load(); renderAccounts(); renderFx();
      $('fx-status').textContent = data.fx.errors.length ? data.fx.errors.join('；') + '。优先使用手动备用值，其次使用上次成功值。' : '参考汇率已更新；行情来源可能存在延迟，请查看各币种的数据日期。';
    } catch (e) { $('fx-status').textContent = '汇率获取失败：' + e.message + '，保留已保存的汇率。'; }
    finally { for (const id of ['refresh-fx','refresh-asset-fx']) { $(id).disabled = false; $(id).textContent = '更新参考汇率'; } }
  }
  function renderAccounts() {
    const totals = {};
    const excluded=new Set(state.analysisScope?.excludedAccountIds||[]);
    for (const a of state.accounts) if (a.included&&!excluded.has(a.id)) { const t = totals[a.currency] ||= { assets:0, debt:0 }; if (a.balance >= 0) t.assets += a.balance; else t.debt -= a.balance; }
    const rates=state.fx?.rates||state.settings.rates, missing=Object.keys(totals).filter(c=>!rates[c]);
    const asset=state.analysis?.asset, period=asset?.period;
    const incomplete=state.accounts.filter(a=>a.included&&!excluded.has(a.id)&&a.balance==null);
    let metrics=incomplete.length?metric('当前 CNY 净资产','—','待补齐证券行情：'+incomplete.map(a=>a.name).join('、')):missing.length?metric('CNY 净资产','—','待获取汇率：'+missing.join('、')):metric('当前 CNY 净资产',m(Object.entries(totals).reduce((n,[c,t])=>n+(t.assets-t.debt)*rates[c],0)),'按当前汇率折算');
    if(period) {
      metrics+=metric('范围期初净资产',m(period.opening),'截至 '+period.openingAsOf+' 日末 · '+(asset.historyMode==='hybrid'?'反推／估值快照':'历史反推'));
      metrics+=metric('范围期末净资产',m(period.closing),period.closingSource==='current'?'截至 '+period.end+' · 今日暂估，与当前净资产同口径':asset.historyMode==='hybrid'?'观测日期 '+(period.closingAsOf||period.end)+' · 范围内最近估值或账面记录':'截至 '+period.end+' 日末 · 历史反推');
      metrics+=metric('范围内资产变化',(period.change>0?'+ ':'')+m(period.change),period.start+' ～ '+period.end+' · 期末 − 期初，含余额调整'+(asset.historyMode==='hybrid'?'及估值变化':''),period.change>0?'bk-income':period.change<0?'bk-expense':'');
    } else if(asset)metrics+=metric('范围内资产变化','—',asset.missingCurrencies.length?'缺少历史汇率，暂无法计算':asset.missingValuations?.length?'证券行情待补齐，暂不汇总部分资产':'所选范围暂无可反推的资产数据');
    $('assets-summary').innerHTML = metrics || metric('净资产',m(0),'新增账户，建立资产基准');
    const grouped = {};
    const selectedGroup = state.accountGroups.some(g=>g.name===$('asset-group').value)?$('asset-group').value:''; $('asset-group').innerHTML = options(state.accountGroups.map(g=>g.name),selectedGroup,'全部分组');
    for (const a of state.accounts) if ((!a.archived || $('show-archived-accounts').checked) && (!selectedGroup || a.group===selectedGroup) && (!$('asset-search').value || (a.name+' '+a.note).toLowerCase().includes($('asset-search').value.toLowerCase()))) (grouped[a.group] ||= []).push(a);
    $('account-groups').innerHTML = Object.entries(grouped).map(([g,list]) => '<details open class="bk-panel bk-account-group"><summary>' + esc(g) + ' · ' + list.length + ' 个账户</summary><p class="bk-muted">' + (list.some(a=>a.balance==null)?'证券行情待补齐，暂不显示部分合计':Object.entries(list.reduce((t,a)=>{t[a.currency]=(t[a.currency]||0)+a.balance;return t;},{})).map(([c,v])=>esc(c)+' '+m(v,c)).join(' · ')) + '（当前列表余额）</p>' + list.map(a => '<div class="bk-account"><span class="bk-badge">' + esc(a.icon || '◈') + '</span><div class="bk-entry-main"><strong>' + esc(a.name) + (a.balanceSource==='portfolio'?' <small class="bk-muted">证券联动</small>':'') + (a.archived?' <small class="bk-muted">已归档</small>':'') + (!a.included?' <small class="bk-muted">不计入</small>':'') + '</strong><p>' + esc(a.currency + ' · ' + a.accountType + (a.note?' · '+a.note:'')) + '</p>' + (a.creditLimit ? '<p>可用额度 ' + m(a.creditLimit+a.balance,a.currency) + (a.billDay?' · 账单日 '+a.billDay+' 日':'') + (a.dueDay?' · 还款日 '+a.dueDay+' 日':'') + '</p>':'') + '<div class="bk-asset-controls"><button data-account-ledger="' + a.id + '">明细</button>' + (a.investment && (me.permissions.includes('*') || me.permissions.includes('service:stock-manage:edit') || me.permissions.includes('service:stock-manage:accounts:view'))?'<a href="/stock-manage/?accountId='+encodeURIComponent(a.investment.id)+'&showAccounts=1">证券明细／现金核对</a>':'') + (can('accounts:edit')?'<button data-account-edit="' + a.id + '">编辑</button>' + (!a.archived && !a.investment?'<button data-account-adjust="' + a.id + '">核对余额</button>':'') + management.accountActions(a):'') + '</div></div><div class="bk-entry-amount ' + (a.balance<0?'bk-expense':'') + '">' + (a.balance==null?'行情待补齐':m(a.balance,a.currency)) + '</div></div>').join('') + '</details>').join('') || '<p class="bk-empty">暂无账户。可新增账户或导入账户快照。</p>';
  }
  let periodSave = Promise.resolve(), periodReload=0;
  const periods = window.createBookkeepingPeriods({ $, load:reloadPeriod, clearFocus:()=>analysis.clearFocus(), save:value=>{periodSave=periodSave.then(()=>write('/preferences',value,'PUT')).catch(e=>{$('error').textContent='日期筛选保存失败：'+e.message;$('error').classList.remove('hidden');});} });
  const periodDock = window.createBookkeepingPeriodDock({ $, can });
  const accountScope = window.createBookkeepingScope({$,esc,can,write,load,capturePosition:()=>periodDock.capturePosition()});
  async function reloadPeriod() {
    const ticket=++periodReload, restore=periodDock.capturePosition();periodDock.setLoading(true);
    await load();
    if(ticket===periodReload){restore?.();periodDock.setLoading(false);}
  }
  const analysis = window.createBookkeepingAnalysis({ $, esc, m, money, can, load, tab, getState:()=>state, periods });
  const management = window.createBookkeepingManagement({ $, esc, can, api, write, load, field, select, options, getState:()=>state, openEditor });
  const details = window.createBookkeepingDetails({ $, esc, m, can, api, getState:()=>state, tab, openEditor, remove:async item=>{
    if(!window.confirm('删除这条账单？新账单会撤销对账户余额的影响。'))return false;
    await api('/entries/'+item.id,{method:'DELETE'});await load();return true;
  } });
  async function load(append = false) {
    const seq = ++loadSequence; $('error').classList.add('hidden');
    try {
      const params = query(); params.set('limit',String(pageSize)); params.set('offset',append?String(state.entries.length):'0');
      const data = await api('/state?' + params);
      if (seq !== loadSequence) return;
      if (append) data.entries = state.entries.concat(data.entries);
      state = data;
      window.initQqBookkeeping(can,state);
      for(const id of ['add-entry','add-account','add-category'])$(id).disabled=false;
      populate('book',state.books,'所有账本'); populate('category',state.categories,'所有分类'); populate('account',state.accounts.map(a => ({ value:a.id, label:a.name })),'所有账户');
      renderEntries(); renderAccounts(); management.render();accountScope.render(state.analysisScope);
    } catch (e) { $('error').textContent = e.message; $('error').classList.remove('hidden'); }
  }
  function tab(name) {
    const previousTab=activeTab;
    activeTab = name;
    document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active',b.dataset.tab===(name==='entry-detail'?'entries':name)));
    document.querySelectorAll('.bk-view').forEach(v => v.classList.toggle('hidden',v.id!==name+'-view'));
    $('filters').classList.toggle('hidden',['accounts','catalog','entry-detail'].includes(name));$('period-selector').classList.toggle('hidden',['catalog','entry-detail'].includes(name));
    periodDock.setTab(name);
    accountScope.setTab(name);
    if(name==='entries' && previousTab==='entry-detail')details.restoreList(()=>activeTab==='entries');
  }
  function field(name, label, value = '', extra = '') { return '<label>' + esc(label) + '<input name="' + name + '" value="' + esc(value) + '" ' + extra + '></label>'; }
  function select(name, label, values, selected = '', empty = null) { return '<label>' + esc(label) + '<select name="' + name + '" aria-label="' + esc(label) + '">' + options(values,selected,empty) + '</select></label>'; }
  const accountOptions = () => {
    const list=state.accounts.filter(a=>!a.archived || [editing?.item.accountId,editing?.item.toAccountId].includes(a.id)).map(a => ({ value:a.id, label:a.name+' · '+a.currency }));
    for(const [id,name] of [[editing?.item.accountId,editing?.item.accountName],[editing?.item.toAccountId,editing?.item.toAccountName]]) if(id && !list.some(a=>a.value===id))list.push({value:id,label:name||'原关联账户'});
    return list;
  };
  let locationCapture=null;
  function openEditor(mode, item = {}, detailGroup = null) {
    locationCapture?.cancel(); locationCapture=null;
    editing = { mode, item, detailGroup };
    $('editor').classList.toggle('bk-field-editor',!!detailGroup); $('editor-error').textContent = ''; $('save-item').disabled = false;
    $('delete-item').classList.toggle('hidden',!!detailGroup || !item.id || !['entry','account'].includes(mode) || !can(mode==='entry'?'entries:edit':'accounts:edit'));
    let html = '';
    if (mode === 'entry') {
      $('editor-title').textContent = detailGroup ? '修改'+window.bookkeepingDetailGroups[detailGroup].label : item.id ? '编辑账单' : '记一笔';
      html = select('type','类型',item.type==='余额调整'?[...types,'余额调整']:types,item.type||'支出') + field('amount','金额',item.amount??'','type="number" step="0.01" required') + select('currency','货币',currencies,item.currency||'CNY') + field('date','日期与时间',item.date||now(),'type="datetime-local" step="1" required') + select('category','一级分类',[],item.category) + select('subcategory','二级分类',[],item.subcategory,'无二级分类') + select('accountId','付款 / 收款账户',accountOptions(),item.accountId,'未关联账户') + select('toAccountId','转入账户',accountOptions(),item.toAccountId,'请选择') + field('toAmount','跨币种到账金额',item.toAmount??'','type="number" min="0.01" step="0.01"') + field('fee','手续费（付款币种）',item.fee||0,'type="number" min="0" step="0.01"') + field('book','账本',item.book||$('book').value||'个人账本','required') + field('tags','标签',item.tags) + '<label><span class="bk-location-heading">位置 <small id="location-status"></small></span><span class="bk-location-input"><input name="location" aria-label="位置" value="'+esc(item.location)+'"><button type="button" id="location-retry" class="btn ghost" aria-label="重新获取当前位置" title="重新获取当前位置">⌖</button></span></label>' + field('refund','退款信息（辅助字段）',item.refund||0,'type="number" min="0" step="0.01"') + field('discount','优惠信息（辅助字段）',item.discount||0,'type="number" min="0" step="0.01"') + '<label class="full">备注<textarea name="note" maxlength="5000">' + esc(item.note) + '</textarea></label><datalist id="category-suggestions">' + state.categories.map(c => '<option value="'+esc(c)+'">').join('') + '</datalist>';
      if (item.historical) html += '<p class="bk-form-hint">这是历史导入记录，编辑或删除不会改变资产基准。原导出的跨币种转账没有到账金额。</p>';
    } else if (mode === 'account') {
      $('editor-title').textContent = item.id?'编辑账户':'新增账户';
      html = field('name','账户名称',item.name,'required maxlength="100"') + select('group','资产分组',state.accountGroups.length?state.accountGroups.map(g=>g.name):['资金账户'],item.group||state.accountGroups[0]?.name||'资金账户') + select('accountType','账户类型',['现金','银行卡','信用卡','储值卡','投资账户','社保账户','应收款','应付款','其他资产'],item.accountType||'其他资产') + field('icon','账户图标',item.icon||'◈','maxlength="20"') + select('currency','货币',currencies,item.currency||'CNY') + (item.id?'<p class="bk-form-hint">当前余额 '+m(item.balance,item.currency)+'，如需修改请使用“核对余额”。</p>':field('balance','初始余额（负数为欠款）',0,'type="number" step="0.01" required')) + field('creditLimit','信用额度',item.creditLimit||0,'type="number" min="0" step="0.01"') + field('billDay','账单日（0 表示未设置）',item.billDay||0,'type="number" min="0" max="31"') + field('dueDay','还款日（0 表示未设置）',item.dueDay||0,'type="number" min="0" max="31"') + field('note','账户备注',item.note) + '<label>计入总资产<input type="checkbox" name="included" '+(item.included!==false?'checked':'')+'></label>';
    } else if (mode === 'adjust') {
      $('editor-title').textContent = '核对余额 · ' + item.name;
      html = field('balance','实际余额（'+item.currency+'）',item.balance,'type="number" step="0.01" required') + field('date','调整时间',now(),'type="datetime-local" step="1" required') + field('note','调整原因','手动核对余额') + '<p class="bk-form-hint">保存一条余额调整记录，使账户余额等于填写值，不计入收支。</p>';
    } else {
      $('editor-title').textContent = '预算与汇率';
      html = field('budgetMonth','预算月份',$('month').value||now().slice(0,7),'type="month" required') + field('budget','人民币月预算',state.settings.budgets[$('month').value]||0,'type="number" min="0" step="0.01" required') + '<p class="bk-form-hint">默认自动获取参考汇率。下列手动值仅在自动更新失败时备用；留空则使用上次成功缓存或显示缺失。</p>' + currencies.filter(c=>c!=='CNY').map(c=>field('rate_'+c,c+' → CNY（手动备用值）',state.settings.rates[c]||'','type="number" min="0.000001" step="any"')).join('');
    }
    $('editor-fields').innerHTML = html;
    const readonly = mode==='entry' && !can('entries:edit');
    $('editor-fields').querySelectorAll('input,select,textarea').forEach(el=>el.disabled=readonly); $('save-item').classList.toggle('hidden',readonly);
    $('editor').showModal();
    if (mode==='entry') {
      const form = $('editor-form'), t = form.elements.type; form.elements.amount.inputMode='decimal';
      locationCapture=window.createBookkeepingLocation({input:form.elements.location,status:$('location-status'),retry:$('location-retry'),active:()=>editing?.mode==='entry' && $('editor').open && form.elements.location===$('editor-form').elements.location,enabled:!readonly && can('location:edit')});
      if(!item.id)void locationCapture.start();
      management.bindCategoryPicker(form,item);
      const update = () => { const transfer = transferTypes.includes(t.value); ['toAccountId','toAmount'].forEach(n=>form.elements[n].closest('label').classList.toggle('hidden',!transfer)); if (!transfer) { form.elements.toAccountId.value=''; form.elements.toAmount.value=''; } applyDetailScope(); };
      function applyDetailScope(){
        if(!detailGroup)return;
        const allowed=new Set(window.bookkeepingDetailGroups[detailGroup].fields);
        if(detailGroup==='category' && transferTypes.includes(t.value))for(const n of ['accountId','currency','toAccountId','toAmount'])allowed.add(n);
        if(!transferTypes.includes(t.value)){allowed.delete('toAccountId');allowed.delete('toAmount');}
        for(const label of $('editor-fields').querySelectorAll(':scope > label')){const control=label.querySelector('[name]');label.classList.toggle('hidden',!control || !allowed.has(control.name));}
        $('editor-fields').querySelectorAll('.bk-form-hint').forEach(el=>el.classList.add('hidden'));
      }
      t.addEventListener('change',update); update();
      form.elements.accountId.addEventListener('change',()=>{ const a=state.accounts.find(a=>a.id===form.elements.accountId.value); if(a) form.elements.currency.value=a.currency; });
      if(detailGroup){const control=form.elements[window.bookkeepingDetailGroups[detailGroup].fields[0]];control?.focus({preventScroll:true});if(control?.name==='amount')control.select();}
    }
  }
  $('editor-form').addEventListener('submit',async event=>{
    event.preventDefault(); if($('save-item').disabled)return;
    const opened=editing; $('save-item').disabled=true;
    if(opened.mode==='entry'){await locationCapture?.wait();if(editing!==opened || !$('editor').open)return;}
    const input = Object.fromEntries(new FormData(event.target)); const { mode,item } = editing; $('save-item').disabled=true;
    try {
      if (mode==='entry') { if (!input.toAmount) delete input.toAmount; await write('/entries'+(item.id?'/'+item.id:''),input,item.id?'PUT':'POST'); }
      else if (mode==='account') { input.included=event.target.elements.included.checked; await write('/accounts'+(item.id?'/'+item.id:''),input,item.id?'PUT':'POST'); }
      else if (mode==='adjust') await write('/accounts/'+item.id+'/adjust',input);
      else { const rates={ CNY:1 }, budgets={...state.settings.budgets}; for(const c of currencies) if(input['rate_'+c]) rates[c]=Number(input['rate_'+c]); budgets[input.budgetMonth]=Number(input.budget); await write('/settings',{rates,budgets},'PUT'); }
      await load(); if(mode==='entry' && opened.detailGroup)await details.refresh(item.id); $('editor').close(); window.portalToast?.success('已保存');
    } catch(e) { $('editor-error').textContent=e.message; } finally { $('save-item').disabled=false; }
  });
  $('delete-item').addEventListener('click',async()=>{
    if(!window.confirm(editing.mode==='entry'?'删除这条账单？新账单会撤销对账户余额的影响。':'删除这个账户？存在关联账单时不能删除。')) return;
    try { await api('/'+(editing.mode==='entry'?'entries':'accounts')+'/'+editing.item.id,{method:'DELETE'}); await load(); $('editor').close(); } catch(e) { $('editor-error').textContent=e.message; }
  });
  for(const id of ['editor','manager-editor']) {
    const dialog=$(id); let outside=false;
    const isOutside=e=>{const r=dialog.getBoundingClientRect();return e.target===dialog && (e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom);};
    dialog.addEventListener('pointerdown',e=>{outside=isOutside(e);});
    dialog.addEventListener('click',e=>{if(outside && isOutside(e))dialog.close();outside=false;});
  }
  $('editor').addEventListener('close',()=>{if(!$('editor').open)locationCapture?.cancel();});
  $('close-editor').onclick=()=>$('editor').close();
  $('add-entry').onclick=()=>openEditor('entry'); $('add-account').onclick=()=>openEditor('account'); $('settings').onclick=()=>openEditor('settings');
  document.querySelector('.bk-tabs').addEventListener('click',e=>{const b=e.target.closest('[data-tab]');if(b)tab(b.dataset.tab);});
  $('entry-list').addEventListener('click',e=>{const b=e.target.closest('[data-entry]');if(b)details.open(state.entries.find(x=>x.id===b.dataset.entry));});
  $('account-groups').addEventListener('click',e=>{
    const b=e.target.closest('button'); if(!b)return;
    if(b.dataset.accountLedger){analysis.clearFocus();periods.choose('all',false);for(const id of ['month','book','currency','type','category','search'])$(id).value='';$('account').value=b.dataset.accountLedger;tab('entries');load();}
    if(b.dataset.accountEdit)openEditor('account',state.accounts.find(a=>a.id===b.dataset.accountEdit));
    if(b.dataset.accountAdjust)openEditor('adjust',state.accounts.find(a=>a.id===b.dataset.accountAdjust));
  });
  for(const id of ['month','book','currency','type','category','account'])$(id).addEventListener('change',()=>{analysis.clearFocus();load();});
  let searchTimer; $('search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>load(),250);});
  $('all-dates').onclick=()=>periods.choose('all'); $('more').onclick=()=>load(true);
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
  $('refresh-fx').onclick = () => refreshFx(true); $('refresh-asset-fx').onclick = () => refreshFx(true);
  async function boot(){
    try { const r=await fetch('/api/me'); me=await r.json();if(me.isGuest||!me.ok)throw new Error('请登录后访问记账模块');$('owner').textContent=me.dataContext&&me.dataContext.scope!=='self'?me.dataContext.label:me.username;
      populate('currency',currencies,'全部货币');$('currency').value='';populate('type',[...types,'余额调整'],'所有类型');$('month').value=now().slice(0,7);
      $('extra-filters').open = window.innerWidth > 760;
      for(const [id,p] of [['add-entry','entries:edit'],['add-account','accounts:edit'],['settings','settings:edit'],['import-label','import:edit'],['snapshot-label','accounts:edit'],['export','export:view'],['import-shortcut','import:edit']])$(id).classList.toggle('hidden',!can(p));
      for (const id of ['refresh-fx','refresh-asset-fx']) $(id).classList.toggle('hidden', !can('fx:edit'));
      document.querySelector('[data-tab="stats"]').classList.toggle('hidden',!can('analysis:view'));
      document.querySelector('[data-tab="catalog"]').classList.toggle('hidden',!can('categories:view'));
      $('add-category').classList.toggle('hidden',!can('categories:edit')); $('manage-groups').classList.toggle('hidden',!can('accounts:edit'));
      document.querySelector('[data-tab="accounts"]').classList.toggle('hidden',!can('accounts:view'));$('account-filter-label').classList.toggle('hidden',!can('accounts:view'));
      document.querySelector('[data-tab="import"]').classList.toggle('hidden',!can('import:edit')&&!can('export:view'));
      periods.hydrate((await api('/preferences')).period);
      await load();
      if (state) refreshFx();
    }catch(e){$('error').textContent=e.message;$('error').classList.remove('hidden');}
  }
  boot();
  let investmentSyncBusy=false;
  const syncInvestmentAccounts=async()=>{
    if(document.hidden || activeTab!=='accounts' || !state?.accounts?.some(a=>a.investment) || document.querySelector('dialog[open]') || investmentSyncBusy)return;
    investmentSyncBusy=true;try{await load();}catch{}finally{investmentSyncBusy=false;}
  };
  document.addEventListener('visibilitychange',syncInvestmentAccounts);
  setInterval(syncInvestmentAccounts,15000);
})();
