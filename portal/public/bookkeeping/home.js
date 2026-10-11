(function () {
  const node = document.getElementById('bookkeeping-home');
  const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  fetch('/api/me').then(r=>r.json()).then(async me=>{
    if(me.isGuest || !me.ok || !(me.permissions||[]).some(p=>['*','bookkeeping:*','bookkeeping:view'].includes(p)))return;
    node.classList.remove('hidden');
    const d=new Date(), month=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
    const r=await fetch('/api/bookkeeping/state?month='+month+'&limit=1'); const data=await r.json();
    if(!r.ok)throw new Error(data.error);
    const metrics=Object.entries(data.summary.totals).map(([c,t])=>{
      const fmt=n=>esc(new Intl.NumberFormat('zh-CN',{style:'currency',currency:c}).format(n));
      return '<div><span>'+esc(c)+' 本月支出</span><strong>'+fmt(t.expense)+'</strong><small>收入 '+fmt(t.income)+' · 结余 '+fmt(t.net)+'</small></div>';
    }).join('');
    document.getElementById('bookkeeping-home-summary').innerHTML=metrics||'<p>还没有本月账单，记下第一笔或导入 iCost 历史记录。</p>';
  }).catch(()=>{if(node && !node.classList.contains('hidden'))document.getElementById('bookkeeping-home-summary').textContent='账本暂时无法加载，请进入模块重试。';});
})();
