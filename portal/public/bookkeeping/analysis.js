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
    let assetChartInstance=null, assetChartHost=null, assetBucket=null;
    const hiddenBillingSeries=new Set(), billingLines=[{key:'income',label:'收入',color:'var(--green)'},{key:'expense',label:'净支出',color:'var(--red)'},{key:'cumulative',label:'累计账单结余',color:'#d89812'}];
    function assetModeName(){return assetChartInstance&&assetChartInstance.mode?assetChartInstance.mode():assetMode;}
    function refreshAssetNote(){
      const note=$('asset-overview-charts').querySelector('.bk-candle-note');
      if(!note)return;
      note.textContent=assetModeName()==='candle'&&assetBucket
        ?(assetBucket.unit==='day'?'每根 K 线对应一个观测日':'每根 K 线按「'+BUCKET_NAMES[assetBucket.unit]+'」聚合')+'：开=上一根收盘（首根取观测值），阳线绿色、阴线红色，拖动下方滑块可缩放。'
        :'折线为逐日观测值，拖动下方滑块可缩放。';
      for(const item of $('asset-overview-charts').querySelectorAll('[data-asset-mode]'))item.setAttribute('aria-pressed',String(item.dataset.assetMode===assetModeName()));
      for(const item of $('asset-overview-charts').querySelectorAll('[data-asset-unit]'))item.setAttribute('aria-pressed',String(item.dataset.assetUnit===assetUnit));
    }

    $('asset-overview-charts').addEventListener('click',event=>{
      const unitButton=event.target.closest('[data-asset-unit]');
      if(unitButton){
        if(unitButton.dataset.assetUnit!==assetUnit){assetUnit=unitButton.dataset.assetUnit;renderAsset();const next=$('asset-overview-charts').querySelector('[data-asset-unit="'+assetUnit+'"]');if(next)next.focus({preventScroll:true});}
        return;
      }
      const button=event.target.closest('[data-asset-mode]');
      if(!button||!assetChartInstance)return;
      assetMode=button.dataset.assetMode;
      assetChartInstance.setMode(assetMode);
      refreshAssetNote();
      button.focus({preventScroll:true});
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
    function unitButtons(attribute){
      const active=attribute==='data-asset-unit'?assetUnit:candleUnit;
      return '<div class="bk-chart-modes" role="group" aria-label="K 线周期">'+CANDLE_UNITS.map(([unit,text])=>'<button type="button" '+attribute+'="'+unit+'" aria-pressed="'+(active===unit)+'">'+text+'</button>').join('')+'</div>';
    }
    function modeButtons(){
      if(!candleApi)return '';
      return '<div class="bk-chart-modes" role="group" aria-label="图表类型">'+[['candle','K线'],['line','折线']].map(([mode,text])=>'<button type="button" data-chart-mode="'+mode+'" aria-pressed="'+(chartMode===mode)+'">'+text+'</button>').join('')+'</div>';
    }
    function legend(points,lines,toggle,seriesAttribute,hiddenSeries,staticKeys){
      const last=points.at(-1),kind=chartMode==='candle'&&candleApi?'K线':'折线';
      return '<div class="bk-chart-legend"'+(toggle?' role="group" aria-label="'+kind+'显隐，点击图例切换"':'')+'>'+lines.map(l=>{
        const title=l.label+(FLOW_KEYS.has(l.key)?'合计':''),amount=Number.isFinite(last[l.key])?m(FLOW_KEYS.has(l.key)?Math.round(points.reduce((n,p)=>n+p[l.key],0)*100)/100:last[l.key],last.currency):'待补齐';
        if(staticKeys&&staticKeys.has(l.key))return '<span class="bk-series-static" style="--line-color:'+l.color+'" title="K 线只展示存量序列；切到折线查看'+esc(title)+'">'+esc(title)+' '+amount+'</span>';
        return toggle?'<button type="button" class="bk-series-toggle"'+(kind==='K线'?' data-candle="1"':'')+' '+seriesAttribute+'="'+l.key+'" aria-pressed="'+!hiddenSeries.has(l.key)+'" aria-label="'+esc(title+kind)+'" style="--line-color:'+l.color+'"><span class="bk-series-label">'+esc(title)+'</span>'+amount+'</button>':'<span style="--line-color:'+l.color+'">'+esc(title)+' '+amount+'</span>';
      }).join('')+'</div>';
    }
    function lineSvg(points,visibleLines,granularity,toggle,label){
      const width=600,height=230,left=76,right=20,top=18,bottom=36;
      const values=points.flatMap(p=>visibleLines.map(l=>p[l.key])).filter(Number.isFinite), min=Math.min(0,...values), max=Math.max(0,...values), span=max-min||1;
      const time=p=>Date.parse((p.date.length===7?p.date+'-01':p.date)+'T12:00:00Z'),firstTime=time(points[0]),lastTime=time(points.at(-1));
      const x=i=>left+(points.length===1?(width-left-right)/2:(time(points[i])-firstTime)/(lastTime-firstTime||1)*(width-left-right));
      const y=value=>height-bottom-(value-min)/span*(height-top-bottom);
      let svg='<svg viewBox="0 0 '+width+' '+height+'" role="group" aria-label="'+esc(label)+'" class="bk-line-chart" data-money>';
      if(!visibleLines.length)svg+='<text x="'+width/2+'" y="'+height/2+'" text-anchor="middle">所有折线已隐藏，点击图例重新显示</text>';
      else for(let i=0;i<=4;i++) {const value=min+span*i/4;svg+='<line x1="'+left+'" x2="'+(width-right)+'" y1="'+y(value)+'" y2="'+y(value)+'" class="bk-grid-line"/><text x="'+(left-9)+'" y="'+(y(value)+4)+'" text-anchor="end">'+esc(new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1}).format(value))+'</text>';}
      const boundary=points.findIndex(p=>p.valuationBoundary);
      if(boundary>=0)svg+='<g data-valuation-boundary><line x1="'+x(boundary)+'" x2="'+x(boundary)+'" y1="'+top+'" y2="'+(height-bottom)+'" stroke="var(--muted)" stroke-dasharray="5 4"/><text x="'+Math.max(left+65,Math.min(width-right-65,x(boundary)))+'" y="'+(top+12)+'" text-anchor="middle">首份快照基准</text></g>';
      for(const line of visibleLines) {
        const segments=[];let segment=[];
        points.forEach((point,index)=>{
          if(Number.isFinite(point[line.key]))segment.push(x(index)+','+y(point[line.key]));
          else if(segment.length){segments.push(segment);segment=[];}
        });
        if(segment.length)segments.push(segment);
        svg+='<g data-chart-series="'+line.key+'">'+segments.map(s=>'<polyline points="'+s.join(' ')+'" fill="none" stroke="'+line.color+'" stroke-width="2.5"/>').join('');
        svg+=points.map((p,i)=>{
          if(!Number.isFinite(p[line.key]))return '';
          if(!granularity && i%Math.max(1,Math.ceil(points.length/60))!==0 && i!==points.length-1 && Number.isFinite(points[i-1]?.[line.key]) && Number.isFinite(points[i+1]?.[line.key]))return '';
          const title=(p.periodBoundary==='opening'?'范围期初 · ':'')+p.date+' '+line.label+' '+money(p[line.key],p.currency)+(p.floatingIncluded===false?' · 仅含已实现收益，未计历史浮盈':p.source==='current'?' · 今日暂估':p.source==='ledger'?' · 账单反推':p.source==='valuation'?(p.revisionPending?' · 估值快照（补录待补齐）':p.revised?' · 补录交易后重算':' · 估值快照'):p.source==='trades'?(p.provisional?' · 今日暂估／最新可用报价':p.backfilled&&line.key!=='realized'?' · 历史报价补算（估算）':' · 成交记录／估值重建'):p.source==='carried'?' · 沿用 '+p.asOf+' 观测':'');
          return '<circle cx="'+x(i)+'" cy="'+y(p[line.key])+'" r="4.5" fill="'+line.color+'"'+(granularity?' tabindex="0" role="button" aria-label="'+esc(title+'，查看账单')+'"'+attr(period(p,granularity,line.key==='income'?'income':line.key==='expense'?'expense':'cumulative')):'')+'><title>'+esc(title)+'</title></circle>';
        }).join('');
        svg+='</g>';
      }
      for(const i of [...new Set([0,Math.floor((points.length-1)/2),points.length-1])])svg+='<text x="'+x(i)+'" y="'+(height-10)+'" text-anchor="middle">'+esc((points[i].periodBoundary==='opening'?'期初 ':points[i].source==='current'||points[i].provisional?'暂估 ':'')+points[i].date)+'</text>';
      return svg+'</svg>';
    }
    function candleSvg(points,visibleLines,granularity,bucket,label){
      const width=600,height=230,left=76,top=18,bottom=36;
      const groups=visibleLines.map(line=>({line,candles:candleApi.buildCandles(points,line.key,bucket)}));
      const starts=[...new Set(groups.flatMap(g=>g.candles.map(c=>c.start)))].sort();
      const all=groups.flatMap(g=>g.candles);
      const extremes=groups.map(group=>{
        const lows=group.candles.map(c=>c.low),highs=group.candles.map(c=>c.high);
        return {min:Math.min(0,...lows),max:Math.max(0,...highs)};
      });
      const magnitude=range=>Math.max(Math.abs(range.min),Math.abs(range.max));
      const largest=Math.max(0,...extremes.map(magnitude));
      // 累计结余是百万级、收支是万级：同一根轴会把流量蜡烛压成一条线，
      // 量级差超过 8 倍时给小量级序列单独一根右轴。
      const dual=groups.length>1 && extremes.some(range=>magnitude(range)>0 && largest/Math.max(magnitude(range),1e-9)>8);
      const right=dual?62:20;
      const side=extremes.map(range=>dual && magnitude(range)>0 && largest/Math.max(magnitude(range),1e-9)>8?'right':'left');
      const bounds=which=>{
        const picked=extremes.filter((range,index)=>side[index]===which);
        const list=picked.length?picked:extremes;
        return {min:Math.min(...list.map(range=>range.min)),max:Math.max(...list.map(range=>range.max))};
      };
      const leftBounds=bounds('left'),rightBounds=bounds('right');
      const scale=(which,value)=>{
        const {min,max}=which==='right'?rightBounds:leftBounds,span=max-min||1;
        return height-bottom-(value-min)/span*(height-top-bottom);
      };
      const yOf=(index,value)=>scale(side[index],value);
      let svg='<svg viewBox="0 0 '+width+' '+height+'" role="group" aria-label="'+esc(label)+'" class="bk-line-chart bk-candle-chart" data-money>';
      if(!all.length)return {svg:svg+'<text x="'+width/2+'" y="'+height/2+'" text-anchor="middle">所选区间没有可绘制的 K 线</text></svg>',dual:false};
      const slot=(width-left-right)/Math.max(1,starts.length);
      const count=Math.max(1,groups.length);
      const bodyWidth=Math.max(2,Math.min(13,slot*0.62/count));
      const compact=value=>esc(new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1}).format(value));
      for(let i=0;i<=4;i++){
        const value=leftBounds.min+(leftBounds.max-leftBounds.min||1)*i/4,y=scale('left',value);
        svg+='<line x1="'+left+'" x2="'+(width-right)+'" y1="'+y+'" y2="'+y+'" class="bk-grid-line"/><text x="'+(left-9)+'" y="'+(y+4)+'" text-anchor="end">'+compact(value)+'</text>';
      }
      if(dual)for(let i=0;i<=4;i++){
        const value=rightBounds.min+(rightBounds.max-rightBounds.min||1)*i/4;
        svg+='<text x="'+(width-right+9)+'" y="'+(scale('right',value)+4)+'" text-anchor="start" class="bk-axis-right">'+compact(value)+'</text>';
      }
      const boundary=points.findIndex(p=>p.valuationBoundary);
      if(boundary>=0){
        const at=starts.findIndex(start=>start>=points[boundary].date),lineX=left+(Math.max(0,at)+0.5)*slot;
        svg+='<g data-valuation-boundary><line x1="'+lineX+'" x2="'+lineX+'" y1="'+top+'" y2="'+(height-bottom)+'" stroke="var(--muted)" stroke-dasharray="5 4"/><text x="'+Math.max(left+65,Math.min(width-right-65,lineX))+'" y="'+(top+12)+'" text-anchor="middle">首份快照基准</text></g>';
      }
      const currency=points.at(-1)?.currency;
      // 与股票模块一致：阳线（收高）绿、阴线（收低）红，方向即颜色。
      const UP='var(--green)',DOWN='var(--red)';
      groups.forEach((group,groupIndex)=>{
        const offset=(groupIndex-(count-1)/2)*(bodyWidth+1.5);
        let inner='';
        for(const candle of group.candles){
          const index=starts.indexOf(candle.start),cx=left+(index+0.5)*slot+offset;
          if(cx<left-bodyWidth||cx>width-right+bodyWidth)continue;
          const up=candle.close>=candle.open,tone=up?UP:DOWN,yOpen=yOf(groupIndex,candle.open),yClose=yOf(groupIndex,candle.close);
          const bodyTop=Math.min(yOpen,yClose),bodyHeight=Math.max(1.2,Math.abs(yClose-yOpen));
          const title=candle.label+' · '+group.line.label+' 开 '+money(candle.open,currency)+' 高 '+money(candle.high,currency)+' 低 '+money(candle.low,currency)+' 收 '+money(candle.close,currency)+'（'+candle.count+' 个数据点）'+(up?' · 区间收高':' · 区间收低')+(side[groupIndex]==='right'?' · 右轴':'');
          const drill=granularity?' tabindex="0" role="button" aria-label="'+esc(title+'，查看账单')+'"'+attr(period({date:candle.start},granularity,group.line.key==='income'?'income':group.line.key==='expense'?'expense':'cumulative')):'';
          inner+='<g class="bk-candle" data-dir="'+(up?'up':'down')+'"><title>'+esc(title)+'</title><line x1="'+cx+'" x2="'+cx+'" y1="'+yOf(groupIndex,candle.high)+'" y2="'+yOf(groupIndex,candle.low)+'" stroke="'+tone+'" stroke-width="1.2"/><rect x="'+(cx-bodyWidth/2)+'" y="'+bodyTop+'" width="'+bodyWidth+'" height="'+bodyHeight+'" fill="'+tone+'" stroke="'+tone+'" stroke-width="1.2"'+drill+'/></g>';
        }
        svg+='<g data-chart-series="'+group.line.key+'">'+inner+'</g>';
      });
      const ticks=[0,Math.floor((starts.length-1)/2),starts.length-1].filter((value,index,list)=>list.indexOf(value)===index);
      for(const tick of ticks)svg+='<text x="'+(left+(tick+0.5)*slot)+'" y="'+(height-10)+'" text-anchor="middle">'+esc(candleApi.bucketLabel(starts[tick],bucket.unit))+'</text>';
      return {svg:svg+'</svg>',dual};
    }
    function chart(points,lines,label,granularity=null,toggle=false) {
      if(!points.length)return '<p class="bk-empty">暂无记录</p>';
      const hiddenSeries=hiddenBillingSeries, seriesAttribute='data-billing-series';
      const visibleLines=toggle?lines.filter(line=>!hiddenSeries.has(line.key)):lines;
      const candles=chartMode==='candle'&&candleApi;
      const bucket=candles?{unit:candleUnit}:null;
      const candleLines=candles?visibleLines.filter(line=>!FLOW_KEYS.has(line.key)):[];
      const candleResult=candles?candleSvg(points,candleLines,granularity,bucket,label):null;
      const body=candleResult?candleResult.svg:lineSvg(points,visibleLines,granularity,toggle,label);
      const unitText=!bucket?'':(bucket.unit==='day'?'每根 K 线对应一个观测日':'每根 K 线按「'+BUCKET_NAMES[bucket.unit]+'」聚合');
      const note=candles?'<p class="bk-muted bk-candle-note">'+(candleLines.length?unitText+'：开=上一根收盘（首根取观测值），阳线（收高）绿色、阴线（收低）红色'+(candleResult?.dual?'；右侧刻度对应量级较小的序列':'')+(granularity?'；点击可查看该区间账单':'')+'。':'K 线只展示存量序列，请切换到折线查看收入与净支出。')+'</p>':'';
      return '<div class="bk-chart-card"><div class="bk-chart-head"><h3>'+esc(label)+'</h3>'+modeButtons()+'<span class="bk-chart-modes-slot'+(candles?'':' is-hidden')+'">'+unitButtons('data-candle-unit')+'</span>'+'</div>'+legend(points,lines,toggle,seriesAttribute,hiddenSeries,candles?FLOW_KEYS:null)+body+note+(points.length===1?'<p class="bk-muted">目前仅有一个基准点，后续账单会形成走势。</p>':'')+'</div>';
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
    function ensureAssetChart(){
      const mount=$('asset-overview-charts').querySelector('[data-asset-chart-host]');
      if(!mount)return null;
      if(!assetChartInstance || assetChartHost!==mount){
        if(assetChartInstance)assetChartInstance.dispose();
        assetChartInstance=window.createBookkeepingAssetChart?window.createBookkeepingAssetChart(mount):null;
        assetChartHost=mount;
      }
      return assetChartInstance;
    }
    function renderAsset() {
      const analysis=getState()?.analysis, assets=analysis?.asset;
      const host=$('asset-overview-charts');
      $('asset-overview').classList.toggle('hidden',!assets);
      if(!assets){host.innerHTML='';if(assetChartInstance){assetChartInstance.dispose();assetChartInstance=null;assetChartHost=null;}return;}
      $('asset-overview-note').textContent=assets.note+(assets.currentOnly || assets.historyMode==='hybrid'?'':' 反推使用全部关联账单，再按所选日期范围截取；账本、分类等收支筛选不改变反推基础。');
      const blocked=assets.currentOnly?'<p class="bk-muted">证券账户当前估值已联动；缺少逐日估值快照，暂不生成历史净值曲线。</p>'
        :assets.missingValuations?.length?'<p class="bk-empty">请补齐证券行情后查看资产合计。</p>'
        :assets.missingCurrencies.length?'<p class="bk-empty">缺少 '+esc(assets.missingCurrencies.join('、'))+' 汇率，暂不能反推 CNY 资产走势。</p>'
        :!assets.points.length?'<p class="bk-empty">暂无计入总资产的账户</p>':'';
      if(blocked){
        host.innerHTML=blocked;
        if(assetChartInstance){assetChartInstance.dispose();assetChartInstance=null;assetChartHost=null;}
        return;
      }
      if(!host.querySelector('.bk-chart-card')){
        host.innerHTML='<div class="bk-chart-card"><div class="bk-chart-head"><h3>CNY 等效总资产走势</h3>'
          +'<div class="bk-chart-modes" role="group" aria-label="图表类型">'
          +'<button type="button" data-asset-mode="candle" aria-pressed="'+(assetMode==='candle')+'">K线</button>'
          +'<button type="button" data-asset-mode="line" aria-pressed="'+(assetMode==='line')+'">折线</button>'
          +'</div>'+unitButtons('data-asset-unit')+'</div><div class="bk-asset-chart" data-asset-chart-host></div>'
          +'<p class="bk-muted bk-candle-note"></p>'
          +'<p class="bk-muted"></p></div>';
      }
      const instance=ensureAssetChart();
      if(!instance){
        host.querySelector('[data-asset-chart-host]').innerHTML='<p class="bk-empty">图表组件未加载</p>';
        return;
      }
      if(instance.mode && assetMode!==instance.mode())instance.setMode(assetMode);
      const bucket=window.bkCandles?{unit:assetUnit}:null;
      assetBucket=bucket;
      instance.render(assets.points,assets.points.at(-1)?.currency,bucket);
      refreshAssetNote();
      host.querySelector('.bk-chart-card > p:last-child').textContent=assets.historyMode==='hybrid'?'':'以当前资产余额为反推锚点，所选历史范围期末可能不同；'+assets.estimatedTransfers+' 笔跨币种转账按等值估算，'+assets.unlinkedEntries+' 笔未关联账户记录按总资产变化估算。';
    }
    function renderBilling() {
      const billing=getState()?.analysis?.billing;
      const excluded=getState()?.analysisScope?.excludedAccountIds?.length||0;
      $('billing-charts').innerHTML=(!billing?'':billing.missingCurrencies.length?'<p class="bk-empty">缺少 '+esc(billing.missingCurrencies.join('、'))+' 汇率，暂不能汇总 CNY 走势。</p>':chart(billing.points,billingLines,'CNY 等效总收支走势',billing.granularity,true))+(excluded?'<p class="bk-muted">统计已排除社保公积金等分组中的 '+excluded+' 个账户。</p>':'');
    }
    return {render,attr,query:()=>({...focus}),clearFocus,drill};
  };
})();
