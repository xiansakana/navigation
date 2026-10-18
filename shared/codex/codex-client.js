import { spawn } from 'node:child_process';

// A short-lived, private stdio connection. Callers expose only allowlisted operations and fields.
export async function withCodexClient(config, work, { signal, spawnProcess = spawn, timeout = 30000 } = {}) {
  if (signal?.aborted) throw new Error('Codex CLI 请求已停止');
  const env = {...process.env,...(config.proxyUrl ? {HTTPS_PROXY:config.proxyUrl,HTTP_PROXY:config.proxyUrl,ALL_PROXY:config.proxyUrl} : {})};
  let child;try{child=spawnProcess(config.binary || 'codex',['app-server'],{env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});}catch{throw new Error('无法启动服务器Codex CLI，请检查运行配置。');}
  let nextId=1,buffer='',closed=false;
  const pending=new Map();
  const failure=()=>new Error('Codex CLI 请求失败，请检查服务器登录、版本及连接后重试。');
  const fail=error=>{closed=true;for(const request of pending.values())request.reject(error);pending.clear();};
  const call=(method,params={})=>new Promise((resolve,reject)=>{
    if(closed)return reject(failure());
    const id=nextId++;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
  const abort=()=>{fail(new Error('Codex CLI 请求已停止'));child.kill();};
  const timer=setTimeout(()=>{fail(new Error('Codex CLI 请求超时，请稍后重试。'));child.kill();},timeout);
  signal?.addEventListener('abort',abort,{once:true});
  child.on('error',()=>fail(failure()));child.on('close',()=>fail(failure()));child.stdin.on('error',()=>fail(failure()));child.stderr.resume();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
    buffer+=chunk;if(buffer.length>2*1024*1024){fail(failure());child.kill();return;}
    let at;
    while((at=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,at);buffer=buffer.slice(at+1);let message;
      try{message=JSON.parse(line);}catch{continue;}
      const request=pending.get(message?.id);if(!request)continue;pending.delete(message.id);
      if(message.error){const error=failure();error.rpcCode=message.error.code;request.reject(error);}else request.resolve(message.result);
    }
  });
  try {
    await call('initialize',{clientInfo:{name:'navigation_codex_control',title:'Navigation Codex CLI',version:'1.0.0'}});
    child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
    return await work({call});
  } finally {
    clearTimeout(timer);signal?.removeEventListener('abort',abort);fail(failure());child.stdin.end();child.kill();
    const force=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},3000);force.unref();child.once('close',()=>clearTimeout(force));
  }
}
