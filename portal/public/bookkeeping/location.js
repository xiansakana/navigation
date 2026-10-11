(function(){
  window.createBookkeepingLocation=function({input,status,retry,active,enabled}) {
    let generation=0,pending=null,revision=0,cancelPending=null;
    input.addEventListener('input',()=>{revision++;});
    const setStatus=text=>{status.textContent=text;status.title=text;};
    function start() {
      if(!enabled)return Promise.resolve();
      const current=++generation,initial=input.value,initialRevision=revision;
      setStatus('正在定位…');
      pending=new Promise(resolve=>{
        let settled=false;
        const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);resolve();};
        cancelPending=finish;
        const valid=()=>current===generation && active() && !settled;
        const timer=setTimeout(()=>{if(valid()){setStatus('定位超时，可手填');generation++;}finish();},12000);
        if(!window.isSecureContext){setStatus('需 HTTPS 定位');finish();return;}
        if(!navigator.geolocation){setStatus('浏览器不支持定位');finish();return;}
        navigator.geolocation.getCurrentPosition(async position=>{
          if(!valid()){finish();return;}
          const {latitude,longitude}=position.coords;
          if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||Math.abs(latitude)>90||Math.abs(longitude)>180){setStatus('定位坐标无效');finish();return;}
          const coordinates=`纬度 ${latitude.toFixed(6)}，经度 ${longitude.toFixed(6)}`;
          let label=coordinates;
          try {
            const r=await fetch('/api/bookkeeping/location?'+new URLSearchParams({latitude,longitude}),{signal:AbortSignal.timeout(5000)});
            const data=await r.json();if(r.ok&&data.ok&&data.label)label=data.label;
          }catch{/* Coordinates remain usable when address lookup fails. */}
          if(valid() && input.value===initial && revision===initialRevision){input.value=label;setStatus(label===coordinates?'已定位（坐标）':'已定位');}
          else if(valid())setStatus('保留手填位置');
          finish();
        },error=>{if(valid())setStatus(error.code===1?'未授权，可手填':'定位失败，可手填');finish();},{enableHighAccuracy:true,timeout:8000,maximumAge:0});
      });
      return pending;
    }
    retry.hidden=!enabled;retry.onclick=()=>{void start();};
    return {start,wait:()=>pending || Promise.resolve(),cancel:()=>{generation++;cancelPending?.();pending=null;}};
  };
})();
