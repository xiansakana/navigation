import path from 'node:path';
import {withCodexClient} from '../../shared/codex/codex-client.js';

const sourceKinds=['cli','vscode','exec','appServer','subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther','unknown'];
const caches=new Map();
const timestamp=n=>Number.isFinite(n)?(n<1e12?n*1000:n):0;
const state=type=>({inProgress:'running',completed:'succeeded',failed:'failed',interrupted:'cancelled',active:'running',systemError:'failed'}[type]||'history');
export function nativeSummary(t,archived=false) {
  return {id:'cli-'+t.id,title:String(t.name||t.preview||'Codex CLI 会话').slice(0,160),project:path.basename(t.cwd||'服务器'),source:'cli',groupId:'',archived,
    createdAt:timestamp(t.createdAt),updatedAt:timestamp(t.updatedAt),state:state(t.status?.type),readOnly:true};
}
export function nativeJobs(thread,turns) {
  return turns.map(turn=>({id:turn.id,prompt:(turn.items||[]).filter(i=>i.type==='userMessage').flatMap(i=>(i.content||[]).filter(c=>c.type==='text').map(c=>c.text)).join('\n').slice(0,100000),
    result:(turn.items||[]).filter(i=>i.type==='agentMessage').map(i=>i.text||'').join('\n\n').slice(0,500000),state:state(turn.status),session_id:thread.id,
    runtime:{model:thread.model||'',effort:thread.reasoningEffort||''},created_at:timestamp(turn.startedAt||thread.createdAt),finished_at:timestamp(turn.completedAt),progress:[],origin:'cli'}));
}
export function createServerSessions(db,{client=withCodexClient}={}) {
  const exists=table=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  const knowledge=(uid,all=false)=>{
    if(!exists('knowledge_documents'))return [];
    return db.prepare(`SELECT * FROM knowledge_documents WHERE ${all?'1':'user_id=?'} AND status<>'deleting' AND
      ((backend='codex' AND (attempt>0 OR notes<>'')) ${exists('knowledge_codex_calls')?'OR EXISTS(SELECT 1 FROM knowledge_codex_calls c WHERE c.user_id=knowledge_documents.user_id AND c.document_id=knowledge_documents.id)':''})
      ORDER BY updated_at DESC`).all(...(all?[]:[uid]));
  };
  const knowledgeSummary=row=>({id:'knowledge-'+row.id,title:row.title,project:'知识库',source:'knowledge',groupId:'',archived:false,createdAt:Date.parse(row.created_at),updatedAt:Date.parse(row.updated_at),
    state:row.status==='processing'?'running':row.status==='ready'?'succeeded':row.status==='failed'?'failed':'queued',readOnly:true,sourceUrl:'/knowledge/?document='+row.id});
  const nativeList=async(config,archived,cursor)=>{
    const key=JSON.stringify([config.binary,process.env.CODEX_HOME,archived,cursor]);
    let cached=caches.get(key);if(cached&&cached.until>Date.now())return cached.promise;
    if(caches.size>100)caches.clear();
    cached={until:Date.now()+10000,promise:client(config,({call})=>call('thread/list',{limit:100,sortKey:'updated_at',sourceKinds,archived,cursor:cursor||null}))};
    caches.set(key,cached);try{return await cached.promise;}catch(e){caches.delete(key);throw e;}
  };
  return {
    async list(uid,{config,all=false,canKnowledge=false,archived=false,cursor='',excludeSessionIds=[]}) {
      const conversations=!cursor&&canKnowledge?knowledge(uid,all).map(knowledgeSummary):[];
      if(!all)return {conversations,nextCursor:null};
      try{
        const result=await nativeList(config,archived,cursor),known=new Set(excludeSessionIds);
        conversations.push(...(result.data||[]).filter(t=>!known.has(t.id)).map(t=>nativeSummary(t,archived)));
        return {conversations,nextCursor:result.nextCursor||null};
      }catch{return {conversations,nextCursor:null,warning:'服务器 CLI 历史暂不可用，模块会话仍可查看，请稍后重试。'};}
    },
    async detail(uid,id,{config,all=false,canKnowledge=false,canKnowledgePrompts=false,archived=false,cursor=''}) {
      if(id.startsWith('knowledge-')&&canKnowledge){
        const doc=knowledge(uid,all).find(d=>'knowledge-'+d.id===id);if(!doc)return null;
        if(cursor&&!/^knowledge-\d+$/.test(cursor))throw new Error('分页标识无效');
        const calls=canKnowledgePrompts&&exists('knowledge_codex_calls')?db.prepare('SELECT rowid AS sequence,* FROM knowledge_codex_calls WHERE user_id=? AND document_id=? AND rowid<? ORDER BY rowid DESC LIMIT 31').all(doc.user_id,doc.id,cursor?Number(cursor.slice(10)):Number.MAX_SAFE_INTEGER):[];
        const nextCursor=calls.length>30?'knowledge-'+calls[29].sequence:null;
        const page=calls.slice(0,30).reverse();
        const jobs=page.map(c=>({id:c.attempt+'-'+c.id,prompt:c.prompt,result:c.result,state:c.state==='running'&&(doc.status!=='processing'||c.attempt!==doc.attempt||Date.parse(doc.heartbeat||'')<Date.now()-15*60000)?'failed':c.state,runtime:{model:c.model},session_id:c.session_id,
          created_at:c.created_at,finished_at:c.state==='running'?0:c.updated_at,origin:'knowledge',progress:[]}));
        // Older ephemeral executions did not retain prompts or CLI thread logs. Show the real saved result, never fabricate those turns.
        if(!calls.length&&!cursor)jobs.push({id:doc.id,prompt:'知识库视频学习：'+doc.title,result:doc.notes||doc.error||doc.stage,state:knowledgeSummary(doc).state,runtime:JSON.parse(doc.provenance_json||'{}'),
          created_at:Date.parse(doc.created_at),progress:[{kind:'status',text:canKnowledgePrompts?'历史临时调用未记录逐轮对话；此处展示知识库已保存的结果和状态。':'此处仅展示已保存的笔记与状态；逐轮调用需要转写和画面查看权限。'}],origin:'knowledge'});
        return {conversation:knowledgeSummary(doc),jobs,nextCursor};
      }
      if(!all||!/^cli-[a-zA-Z0-9-]{1,80}$/.test(id))return null;
      return client(config,async({call})=>{
        const {thread}=await call('thread/read',{threadId:id.slice(4)});
        const history=await call('thread/turns/list',{threadId:thread.id,limit:30,sortDirection:'desc',itemsView:'full',cursor:cursor||null});
        return {conversation:nativeSummary(thread,archived),jobs:nativeJobs(thread,[...(history.data||[])].reverse()),nextCursor:history.nextCursor||null};
      });
    }
  };
}
