import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { runProcess } from './knowledge-model.js';
import { qualitySettings } from './knowledge-bilibili-account.js';

const headers = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' };
export const IMPORT_LIMIT = 1024 ** 3;
export function bilibiliUrl(input) {
  // Share text may include a title; only the URL is used. Never forward arbitrary query parameters.
  const text = String(input || '').trim();
  const match = text.match(/https?:\/\/[^\s<>"“”]+/i);
  let u;
  try { u = new URL(match?.[0] || text); } catch { throw new Error('请输入B站视频链接或b23.tv分享链接'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port) throw new Error('视频链接无效');
  if (u.hostname === 'b23.tv' && /^\/[A-Za-z0-9]{1,32}\/?$/.test(u.pathname)) return 'https://b23.tv' + u.pathname;
  const id = /^\/video\/(BV[A-Za-z0-9]{10}|av[1-9]\d{0,19})\/?$/i.exec(u.pathname)?.[1];
  if (!['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(u.hostname) || !id) throw new Error('目前支持B站视频页和b23.tv短链接');
  const part = u.searchParams.get('p') || '1';
  if (!/^\d{1,4}$/.test(part) || Number(part) < 1) throw new Error('B站分P编号无效');
  return 'https://www.bilibili.com/video/' + id + '/' + (Number(part) > 1 ? '?p=' + Number(part) : '');
}
async function resolveUrl(input, fetcher, signal) {
  const url = bilibiliUrl(input);
  if (!url.startsWith('https://b23.tv/')) return url;
  const response = await fetcher(url, { headers, redirect: 'manual', signal });
  await response.body?.cancel();
  const location = response.headers.get('location');
  if (![301, 302, 303, 307, 308].includes(response.status) || !location) throw new Error('B站短链接无法解析');
  const target = bilibiliUrl(new URL(location, url).href);
  if (target.startsWith('https://b23.tv/')) throw new Error('B站短链接未指向视频页');
  return target;
}
async function api(route, fetcher, signal, cookie = '') {
  const response = await fetcher('https://api.bilibili.com' + route, { headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) }, redirect: 'error', signal });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 412) throw Object.assign(new Error('B站风控暂时拦截了请求（HTTP 412）。请勿连续重试；可在处理设置中检查B站绑定状态，稍后再试或上传本地视频。'), { code: 'BILIBILI_RISK_CONTROL' });
    throw new Error('B站接口暂时不可用（HTTP ' + response.status + '），请稍后重试');
  }
  // Metadata is bounded too; never buffer an unbounded remote response.
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 2 * 1024 ** 2) throw new Error('B站元数据超过限制'); chunks.push(Buffer.from(chunk)); }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('B站返回的数据无效'); }
  if (result.code !== 0 || !result.data) throw new Error('B站视频不可用、需要登录或没有访问权限（' + String(result.code) + '）');
  return result.data;
}
export function suggestedTopic(title, tags, category = '') {
  const text = [title, ...tags].join(' ');
  if (/八字|命理|四柱|紫微|六爻|风水/.test(text)) return '命理';
  if (/编程|程序|代码|开发|软件|算法|计算机|人工智能|机器学习|python|javascript/i.test(text)) return '技术';
  if (/股票|期权|金融|投资|基金|交易/.test(text)) return '投资';
  return String(category || '视频学习').trim().slice(0, 60);
}
export async function inspectBilibili(input, { fetcher = fetch, cookie = '', signal = AbortSignal.timeout(25000) } = {}) {
  const sourceUrl = await resolveUrl(input, fetcher, signal), u = new URL(sourceUrl);
  const id = u.pathname.split('/')[2], part = Number(u.searchParams.get('p') || 1);
  const data = await api('/x/web-interface/view?' + (id.toLowerCase().startsWith('av') ? 'aid=' + id.slice(2) : 'bvid=' + id), fetcher, signal, cookie);
  const page = data.pages?.find(p => p.page === part);
  if (!page || !Number.isSafeInteger(page.cid) || !/^BV[A-Za-z0-9]{10}$/.test(data.bvid)) throw new Error('B站分P不存在或视频信息不完整');
  const duration = Number(page.duration || data.duration);
  if (!(duration > 0 && duration <= 14400)) throw new Error('视频需在4小时以内');
  let tags = [], tagsUnavailable = false;
  try { tags = (await api('/x/tag/archive/tags?bvid=' + data.bvid, fetcher, signal, cookie)).map(t => String(t.tag_name || '').trim()).filter(Boolean); }
  catch { tagsUnavailable = true; }
  tags = [...new Set(tags)].filter(t => t.length <= 30).slice(0, 20);
  const title = (String(data.title || '') + (data.pages.length > 1 ? ' · P' + part + ' ' + page.part : '')).slice(0, 160).trim();
  if (!title) throw new Error('B站视频没有可用标题');
  return { title, topic: suggestedTopic(title, tags, data.tname_v2 || data.tname), tags,
    sourceUrl: 'https://www.bilibili.com/video/' + data.bvid + '/' + (part > 1 ? '?p=' + part : ''),
    duration, bvid: data.bvid, cid: page.cid, part, uploader: String(data.owner?.name || '').slice(0, 100),
    warnings: tagsUnavailable ? ['标签暂未读取，可手动填写。'] : [] };
}
export function mediaUrl(value) {
  let u;
  try { u = new URL(value); } catch { throw new Error('B站视频流地址无效'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port ||
      !['bilivideo.com', 'bilivideo.cn', 'bilivideo.net', 'hdslb.com'].some(h => u.hostname.endsWith('.' + h))) throw new Error('B站视频流域名不在允许范围');
  return u.href;
}
export const qualityLabel = q => ({ 80: '1080p', 64: '720p', 32: '480p', 16: '360p' })[q] || '未知';
function streamQuality(v) {
  return Number(v.id) || (Number(v.height) >= 1080 ? 80 : Number(v.height) >= 720 ? 64 : Number(v.height) >= 480 ? 32 : 16);
}
export function availableQualities(data) {
  const values = (data.dash?.video || []).filter(v => Number(v.codecid) === 7).map(streamQuality);
  if (!values.length && data.durl?.length === 1) values.push(Number(data.quality));
  return [...new Set(values)].filter(q => [80, 64, 32, 16].includes(q)).sort((a, b) => b - a);
}
export function selectBilibiliMedia(data, settings = {}) {
  const { quality, strict } = qualitySettings(settings);
  if (data.is_preview || data.isPreview) throw new Error('此视频只提供试看，请使用有权访问的完整视频');
  const available = availableQualities(data), selected = strict ? available.find(q => q === quality) : available.find(q => q <= quality);
  if (!selected) throw new Error(`没有可用的${qualityLabel(quality)}视频流；当前可用：${available.map(qualityLabel).join('、') || '无'}。请扫码绑定、选择较低清晰度或允许自动降级`);
  const video = (data.dash?.video || []).filter(v => streamQuality(v) === selected && Number(v.codecid) === 7)
    .sort((a, b) => b.bandwidth - a.bandwidth)[0];
  const audio = (data.dash?.audio || []).sort((a, b) => b.bandwidth - a.bandwidth)[0];
  if (video && audio) return { urls: [mediaUrl(video.baseUrl || video.base_url), mediaUrl(audio.baseUrl || audio.base_url)], quality: selected, availableQualities: available };
  if (data.durl?.length === 1) return { urls: [mediaUrl(data.durl[0].url)], quality: selected, availableQualities: available };
  throw new Error('没有可下载的完整音视频流，可能需要登录；可改用上传文件');
}
export const selectStreams = (data, settings) => selectBilibiliMedia(data, settings).urls;
async function playback(meta, settings, fetcher, signal, cookie) {
  return api(`/x/player/playurl?bvid=${meta.bvid}&cid=${meta.cid}&qn=${settings.quality}&fnval=4048&fourk=0`, fetcher, signal, cookie);
}
export async function inspectBilibiliQuality(meta, settings = {}, { fetcher = fetch, cookie = '', signal = AbortSignal.timeout(20000) } = {}) {
  settings = qualitySettings(settings);
  const data = await playback(meta, settings, fetcher, signal, cookie);
  const available = availableQualities(data);
  try {
    const selected = selectBilibiliMedia(data, settings);
    return { ...settings, availableQualities: available, selectedQuality: selected.quality, canImport: true, reason: '' };
  } catch (e) { return { ...settings, availableQualities: available, selectedQuality: null, canImport: false, reason: e.message }; }
}
async function download(url, file, budget, fetcher, signal, progress) {
  let response;
  for (let redirect = 0; redirect <= 3; redirect++) {
    response = await fetcher(mediaUrl(url), { headers, redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location'); await response.body?.cancel();
    if (!location || redirect === 3) throw new Error('视频流重定向过多');
    url = mediaUrl(new URL(location, url).href);
  }
  if (response.status !== 200) { await response.body?.cancel(); throw new Error('B站视频流读取失败（HTTP ' + response.status + '）'); }
  const declared = Number(response.headers.get('content-length'));
  if (declared > budget.remaining) { await response.body?.cancel(); throw new Error('视频超过1GB限制'); }
  const limit = new Transform({ transform(chunk, _, cb) {
    budget.remaining -= chunk.length; budget.downloaded += chunk.length;
    if (budget.remaining < 0) return cb(new Error('视频超过1GB限制'));
    progress(budget.downloaded); cb(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), limit, fs.createWriteStream(file, { mode: 0o600 }), { signal });
}
export async function downloadBilibili(input, directory, { fetcher = fetch, signal, cookie = '', quality = 80, strict = true, progress = () => {}, run = runProcess } = {}) {
  const meta = await inspectBilibili(input, { fetcher, signal, cookie });
  const data = await playback(meta, qualitySettings({ quality, strict }), fetcher, signal, cookie);
  const media = selectBilibiliMedia(data, { quality, strict }), urls = media.urls, budget = { remaining: IMPORT_LIMIT, downloaded: 0 };
  const temp = path.join(directory, 'link-download');
  await fsp.mkdir(temp, { recursive: true, mode: 0o700 });
  try {
    for (let i = 0; i < urls.length; i++) await download(urls[i], path.join(temp, String(i)), budget, fetcher, signal, progress);
    const output = path.join(temp, 'merged.mp4');
    const inputs = urls.flatMap((_, i) => ['-i', path.join(temp, String(i))]);
    try { await run(process.env.KNOWLEDGE_IMPORT_FFMPEG || 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...inputs,
      '-map', '0:v:0', '-map', (urls.length > 1 ? '1' : '0') + ':a:0', '-c', 'copy', '-movflags', '+faststart', output], { signal, timeout: 180000 }); }
    catch { throw new Error('音视频合并失败，请检查服务器FFmpeg或改用上传文件'); }
    const size = (await fsp.stat(output)).size;
    if (size < 12 || size > IMPORT_LIMIT) throw new Error('下载的视频为空或超过1GB限制');
    let probe;
    try { probe = JSON.parse(await run(process.env.KNOWLEDGE_IMPORT_FFPROBE || 'ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', output], { signal, timeout: 20000 })); }
    catch { throw new Error('无法验证下载视频的实际分辨率，请检查FFprobe'); }
    const v = probe.streams?.find(s => s.codec_type === 'video');
    if (!v || !Number.isSafeInteger(v.width) || !Number.isSafeInteger(v.height) || v.width <= 0 || v.height <= 0 || !probe.streams.some(s => s.codec_type === 'audio')) throw new Error('下载视频缺少有效画面或音轨');
    return { file: output, bytes: size, meta, media: { requestedQuality: quality, quality: media.quality, strict, width: v.width, height: v.height, downgraded: media.quality !== quality }, cleanup: () => fsp.rm(temp, { recursive: true, force: true }) };
  } catch (e) { await fsp.rm(temp, { recursive: true, force: true }); throw e; }
}
