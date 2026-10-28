import {readCodexUsage} from '../../shared/codex/codex-usage.js';
import {sendEmail} from './email.js';

const KEY='codex_auth_email_monitor';
const INTERVAL=5*60000;
export function createCodexAuthMonitor({db,getConfig,readUsage=readCodexUsage,send=sendEmail,now=Date.now,log=console,signal}) {
  let busy=false;
  const load=()=>{try{return JSON.parse(db.prepare('SELECT value FROM meta WHERE key=?').get(KEY)?.value||'{}');}catch{return {};}};
  const save=value=>db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run(KEY,JSON.stringify(value));
  return {async tick(){
    if(busy)return;busy=true;
    try{
      const config=getConfig();if(!config.codex?.enabled)return;
      const time=now();if((load().nextCheck||0)>time)return;
      save({...load(),nextCheck:time+INTERVAL});
      try{await readUsage(config.codex,{signal});save({nextCheck:time+INTERVAL});return;}
      catch(error){if(error.code!=='CODEX_AUTH_REQUIRED')return;}
      const incident=db.transaction(()=>{
        const value=load();if(value.notified||value.sendingUntil>time)return null;
        if(!config.channels?.email?.enabled||!config.channels.email.smtp?.host||!config.channels.email.to){
          save({...value,since:value.since||time});log.error('Codex 登录失效：邮件渠道未配置，等待下次检查');return null;
        }
        const claimed={...value,since:value.since||time,sendingUntil:time+INTERVAL};save(claimed);return claimed;
      }).immediate();
      if(!incident)return;
      const detected=new Date(incident.since).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
      const message='服务器 Codex 的 ChatGPT 登录已失效，自动刷新未能恢复，需要重新授权。\n检测时间：'+detected+'（北京时间）\n\n请在服务器运行 Codex 登录命令，按提示完成浏览器授权。登录恢复后，额度查询和待办调度会自动恢复。\n同一次登录失效只提醒一次。';
      try{
        await send(config.channels.email,message,{subject:'[Navigation] Codex 登录失效，请重新授权'});
        save({...load(),notified:true,sendingUntil:0});
      }catch{save({...load(),sendingUntil:0});log.error('Codex 登录失效提醒发送失败，将在下次检查时重试');}
    }catch{log.error('Codex 登录监测暂不可用，将自动重试');}
    finally{busy=false;}
  }};
}
