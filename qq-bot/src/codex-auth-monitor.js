import {readCodexUsage} from '../../shared/codex/codex-usage.js';
import {sendEmail} from './email.js';

const KEY='codex_auth_email_monitor';
const INTERVAL=5*60000;
const parse = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };

function postgresAuthState(db) {
  async function mutate(change) {
    return db.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [KEY]);
      const { rows } = await client.query('SELECT value FROM navigation.meta WHERE key=$1', [KEY]);
      const next = change(parse(rows[0]?.value));
      if (!next) return null;
      await client.query(`INSERT INTO navigation.meta(key,value) VALUES($1,$2)
        ON CONFLICT (key) DO UPDATE SET value=excluded.value`, [KEY, JSON.stringify(next)]);
      return next;
    });
  }
  return mutate;
}

export function createCodexAuthMonitor({db,getConfig,readUsage=readCodexUsage,send=sendEmail,now=Date.now,log=console,signal}) {
  let busy=false;
  const mutate = db.query ? postgresAuthState(db) : change => db.transaction(() => {
    const next = change(parse(db.prepare('SELECT value FROM meta WHERE key=?').get(KEY)?.value));
    if (!next) return null;
    db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY,JSON.stringify(next));
    return next;
  }).immediate();
  return {async tick(){
    if(busy)return;busy=true;
    try{
      const config=getConfig();if(!config.codex?.enabled)return;
      const time=now();
      if (!await mutate(value => (value.nextCheck || 0) > time ? null : { ...value, nextCheck: time + INTERVAL })) return;
      try{await readUsage(config.codex,{signal});await mutate(value => value.nextCheck === time + INTERVAL ? {nextCheck:time+INTERVAL} : null);return;}
      catch(error){if(error.code!=='CODEX_AUTH_REQUIRED')return;}
      const claimed = await mutate(value => {
        if (value.nextCheck !== time + INTERVAL || value.notified || value.sendingUntil > time) return null;
        if(!config.channels?.email?.enabled||!config.channels.email.smtp?.host||!config.channels.email.to){
          log.error('Codex 登录失效：邮件渠道未配置，等待下次检查');
          return {...value,since:value.since||time,sendingUntil:0};
        }
        return {...value,since:value.since||time,sendingUntil:time+INTERVAL};
      });
      if (!claimed?.sendingUntil) return;
      const detected=new Date(claimed.since).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
      const message='服务器 Codex 的 ChatGPT 登录已失效，自动刷新未能恢复，需要重新授权。\n检测时间：'+detected+'（北京时间）\n\n请在服务器运行 Codex 登录命令，按提示完成浏览器授权。登录恢复后，额度查询和待办调度会自动恢复。\n同一次登录失效只提醒一次。';
      try{
        await send(config.channels.email,message,{subject:'[Navigation] Codex 登录失效，请重新授权'});
        await mutate(value => value.sendingUntil === claimed.sendingUntil ? {...value,notified:true,sendingUntil:0} : null);
      }catch{await mutate(value => value.sendingUntil === claimed.sendingUntil ? {...value,sendingUntil:0} : null);log.error('Codex 登录失效提醒发送失败，将在下次检查时重试');}
    }catch{log.error('Codex 登录监测暂不可用，将自动重试');}
    finally{busy=false;}
  }};
}
