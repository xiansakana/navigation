(function () {
  'use strict';
  window.createBookkeepingAnalysis = function ({ $, esc, m, money, can, load, tab, getState, periods }) {
    const fields=['period-kind','period-anchor','range-start','range-end','month','book','currency','type','category','account','search'];
    let focus={}, saved=null;
    let assetChart='balance';
    const assetChartTabs=$('asset-chart-tabs');
    assetChartTabs.addEventListener('click',event=>{
      const button=event.target.closest('[data-asset-chart]');if(!button || button.hidden)return;
      assetChart=button.dataset.assetChart;renderAsset();button.focus({preventScroll:true});
      if(assetChart==='returns')load();
    });
    assetChartTabs.addEventListener('keydown',event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      const buttons=[...assetChartTabs.querySelectorAll('button')].filter(b=>!b.hidden);
      const index=buttons.indexOf(document.activeElement);if(index<0)return;
      event.preventDefault();buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowLeft'?-1:1)+buttons.length)%buttons.length].click();
    });
    const hiddenBillingSeries=new Set(), billingLines=[{key:'income',label:'收入',color:'var(--green)'},{key:'expense',label:'净支出',color:'var(--red)'},{key:'cumulative',label:'累计账单结余',color:'#d89812'}];
    const hiddenTradingSeries=new Set(),tradingLines=[{key:'realized',label:'范围已实现净收益',color:'var(--green)'},{key:'unrealized',label:'范围浮盈变化',color:'#579cf0'},{key:'total',label:'范围证券总收益',color:'#d89812'}];
    const tradingChart=points=>chart(points,tradingLines,'CNY 证券收益走势（所选范围）',null,'trading');
    $('asset-overview-charts').addEventListener('click',event=>{
      const key=event.target.closest('[data-trading-series]')?.dataset.tradingSeries;
      if(!tradingLines.some(line=>line.key===key))return;
      if(hiddenTradingSeries.has(key))hiddenTradingSeries.delete(key);else hiddenTradingSeries.add(key);
      const points=getState()?.analysis?.investmentReturns?.trading?.points,card=$('asset-overview-charts').querySelector('.bk-trading-history .bk-chart-card');
      if(!points||!card)return;
      card.outerHTML=tradingChart(points);
      $('asset-overview-charts').querySelector('[data-trading-series="'+key+'"]').focus({preventScroll:true});
    });
    const attr = data => ' data-drill="'+esc(JSON.stringify(data))+'"';
    function clearFocus() {focus={};saved=null;periods.restore();$('drill-context').classList.add('hidden');}
    function drill(data) {
      if(!can('view'))return;
      if(!saved)saved={values:Object.fromEntries(fields.map(id=>[id,$(id).value])),focus:{...focus}};
      if(!$('stats-view').classList.contains('hidden'))focus.analysisScope='1';
      for(const id of ['currency','month','category']) if(data[id]!==undefined)$(id).value=data[id];
      periods.focusDate(data);
      if(data.month!==undefined){focus.day=data.day||'';focus.through='';}
      if(data.day!==undefined)focus.day=data.day;
      if(data.through!==undefined){focus.through=data.through;focus.day='';}
      if(data.flow!==undefined)focus.flow=data.flow;
      const names={expense:'净支出构成（含退款、报销和手续费）',income:'收入',net:'收入与净支出构成'};
      $('drill-label').textContent=[$('category').value,focus.day||$('month').value, focus.through?'截至 '+focus.through:'',$('currency').value,names[focus.flow],focus.analysisScope&&getState()?.analysisScope?.excludedAccountIds?.length?'已排除社保公积金等账户':''].filter(Boolean).join(' · ');
      $('drill-context').classList.remove('hidden');tab('entries');load();$('drill-context').scrollIntoView({block:'nearest'});
    }
    document.querySelector('.bk-shell').addEventListener('click',e=>{const target=e.target.closest('[data-drill]');if(target)drill(JSON.parse(target.dataset.drill));});
    document.querySelector('.bk-shell').addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ') && e.target.matches('circle[data-drill]')){e.preventDefault();drill(JSON.parse(e.target.dataset.drill));}});
    $('return-stats').onclick=()=>{if(saved){for(const [id,v] of Object.entries(saved.values))$(id).value=v;focus=saved.focus;}saved=null;periods.restore();$('drill-context').classList.add('hidden');tab(can('analysis:view')?'stats':'entries');load();};
    $('billing-charts').addEventListener('click',event=>{
      const key=event.target.closest('[data-billing-series]')?.dataset.billingSeries;
      if(!billingLines.some(line=>line.key===key))return;
      if(hiddenBillingSeries.has(key))hiddenBillingSeries.delete(key);else hiddenBillingSeries.add(key);
      renderBilling();$('billing-charts').querySelector('[data-billing-series="'+key+'"]').focus({preventScroll:true});
    });
    function period(point,granularity,flow) {
      if(flow==='cumulative')return {currency:$('currency').value,through:granularity==='month'?new Date(Date.UTC(Number(point.date.slice(0,4)),Number(point.date.slice(5,7)),0)).toISOString().slice(0,10):point.date,flow:'net'};
      return {currency:$('currency').value,month:point.date.slice(0,7),...(granularity==='day'?{day:point.date}:{}),flow};
    }
    function chart(points,lines,label,granularity=null,toggle=false) {
      if(!points.length)return '<p class="bk-empty">暂无记录</p>';
      const hiddenSeries=toggle==='trading'?hiddenTradingSeries:hiddenBillingSeries;
      const seriesAttribute=toggle==='trading'?'data-trading-series':'data-billing-series';
      const visibleLines=toggle?lines.filter(line=>!hiddenSeries.has(line.key)):lines;
      const width=600,height=230,left=76,right=20,top=18,bottom=36;
      const values=points.flatMap(p=>visibleLines.map(l=>p[l.key])).filter(Number.isFinite), min=Math.min(0,...values), max=Math.max(0,...values), span=max-min||1;
      const time=p=>Date.parse((p.date.length===7?p.date+'-01':p.date)+'T12:00:00Z'),firstTime=time(points[0]),lastTime=time(points.at(-1));
      const x=i=>left+(points.length===1?(width-left-right)/2:(time(points[i])-firstTime)/(lastTime-firstTime||1)*(width-left-right));
      const y=value=>height-bottom-(value-min)/span*(height-top-bottom);
      let svg='<svg viewBox="0 0 '+width+' '+height+'" role="group" aria-label="'+esc(label)+'" class="bk-line-chart" data-money>';
      if(!visibleLines.length)svg+='<text x="'+width/2+'" y="'+height/2+'" text-anchor="middle">所有折线已隐藏，点击图例重新显示</text>';
      else for(let i=0;i<=4;i++) {const value=min+span*i/4;svg+='<line x1="'+left+'" x2="'+(width-right)+'" y1="'+y(value)+'" y2="'+y(value)+'" class="bk-grid-line"/><text x="'+(left-9)+'" y="'+(y(value)+4)+'" text-anchor="end">'+esc(new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1}).format(value))+'</text>';}
      for(const line of visibleLines) {
        const segments=[];let segment=[];
        points.forEach((p,i)=>{if(Number.isFinite(p[line.key]))segment.push(x(i)+','+y(p[line.key]));else if(segment.length){segments.push(segment);segment=[];}});if(segment.length)segments.push(segment);
        svg+='<g data-chart-series="'+line.key+'">'+segments.map(s=>'<polyline points="'+s.join(' ')+'" fill="none" stroke="'+line.color+'" stroke-width="2.5"/>').join('');
        svg+=points.map((p,i)=>{
          if(!Number.isFinite(p[line.key]))return '';
          if(!granularity && i%Math.max(1,Math.ceil(points.length/60))!==0 && i!==points.length-1 && Number.isFinite(points[i-1]?.[line.key]) && Number.isFinite(points[i+1]?.[line.key]))return '';
          const title=(p.periodBoundary==='opening'?'范围期初 · ':'')+p.date+' '+line.label+' '+money(p[line.key],p.currency)+(p.source==='current'?' · 今日暂估':p.source==='ledger'?' · 账单反推':p.source==='valuation'?' · 估值快照':p.source==='trades'?(p.provisional?' · 今日暂估／最新可用报价':' · 成交记录／历史收盘重建'):p.source==='carried'?' · 沿用 '+p.asOf+' 观测':'');
          return '<circle cx="'+x(i)+'" cy="'+y(p[line.key])+'" r="4.5" fill="'+line.color+'"'+(granularity?' tabindex="0" role="button" aria-label="'+esc(title+'，查看账单')+'"'+attr(period(p,granularity,line.key==='income'?'income':line.key==='expense'?'expense':'cumulative')):'')+'><title>'+esc(title)+'</title></circle>';
        }).join('');
        svg+='</g>';
      }
      for(const i of [...new Set([0,Math.floor((points.length-1)/2),points.length-1])])svg+='<text x="'+x(i)+'" y="'+(height-10)+'" text-anchor="middle">'+esc((points[i].periodBoundary==='opening'?'期初 ':points[i].source==='current'||points[i].provisional?'暂估 ':'')+points[i].date)+'</text>';
      svg+='</svg>';
      const last=points.at(-1);
      return '<div class="bk-chart-card"><h3>'+esc(label)+'</h3><div class="bk-chart-legend"'+(toggle?' role="group" aria-label="折线显隐，点击图例切换"':'')+'>'+lines.map(l=>{
        const title=l.label+(['income','expense'].includes(l.key)?'合计':''),amount=Number.isFinite(last[l.key])?m(['income','expense'].includes(l.key)?Math.round(points.reduce((n,p)=>n+p[l.key],0)*100)/100:last[l.key],last.currency):'待补齐';
        return toggle?'<button type="button" class="bk-series-toggle" '+seriesAttribute+'="'+l.key+'" aria-pressed="'+!hiddenSeries.has(l.key)+'" aria-label="'+esc(title+'折线')+'" style="--line-color:'+l.color+'"><span class="bk-series-label">'+esc(title)+'</span>'+amount+'</button>':'<span style="--line-color:'+l.color+'">'+esc(title)+' '+amount+'</span>';
      }).join('')+'</div>'+svg+(points.length===1?'<p class="bk-muted">目前仅有一个基准点，后续账单会形成走势。</p>':'')+'</div>';
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
      renderBilling();
      $('spending-insights').innerHTML=analysis.insights.map(i=>'<section class="bk-insight"><h3>'+esc(i.currency)+' · '+i.count+' 笔账单</h3><p>收入 '+m(i.income,i.currency)+'，净支出 '+m(i.expense,i.currency)+'，结余 '+m(i.net,i.currency)+'。</p>'+(i.topCategory?'<p>最大支出分类 <button class="bk-text-button"'+attr({category:i.topCategory.category,currency:$('currency').value,flow:'expense'})+'>'+esc(i.topCategory.category)+' →</button> '+m(i.topCategory.amount,i.currency)+'，占正向分类支出的 <span data-money>'+(i.share*100).toFixed(1)+'%</span>。</p>':'')+(i.comparison?'<p>较 '+esc(i.comparison.month)+' '+(i.comparison.change>=0?'增长':'下降')+' <span data-money>'+Math.abs(i.comparison.change*100).toFixed(1)+'%</span>。</p>':'')+'<ul>'+i.suggestions.map(s=>'<li>'+suggestion(s,i.currency)+'</li>').join('')+'</ul></section>').join('')+'<p class="bk-muted">'+esc(analysis.comparisonNote)+' 分类建议基于当前记录，未设置预算时不推测你的收入或消费能力。</p>';
      renderAsset();
    }
    function renderAsset() {
      const analysis=getState()?.analysis, assets=analysis?.asset;
      const allowed=can('accounts:returns:view') && !!analysis?.investmentReturns;
      $('asset-tab-returns').hidden=!allowed;
      if(assetChart==='returns' && !allowed)assetChart='balance';
      for(const button of assetChartTabs.querySelectorAll('button')){
        const active=button.dataset.assetChart===assetChart;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;
      }
      $('asset-overview-charts').setAttribute('aria-labelledby','asset-tab-'+assetChart);
      $('asset-overview').classList.toggle('hidden',!assets);if(!assets){$('asset-overview-charts').innerHTML='';}
      if(assets) {
        if(assetChart==='returns') {
          const returns=analysis.investmentReturns,period=returns.period;
          $('asset-overview-note').textContent=returns.note;
          const metrics=period?'<div class="bk-summary bk-return-summary">'+[['观测资产变化',period.assetChange],['账单净资金流',period.netFlow],['余额调整',period.adjustments],['综合投资收益（估算）',period.profit]].map(([label,value])=>'<div class="bk-metric"><p>'+esc(label)+'</p><strong>'+m(value,'CNY')+'</strong></div>').join('')+'</div><p class="bk-muted">'+esc(period.openingAsOf+' 至 '+period.closingAsOf)+(period.provisional?' · 今日暂估':'')+(period.partial?' · 仅含可比观测区间':'')+'</p>':'';
          const trading=returns.trading;
          if(trading)$('asset-overview-note').textContent='证券收益以所选范围期初为基准，展示范围内已实现净收益、浮盈变化及总收益；范围前交易仅用于还原成本，缺少期初或当日估值处留空。';
          const history=trading?'<section class="bk-trading-history"><h3>历史证券收益 · 成交重建</h3><details><summary>计算口径与覆盖范围</summary><p class="bk-muted">'+esc(trading.note)+'</p></details>'+(trading.pending?'<p role="status" class="bk-muted">后台正在补齐 '+trading.pending+' 个证券的历史行情；缺失处留空。</p>':'')+(trading.issues?.length?'<p class="bk-error">'+esc(trading.issues.slice(0,10).join('；'))+(trading.issues.length>10?' 等 '+trading.issues.length+' 项':'')+'</p>':'')+(trading.missingSymbols?.length?'<details><summary>缺失行情、汇率或历史持仓成本：'+trading.missingSymbols.length+' 个证券</summary><p class="bk-muted">'+esc(trading.missingSymbols.join('、'))+'</p></details>':'')+tradingChart(trading.points)+'</section>':'';
          $('asset-overview-charts').innerHTML=history+'<h3>全资产收益 · 估值快照</h3>'+(trading?'<details><summary>快照计算口径</summary><p class="bk-muted">'+esc(returns.note)+'</p></details>':'')+metrics+(returns.points.length?chart(returns.points,[{key:'profit',label:'累计综合投资收益（估算）',color:'#d89812'}],'CNY 等效综合投资收益走势'):'<p class="bk-empty">暂无可比快照收益数据，请查看计算口径。</p>');
          return;
        }
        $('asset-overview-note').textContent=assets.note+(assets.currentOnly || assets.historyMode==='hybrid'?'':' 反推使用全部关联账单，再按所选日期范围截取；账本、分类等收支筛选不改变反推基础。');
        $('asset-overview-charts').innerHTML=assets.currentOnly?'<p class="bk-muted">证券账户当前估值已联动；缺少逐日估值快照，暂不生成历史净值曲线。</p>':assets.missingValuations?.length?'<p class="bk-empty">请补齐证券行情后查看资产合计。</p>':assets.missingCurrencies.length?'<p class="bk-empty">缺少 '+esc(assets.missingCurrencies.join('、'))+' 汇率，暂不能反推 CNY 资产走势。</p>':(assets.points.length?chart(assets.points,[{key:'balance',label:assets.historyMode==='hybrid'?'历史账面／估值净资产':'反推净资产',color:'#d89812'}],'CNY 等效总资产走势')+(assets.historyMode==='hybrid'?'':'<p class="bk-muted">以当前资产余额为反推锚点，所选历史范围期末可能不同；'+assets.estimatedTransfers+' 笔跨币种转账按等值估算，'+assets.unlinkedEntries+' 笔未关联账户记录按总资产变化估算。</p>'):'<p class="bk-empty">暂无计入总资产的账户</p>');
      }
    }
    function renderBilling() {
      const billing=getState()?.analysis?.billing;
      const excluded=getState()?.analysisScope?.excludedAccountIds?.length||0;
      $('billing-charts').innerHTML=(!billing?'':billing.missingCurrencies.length?'<p class="bk-empty">缺少 '+esc(billing.missingCurrencies.join('、'))+' 汇率，暂不能汇总 CNY 走势。</p>':chart(billing.points,billingLines,'CNY 等效总收支走势',billing.granularity,true))+(excluded?'<p class="bk-muted">统计已排除社保公积金等分组中的 '+excluded+' 个账户。</p>':'');
    }
    return {render,attr,query:()=>({...focus,...(assetChart==='returns'&&!$('accounts-view').classList.contains('hidden')?{investmentHistory:'1'}:{})}),clearFocus,drill};
  };
})();
