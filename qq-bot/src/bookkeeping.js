import WebSocket from 'ws';

export function qqCommandEvent(event) {
  if(event.post_type!=='message' || !['private','group'].includes(event.message_type) || String(event.user_id)===String(event.self_id))return null;
  // Array mode preserves real mention elements; plain text CQ-like strings cannot trigger group writes.
  if(!Array.isArray(event.message))return null;
  if(event.message_type==='group' && !event.message.some(s=>s.type==='at' && String(s.data?.qq)===String(event.self_id)))return null;
  if(event.message.some(s=>!['text','at','reply'].includes(s.type)))return null;
  const text=event.message.filter(s=>s.type==='text').map(s=>s.data?.text || '').join('').trim();
  if(!/^(记账帮助$|绑定记账\s|记账\s|转账\s|撤销\s)/.test(text))return null;
  return {selfId:String(event.self_id),qqId:String(event.user_id),groupId:event.message_type==='group'?String(event.group_id):'',
    messageId:String(event.message_id),type:event.message_type,text};
}

export function createQqCommandReceiver({ getConfig, send, request=fetch, Socket=WebSocket, log=console } ) {
  let socket, timer, heartbeat, stopped=true, connected=false, lastError='', lastMessageAt=null;
  const pending=new Set();
  const limits=new Map();
  async function portal(body) {
    const c=getConfig(), url=c.bookkeeping?.portalUrl || 'http://127.0.0.1:8080';
    const r=await request(url+'/api/internal/bookkeeping/qq',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+c.server.notifyToken},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    const data=await r.json();if(!r.ok || !data.ok)throw new Error(data.error || '记账服务暂时不可用');return data;
  }
  async function receive(event) {
    const command=qqCommandEvent(event);if(!command)return;
    const c=getConfig();if(!c.bookkeeping?.enabled || !c.channels.qq.enabled)return;
    const key=[command.selfId,command.type,command.groupId,command.qqId,command.messageId].join(':');if(pending.has(key))return;
    const now=Date.now(),count=limits.get(command.qqId);
    if(count && now-count.at<60000){if(count.n>=10)return;count.n++;}else limits.set(command.qqId,{at:now,n:1});
    if(limits.size>1000)for(const [id,value] of limits)if(now-value.at>=60000)limits.delete(id);
    if(pending.size>=100)return;pending.add(key);
    lastMessageAt=new Date().toISOString();
    try {
      let result;
      try {result=await portal({event:command});}
      catch(error){await send(c,command,'未取得记账结果：'+error.message+'。若提示服务超时或不可用，请先到网页核对再重新发送。');return;}
      if(result.sent)return;
      await send(c,command,result.reply);
      await portal({ack:result.eventKey});
    } catch {lastError='指令回执投递失败；请查看网页确认结果，重发同一消息事件不会重复入账。';log.error(lastError);}
    finally {pending.delete(key);}
  }
  function connect() {
    if(stopped)return;
    const c=getConfig();
    if(!c.bookkeeping?.enabled)return;
    if(!c.server.notifyToken || !c.napcat.accessToken){lastError='接收记账指令需要配置通知 Token 和 NapCat Token';return;}
    try {
      socket=new Socket(c.bookkeeping.wsUrl || 'ws://127.0.0.1:3001',{headers:{Authorization:'Bearer '+c.napcat.accessToken},maxPayload:1024*1024});
      socket.on('open',()=>{connected=true;lastError='';let alive=true;
        socket.on('pong',()=>{alive=true;});
        heartbeat=setInterval(()=>{if(!alive){socket.terminate();return;}alive=false;socket.ping();},30000);
      });
      socket.on('message',data=>{try{void receive(JSON.parse(data.toString()));}catch{/* Non-message frames are ignored. */}});
      socket.on('error',()=>{lastError='NapCat 消息接收连接失败';});
      socket.on('close',()=>{clearInterval(heartbeat);connected=false;if(!stopped)timer=setTimeout(connect,5000);});
    }catch {lastError='NapCat 消息接收地址无效';timer=setTimeout(connect,5000);}
  }
  function stop(){stopped=true;clearTimeout(timer);clearInterval(heartbeat);socket?.removeAllListeners();socket?.on('error',()=>{});socket?.terminate();connected=false;}
  function start(){stop();stopped=false;connect();}
  return {start,stop,receive,status:()=>({enabled:!!getConfig().bookkeeping?.enabled,connected,lastError,lastMessageAt})};
}
