import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withCodexClient } from './codex-client.js';
const run=promisify(execFile);
const slug=value=>typeof value==='string'&&/^[a-zA-Z0-9][\w./:-]{0,119}$/.test(value);
const level=value=>typeof value==='string'&&/^[a-z0-9_-]{1,24}$/.test(value);

export async function readCodexCatalog(config, options={}) {
  return (options.client || withCodexClient)(config,async({call})=>{
    const current=await call('config/read',{includeLayers:true});
    const models=[];let cursor;
    for(let page=0;page<5;page++){
      const result=await call('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}:{})});
      for(const model of result.data || []){
        if(!slug(model.model || model.id)||model.hidden)continue;
        const efforts=(model.supportedReasoningEfforts || []).map(e=>e.reasoningEffort).filter(level);
        models.push({id:model.model || model.id,name:String(model.displayName || model.model || model.id).slice(0,160),efforts,defaultEffort:efforts.includes(model.defaultReasoningEffort)?model.defaultReasoningEffort:efforts[0] || '',isDefault:!!model.isDefault,inputModalities:(model.inputModalities || ['text','image']).filter(m=>['text','image'].includes(m))});
      }
      cursor=result.nextCursor;if(!cursor)break;
    }
    if(!models.length)throw new Error('服务器未返回可用模型，请检查CLI登录状态。');
    const raw=current.config || {},userLayer=(current.layers || []).find(l=>l.name?.type==='user'&&!l.name?.profile);
    const model=raw.model || raw.models?.new_thread?.model || models.find(m=>m.isDefault)?.id || models[0].id;
    const effort=raw.model_reasoning_effort || raw.models?.new_thread?.model_reasoning_effort || models.find(m=>m.id===model)?.defaultEffort || '';
    return {models,defaults:{model,effort},version:userLayer?.version || '',safety:{sandbox:typeof raw.sandbox_mode==='string'?raw.sandbox_mode:null,approval:typeof raw.approval_policy==='string'?raw.approval_policy:null}};
  },options);
}

export function validateRuntime(input,catalog,{partial=false,defaultModel=catalog.defaults.model}={}) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['model','effort'].includes(k)))throw new Error('只允许设置模型和推理强度');
  const model=input.model ?? '',effort=input.effort ?? '';
  if(typeof model!=='string'||typeof effort!=='string'||model&&!catalog.models.some(m=>m.id===model))throw new Error('请选择服务器返回的可用模型');
  const selected=catalog.models.find(m=>m.id===(model || defaultModel));
  if(!selected)throw new Error('当前默认模型不在可用列表，请先选择可用模型');
  if(effort&&!selected.efforts.includes(effort))throw new Error('该模型不支持此推理强度，可选：'+selected.efforts.join('、'));
  if(!partial&&(!model||!effort&&selected.efforts.length))throw new Error('请选择模型和对应的推理强度');
  return {model,effort};
}

export function resolveRuntime(config,preference,catalog) {
  const model=preference.model || config.model || catalog.defaults.model;
  const selected=catalog.models.find(m=>m.id===model);
  if(!selected)throw new Error('所选模型已不可用，请发送 codex 模型 重新选择');
  const desired=preference.effort || (preference.model ? selected.defaultEffort : config.reasoningEffort || catalog.defaults.effort) || selected.defaultEffort;
  if(desired&&!selected.efforts.includes(desired))throw new Error('所选强度已不适用，请发送 codex 强度 默认 后重试');
  return {model,effort:desired || ''};
}

export async function readCodexStatus(config,options={}) {
  const catalog=await readCodexCatalog(config,options);
  const account=await (options.client || withCodexClient)(config,({call})=>call('account/read',{refreshToken:false}),options);
  let version='未知';try{version=(await run(config.binary || 'codex',['--version'],{timeout:5000,windowsHide:true,maxBuffer:8192})).stdout.trim().slice(0,120);}catch{/* Catalog remains useful on a missing version banner. */}
  return {...catalog,cliVersion:version,account:{loggedIn:!!account?.account,type:account?.account?.type || null,planType:account?.account?.planType || null},qqOverrides:{model:config.model || '',effort:config.reasoningEffort || '',sandbox:config.sandbox || 'workspace-write',approval:'never'}};
}

export async function writeCodexDefaults(config,input,{catalog,client=withCodexClient,...options}={}) {
  if(!input||Object.keys(input).some(k=>!['model','effort','version'].includes(k))||typeof input.version!=='string'||!input.version||input.version.length>256)throw new Error('设置版本无效，请刷新页面后保存');
  const current=catalog || await readCodexCatalog(config,{client,...options});
  const values=validateRuntime({model:input.model,effort:input.effort},current);
  if(input.version!==current.version)throw new Error('服务器设置已变化，请刷新后重新保存');
  const result=await client(config,({call})=>call('config/batchWrite',{expectedVersion:input.version,edits:[{keyPath:'model',value:values.model,mergeStrategy:'replace'},{keyPath:'model_reasoning_effort',value:values.effort || null,mergeStrategy:'replace'}]}),options);
  return {model:values.model,effort:values.effort,version:result.version || ''};
}
