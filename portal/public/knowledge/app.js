import { uploadParts } from './upload.js?v=1';
const $ = id => document.getElementById(id);
const state = { permissions: [], documents: [], current: null, settings: null, editing: false, resume: null, uploading: false, offset: 0, total: 0, query: 0 };
const can = action => state.permissions.includes('*') || state.permissions.includes('knowledge:' + action);
const text = (id, value) => { $(id).textContent = value || ''; };
const show = (id, yes) => { $(id).hidden = !yes; };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tags = value => value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
const time = value => { const s = Math.floor(value || 0); return (s >= 3600 ? String(Math.floor(s / 3600)).padStart(2, '0') + ':' : '') + String(Math.floor(s / 60) % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
function error(e) { text('error', e.message || String(e)); show('error', true); }
async function api(route, options = {}) {
  const response = await fetch('/api/knowledge' + route, { ...options, headers: { ...(options.body instanceof Blob ? {} : { 'Content-Type': 'application/json' }), ...options.headers } });
  if (response.redirected) throw new Error('登录已过期，请刷新页面重新登录');
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || '请求失败');
  return payload;
}
const send = (route, method, data = {}) => api(route, { method, body: JSON.stringify(data) });
async function settings() {
  state.settings = await api('/settings');
  text('storage-policy', state.settings.storage?.provider === '115' ? '原视频保存至115，上传和处理期间使用临时缓存。' : '原视频保存在服务器。');
  $('backend').value = state.settings.backend;
  $('backend').disabled = !can('settings:edit');
  const worker = state.settings.worker, c = worker.capabilities;
  text('worker-status', worker.online ? `${worker.label || '工作器'} · 在线${worker.scheduling === 'gpu-first' ? ' · GPU 优先，离线后由服务器接手后续任务' : ''}` : worker.configured ? '工作器离线，等待连接。已上传的任务会保留在队列中。' : '尚未连接工作器。生成个人凭据后，可在服务器或本机启动处理。');
  const info = c[state.settings.backend];
  text('backend-description', info ? `${info.ready ? '可用' : '尚不可用'} · ${info.model || info.detail || ''}` : '选择总结方式后，由已连接工作器执行。');
}
function renderList() {
  text('total', state.total + ' 篇');
  const list = $('documents'); list.replaceChildren();
  if (!state.documents.length) { const p = document.createElement('p'); p.className = 'kb-hint'; p.textContent = '还没有符合条件的内容。上传视频后会出现在这里。'; list.append(p); }
  for (const d of state.documents) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'kb-document' + (state.current?.id === d.id ? ' active' : '');
    button.innerHTML = `<strong>${escape(d.title)}</strong><small>${escape(d.topic || '未分类')} · ${escape(d.storage?.provider === '115' && d.storage.state !== 'ready' ? ({ waiting: '等待上传', pending: '等待保存至115', uploading: '正在保存至115', verifying: '校验原视频', verified: '清理临时原片', failed: '115保存待重试' })[d.storage.state] || d.stage : d.stage)}${d.status === 'processing' ? ' ' + d.progress + '%' : ''}</small><p>${escape(d.preview || d.originalName)}</p>`;
    button.addEventListener('click', () => open(d.id).catch(error)); list.append(button);
  }
  show('more', state.documents.length < state.total);
}
async function load(more = false) {
  const query = ++state.query, offset = more ? state.documents.length : 0;
  const params = new URLSearchParams({ search: $('search').value, topic: $('topic-filter').value, status: $('status-filter').value, offset });
  const result = await api('/documents?' + params);
  if (query !== state.query) return;
  state.documents = more ? [...state.documents, ...result.documents] : result.documents; state.total = result.total;
  const topic = $('topic-filter').value;
  $('topic-filter').innerHTML = '<option value="">全部分类</option>' + result.topics.map(t => `<option value="${escape(t.topic)}">${escape(t.topic)} (${t.count})</option>`).join('');
  $('topic-filter').value = topic;
  $('topics').innerHTML = result.topics.map(t => `<option value="${escape(t.topic)}"></option>`).join('');
  renderList();
}
function tab(name) {
  for (const button of $('tabs').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.tab === name)); show(button.dataset.tab + '-view', button.dataset.tab === name && !state.editing);
  }
}
function renderStorage(d) {
  const source = d.storage || { provider: 'local', state: 'local' };
  const labels = { waiting: '等待视频上传', pending: '等待保存至115', uploading: '正在保存至115', verifying: '正在校验115原视频', verified: '115校验通过，正在清理临时原片', ready: '原视频已保存至115 · ECS原片已清理', failed: source.error || '115保存失败，临时原片已保留' };
  text('storage-status', source.provider === '115' ? labels[source.state] || '正在保存至115' : '原视频保存在服务器');
  if (source.timings) {
    const durations = [];
    if (source.timings.uploadMs > 0) durations.push(`保存至115${source.state === 'uploading' ? '已用' : '用时'} ${time(source.timings.uploadMs / 1000)}`);
    if (source.timings.verificationMs > 0) durations.push(`完整性校验${source.state === 'verifying' ? '已用' : '用时'} ${time(source.timings.verificationMs / 1000)}`);
    if (durations.length) text('storage-status', $('storage-status').textContent + ' · ' + durations.join(' · '));
  }
  show('storage-retry', source.state === 'failed' && can('storage:edit'));
}
function renderDocument(d) {
  state.current = d; state.editing = false; show('empty', false); show('detail', true); show('edit-form', false); show('tabs', true);
  renderStorage(d);
  text('document-title', d.title);
  text('document-meta', `${d.topic || '未分类'} · ${time(d.duration)} · ${d.originalName} · ${d.backend === 'codex' ? 'Codex CLI' : '兼容 API'} · ${new Date(d.updatedAt).toLocaleString('zh-CN')}`);
  $('document-tags').innerHTML = d.tags.map(t => '<span>' + escape(t) + '</span>').join('');
  text('job-status', d.error || d.stage + (d.status === 'processing' ? ' · ' + d.progress + '%' : ''));
  $('job-status').className = d.status;
  show('retry', d.status === 'failed' && can('process:edit')); show('resume-upload', d.status === 'uploading' && can('upload:edit'));
  show('edit', can('notes:edit') && ['ready', 'failed'].includes(d.status));
  show('delete', can('delete:edit')); show('export', can('export:view') && !!d.notes);
  $('export').href = '/api/knowledge/documents/' + d.id + '/export';
  const p = d.provenance;
  text('provenance', p.generatedAt ? `生成于 ${new Date(p.generatedAt).toLocaleString('zh-CN')} · ${p.model || p.backend} · ${p.vision ? '含抽样画面核对' : '未进行模型视觉核对'}。${(p.warnings || []).join(' ')}` : '任务完成后在这里阅读完整笔记。');
  $('note-content').innerHTML = DOMPurify.sanitize(marked.parse(d.notes || ''), { USE_PROFILES: { html: true }, FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'form', 'input', 'button', 'style'], FORBID_ATTR: ['style', 'id', 'name'] });
  for (const a of $('note-content').querySelectorAll('a')) { a.rel = 'noopener noreferrer'; a.target = '_blank'; }
  $('outline').replaceChildren();
  [...$('note-content').querySelectorAll('h2,h3')].forEach((h, i) => {
    h.id = 'kb-heading-' + i;
    if (h.tagName !== 'H2') return;
    const link = document.createElement('a'); link.href = '#' + h.id; link.textContent = h.textContent; $('outline').append(link);
  });
  $('player').removeAttribute('src'); $('player').load();
  if (can('source:view') && d.status !== 'uploading') $('player').src = '/api/knowledge/documents/' + d.id + '/source';
  $('transcript').replaceChildren();
  for (const s of d.transcript) {
    const row = document.createElement('div'); row.className = 'kb-segment';
    const button = document.createElement('button'); button.type = 'button'; button.textContent = time(s.start); button.disabled = !can('source:view');
    button.addEventListener('click', () => { tab('source'); $('player').currentTime = s.start; $('player').play().catch(() => {}); });
    const p = document.createElement('p'); p.textContent = s.text; row.append(button, p); $('transcript').append(row);
  }
  $('frames').replaceChildren();
  for (const f of d.frames) {
    const figure = document.createElement('figure'), image = document.createElement('img'), caption = document.createElement('figcaption');
    image.src = '/api/knowledge/documents/' + d.id + '/frames/' + f.name; image.alt = '视频画面 ' + time(f.time); image.loading = 'lazy'; caption.textContent = '视频时间 ' + time(f.time); figure.append(image, caption); $('frames').append(figure);
  }
  for (const button of $('tabs').querySelectorAll('button')) button.hidden = !can(button.dataset.tab === 'notes' ? 'notes:view' : button.dataset.tab + ':view');
  tab('notes'); renderList();
}
async function open(id, quiet = false) {
  if (!quiet && state.editing && !window.confirm('当前编辑还未保存，放弃修改并打开其他笔记？')) return;
  const d = (await api('/documents/' + id)).document;
  if (quiet && state.current?.id !== id) return;
  if (quiet && d.revision === state.current?.revision && d.status === state.current?.status) { state.current = d; renderStorage(d); text('job-status', d.error || d.stage + (d.status === 'processing' ? ' · ' + d.progress + '%' : '')); return; }
  renderDocument(d);
}
async function upload(event) {
  event.preventDefault(); show('error', false);
  if (state.uploading) return;
  const file = $('video-file').files[0]; if (!file) return;
  if (file.size > state.settings.maxBytes) return error(new Error('视频超过1GB限制'));
  state.uploading = true; $('upload-submit').disabled = true; show('upload-progress', true);
  $('upload-progress').value = 0; text('upload-status', '正在检查文件和续传进度…');
  try {
    const stamp = new Blob([file.slice(0, 1048576), file.slice(Math.max(0, file.size - 1048576)), String(file.size)]);
    const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await stamp.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
    let item = state.resume;
    if (item && (item.bytes !== file.size || item.originalName !== file.name)) throw new Error('请选择同名、同大小的原始视频文件');
    if (item?.fingerprint && item.fingerprint !== fingerprint) throw new Error('文件内容与原上传文件不同，请选择原始视频');
    if (!item) {
      const extension = file.name.split('.').pop().toLowerCase(), mimeType = ({ mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' })[extension];
      const result = await send('/documents', 'POST', { title: $('upload-title').value, topic: $('upload-topic').value, tags: tags($('upload-tags').value), sourceUrl: $('upload-source').value,
        bytes: file.size, mimeType, fingerprint, originalName: file.name, backend: state.settings.backend });
      item = result.document; state.resume = item;
    }
    const { parts, chunkBytes } = await api('/documents/' + item.id + '/parts');
    const transfer = await uploadParts({ file, parts, chunkBytes, url: `/api/knowledge/documents/${item.id}/parts/`, onProgress(p) {
      const progress = Math.min(99, Math.floor(p.loaded / p.total * 100));
      $('upload-progress').value = progress;
      text('upload-status', `上传到服务器 ${progress}% · ${(p.speed / 1024 ** 2).toFixed(2)} MB/s · ${p.remaining === null ? '正在测算剩余时间' : p.loaded === p.total ? '等待服务器确认' : '预计剩余 ' + time(Math.ceil(p.remaining))} · 已用 ${time(p.elapsed)}`);
    } });
    text('upload-status', '分片已传完，正在合并视频…');
    const mergeStarted = performance.now();
    await send('/documents/' + item.id + '/complete', 'POST'); state.resume = null;
    const elapsed = `本次上传用时 ${time(transfer.elapsedMs / 1000)}，合并用时 ${time((performance.now() - mergeStarted) / 1000)}。`;
    text('message', elapsed + (state.settings.storage?.provider === '115' ? '接下来保存至115并校验，之后自动生成笔记。' : '视频已保存，工作器将按队列生成笔记。')); $('upload-progress').value = 100; text('upload-status', '上传完成'); show('upload-panel', false); $('upload-form').reset();
    await load(); await open(item.id);
  } catch (e) { error(e); text('upload-status', '上传未完成，可重新提交继续上传。'); await load().catch(() => {}); }
  finally { state.uploading = false; $('upload-submit').disabled = false; }
}
async function boot() {
  const meResponse = await fetch('/api/me'); if (meResponse.redirected) return location.assign('/login/');
  const me = await meResponse.json(); state.permissions = me.permissions || [];
  if (me.isGuest || !can('view')) throw new Error('请登录具备知识库权限的账号');
  show('upload-toggle', can('upload:edit') && can('process:edit')); show('worker-token', can('worker:edit'));
  await settings();
  if (can('notes:view')) {
    await load();
    const documentId = new URL(location.href).searchParams.get('document');
    if (documentId && /^[a-f0-9]{32}$/.test(documentId)) {
      await open(documentId);
      if (/^#kb-heading-\d+$/.test(location.hash)) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' });
    }
  }
  setInterval(async () => {
    if (document.hidden || state.uploading) return;
    try {
      await settings();
      if (can('notes:view') && (state.current?.storage?.provider === '115' && state.current.storage.state !== 'ready' || state.documents.some(d => ['queued', 'processing', 'uploading'].includes(d.status) || d.storage?.provider === '115' && d.storage.state !== 'ready'))) await load();
      if (!state.editing && state.current && (['queued', 'processing'].includes(state.current.status) || state.current.storage?.provider === '115' && state.current.storage.state !== 'ready')) await open(state.current.id, true);
    } catch { /* Keep existing content during temporary connection loss. */ }
  }, 5000);
}
$('settings-toggle').onclick = () => show('settings', $('settings').hidden);
$('upload-toggle').onclick = () => { state.resume = null; text('upload-heading', '从一个视频开始'); show('upload-panel', true); };
$('upload-close').onclick = () => show('upload-panel', false);
$('upload-form').onsubmit = upload;
$('video-file').onchange = () => { if (!state.resume && $('video-file').files[0]) $('upload-title').value = $('video-file').files[0].name.replace(/\.[^.]+$/, '').slice(0, 160); };
$('search-form').onsubmit = event => { event.preventDefault(); load().catch(error); };
$('topic-filter').onchange = $('status-filter').onchange = () => load().catch(error);
$('more').onclick = () => load(true).catch(error);
$('backend').onchange = async () => { try { await send('/settings', 'PUT', { backend: $('backend').value }); await settings(); text('message', '已切换默认总结方式。'); } catch (e) { error(e); } };
$('worker-token').onclick = async () => {
  if (state.settings.worker.configured && !window.confirm('更换后旧工作器凭据立即失效，正在处理的任务需重试。继续？')) return;
  try { const result = await send('/worker-token', 'POST'); $('new-token').value = result.token; show('token-result', true); await settings(); } catch (e) { error(e); }
};
$('tabs').onclick = event => { const button = event.target.closest('[data-tab]'); if (button) tab(button.dataset.tab); };
$('storage-retry').onclick = async () => { try { await send('/documents/' + state.current.id + '/storage-retry', 'POST'); await open(state.current.id, true); await load(); } catch (e) { error(e); } };
$('retry').onclick = async () => { try { await send('/documents/' + state.current.id + '/retry', 'POST', { backend: state.settings.backend }); await open(state.current.id); await load(); } catch (e) { error(e); } };
$('resume-upload').onclick = () => { state.resume = state.current; $('upload-title').value = state.current.title; text('upload-heading', '继续上传：' + state.current.title); show('upload-panel', true); $('video-file').click(); };
$('delete').onclick = async () => {
  if (!window.confirm('删除这篇笔记及其原视频、转写和截图？')) return;
  try { await api('/documents/' + state.current.id, { method: 'DELETE' }); state.current = null; state.editing = false; $('player').removeAttribute('src'); $('player').load(); show('detail', false); show('empty', true); await load(); } catch (e) { error(e); }
};
$('edit').onclick = () => {
  const d = state.current; state.editing = true; $('edit-title').value = d.title; $('edit-topic').value = d.topic; $('edit-tags').value = d.tags.join(', '); $('edit-source').value = d.sourceUrl; $('edit-notes').value = d.notes;
  tab('notes'); show('notes-view', false); show('tabs', false); show('edit-form', true);
};
$('cancel-edit').onclick = () => renderDocument(state.current);
$('edit-form').onsubmit = async event => {
  event.preventDefault();
  try { const result = await send('/documents/' + state.current.id, 'PUT', { title: $('edit-title').value, topic: $('edit-topic').value, tags: tags($('edit-tags').value), sourceUrl: $('edit-source').value, notes: $('edit-notes').value, revision: state.current.revision }); renderDocument(result.document); text('message', '笔记已保存。'); await load(); } catch (e) { error(e); }
};
window.addEventListener('beforeunload', event => { if (state.editing || state.uploading) { event.preventDefault(); event.returnValue = ''; } });
boot().catch(error);
