(function () {
  'use strict';
  window.createBookkeepingAnalysis = function ({ $, esc, m, money, can, load, tab, getState, periods }) {
    const fields=['period-kind','period-anchor','range-start','range-end','month','book','currency','type','category','account','search'];
    let focus={}, saved=null;
    const attr = data => ' data-drill="'+esc(JSON.stringify(data))+'"';
    function clearFocus() {focus={};saved=null;periods.restore();$('drill-context').classList.add('hidden');}
    function drill(data) {
      if(!can('view'))return;
      if(!saved)saved={values:Object.fromEntries(fields.map(id=>[id,$(id).value])),focus:{...focus}};
      for(const id of ['currency','month','category']) if(data[id]!==undefined)$(id).value=data[id];
      periods.focusDate(data);
      if(data.month!==undefined){focus.day=data.day||'';focus.through='';}
      if(data.day!==undefined)focus.day=data.day;
      if(data.through!==undefined){focus.through=data.through;focus.day='';}
      if(data.flow!==undefined)focus.flow=data.flow;
      const names={expense:'净支出构成（含退款、报销和手续费）',income:'收入',net:'收入与净支出构成'};
      $('drill-label').textContent=[$('category').value,focus.day||$('month').value, focus.through?'截至 '+focus.through:'',$('currency').value,names[focus.flow]].filter(Boolean).join(' · ');
      $('drill-context').classList.remove('hidden');tab('entries');load();$('drill-context').scrollIntoView({block:'nearest'});
    }
    document.querySelector('.bk-shell').addEventListener('click',e=>{const target=e.target.closest('[data-drill]');if(target)drill(JSON.parse(target.dataset.drill));});
    document.querySelector('.bk-shell').addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ') && e.target.matches('circle[data-drill]')){e.preventDefault();drill(JSON.parse(e.target.dataset.drill));}});
    $('return-stats').onclick=()=>{if(saved){for(const [id,v] of Object.entries(saved.values))$(id).value=v;focus=saved.focus;}saved=null;periods.restore();$('drill-context').classList.add('hidden');tab(can('analysis:view')?'stats':'entries');load();};
    function period(point,granularity,flow) {
      if(flow==='cumulative')return {currency:$('currency').value,through:granularity==='month'?new Date(Date.UTC(Number(point.date.slice(0,4)),Number(point.date.slice(5,7)),0)).toISOString().slice(0,10):point.date,flow:'net'};
      return {currency:$('currency').value,month:point.date.slice(0,7),...(granularity==='day'?{day:point.date}:{}),flow};
    }
    function chart(points,lines,label,granularity=null) {
      if(!points.length)return '<p class="bk-empty">暂无记录</p>';
      const width=600,height=230,left=76,right=20,top=18,bottom=36;
      const values=points.flatMap(p=>lines.map(l=>p[l.key])), min=Math.min(0,...values), max=Math.max(0,...values), span=max-min||1;
      const time=p=>Date.parse((p.date.length===7?p.date+'-01':p.date)+'T12:00:00Z'),firstTime=time(points[0]),lastTime=time(points.at(-1));
      const x=i=>left+(points.length===1?(width-left-right)/2:(time(points[i])-firstTime)/(lastTime-firstTime||1)*(width-left-right));
      const y=value=>height-bottom-(value-min)/span*(height-top-bottom);
      let svg='<svg viewBox="0 0 '+width+' '+height+'" role="group" aria-label="'+esc(label)+'" class="bk-line-chart" data-money>';
      for(let i=0;i<=4;i++) {const value=min+span*i/4;svg+='<line x1="'+left+'" x2="'+(width-right)+'" y1="'+y(value)+'" y2="'+y(value)+'" class="bk-grid-line"/><text x="'+(left-9)+'" y="'+(y(value)+4)+'" text-anchor="end">'+esc(new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1}).format(value))+'</text>';}
      for(const line of lines) {
        svg+='<polyline points="'+points.map((p,i)=>x(i)+','+y(p[line.key])).join(' ')+'" fill="none" stroke="'+line.color+'" stroke-width="2.5"/>';
        svg+=points.map((p,i)=>{
          if(!granularity && i%Math.max(1,Math.ceil(points.length/60))!==0 && i!==points.length-1)return '';
          const title=(p.periodBoundary==='opening'?'范围期初 · ':'')+p.date+' '+line.label+' '+money(p[line.key],p.currency)+(p.source==='current'?' · 今日暂估':p.source==='ledger'?' · 账单反推':p.source==='valuation'?' · 估值快照':p.source==='carried'?' · 沿用 '+p.asOf+' 观测':'');
          return '<circle cx="'+x(i)+'" cy="'+y(p[line.key])+'" r="4.5" fill="'+line.color+'"'+(granularity?' tabindex="0" role="button" aria-label="'+esc(title+'，查看账单')+'"'+attr(period(p,granularity,line.key==='income'?'income':line.key==='expense'?'expense':'cumulative')):'')+'><title>'+esc(title)+'</title></circle>';
        }).join('');
      }
      for(const i of [...new Set([0,Math.floor((points.length-1)/2),points.length-1])])svg+='<text x="'+x(i)+'" y="'+(height-10)+'" text-anchor="middle">'+esc((points[i].periodBoundary==='opening'?'期初 ':points[i].source==='current'?'暂估 ':'')+points[i].date)+'</text>';
      svg+='</svg>';
      const last=points.at(-1);
      return '<div class="bk-chart-card"><h3>'+esc(label)+'</h3><div class="bk-chart-legend">'+lines.map(l=>'<span style="--line-color:'+l.color+'">'+esc(l.label+(['income','expense'].includes(l.key)?'合计':''))+' '+m(['income','expense'].includes(l.key)?Math.round(points.reduce((n,p)=>n+p[l.key],0)*100)/100:last[l.key],last.currency)+'</span>').join('')+'</div>'+svg+(points.length===1?'<p class="bk-muted">目前仅有一个基准点，后续账单会形成走势。</p>':'')+'</div>';
    }
    function suggestion(item,currency) {
      if(item.kind==='concentration')return '“'+esc(item.category)+'”占正向分类支出的 '+(item.share*100).toFixed(1)+'%。“固定、一次性和可选支出”应分别核对，优先检查大额项目。'+(item.target!==null?'如有可调整部分，下期可试设比该完整月份低 10% 的参考目标 '+m(item.target,currency)+'。':'选择最近一个完整月份后，再为可调整的消费设置下期预算。');
      if(item.kind==='deficit')return '本筛选范围支出超过已记录收入 '+m(item.amount,currency)+'。先核对收入是否完整，再决定削减可选消费或调整预算。';
      if(item.kind==='over-budget')return '本月净支出超过人民币预算 '+m(-item.remaining,currency)+'。核对剩余必需支出，暂停可以延后的购买。';
      if(item.kind==='budget')return '人民币月预算尚余 '+m(item.remaining,currency)+'。为月底的固定开销预留额度。';
      if(item.kind==='increase')return '同范围支出较 '+esc(item.previous)+' 增长 '+(item.change*100).toFixed(1)+'%，建议打开分类明细核对一次性大额支出。';
      return '可从“'+esc(item.category)+'”明细检查重复订阅和可延后的购买，结合实际需求设定分类预算。';
    }
    function render() {
      const analysis=getState()?.analysis;if(!analysis){for(const id of ['spending-insights','billing-charts','asset-overview-charts'])$(id).innerHTML='';$('asset-overview').classList.add('hidden');return;}
      $('billing-charts').innerHTML=analysis.billing.missingCurrencies.length?'<p class="bk-empty">缺少 '+esc(analysis.billing.missingCurrencies.join('、'))+' 汇率，暂不能汇总 CNY 走势。</p>':chart(analysis.billing.points,[{key:'income',label:'收入',color:'var(--green)'},{key:'expense',label:'净支出',color:'var(--red)'},{key:'cumulative',label:'累计账单结余',color:'#d89812'}],'CNY 等效总收支走势',analysis.billing.granularity)||'<p class="bk-empty">当前筛选无账单，可选择全部日期查看历史走势。</p>';
      $('spending-insights').innerHTML=analysis.insights.map(i=>'<section class="bk-insight"><h3>'+esc(i.currency)+' · '+i.count+' 笔账单</h3><p>收入 '+m(i.income,i.currency)+'，净支出 '+m(i.expense,i.currency)+'，结余 '+m(i.net,i.currency)+'。</p>'+(i.topCategory?'<p>最大支出分类 <button class="bk-text-button"'+attr({category:i.topCategory.category,currency:$('currency').value,flow:'expense'})+'>'+esc(i.topCategory.category)+' →</button> '+m(i.topCategory.amount,i.currency)+'，占正向分类支出的 <span data-money>'+(i.share*100).toFixed(1)+'%</span>。</p>':'')+(i.comparison?'<p>较 '+esc(i.comparison.month)+' '+(i.comparison.change>=0?'增长':'下降')+' <span data-money>'+Math.abs(i.comparison.change*100).toFixed(1)+'%</span>。</p>':'')+'<ul>'+i.suggestions.map(s=>'<li>'+suggestion(s,i.currency)+'</li>').join('')+'</ul></section>').join('')+'<p class="bk-muted">'+esc(analysis.comparisonNote)+' 分类建议基于当前记录，未设置预算时不推测你的收入或消费能力。</p>';
      const assets=analysis.asset;
      $('asset-overview').classList.toggle('hidden',!assets);if(!assets){$('asset-overview-charts').innerHTML='';}
      if(assets) {
        $('asset-overview-note').textContent=assets.note+(assets.currentOnly || assets.historyMode==='hybrid'?'':' 反推使用全部关联账单，再按所选日期范围截取；账本、分类等收支筛选不改变反推基础。');
        $('asset-overview-charts').innerHTML=assets.currentOnly?'<p class="bk-muted">证券账户当前估值已联动；缺少逐日估值快照，暂不生成历史净值曲线。</p>':assets.missingValuations?.length?'<p class="bk-empty">请补齐证券行情后查看资产合计。</p>':assets.missingCurrencies.length?'<p class="bk-empty">缺少 '+esc(assets.missingCurrencies.join('、'))+' 汇率，暂不能反推 CNY 资产走势。</p>':(assets.points.length?chart(assets.points,[{key:'balance',label:assets.historyMode==='hybrid'?'历史账面／估值净资产':'反推净资产',color:'#d89812'}],'CNY 等效总资产走势')+(assets.historyMode==='hybrid'?'':'<p class="bk-muted">以当前资产余额为反推锚点，所选历史范围期末可能不同；'+assets.estimatedTransfers+' 笔跨币种转账按等值估算，'+assets.unlinkedEntries+' 笔未关联账户记录按总资产变化估算。</p>'):'<p class="bk-empty">暂无计入总资产的账户</p>');
      }
    }
    return {render,attr,query:()=>focus,clearFocus,drill};
  };
})();
