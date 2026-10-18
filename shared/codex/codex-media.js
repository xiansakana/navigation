import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { callNapCat } from '../integrations/napcat.js';

export const MAX_ATTACHMENTS = 6;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const mediaRoot = config => path.resolve(config.mediaDirectory || (config.logDirectory ? path.join(config.logDirectory, '..', 'media') : fileURLToPath(new URL('../../qq-bot/data/codex-media', import.meta.url))));
const scopePath = (config, uid, group) => path.join(mediaRoot(config), hash(String(uid)), hash(String(group || '')));
const jobPath = (config, job) => {
  if (!/^[a-f0-9]{16}$/.test(job.id || '') || !job.user_id) throw new Error('附件任务标识无效');
  return path.join(scopePath(config, job.user_id, job.group_id), job.id);
};

export function safeFilename(name) {
  const value = String(name || 'attachment').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 120);
  return value && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(value) ? value : 'attachment';
}

export function attachmentSegments(segments) {
  return segments.filter(s => ['image', 'file'].includes(s.type)).map(s => ({
    kind: s.type, id: String(s.data?.file_id || s.data?.file || s.data?.id || '').slice(0, 8192),
    url: String(s.data?.url || '').slice(0, 8192), name: safeFilename(s.data?.name || s.data?.file_name || (s.type === 'image' ? 'image.png' : 'attachment')),
    size: Number(s.data?.file_size || s.data?.size || 0)
  }));
}

export function validateAttachments(items) {
  if (!Array.isArray(items) || items.length > MAX_ATTACHMENTS) throw new Error('每次最多接收6个附件，请分批发送。');
  for (const item of items) {
    if (!['image', 'file'].includes(item.kind) || (!item.id && !item.url)) throw new Error('附件缺少有效文件标识，请重新上传。');
    if (item.id && (item.id.length > 8192 || /^(?:[a-z]+:|[\\/])|\.\.[\\/]/i.test(item.id))) throw new Error('附件标识无效，请直接发送QQ图片或文件。');
    if (!Number.isFinite(item.size) || item.size < 0 || item.size > MAX_FILE_BYTES) throw new Error('每个附件不能超过25MB。');
  }
  if (items.reduce((n, item) => n + item.size, 0) > MAX_TOTAL_BYTES) throw new Error('每次附件合计不能超过50MB。');
  return items;
}

export function mergeAttachments(...lists) {
  return validateAttachments([...new Map(lists.flat().map(item => [item.kind + ':' + (item.id || item.url),item])).values()]);
}

export function publicAddress(address) {
  if (address.includes(':')) return /^[23][a-f\d]{0,3}:/i.test(address) && !/^(2001:db8:|2002:)/i.test(address);
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a,b] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && [0,168].includes(b) || a === 100 && b >= 64 && b <= 127 || a === 198 && [18,19,51].includes(b) || a === 203 && b === 0);
}

// Pin the checked DNS result to the request, including on redirects. No NapCat credentials leave its API.
export async function downloadAttachment(url, { signal, trusted = false, lookup = dns.lookup, request, maxBytes = MAX_FILE_BYTES } = {}, redirects = 0) {
  const target = new URL(url);
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.port && !['80','443'].includes(target.port)) throw new Error('附件下载地址无效');
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  if (!trusted && !/(^|\.)(qq\.com|qpic\.cn|gtimg\.cn|qlogo\.cn)$/i.test(hostname)) throw new Error('仅接收QQ提供的附件下载地址');
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('附件下载地址不允许访问内网');
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const req = (request || (target.protocol === 'https:' ? https.get : http.get))(target, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
      headers: { 'Accept-Encoding': 'identity' }, lookup: (host, options, callback) => callback(null, options?.all ? [pinned] : pinned.address, pinned.family)
    }, response => {
      if ([301,302,303,307,308].includes(response.statusCode)) {
        response.resume();
        if (redirects >= 3 || !response.headers.location) { reject(new Error('附件下载重定向无效')); return; }
        downloadAttachment(new URL(response.headers.location, target).href, { signal, trusted, lookup, request, maxBytes }, redirects + 1).then(resolve,reject); return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error('附件下载失败，请重新上传文件')); return; }
      if (Number(response.headers['content-length']) > maxBytes) { response.destroy(); reject(new Error('附件实际大小超过25MB或本次总量限制')); return; }
      response.on('data', chunk => { size += chunk.length; if (size > maxBytes) { response.destroy(); reject(new Error('附件实际大小超过25MB或本次总量限制')); } else chunks.push(chunk); });
      response.on('error',reject);
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error',reject);
  });
}

async function attachmentBytes(napcat, item, group, { signal, api = callNapCat, download = downloadAttachment } = {}) {
  const call = (action, params) => api(napcat.baseUrl,napcat.accessToken || '',action,params,{signal,timeout:60000,maxResponseBytes:Math.ceil(MAX_FILE_BYTES * 4 / 3) + 4096});
  if (item.id) {
    try {
      const response = await call(item.kind === 'image' ? 'get_image' : group ? 'get_group_file_url' : 'get_private_file_url', item.kind === 'image' ? {file:item.id} : {file_id:item.id,...(group?{group_id:group}:{})});
      if (/^https?:\/\//i.test(response.data?.url || '')) return await download(response.data.url,{signal,trusted:true});
    } catch (error) { if (signal?.aborted) throw error; }
    try {
      const response = await call('get_file',{file_id:item.id});
      if (response.data?.base64) {
        const encoded = String(response.data.base64).replace(/^base64:\/\//,'');
        if (encoded.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 4) throw new Error('附件实际大小超过25MB');
        return Buffer.from(encoded,'base64');
      }
      if (/^https?:\/\//i.test(response.data?.url || '')) return await download(response.data.url,{signal,trusted:true});
    } catch (error) { if (signal?.aborted) throw error; }
  }
  if (item.url) return download(item.url,{signal});
  throw new Error('无法下载QQ附件，请重新上传；请检查NapCat文件直链接口是否可用。');
}

async function checkedDirectory(directory) {
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  if (path.resolve(await fs.realpath(directory)) !== path.resolve(directory)) throw new Error('附件目录不能包含符号链接');
  return directory;
}

export async function prepareCodexMedia(config, job, napcat, options = {}) {
  const items = validateAttachments(JSON.parse(job.attachments_json || '[]'));
  const root = jobPath(config,job);
  const input = await checkedDirectory(path.join(root,'input'));
  const output = await checkedDirectory(path.join(root,'output'));
  await checkedDirectory(path.join(root,'sent'));
  let total = 0; const files = [];
  for (const [index,item] of items.entries()) {
    const bytes = await attachmentBytes(napcat,item,job.group_id,options);
    total += bytes.length;
    if (!bytes.length || bytes.length > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) throw new Error('附件为空或实际大小超过25MB/合计50MB限制');
    const image = imageExtension(bytes);
    if (item.kind === 'image' && !image) throw new Error('图片格式不支持，请使用PNG、JPEG、WebP或GIF。');
    const filename = `${index + 1}-${safeFilename(item.name)}${item.kind === 'image' ? '.' + image : ''}`;
    const local = path.join(input,filename);
    await fs.writeFile(local,bytes,{flag:'wx',mode:0o600});
    files.push({path:local,name:item.name,kind:image ? 'image' : 'file'});
  }
  return {root,output,files};
}

function imageExtension(bytes) {
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (/^GIF8[79]a/.test(bytes.subarray(0,6).toString())) return 'gif';
  if (bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP') return 'webp';
  return '';
}

async function readRegularFile(root, file, maxBytes = MAX_FILE_BYTES) {
  const resolved = path.resolve(file), relative = path.relative(path.resolve(root),resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.resolve(await fs.realpath(resolved)) !== resolved) throw new Error('返回文件必须位于当前任务输出目录，不能使用符号链接');
  const handle = await fs.open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error('返回文件必须为普通文件，每个不超过25MB');
    const chunks = []; let size = 0;
    for await (const chunk of handle.createReadStream({autoClose:false})) { size += chunk.length; if (size > maxBytes) throw new Error('返回文件大小超限'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}

export async function collectCodexArtifacts(config, job, media) {
  await checkedDirectory(path.join(jobPath(config,job),'sent'));
  const entries = await fs.readdir(media.output,{withFileTypes:true});
  if (entries.length > MAX_ATTACHMENTS) throw new Error('每个任务最多返回6个文件，请分批生成。');
  let total = 0; const artifacts = [];
  for (const entry of entries) {
    if (entry.name !== safeFilename(entry.name) || !entry.isFile()) throw new Error('输出目录只允许直接放置普通文件；多个文件夹请先打包。');
    const bytes = await readRegularFile(media.output,path.join(media.output,entry.name));
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('返回文件合计不能超过50MB');
    const digest = hash(bytes), file = digest + '.bin';
    const target = path.join(jobPath(config,job),'sent',file);
    try { await fs.writeFile(target,bytes,{flag:'wx',mode:0o600}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    artifacts.push({jobId:job.id,file,name:entry.name,kind:imageExtension(bytes) && bytes.length <= 10 * 1024 * 1024 ? 'image' : 'file',size:bytes.length,sha256:digest});
  }
  return artifacts;
}

export async function sendCodexArtifact(config, target, artifact, { userId, groupId = '', api = callNapCat } = {}) {
  if (!/^[a-f0-9]{64}\.bin$/.test(artifact.file || '') || artifact.sha256 + '.bin' !== artifact.file) throw new Error('返回文件标识无效');
  const root = jobPath(config.codex,{id:artifact.jobId,user_id:userId,group_id:groupId});
  const bytes = await readRegularFile(path.join(root,'sent'),path.join(root,'sent',artifact.file));
  if (hash(bytes) !== artifact.sha256 || bytes.length !== artifact.size) throw new Error('返回文件校验失败');
  const file = 'base64://' + bytes.toString('base64');
  const group = target.type === 'group';
  const recipient = group ? {group_id:String(target.groupId)} : {user_id:String(target.userId)};
  let action,params;
  if (artifact.kind === 'image') {
    action = group ? 'send_group_msg' : 'send_private_msg';
    params = {...recipient,message:[...(group && target.atUserId ? [{type:'at',data:{qq:String(target.atUserId)}}] : []),{type:'image',data:{file}}]};
  } else {
    action = group ? 'upload_group_file' : 'upload_private_file';
    params = {...recipient,file,name:safeFilename(artifact.name)};
  }
  return api(config.napcat.baseUrl,config.napcat.accessToken || '',action,params,{timeout:120000});
}
