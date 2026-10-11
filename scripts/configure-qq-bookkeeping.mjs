// Run on ECS after deploying: node scripts/configure-qq-bookkeeping.mjs
// Updates private runtime configuration only; never prints tokens or QQ destinations.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const botPath=path.join(root,'qq-bot/config.json'),bot=JSON.parse(fs.readFileSync(botPath,'utf8'));
const portal=JSON.parse(fs.readFileSync(path.join(root,'portal/config.json'),'utf8'));
if(!bot.napcat?.accessToken || !bot.server?.notifyToken)throw new Error('NapCat 和通知服务需要现有的非空 Token。');
const dir=process.env.NAPCAT_CONFIG_DIR || '/opt/napcat/config';
const configs=fs.readdirSync(dir).filter(f=>/^onebot11_\d+\.json$/.test(f));
if(configs.length!==1)throw new Error('无法唯一确定 NapCat 账号配置，请人工检查。');
const napPath=path.join(dir,configs[0]),nap=JSON.parse(fs.readFileSync(napPath,'utf8'));
nap.network ||= {};nap.network.websocketServers ||= [];
let ws=nap.network.websocketServers.find(s=>s.name==='bookkeeping-receiver');
if(!ws && nap.network.websocketServers.some(s=>s.enable && Number(s.port)===3001))throw new Error('3001 已有其他 WebSocket 服务，请人工核对，未覆盖。');
if(!ws){ws={name:'bookkeeping-receiver'};nap.network.websocketServers.push(ws);}
Object.assign(ws,{enable:true,host:'0.0.0.0',port:3001,messagePostFormat:'array',reportSelfMessage:false,token:bot.napcat.accessToken,enableForcePushEvent:true,heartbeatInterval:30000,debug:false});
bot.bookkeeping={...bot.bookkeeping,enabled:true,wsUrl:'ws://127.0.0.1:3001',portalUrl:'http://127.0.0.1:'+(portal.server?.port || 8080)};
function save(file,data,backup=file+'.before-qq-bookkeeping') {
  fs.mkdirSync(path.dirname(backup),{recursive:true});
  if(!fs.existsSync(backup))fs.copyFileSync(file,backup);
  const temp=file+'.qq-tmp';fs.writeFileSync(temp,JSON.stringify(data,null,2)+'\n',{mode:0o600});fs.renameSync(temp,file);
  fs.chmodSync(file,0o600);fs.chmodSync(backup,0o600);
}
save(napPath,nap);save(botPath,bot,path.join(root,'qq-bot/data/bookkeeping/config.before-qq-bookkeeping.json'));
console.log('QQ记账接收配置已启用（本机3001，array事件）；已保留原配置备份。请重启NapCat和qq-bot。');
