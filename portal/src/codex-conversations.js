import { sameOriginWrite } from '../../shared/http.js';
import { getDatabase } from '../../shared/db/index.js';
import {createServerSessions} from './codex-server-sessions.js';
import { createCodexStore } from '../../shared/codex/codex-store.js';
import { readCodexCatalog, resolveRuntime, validateRuntime } from '../../shared/codex/codex-control.js';
import { hasPermission } from './rbac.js';

async function bodyOf(req) {
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>40000)throw new Error('消息内容过长');chunks.push(chunk);}
  try {const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}
  catch {throw new Error('请求格式无效');}
}
const summary=c=>({id:c.id,title:c.title,project:c.project,source:c.source,groupId:c.group_id,archived:!!c.archived,createdAt:c.created_at,updatedAt:c.updated_at,state:c.state || ''});

export async function handleCodexConversationsApi(req,res,url,session,json,dependencies) {
  const can=p=>hasPermission(session.permissions || [],'codex-cli:'+p),uid=session.userId;
  if(!can('sessions:view')||!hasPermission(session.permissions || [],'qq-codex:execute')&&!hasPermission(session.permissions || [],'knowledge:view')&&!can('sessions:server:view'))return json(res,403,{ok:false,error:'无权访问会话工作台'});
  const match=/^\/api\/codex-cli\/conversations(?:\/([a-zA-Z0-9-]{1,80})(?:\/(messages|stop))?)?$/.exec(url.pathname);
  if(!match)return json(res,404,{ok:false,error:'接口不存在'});
  const [,id,action]=match,method=req.method;
  if(!['GET','POST','PATCH'].includes(method)||method==='GET'&&action||method==='PATCH'&&(!id||action)||method==='POST'&&id&&!action)return json(res,405,{ok:false,error:'不支持此方法'});
  if(method!=='GET') {
    if(!hasPermission(session.permissions||[],'qq-codex:execute'))return json(res,403,{ok:false,error:'没有Codex任务执行权限'});
    if(!sameOriginWrite(req))return json(res,403,{ok:false,error:'不允许跨站写入'});
    const permission=method==='PATCH'?'sessions:manage':action==='messages'?'messages:send':action==='stop'?'tasks:stop':'sessions:create';
    if(!can(permission))return json(res,403,{ok:false,error:'没有执行此操作的权限'});
  }
  try {
    const setup=dependencies.setup(uid);
    if (session.actorUserId && session.actorUserId !== uid) {
      const actor = dependencies.setup(session.actorUserId);
      setup.projects = setup.projects.filter(project => actor.projects.includes(project));
      setup.configured = setup.configured && actor.configured;
      setup.enabled = setup.enabled && actor.enabled;
    }
    if(method!=='GET'&&!setup.configured)return json(res,403,{ok:false,error:'当前账号尚未配置Codex执行项目'});
    const store=dependencies.store || createCodexStore(getDatabase()),conversations=store.conversations;
    const external=dependencies.external || (!dependencies.store?createServerSessions(getDatabase()):null);
    const cursor=url.searchParams.get('cursor')||'';if(cursor.length>8192)throw new Error('分页标识无效');
    const externalOptions={config:setup.config,all:can('sessions:server:view')&&(!session.dataAccess||session.dataAccess.scope==='self'),canKnowledge:['knowledge:view','knowledge:notes:view'].every(p=>hasPermission(session.permissions||[],p)),canKnowledgePrompts:['knowledge:transcript:view','knowledge:frames:view'].every(p=>hasPermission(session.permissions||[],p)),archived:url.searchParams.get('archived')==='true',cursor};
    const allowed=c=>c&&hasPermission(session.permissions||[],'qq-codex:execute')&&setup.projects.includes(c.project)&&(!c.group_id||store.settings(uid).groups.includes(c.group_id));
    if(method==='GET'&&!id) {
      const local=conversations.list(uid).filter(allowed),extra=await external?.list(uid,{...externalOptions,excludeSessionIds:local.map(c=>c.session_id).filter(Boolean)})||{conversations:[]};
      return json(res,200,{ok:true,conversations:[...local.map(summary),...extra.conversations].sort((a,b)=>b.updatedAt-a.updatedAt),nextCursor:extra.nextCursor||null,warning:extra.warning||'',projects:setup.projects,
        enabled:setup.enabled,permissions:{serverHistory:can('sessions:server:view'),create:setup.configured&&can('sessions:create'),send:setup.configured&&can('messages:send'),manage:can('sessions:manage'),stop:can('tasks:stop')}});
    }
    if(id&&(id.startsWith('knowledge-')||id.startsWith('cli-'))){
      if(method!=='GET')return json(res,403,{ok:false,error:'模块与服务器历史仅供查看，请在原入口管理任务'});
      const detail=await external?.detail(uid,id,externalOptions);
      return detail?json(res,200,{ok:true,...detail}):json(res,404,{ok:false,error:'会话不存在或未授权'});
    }
    const conversation=id?conversations.get(uid,id):null;
    if(id&&!allowed(conversation))return json(res,404,{ok:false,error:'会话不存在或未授权'});
    if(method==='GET')return json(res,200,{ok:true,conversation:summary(conversation),jobs:conversations.jobs(uid,id)});
    const body=await bodyOf(req),keys=Object.keys(body);
    if(method==='PATCH') {
      if(keys.some(k=>!['title','archived'].includes(k))||!keys.length||body.title!==undefined&&(typeof body.title!=='string'||!body.title.trim()||body.title.length>80)||body.archived!==undefined&&typeof body.archived!=='boolean')throw new Error('请输入1—80字的标题或有效归档状态');
      if(body.archived&&conversations.jobs(uid,id).some(j=>['queued','running'].includes(j.state)))throw new Error('请先等待或停止执行中的任务');
      return json(res,200,{ok:true,conversation:summary(conversations.update(uid,id,{...body,...(body.title!==undefined?{title:body.title.trim()}:{})}))});
    }
    if(action==='stop') {
      if(keys.length)throw new Error('停止请求不接受额外参数');
      return json(res,200,{ok:true,count:conversations.stop(uid,id)});
    }
    if(!setup.enabled)throw new Error('服务器Codex执行入口尚未启用');
    if(!id) {
      if(keys.some(k=>k!=='project')||typeof body.project!=='string'||!setup.projects.includes(body.project))throw new Error('项目不存在或未授权');
      return json(res,201,{ok:true,conversation:summary(conversations.create(uid,body.project))});
    }
    if(conversation.archived)throw new Error('请先恢复已归档的会话');
    if(keys.some(k=>!['prompt','model','effort','requestId'].includes(k))||typeof body.prompt!=='string'||!body.prompt.trim()||body.prompt.length>20000||typeof body.requestId!=='string'||!/^[a-f0-9-]{16,64}$/i.test(body.requestId))throw new Error('请输入1—20000字的消息和有效请求标识');
    const catalog=await (dependencies.catalog || readCodexCatalog)(setup.config);
    const values=validateRuntime({model:body.model ?? '',effort:body.effort ?? ''},catalog,{partial:true,defaultModel:setup.config.model || catalog.defaults.model});
    const runtime=resolveRuntime(setup.config,values,catalog);
    const fresh=dependencies.setup(uid);
    if (session.actorUserId && session.actorUserId !== uid) {
      const actor = dependencies.setup(session.actorUserId);
      if (!actor.enabled || !actor.configured || !actor.projects.includes(conversation.project)) return json(res, 403, { ok: false, error: '操作人的项目授权已撤销' });
    }
    if(!fresh.enabled||!fresh.configured||!fresh.projects.includes(conversation.project)||conversation.group_id&&!store.settings(uid).groups.includes(conversation.group_id))return json(res,403,{ok:false,error:'项目或会话授权已撤销'});
    const jobId=conversations.enqueue(uid,setup.qqId || '',id,{prompt:body.prompt.trim(),runtime,requestId:body.requestId});
    return json(res,202,{ok:true,jobId});
  } catch(error) {
    return json(res,400,{ok:false,error:error.code?.startsWith('SQLITE_')?'会话保存失败，请重试':error.message});
  }
}
