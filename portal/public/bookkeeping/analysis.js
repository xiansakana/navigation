(function () {
  'use strict';
  window.createBookkeepingAnalysis = function ({ $, esc, m, money, can, load, tab, getState, periods }) {
    const fields=['period-kind','period-anchor','range-start','range-end','month','book','currency','type','category','account','search'];
    let focus={}, saved=null;
    let chartMode='candle';
    let assetMode='candle';
    const CANDLE_UNITS=[['day','日K'],['week','周K'],['month','月K'],['quarter','季K'],['year','年K']];
    let candleUnit='day';
    let assetUnit='day';
    let assetChartRef=null;
    const hiddenBillingSeries=new Set(), billingLines=[{key:'income',label:'收入',color:'var(--green)'},{key:'expense',label:'净支出',color:'var(--red)'},{key:'cumulative',label:'累计账单结余',color:'#d89812'}];
    $('asset-overview-charts').addEventListener('click',event=>{
      const unitButton=event.target.closest('[data-asset-unit]');
      if(unitButton){
        if(unitButton.dataset.assetUnit!==assetUnit){assetUnit=unitButton.dataset.assetUnit;renderAsset();const next=$('asset-overview-charts').querySelector('[data-asset-unit="'+assetUnit+'"]');if(next)next.focus({preventScroll:true});}
        return;
      }
      const button=event.target.closest('[data-asset-mode]');
      if(!button)return;
      if(button.dataset.assetMode!==assetMode){assetMode=button.dataset.assetMode;renderAsset();const next=$('asset-overview-charts').querySelector('[data-asset-mode="'+assetMode+'"]');if(next)next.focus({preventScroll:true});}
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
    document.querySelector('.bk-shell').addEventListener('click',e=>{
      const unitButton=e.target.closest('[data-candle-unit]');
      if(unitButton){
        if(unitButton.dataset.candleUnit!==candleUnit){candleUnit=unitButton.dataset.candleUnit;renderBilling();const next=document.querySelector('[data-candle-unit="'+candleUnit+'"]');if(next)next.focus({preventScroll:true});}
        return;
      }
      const modeButton=e.target.closest('[data-chart-mode]');
      if(modeButton){
        const next=modeButton.dataset.chartMode;
        if(next&&next!==chartMode){chartMode=next;renderBilling();const focusTarget=document.querySelector('[data-chart-mode="'+chartMode+'"]');if(focusTarget)focusTarget.focus({preventScroll:true});}
        return;
      }
      const target=e.target.closest('[data-drill]');if(target)drill(JSON.parse(target.dataset.drill));
    });
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
    const BUCKET_NAMES={day:'日',week:'周',month:'月',quarter:'季度',half:'半年',year:'年'};
    // 收入/支出是流量，开高低收没有金融含义，K 线模式只画存量序列。
    const FLOW_KEYS=new Set(['income','expense']);
    const candleApi=window.bkCandles;
    function unitButtons(attribute,finest){
      const active=attribute==='data-asset-unit'?assetUnit:candleUnit;
      const order=CANDLE_UNITS.map(item=>item[0]),floor=order.indexOf(finest||'day');
      return '<div class="bk-chart-modes" role="group" aria-label="K 线周期">'+CANDLE_UNITS.map(([unit,text],index)=>'<button type="button" '+attribute+'="'+unit+'" aria-pressed="'+(active===unit)+'"'+(index<floor?' disabled title="数据只有月度粒度"':'')+'>'+text+'</button>').join('')+'</div>';
    }
    function modeButtons(){
      return '<div class="bk-chart-modes" role="group" aria-label="图表类型">'+[['candle','K线'],['line','折线']].map(([mode,text])=>'<button type="button" data-chart-mode="'+mode+'" aria-pressed="'+(chartMode===mode)+'">'+text+'</button>').join('')+'</div>';
    }
    function legend(points,lines,toggle,seriesAttribute,hiddenSeries,staticKeys){
      const last=points.at(-1),kind=chartMode==='candle'?'K线':'折线';
      return '<div class="bk-chart-legend"'+(toggle?' role="group" aria-label="'+kind+'显隐，点击图例切换"':'')+'>'+lines.map(l=>{
        const title=l.label+(['income','expense'].includes(l.key)?'合计':''),amount=Number.isFinite(last[l.key])?m(['income','expense'].includes(l.key)?Math.round(points.reduce((n,p)=>n+p[l.key],0)*100)/100:last[l.key],last.currency):'待补齐';
        if(staticKeys&&staticKeys.has(l.key))return '<span class="bk-series-static" style="--line-color:'+l.color+'" title="K 线只展示存量序列；切到折线查看'+esc(title)+'">'+esc(title)+' '+amount+'</span>';
        return toggle?'<button type="button" class="bk-series-toggle" '+seriesAttribute+'="'+l.key+'" aria-pressed="'+!hiddenSeries.has(l.key)+'" aria-label="'+esc(title+kind)+'" style="--line-color:'+l.color+'"><span class="bk-series-label">'+esc(title)+'</span>'+amount+'</button>':'<span style="--line-color:'+l.color+'">'+esc(title)+' '+amount+'</span>';
      }).join('')+'</div>';
    }
    function candleNoteText(){
      return candleUnit==='day'?'每根 K 线对应一个观测日':(candleUnit==='week'?'每根 K 线按「周」聚合':candleUnit==='month'?'每根 K 线按「月」聚合':candleUnit==='quarter'?'每根 K 线按「季度」聚合':'每根 K 线按「年」聚合');
    }
    function chart(points,lines,label,granularity=null,toggle=false) {
      if(!points.length)return '<p class="bk-empty">暂无记录</p>';
      const hiddenSeries=hiddenBillingSeries, seriesAttribute='data-billing-series';
      const candle=chartMode==='candle';
      const fineGrain=granularity==='month'&&['day','week'].includes(candleUnit)?'（当前区间为月度数据，日K／周K 与月K 等效）':'';
      return '<div class="bk-chart-card"><div class="bk-chart-head"><h3>'+esc(label)+'</h3>'+modeButtons()+'<span class="bk-chart-modes-slot'+(candle?'':' is-hidden')+'">'+unitButtons('data-candle-unit')+'</span></div>'
        +legend(points,lines,toggle,seriesAttribute,hiddenSeries,candle?FLOW_KEYS:null)
        +'<div class="bk-asset-chart" data-billing-chart-host></div>'
        +'<p class="bk-muted bk-candle-note">'+(candle?candleNoteText()+'：开=上一根收盘（首根取观测值），阳线绿色、阴线红色，拖动下方滑块可缩放。'+'':'折线为逐日观测值，拖动下方滑块可缩放。')+(candle?'':'')+'</p></div>';
    }
    function trendSeries(lines,hiddenSeries){
      return lines.filter(line=>!hiddenSeries.has(line.key)).map(line=>({key:line.key,label:line.label,color:line.color,stock:!FLOW_KEYS.has(line.key)}));
    }
    function ensureTrend(hostSelector,current){
      const mount=$(hostSelector)?.querySelector('[data-billing-chart-host],[data-asset-chart-host]');
      if(!mount)return null;
      if(!current.instance || current.host!==mount){
        if(current.instance)current.instance.dispose();
        current.instance=window.createBookkeepingTrendChart?window.createBookkeepingTrendChart(mount):null;
        current.host=mount;
      }
      return current.instance;
    }
    const billingChart={instance:null,host:null};
    function mountBilling(points,granularity){
      const instance=ensureTrend('billing-charts',billingChart);
      if(!instance)return;
      instance.render({
        points,
        series:trendSeries(billingLines,hiddenBillingSeries),
        currency:points.at(-1)?.currency||'CNY',
        unit:candleUnit,
        mode:chartMode,
        onPick:granularity?candle=>drill(period({date:candle.start},granularity,'cumulative')):null
      });
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
    assetChartRef={instance:null,host:null};
    function assetNoteText(){
      return assetMode==='candle'
        ? candleNoteText()+'：开=上一根收盘（首根取观测值），阳线绿色、阴线红色，拖动下方滑块可缩放。'
        : '折线为逐日观测值，拖动下方滑块可缩放。';
    }
    function refreshAssetNote(){
      const note=$('asset-overview-charts').querySelector('.bk-candle-note');
      if(note)note.textContent=assetNoteText();
      for(const item of $('asset-overview-charts').querySelectorAll('[data-asset-mode]'))item.setAttribute('aria-pressed',String(item.dataset.assetMode===assetMode));
      for(const item of $('asset-overview-charts').querySelectorAll('[data-asset-unit]'))item.setAttribute('aria-pressed',String(item.dataset.assetUnit===assetUnit));
    }
    function renderAsset() {
      const analysis=getState()?.analysis, assets=analysis?.asset;
      const host=$('asset-overview-charts');
      $('asset-overview').classList.toggle('hidden',!assets);
      if(!assets){host.innerHTML='';if(assetChartRef.instance){assetChartRef.instance.dispose();assetChartRef.instance=null;assetChartRef.host=null;}return;}
      $('asset-overview-note').textContent=assets.note+(assets.currentOnly || assets.historyMode==='hybrid'?'':' 反推使用全部关联账单，再按所选日期范围截取；账本、分类等收支筛选不改变反推基础。');
      const blocked=assets.currentOnly?'<p class="bk-muted">证券账户当前估值已联动；缺少逐日估值快照，暂不生成历史净值曲线。</p>'
        :assets.missingValuations?.length?'<p class="bk-empty">请补齐证券行情后查看资产合计。</p>'
        :assets.missingCurrencies.length?'<p class="bk-empty">缺少 '+esc(assets.missingCurrencies.join('、'))+' 汇率，暂不能反推 CNY 资产走势。</p>'
        :!assets.points.length?'<p class="bk-empty">暂无计入总资产的账户</p>':'';
      if(blocked){
        host.innerHTML=blocked;
        if(assetChartRef.instance){assetChartRef.instance.dispose();assetChartRef.instance=null;assetChartRef.host=null;}
        return;
      }
      if(!host.querySelector('.bk-chart-card')){
        host.innerHTML='<div class="bk-chart-card"><div class="bk-chart-head"><h3>CNY 等效总资产走势</h3>'
          +'<div class="bk-chart-modes" role="group" aria-label="图表类型">'
          +'<button type="button" data-asset-mode="candle" aria-pressed="'+(assetMode==='candle')+'">K线</button>'
          +'<button type="button" data-asset-mode="line" aria-pressed="'+(assetMode==='line')+'">折线</button>'
          +'</div><span class="bk-chart-modes-slot'+(assetMode==='candle'?'':' is-hidden')+'">'+unitButtons('data-asset-unit')+'</span></div>'
          +'<div class="bk-asset-chart" data-asset-chart-host></div>'
          +'<p class="bk-muted bk-candle-note"></p>'
          +'<p class="bk-muted"></p></div>';
      }
      const instance=ensureTrend('asset-overview-charts',assetChartRef);
      if(!instance){
        host.querySelector('[data-asset-chart-host]').innerHTML='<p class="bk-empty">图表组件未加载</p>';
        return;
      }
      instance.render({
        points:assets.points,
        series:[{key:'balance',label:assets.historyMode==='hybrid'?'历史账面／估值净资产':'反推净资产',color:'#d89812',stock:true}],
        currency:assets.points.at(-1)?.currency||'CNY',
        unit:assetUnit,
        mode:assetMode
      });
      refreshAssetNote();
      host.querySelector('.bk-chart-card > p:last-child').textContent=assets.historyMode==='hybrid'?'':'以当前资产余额为反推锚点，所选历史范围期末可能不同；'+assets.estimatedTransfers+' 笔跨币种转账按等值估算，'+assets.unlinkedEntries+' 笔未关联账户记录按总资产变化估算。';
    }
    function renderBilling() {
      const billing=getState()?.analysis?.billing;
      const excluded=getState()?.analysisScope?.excludedAccountIds?.length||0;
      $('billing-charts').innerHTML=(!billing?'':billing.missingCurrencies.length?'<p class="bk-empty">缺少 '+esc(billing.missingCurrencies.join('、'))+' 汇率，暂不能汇总 CNY 走势。</p>':chart(billing.points,billingLines,'CNY 等效总收支走势',billing.granularity,true))+(excluded?'<p class="bk-muted">统计已排除社保公积金等分组中的 '+excluded+' 个账户。</p>':'');
      if(billing&&!billing.missingCurrencies.length&&billing.points.length)mountBilling(billing.points,billing.granularity);
    }
    return {render,attr,query:()=>({...focus,billingDaily:'1'}),clearFocus,drill};
  };
})();
