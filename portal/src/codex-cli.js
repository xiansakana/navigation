import { sameOriginWrite } from '../../shared/http.js';
import { codexConfig } from '../../shared/runtime-config.js';
import { getDatabase } from '../../shared/db/index.js';
import { createCodexStore } from '../../shared/codex/codex-store.js';
import { readCodexCatalog, readCodexStatus, writeCodexDefaults, resolveRuntime, validateRuntime } from '../../shared/codex/codex-control.js';
import { readCodexUsage, formatCodexUsage } from '../../shared/codex/codex-usage.js';
import { hasPermission } from './rbac.js';
import { handleCodexConversationsApi } from './codex-conversations.js';
import { handleCodexTodosApi } from './codex-todos.js';

export const canCodexCli=session=>!!session?.userId&&hasPermission(session.permissions || [],'codex-cli:view');
export function codexServerSetup(uid){
  const raw={codex:codexConfig()};if(!raw.codex)throw new Error('服务器Codex执行配置不可用');
  const user=raw.codex?.allowedUsers?.find(u=>u.userId===uid);
  return {config:raw.codex || {},qqId:String(user?.qqId || ''),configured:!!user,enabled:!!raw.codex?.enabled,projects:user?.projects || []};
}
async function readBody(req){
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>8192)throw new Error('设置内容过长');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('设置格式无效');}
}
export async function handleCodexCliApi(req,res,url,session,json,dependencies={}){
  res.setHeader('Cache-Control','no-store');
  const can=permission=>!!session?.userId&&!session.isGuest&&hasPermission(session.permissions || [],permission);
  if(!canCodexCli(session))return json(res,403,{ok:false,error:'无权访问Codex CLI模块'});
  if (url.pathname === '/api/codex-cli/public-status' && req.method === 'GET') {
    return json(res, 200, { ok: true, mode: 'public', service: 'available',
      description: 'Codex 支持项目问答、代码修改和任务执行。登录并获得授权后可使用会话与任务功能。' });
  }
  if (session.isGuest) return json(res, 403, { ok: false, error: '请登录并获取对应的 Codex 权限' });
  if(url.pathname.startsWith('/api/codex-cli/todos'))return handleCodexTodosApi(req,res,url,session,json,{setup:codexServerSetup,...dependencies});
  if(url.pathname.startsWith('/api/codex-cli/conversations'))return handleCodexConversationsApi(req,res,url,session,json,{setup:codexServerSetup,...dependencies});
  const routes=['/api/codex-cli/status','/api/codex-cli/usage','/api/codex-cli/settings','/api/codex-cli/runtime'];
  if(!routes.includes(url.pathname))return json(res,404,{ok:false,error:'接口不存在'});
  const write=req.method==='PUT';
  if(!['GET','PUT'].includes(req.method)||write&&!['/api/codex-cli/settings','/api/codex-cli/runtime'].includes(url.pathname)||!write&&url.pathname==='/api/codex-cli/settings')return json(res,405,{ok:false,error:'不支持此方法'});
  if(write&&(!sameOriginWrite(req)))return json(res,403,{ok:false,error:'不允许跨站写入'});
  if(write&&!can(url.pathname.endsWith('/settings')?'codex-cli:settings:edit':'codex-cli:runtime:edit'))return json(res,403,{ok:false,error:'没有保存此设置的权限'});
  if(url.pathname.endsWith('/usage')&&!can('codex-cli:usage:view'))return json(res,403,{ok:false,error:'无权查看服务器账户额度'});
  try{
    const setup=(dependencies.setup || codexServerSetup)(session.userId),config=setup.config;
    const runtimeAllowed=setup.configured&&can('qq-codex:execute');
    const store=dependencies.store || createCodexStore(getDatabase());
    const catalog=dependencies.catalog || readCodexCatalog;
    if(url.pathname.endsWith('/status')){
      const status=await (dependencies.status || readCodexStatus)(config);
      return json(res,200,{ok:true,...status,qqDefaults:resolveRuntime(config,{model:'',effort:''},status),provisioning:{configured:setup.configured,enabled:setup.enabled,projects:setup.projects},groups:runtimeAllowed?store.settings(session.userId).groups:[],permissions:{editServer:can('codex-cli:settings:edit'),editRuntime:runtimeAllowed&&can('codex-cli:runtime:edit'),viewRuntime:runtimeAllowed,viewUsage:can('codex-cli:usage:view')}});
    }
    if(url.pathname.endsWith('/usage')){
      const snapshot=await (dependencies.usage || readCodexUsage)(config);
      return json(res,200,{ok:true,text:formatCodexUsage(snapshot).replace('QQ 服务器当前登录账号','服务器当前登录账号')});
    }
    if(url.pathname.endsWith('/runtime')){
      if(!runtimeAllowed)return json(res,403,{ok:false,error:'当前账号未配置QQ Codex执行权限'});
      const body=write?await readBody(req):{},group=write?body.groupId ?? '':url.searchParams.get('groupId') || '';
      if(typeof group!=='string'||group&&!store.settings(session.userId).groups.includes(group))return json(res,403,{ok:false,error:'群聊不存在或未授权'});
      if(write&&Object.keys(body).some(k=>!['groupId','model','effort'].includes(k)))throw new Error('只允许修改当前账号的模型和强度');
      const available=await catalog(config);
      if(write){
        const values=validateRuntime({model:body.model,effort:body.effort},available,{partial:true,defaultModel:config.model || available.defaults.model});
        resolveRuntime(config,values,available);
        if(group&&!store.settings(session.userId).groups.includes(group))return json(res,403,{ok:false,error:'群聊授权已撤销'});
        store.saveRuntime(session.userId,group,values);
      }
      const preference=store.runtime(session.userId,group);
      return json(res,200,{ok:true,groupId:group,preference,effective:resolveRuntime(config,preference,available)});
    }
    const body=await readBody(req);
    const result=await (dependencies.write || writeCodexDefaults)(config,body);
    return json(res,200,{ok:true,...result});
  }catch(error){return json(res,400,{ok:false,error:error.code?.startsWith('SQLITE_')?'模型设置保存失败，请重试':error.code==='ENOENT'?'服务器尚未配置Codex CLI':error.message});}
}
