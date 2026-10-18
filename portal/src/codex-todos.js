import {getDatabase} from '../../shared/db/index.js';
import {createCodexStore} from '../../qq-bot/src/codex-store.js';
import {readCodexCatalog,validateRuntime,resolveRuntime} from '../../qq-bot/src/codex-control.js';
import {hasPermission} from './rbac.js';

const chatPermissions=['codex-cli:sessions:view','codex-cli:sessions:create','codex-cli:messages:send'];
const serialize=row=>({id:row.id,title:row.title,prompt:row.prompt,project:row.project,conversationId:row.conversation_id,state:row.state,jobState:row.job_state || '',runtime:JSON.parse(row.runtime_json),jobId:row.job_id,attempts:row.attempts,scheduledAt:row.scheduled_at,nextCheckAt:row.next_check_at,resetAt:row.reset_at,note:row.note,createdAt:row.created_at,updatedAt:row.updated_at});
async function readBody(req){
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>80000)throw new Error('待办内容过长');chunks.push(chunk);}
  try{const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!body||typeof body!=='object'||Array.isArray(body))throw new Error();return body;}catch{throw new Error('请求格式无效');}
}
export async function handleCodexTodosApi(req,res,url,session,json,dependencies){
  const uid=session.userId,can=id=>hasPermission(session.permissions || [],'codex-cli:todos:'+id);
  const canRun=()=>can('run')&&chatPermissions.every(p=>hasPermission(session.permissions || [],p));
  if(!can('view')||!hasPermission(session.permissions || [],'qq-codex:execute'))return json(res,403,{ok:false,error:'无权访问待办列表'});
  const match=/^\/api\/codex-cli\/todos(?:\/([a-zA-Z0-9-]{1,80})(?:\/(pause|resume|move))?)?$/.exec(url.pathname);
  if(!match)return json(res,404,{ok:false,error:'接口不存在'});
  const [,id,action]=match,method=req.method;
  if(!(method==='GET'&&!id||method==='POST'&&(!id||action)||['PATCH','DELETE'].includes(method)&&id&&!action))return json(res,405,{ok:false,error:'不支持此方法'});
  if(method!=='GET'){
    if(req.headers['sec-fetch-site']==='cross-site'||req.headers.origin&&!['http://'+req.headers.host,'https://'+req.headers.host].includes(req.headers.origin))return json(res,403,{ok:false,error:'不允许跨站写入'});
    const authorized=action==='resume'?canRun():action==='pause'?can('stop'):action==='move'?can('order'):can('edit');
    if(!authorized)return json(res,403,{ok:false,error:'没有执行此待办操作的权限'});
  }
  try{
    const setup=dependencies.setup(uid);if(!setup.configured)return json(res,403,{ok:false,error:'当前账号尚未配置Codex项目'});
    const store=dependencies.store || createCodexStore(getDatabase()),todos=store.todos;
    const allowed=c=>c&&setup.projects.includes(c.project)&&(!c.group_id||store.settings(uid).groups.includes(c.group_id));
    const allowedTodo=row=>row&&setup.projects.includes(row.project)&&(!row.conversation_id||allowed(store.conversations.get(uid,row.conversation_id)));
    if(method==='GET')return json(res,200,{ok:true,todos:todos.list(uid).filter(allowedTodo).map(serialize),projects:setup.projects,enabled:setup.enabled,
      conversations:hasPermission(session.permissions || [],'codex-cli:sessions:view')?store.conversations.list(uid).filter(c=>allowed(c)&&!c.archived).map(c=>({id:c.id,title:c.title,project:c.project})):[],
      permissions:{edit:can('edit'),run:canRun(),stop:can('stop'),order:can('order'),viewConversation:hasPermission(session.permissions || [],'codex-cli:sessions:view')}});
    todos.reconcile();const row=id?todos.get(uid,id):null;
    if(id&&!allowedTodo(row))return json(res,404,{ok:false,error:'待办不存在或未授权'});
    if(method==='DELETE'){todos.remove(uid,id);return json(res,200,{ok:true});}
    const body=await readBody(req);
    if(action){
      if(action==='move'){
        if(Object.keys(body).some(k=>k!=='direction')||!['up','down'].includes(body.direction))throw new Error('排序方向无效');
        return json(res,200,{ok:true,todo:serialize(todos.move(uid,id,body.direction))});
      }
      if(Object.keys(body).length)throw new Error('此操作不接受额外参数');
      return json(res,200,{ok:true,todo:serialize(action==='pause'?todos.pause(uid,id):todos.resume(uid,id))});
    }
    if(Object.keys(body).some(k=>!['project','title','prompt','model','effort','conversationId','autoRun','requestId','scheduledAt'].includes(k))||typeof body.project!=='string'||!setup.projects.includes(body.project)
      ||typeof body.title!=='string'||!body.title.trim()||body.title.length>80||typeof body.prompt!=='string'||!body.prompt.trim()||body.prompt.length>20000||typeof body.autoRun!=='boolean'
      ||body.conversationId!==undefined&&typeof body.conversationId!=='string'||!id&&(typeof body.requestId!=='string'||!/^[a-f0-9-]{16,64}$/i.test(body.requestId)))throw new Error('请填写已授权项目、1—80字标题、1—20000字指令和有效请求标识');
    if(body.scheduledAt!==undefined&&(!Number.isSafeInteger(body.scheduledAt)||body.scheduledAt<0||body.scheduledAt>=Date.UTC(2101,0,1)))throw new Error('执行时间无效，请选择不晚于2100年的日期时间');
    if(body.autoRun&&!canRun())return json(res,403,{ok:false,error:'自动执行需要待办运行与会话执行权限'});
    const conversationId=body.conversationId || '';
    const conversation=conversationId&&store.conversations.get(uid,conversationId);
    if(conversationId&&(!allowed(conversation)||conversation.archived||conversation.project!==body.project))return json(res,404,{ok:false,error:'目标会话不存在或未授权'});
    const catalog=await (dependencies.catalog || readCodexCatalog)(setup.config);
    const runtime=validateRuntime({model:body.model ?? '',effort:body.effort ?? ''},catalog,{partial:true,defaultModel:setup.config.model || catalog.defaults.model});
    resolveRuntime(setup.config,runtime,catalog);
    const fresh=dependencies.setup(uid);
    if(!fresh.configured||!fresh.projects.includes(body.project)||conversationId&&(!store.conversations.get(uid,conversationId)||store.conversations.get(uid,conversationId).archived||conversation.group_id&&!store.settings(uid).groups.includes(conversation.group_id)))return json(res,403,{ok:false,error:'项目或会话授权已撤销'});
    const values={project:body.project,title:body.title.trim(),prompt:body.prompt.trim(),runtime,conversationId,autoRun:body.autoRun,requestId:body.requestId,scheduledAt:body.scheduledAt || 0};
    const saved=id?todos.edit(uid,id,values):todos.create(uid,setup.qqId || '',values);
    return json(res,id?200:201,{ok:true,todo:serialize(saved)});
  }catch(error){return json(res,400,{ok:false,error:error.code?.startsWith('SQLITE_')?'待办保存失败，请重试':error.message});}
}
