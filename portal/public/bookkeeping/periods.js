(function(){
  'use strict';
  window.createBookkeepingPeriods=function({$,load,clearFocus}){
    const iso=d=>new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);
    const today=iso(new Date());
    $('period-anchor').value=today;
    function update(reload=true){
      const kind=$('period-kind').value,anchor=new Date(($('period-anchor').value||today)+'T12:00:00');let start='',end='';
      if(kind==='range'){start=$('range-start').value;end=$('range-end').value;}
      else if(kind!=='all'){
        const a=new Date(anchor),b=new Date(anchor);
        if(kind==='week'){a.setDate(a.getDate()-((a.getDay()+6)%7));b.setTime(a.getTime());b.setDate(b.getDate()+6);}
        if(kind==='month'){a.setDate(1);b.setMonth(b.getMonth()+1,0);}
        if(kind==='year'){a.setMonth(0,1);b.setMonth(11,31);}
        start=iso(a);end=iso(b);$('range-start').value=start;$('range-end').value=end;
      }
      $('month').value=kind==='month'?start.slice(0,7):'';
      $('period-range').classList.toggle('hidden',kind!=='range');$('period-anchor-label').classList.toggle('hidden',['range','all'].includes(kind));
      $('period-prev').disabled=['range','all'].includes(kind);$('period-next').disabled=['range','all'].includes(kind);
      $('period-caption').textContent=kind==='all'?'全部日期':start+' ～ '+end;
      document.querySelectorAll('[data-period]').forEach(b=>b.classList.toggle('active',b.dataset.period===kind));
      if(reload){clearFocus();load();}
    }
    function choose(kind,reload=true){$('period-kind').value=kind;update(reload);}
    for(const id of ['period-anchor','range-start','range-end'])$(id).addEventListener('change',()=>update());
    $('period-buttons').onclick=e=>{const b=e.target.closest('[data-period]');if(b)choose(b.dataset.period);};
    for(const [id,step] of [['period-prev',-1],['period-next',1]])$(id).onclick=()=>{const a=new Date($('period-anchor').value+'T12:00:00'),kind=$('period-kind').value;if(kind==='week')a.setDate(a.getDate()+7*step);if(kind==='month'){a.setDate(1);a.setMonth(a.getMonth()+step);}if(kind==='year'){a.setDate(1);a.setFullYear(a.getFullYear()+step);} $('period-anchor').value=iso(a);update();};
    function query(){const kind=$('period-kind').value;if(kind==='all')return {};return {start:$('range-start').value,end:$('range-end').value};}
    function focusDate(data){if(data.day||data.month){const previous=query(),start=data.day||data.month+'-01',end=data.day||new Date(Date.UTC(Number(data.month.slice(0,4)),Number(data.month.slice(5,7)),0)).toISOString().slice(0,10);$('period-kind').value='range';$('range-start').value=previous.start && previous.start>start?previous.start:start;$('range-end').value=previous.end && previous.end<end?previous.end:end;update(false);}}
    update(false);return {query,choose,focusDate,restore:()=>update(false)};
  };
})();
