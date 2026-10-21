import fs from 'node:fs';
import path from 'node:path';

export function reanalysisTargets(store, uid, input, includeTranscript = false) {
  if (Array.isArray(input.items)) {
    if (!input.items.length || input.items.length > 2000 || input.items.some(r => !r || !/^[a-f0-9]{32}$/.test(r.id) || !Number.isSafeInteger(r.revision))) throw new Error('请选择1至2000篇笔记，并刷新版本');
    const seen = new Set();
    return input.items.filter(r => !seen.has(r.id) && seen.add(r.id)).map(r => ({ id: r.id, revision: r.revision }));
  }
  if (input.preview !== true) throw new Error('请先预览并确认本次重新分析的笔记');
  const items = [];
  for (let offset = 0; ; offset += 100) {
    const result = store.list(uid, { search: String(input.search || ''), topic: String(input.topic || ''), status: 'ready', offset, limit: 100, includeTranscript });
    items.push(...result.documents.map(d => ({ id: d.id, revision: d.revision })));
    if (items.length >= result.total) break;
  }
  return items;
}
export function scheduleReanalysis(store, uid, items, mode, directoryFor, preview = false) {
  if (!['reuse', 'full'].includes(mode)) throw new Error('重新分析方式无效');
  const results = [];
  for (const item of items) {
    try {
      const d = store.get(uid, item.id);
      if (!d || !['ready', 'failed'].includes(d.status) || !d.notes || d.revision !== item.revision) throw new Error('笔记不存在、已更新或正在处理');
      if (mode === 'reuse') {
        if (!d.duration || !d.transcript.length && !d.frames.length) throw new Error('缺少可复用素材，请选择重新提取原视频');
        if (d.frames.some(f => !/^[a-z0-9.-]+\.jpg$/.test(f.name) || !fs.existsSync(path.join(directoryFor(d.id), f.name)))) throw new Error('关键画面文件缺失，请选择重新提取原视频');
      } else if (!fs.existsSync(path.join(directoryFor(d.id), 'source')) && !(d.storage.provider === '115' && ['ready', 'verified'].includes(d.storage.state))) throw new Error('原视频尚不可用，请等待115归档完成或改用已有素材');
      if (!preview) store.reanalysis.schedule(uid, d.id, item.revision, mode, store.settings(uid));
      results.push({ ...item, accepted: true });
    } catch (e) { results.push({ ...item, accepted: false, error: /^SQLITE_/.test(e.code || '') ? '知识库忙，请稍后重试' : e.message }); }
  }
  return { accepted: results.filter(r => r.accepted).length, skipped: results.filter(r => !r.accepted).length, results };
}
