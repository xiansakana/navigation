<script setup>
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { uploadParts } from '../../public/knowledge/upload.js';
import { createDevicePanel } from '../../public/knowledge/devices.js';
import { createSourcePlayer } from '../../public/knowledge/source.js';
import { bindVideoDrop } from '../../public/knowledge/drop.js';
import { sendLocalInput } from '../../public/knowledge/local-input.js';
import { bindLinkImport } from '../../public/knowledge/link-import.js';
import { createFileQueue } from '../../public/knowledge/file-queue.js';
import { createBilibiliPanel } from '../../public/knowledge/bilibili-account.js';
import { createNotePager } from '../../public/knowledge/pagination.js';
import { failureMessage } from '../../public/knowledge/failure.js';
import { createReanalysisPanel } from '../../public/knowledge/reanalysis.js';

const $ = id => document.getElementById(id);
const time = value => {
  const s = Math.floor(value || 0);
  return (s >= 3600 ? String(Math.floor(s / 3600)).padStart(2, '0') + ':' : '')
    + String(Math.floor(s / 60) % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
};
const tags = value => value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
const phaseLabel = d => d.status === 'processing'
  ? ({ media: '正在转写/提取素材', summary_wait: '等待总结', summary: '正在总结' })[d.processingPhase] || '' : '';

const errorText = ref('');
const errorLink = ref(null);
const messageText = ref('');
const settingsOpen = ref(false);
const uploadOpen = ref(false);
const uploading = ref(false);
const search = ref('');
const topicFilter = ref('');
const statusFilter = ref('');
const statusOptions = shallowRef([
  { value: '', label: '全部状态' },
  { value: 'ready', label: '已生成' },
  { value: 'queued', label: '等待处理' },
  { value: 'processing', label: '处理中' },
  { value: 'failed', label: '失败' },
  { value: 'uploading', label: '上传中' },
  { value: 'importing', label: '链接下载中' }
]);
const topicOptions = shallowRef([]);
const topicNames = shallowRef([]);
const total = ref(0);
const listLoading = ref(false);
const notesPage = ref('');
const notesVisible = ref(false);
const notesPrevDisabled = ref(true);
const notesNextDisabled = ref(true);
const retryFailedVisible = ref(false);
const retrying = ref(false);
const batchVisible = ref(false);
const batchCount = ref('已选 0 篇（最多100篇）');
const batchVisibility = ref('private');
const batchBusy = ref(false);
const batchSaveDisabled = ref(true);
const batchAllDisabled = ref(false);
const documentOpen = ref(false);
const documentTitle = ref('');
const documentMeta = ref('');
const documentTags = shallowRef([]);
const publicationVisible = ref(false);
const documentVisibility = ref('private');
const storagePolicy = ref('');
const storageStatus = ref('');
const storageRetryVisible = ref(false);
const jobStatus = ref('');
const jobStatusClass = ref('');
const retryVisible = ref(false);
const resumeVisible = ref(false);
const editVisible = ref(false);
const deleteVisible = ref(false);
const exportVisible = ref(false);
const exportHref = ref('');
const provenance = ref('');
const noteHtml = ref('');
const outlineLinks = shallowRef([]);
const historyVisible = ref(false);
const transcriptScriptVisible = ref(false);
const transcriptScript = ref('simplified');
const transcriptRows = shallowRef([]);
const framesList = shallowRef([]);
const editing = ref(false);
const editTitle = ref('');
const editTopic = ref('');
const editTags = ref('');
const editSource = ref('');
const editNotes = ref('');
const activeTab = ref('notes');
const notesHost = ref(null);
const localQueueItems = shallowRef([]);
const uploadProgress = ref(0);
const uploadProgressVisible = ref(false);
const asrSettingsVisible = ref(false);
const concurrencySettingsVisible = ref(false);
const modelSaveVisible = ref(false);

const permissionTick = ref(0);
const state = {
  permissions: [],
  documents: [],
  statusCounts: {},
  selected: new Map(),
  filter: '',
  current: null,
  settings: null,
  modelDirty: false,
  asrDirty: false,
  concurrencyDirty: false,
  resume: null,
  offset: 0,
  total: 0,
};

const can = action => {
  permissionTick.value;
  return state.permissions.includes('*') || state.permissions.includes('knowledge:' + action);
};

let sourcePlayer;
let notePager;
let linkImport;
let uploadQueue;
let reanalysisPanel;
let localQueue;
let notesView;
let notesViewLoad;
let pollTimer;
let parseBatchLinks;

function setError(error) {
  errorText.value = error?.message || String(error || '');
  errorLink.value = null;
  if (error?.duplicate?.documentId && can('notes:view')) {
    errorLink.value = { href: '/knowledge/?document=' + encodeURIComponent(error.duplicate.documentId), text: '打开已有笔记' };
  }
}

function clearError() {
  errorText.value = '';
  errorLink.value = null;
}

async function api(route, options = {}) {
  const response = await fetch('/api/knowledge' + route, {
    ...options,
    headers: {
      ...(options.body instanceof Blob ? {} : { 'Content-Type': 'application/json' }),
      ...(state.owner ? { 'X-Knowledge-Owner': state.owner } : {}),
      ...options.headers
    }
  });
  if (response.redirected) throw new Error('登录已过期，请刷新页面重新登录');
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw Object.assign(new Error(payload.error || '请求失败'), {
      status: response.status, code: payload.code, duplicate: payload.duplicate
    });
  }
  return payload;
}
const send = (route, method, data = {}) => api(route, { method, body: JSON.stringify(data) });

function prepareNotesView() {
  if (!notesViewLoad) {
    const url = '/generated/knowledge-notes-view.js?v=1';
    notesViewLoad = import(url).then(({ mountNotes }) => {
      notesView = mountNotes(notesHost.value, {
        open: id => open(id).catch(setError),
        select(id, checked) {
          const document = state.documents.find(item => item.id === id);
          if (!document || batchBusy.value) return false;
          if (checked && state.selected.size >= 100) {
            setError(new Error('每批最多选择100篇笔记'));
            return false;
          }
          if (checked) state.selected.set(id, document.revision);
          else state.selected.delete(id);
          renderBatch();
          return true;
        }
      });
    });
  }
  return notesViewLoad;
}

function renderLocalQueue() {
  localQueueItems.value = localQueue.entries.map(entry => ({
    id: entry.id,
    name: entry.name,
    state: entry.state,
    message: entry.message
  }));
}

async function loadSettings() {
  state.settings = await api('/settings');
  linkImport.defaults(state.settings.linkDefaults);
  storagePolicy.value = state.settings.storage?.provider === '115'
    ? '原视频保存至115，上传和处理期间使用临时缓存。' : '原视频保存在服务器。';
  $('backend').value = state.settings.backend;
  $('backend').disabled = !can('settings:edit');
  const prefix = state.settings.backend === 'codex' ? 'codex' : (state.settings.backend === 'gemini' ? 'gemini' : 'api');
  const usingGemini = state.settings.backend === 'gemini';
  $('summary-effort-label').hidden = usingGemini;
  $('summary-model').placeholder = usingGemini ? (state.settings.gemini?.model || '服务器默认 Gemini 模型') : '留空使用工作器默认模型';
  if (!state.modelDirty) {
    $('summary-model').value = state.settings[prefix + 'Model'] || '';
    $('summary-effort').value = state.settings[prefix + 'Effort'] || '';
  }
  $('summary-model').disabled = $('summary-effort').disabled = !can('model:edit') || !can('settings:edit');
  modelSaveVisible.value = can('model:edit') && can('settings:edit');
  asrSettingsVisible.value = !usingGemini && can('asr:edit') && can('settings:edit');
  if (!state.asrDirty) {
    for (const [id, key] of [['asr-model', 'asrModel'], ['asr-language', 'asrLanguage'], ['asr-profile', 'asrProfile'], ['asr-hotwords', 'asrHotwords']]) $(id).value = state.settings[key] || '';
  }
  concurrencySettingsVisible.value = can('concurrency:edit') && can('settings:edit');
  if (!state.concurrencyDirty) {
    $('media-concurrency').value = String(state.settings.mediaConcurrency);
    $('summary-concurrency').value = String(state.settings.summaryConcurrency);
  }
  const worker = state.settings.worker, c = worker.capabilities;
  $('worker-status').textContent = worker.online
    ? `${worker.label || 'GPU工作器'} · 在线 · 仅GPU处理，已禁用CPU接单 · ${c.pipeline?.version === 1 ? '分阶段并发已启用' : '当前设备为旧版，空闲更新后启用并发'}`
    : worker.configured ? '等待本机GPU工作器就绪，使用 GPU 工作器的任务在队列中等待。' : '尚未连接GPU工作器，请安装并配对本机工作器。使用 GPU 工作器的任务会保留在队列中。';
  const info = c[state.settings.backend];
  $('backend-description').textContent = usingGemini
    ? (state.settings.gemini?.configured ? '由服务器提交原视频，工作器离线也可处理。' : '服务器尚未配置此账号的 Gemini API Key，任务会等待配置。')
    : info
    ? `${worker.online && info.ready ? '工作器已就绪' : '工作器未就绪'} · ${state.settings[prefix + 'Model'] || info.model || info.detail || ''} · 强度：${state.settings[prefix + 'Effort'] || '工作器默认'}`
    : '选择总结方式后，由已连接工作器执行。';
  $('upload-toggle').disabled = $('settings-toggle').disabled = $('worker-token').disabled = false;
}

function renderBatch() {
  batchVisible.value = can('publish:batch:edit') && can('publish:edit') && can('notes:view');
  batchCount.value = '已选 ' + state.selected.size + ' 篇（最多100篇）';
  batchSaveDisabled.value = batchBusy.value || !state.selected.size;
  batchAllDisabled.value = batchBusy.value;
}

function renderList() {
  reanalysisPanel?.refresh();
  retryFailedVisible.value = can('process:batch:edit') && can('process:edit') && can('notes:view');
  $('retry-failed').disabled = retrying.value;
  total.value = state.total;
  const canSelect = (can('publish:batch:edit') && can('publish:edit')) || (can('reanalysis:batch:edit') && can('reanalysis:edit'));
  const storageStage = { waiting: '等待上传', pending: '等待保存至115', uploading: '正在保存至115', verifying: '校验原视频', verified: '清理临时原片', failed: '115保存待重试' };
  notesView?.update(state.documents.map(document => {
    let stage = document.stage;
    if (document.status === 'queued' && document.storage?.provider === '115' && document.storage.state !== 'ready') {
      stage = storageStage[document.storage.state] || stage;
    }
    const progress = document.status === 'processing' ? ' ' + document.progress + '%' : '';
    return {
      id: document.id,
      title: document.title,
      subtitle: (document.topic || '未分类') + ' · ' + stage + progress,
      preview: document.preview || document.originalName,
      phase: phaseLabel(document),
      active: state.current?.id === document.id,
      selection: canSelect && document.status === 'ready' ? {
        checked: state.selected.has(document.id),
        disabled: batchBusy.value,
        visibility: document.visibility === 'public' ? '公开' : '私有'
      } : null
    };
  }));
  renderBatch();
  notesVisible.value = can('notes:view');
  notesPage.value = `第 ${Math.floor(state.offset / 30) + 1} / ${Math.max(1, Math.ceil(state.total / 30))} 页 · 共 ${state.total} 篇`;
  notesPrevDisabled.value = state.offset === 0 || listLoading.value;
  notesNextDisabled.value = state.offset + 30 >= state.total || listLoading.value;
}

async function load(offset, quiet = false) {
  listLoading.value = true;
  const [result] = await Promise.all([
    quiet ? notePager.refresh() : notePager.load({ search: search.value, topic: topicFilter.value, status: statusFilter.value }, offset),
    prepareNotesView()
  ]).finally(() => { listLoading.value = false; });
  if (!result) return;
  state.offset = result.offset;
  state.documents = result.documents;
  state.total = result.total;
  state.statusCounts = result.statusCounts || {};
  const statusLabels = { '': '全部状态', ready: '已生成', queued: '等待处理', processing: '处理中', failed: '失败', uploading: '上传中', importing: '链接下载中' };
  statusOptions.value = Object.keys(statusLabels).map(value => ({
    value,
    label: statusLabels[value] + '（' + (value ? state.statusCounts[value] || 0 : Object.values(state.statusCounts).reduce((sum, n) => sum + n, 0)) + '）'
  }));
  if (result.filterChanged) state.selected.clear();
  state.filter = result.filterKey;
  for (const [id, revision] of state.selected) {
    const item = state.documents.find(d => d.id === id);
    if (item && (item.status !== 'ready' || item.revision !== revision)) state.selected.delete(id);
  }
  topicOptions.value = result.topics.map(t => ({ value: t.topic, label: `${t.topic} (${t.count})` }));
  topicNames.value = result.topics.map(t => t.topic);
  renderList();
}

function tab(name) {
  sourcePlayer?.activate(name === 'source' && !editing.value);
  activeTab.value = name;
}

function renderStorage(d) {
  const source = d.storage || { provider: 'local', state: 'local' };
  const labels = { waiting: '等待视频上传', pending: '等待保存至115', uploading: '正在保存至115', verifying: '正在校验115原视频', verified: '115校验通过，正在清理临时原片', ready: '原视频已保存至115 · ECS原片已清理', failed: source.error ? failureMessage(source.error, '保存至115') : '115保存失败，临时原片已保留' };
  storageStatus.value = source.provider === '115' ? labels[source.state] || '正在保存至115' : '原视频保存在服务器';
  if (source.timings) {
    const durations = [];
    if (source.timings.uploadMs > 0) durations.push(`保存至115${source.state === 'uploading' ? '已用' : '用时'} ${time(source.timings.uploadMs / 1000)}`);
    if (source.timings.verificationMs > 0) durations.push(`完整性校验${source.state === 'verifying' ? '已用' : '用时'} ${time(source.timings.verificationMs / 1000)}`);
    if (durations.length) storageStatus.value += ' · ' + durations.join(' · ');
  }
  storageRetryVisible.value = source.state === 'failed' && can('storage:edit');
}

function renderTranscript(d) {
  $('asr-provenance').textContent = `语音模型：${d.provenance.asrModel || '历史记录未保存'} · 语言：${d.language || '未记录'}`;
  transcriptScriptVisible.value = can('transcript:script:view') && can('transcript:view');
  transcriptRows.value = d.transcript.map(segment => ({
    start: segment.start,
    text: transcriptScript.value === 'raw' && can('transcript:script:view') ? segment.rawText || segment.text : segment.text
  }));
}

function jumpTo(start) {
  tab('source');
  sourcePlayer.seek(start);
}

function renderDocument(d) {
  state.current = d;
  state.editing = false;
  editing.value = false;
  documentOpen.value = true;
  reanalysisPanel?.refresh(d);
  renderStorage(d);
  documentTitle.value = d.title;
  publicationVisible.value = can('publish:edit') && d.status === 'ready';
  documentVisibility.value = d.visibility || 'private';
  documentMeta.value = `${d.topic || '未分类'} · ${time(d.duration)} · ${d.originalName} · ${d.backend === 'gemini' ? 'Gemini API' : d.backend === 'codex' ? 'Codex CLI' : '兼容 API'} · ${new Date(d.updatedAt).toLocaleString('sv-SE')}`;
  documentTags.value = d.tags || [];
  jobStatus.value = d.error ? failureMessage(d.error, d.stage) : [phaseLabel(d), d.stage].filter(Boolean).join(' · ') + (d.status === 'processing' ? ' · ' + d.progress + '%' : '');
  jobStatusClass.value = d.status;
  retryVisible.value = d.status === 'failed' && can('process:edit');
  resumeVisible.value = d.status === 'uploading' && can('upload:edit');
  editVisible.value = can('notes:edit') && ['ready', 'failed'].includes(d.status);
  deleteVisible.value = can('delete:edit');
  exportVisible.value = can('export:view') && !!d.notes;
  exportHref.value = '/api/knowledge/documents/' + d.id + '/export';
  const p = d.provenance;
  const media = d.sourceMedia || {};
  const profile = d.modelSettings || {}, prefix = d.backend === 'codex' ? 'codex' : (d.backend === 'gemini' ? 'gemini' : 'api');
  provenance.value = p.generatedAt
    ? `生成于 ${new Date(p.generatedAt).toLocaleString('sv-SE')} · ${p.model || p.backend} · 推理强度：${p.reasoningEffort || '模型默认'} · ${p.backend === 'gemini' ? '直接分析视频音画' : p.vision ? '含抽样画面核对' : '未进行模型视觉核对'}。${(p.warnings || []).join(' ')}`
    : `本次任务模型：${profile[prefix + 'Model'] || '工作器默认'} · 强度：${profile[prefix + 'Effort'] || '工作器默认'}。任务完成后在这里阅读完整笔记。`;
  if (media.width) provenance.value += ` 原片：${media.width}×${media.height}${media.downgraded ? '（已按设置自动降级）' : ''}。`;
  const holder = document.createElement('div');
  holder.innerHTML = DOMPurify.sanitize(marked.parse(d.notes || ''), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'form', 'input', 'button', 'style'],
    FORBID_ATTR: ['style', 'id', 'name']
  });
  const outline = [];
  [...holder.querySelectorAll('h2,h3')].forEach((h, i) => {
    h.id = 'kb-heading-' + i;
    if (h.tagName !== 'H2') return;
    outline.push({ id: h.id, text: h.textContent });
  });
  holder.querySelectorAll('a').forEach(a => { a.rel = 'noopener noreferrer'; a.target = '_blank'; });
  noteHtml.value = holder.innerHTML;
  outlineLinks.value = outline;
  sourcePlayer?.reset(d);
  renderTranscript(d);
  framesList.value = d.frames.map(f => ({
    name: f.name,
    time: f.time,
    src: '/api/knowledge/documents/' + d.id + '/frames/' + f.name,
    label: '视频画面 ' + time(f.time),
    caption: '视频时间 ' + time(f.time)
  }));
  tab('notes');
  renderList();
}

async function open(id, quiet = false) {
  if (!quiet && editing.value && !window.confirm('当前编辑还未保存，放弃修改并打开其他笔记？')) return;
  const d = (await api('/documents/' + id)).document;
  if (quiet && state.current?.id !== id) return;
  if (quiet && d.revision === state.current?.revision && d.status === state.current?.status) {
    state.current = d;
    renderStorage(d);
    jobStatus.value = d.error ? failureMessage(d.error, d.stage) : d.stage + (d.status === 'processing' ? ' · ' + d.progress + '%' : '');
    return;
  }
  renderDocument(d);
}

async function upload(event) {
  event.preventDefault();
  clearError();
  if (uploading.value) return;
  if (['link', 'batch'].includes($('upload-mode').value)) {
    uploading.value = true;
    $('upload-submit').disabled = true;
    $('upload-mode').disabled = true;
    $('upload-status').textContent = '正在提交链接导入任务…';
    try {
      const batch = $('upload-mode').value === 'batch', queued = can('queue:edit');
      const rawLinks = batch ? parseBatchLinks($('batch-links').value) : [$('video-link').value];
      const result = await send(queued ? '/upload-queue' : '/imports', 'POST', {
        ...(queued ? { urls: rawLinks } : { url: rawLinks[0] }),
        ...(!batch ? { title: $('upload-title').value, sourceUrl: $('upload-source').value } : {}),
        topic: $('upload-topic').value,
        tags: tags($('upload-tags').value),
        backend: state.settings.backend,
        ...linkImport.selection()
      });
      if (queued) {
        const duplicates = result.results.filter(r => r.status === 'duplicate').length;
        const invalid = result.results.filter(r => r.status === 'invalid');
        $('queue-submit-result').textContent = `已加入 ${result.accepted} 条；重复跳过 ${duplicates} 条；无效 ${invalid.length} 条。` + invalid.map(r => `第${r.index + 1}条：${r.error}`).join(' ');
        if (can('notes:view')) {
          for (const row of result.results.filter(r => r.status === 'duplicate' && r.documentId)) {
            const link = document.createElement('a');
            link.href = '/knowledge/?document=' + encodeURIComponent(row.documentId);
            link.textContent = '打开已有笔记：' + (row.title || row.url);
            $('queue-submit-result').append(document.createElement('br'), link);
          }
        }
        if (invalid.length) $('batch-links').value = invalid.map(r => rawLinks[r.index]).join('\n');
        await uploadQueue.reset();
      }
      state.resume = null;
      if (!result.results?.some(r => r.status === 'invalid')) {
        uploadOpen.value = false;
        $('upload-form').reset();
        linkImport.mode();
      }
      messageText.value = queued && !result.accepted ? '没有创建新的导入任务，请查看重复或无效链接的校验结果。' : '视频已加入链接下载队列。可关闭页面，下载、生成笔记和115归档会在后台继续。';
      $('upload-status').textContent = queued && !result.accepted ? '未新增任务' : '链接已提交';
      await load();
      if (result.document) await open(result.document.id);
    } catch (e) {
      setError(e);
      $('upload-status').textContent = '链接未提交，请检查后重试。';
    } finally {
      uploading.value = false;
      $('upload-submit').disabled = false;
      $('upload-mode').disabled = false;
    }
    return;
  }
  const files = Array.from($('video-file').files);
  if (!files.length) return;
  const metadata = {
    title: $('upload-title').value, topic: $('upload-topic').value,
    tags: tags($('upload-tags').value), sourceUrl: $('upload-source').value,
    backend: state.settings.backend
  };
  if (can('queue:edit') && can('queue:view')) {
    try {
      if (state.resume && files.length !== 1) throw new Error('续传时请只选择对应原视频');
      const added = localQueue.add(files, metadata, state.resume);
      state.resume = null;
      messageText.value = added
        ? `已加入 ${added} 个本地视频。请保持页面打开，处理位置空闲后自动上传。`
        : '所选视频已在本地上传队列中。';
    } catch (e) { setError(e); }
  } else await uploadFile(files[0], metadata).catch(setError);
}

async function uploadFile(file, metadata, entry = null, report = () => {}) {
  if (file.size > state.settings.maxBytes) throw new Error('视频超过1GB限制');
  uploading.value = true;
  $('upload-submit').disabled = true;
  $('upload-mode').disabled = true;
  $('video-file').disabled = true;
  uploadProgressVisible.value = true;
  uploadProgress.value = 0;
  $('upload-status').textContent = '正在检查文件和续传进度…';
  try {
    const stamp = new Blob([file.slice(0, 1048576), file.slice(Math.max(0, file.size - 1048576)), String(file.size)]);
    const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await stamp.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
    let item = entry ? entry.resume : state.resume;
    if (item && can('notes:view')) {
      const latest = (await api('/documents/' + item.id)).document;
      if (latest.status !== 'uploading') { if (entry) entry.resume = null; return latest; }
    }
    if (item && (item.bytes !== file.size || item.originalName !== file.name)) throw new Error('请选择同名、同大小的原始视频文件');
    if (item?.fingerprint && item.fingerprint !== fingerprint) throw new Error('文件内容与原上传文件不同，请选择原始视频');
    if (!item) {
      const extension = file.name.split('.').pop().toLowerCase();
      const mimeType = ({ mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' })[extension];
      const result = await send('/documents', 'POST', {
        title: metadata.title, topic: metadata.topic, tags: metadata.tags, sourceUrl: metadata.sourceUrl,
        bytes: file.size, mimeType, fingerprint, originalName: file.name, backend: metadata.backend
      });
      item = result.document;
      state.resume = item;
      if (entry) entry.resume = item;
    }
    const { parts, chunkBytes } = await api('/documents/' + item.id + '/parts');
    const localTransfer = item.backend !== 'gemini' && can('local-input:edit')
      ? sendLocalInput({ file, documentId: item.id, send, status: value => { $('local-input-status').textContent = value; } })
      : Promise.resolve(false);
    const transfer = await uploadParts({ file, parts, chunkBytes, url: `/api/knowledge/documents/${item.id}/parts/`, onProgress(p) {
      const progress = Math.min(99, Math.floor(p.loaded / p.total * 100));
      uploadProgress.value = progress;
      report('上传中 · ' + progress + '%');
      $('upload-status').textContent = `上传到服务器 ${progress}% · ${(p.speed / 1024 ** 2).toFixed(2)} MB/s · ${p.remaining === null ? '正在测算剩余时间' : p.loaded === p.total ? '等待服务器确认' : '预计剩余 ' + time(Math.ceil(p.remaining))} · 已用 ${time(p.elapsed)}`;
    } });
    $('upload-status').textContent = '分片已传完，正在合并视频…';
    const localReady = await localTransfer;
    const mergeStarted = performance.now();
    await send('/documents/' + item.id + '/complete', 'POST');
    state.resume = null;
    const elapsed = `本次上传用时 ${time(transfer.elapsedMs / 1000)}，合并用时 ${time((performance.now() - mergeStarted) / 1000)}。`;
    messageText.value = elapsed + (localReady
      ? '已启用本机原视频处理，无需等待115归档或下载；归档在后台独立继续。'
      : item.backend === 'gemini' ? '视频已上传，等待服务器提交给 Gemini。' : state.settings.storage?.provider === '115' ? '接下来保存至115并校验，之后自动生成笔记。' : '视频已保存，工作器将按队列生成笔记。');
    uploadProgress.value = 100;
    $('upload-status').textContent = '上传完成';
    uploadOpen.value = false;
    $('upload-form').reset();
    await load();
    await open(item.id);
    if (entry) entry.resume = null;
    return item;
  } catch (e) {
    setError(e);
    $('upload-status').textContent = '上传未完成，可重新提交继续上传。';
    await load().catch(() => {});
    throw e;
  } finally {
    if (entry) state.resume = null;
    uploading.value = false;
    $('upload-submit').disabled = false;
    $('upload-mode').disabled = false;
    $('video-file').disabled = false;
    linkImport.mode();
  }
}

async function boot() {
  let me;
  try { me = await window.portalPage.user(); }
  catch (e) { if (e.status === 401) return location.assign('/login/'); throw e; }
  state.permissions = me.permissions || [];
  permissionTick.value++;
  state.owner = me.userId;
  if (me.isGuest || !can('view')) throw new Error('请登录具备知识库权限的账号');
  $('upload-toggle').hidden = !(can('upload:edit') && can('process:edit'));
  $('worker-token').hidden = !can('worker:edit');
  $('upload-batch-option').hidden = !can('queue:edit') || !can('import:edit');
  $('video-file').multiple = can('queue:edit') && can('queue:view');
  $('upload-mode-label').hidden = !(can('import:edit') && can('upload:edit') && can('process:edit'));
  linkImport.mode();
  createDevicePanel({ can, api, send, onError: setError });
  const bilibili = createBilibiliPanel({ element: $, can, api, send, onError: setError, onDefaults: s => linkImport.defaults(s) });
  if (new URL(location.href).searchParams.get('pair')) settingsOpen.value = true;
  $('upload-toggle').disabled = $('settings-toggle').disabled = $('worker-token').disabled = true;
  const configuration = (async () => {
    try { await bilibili.refresh(); }
    finally { await loadSettings(); }
  })();
  const preparation = Promise.allSettled([configuration, uploadQueue.refresh()]);
  if (can('notes:view')) {
    await load();
    const documentId = new URL(location.href).searchParams.get('document');
    if (documentId && /^[a-f0-9]{32}$/.test(documentId)) {
      await open(documentId);
      if (/^#kb-heading-\d+$/.test(location.hash)) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' });
    }
  }
  for (const result of await preparation) { if (result.status === 'rejected') setError(result.reason); }
  let polling = false;
  pollTimer = setInterval(async () => {
    if (document.hidden || uploading.value || polling) return;
    polling = true;
    try {
      await loadSettings();
      const queueState = await uploadQueue.refresh();
      if (can('notes:view') && (queueState?.active > 0 || ['queued', 'processing', 'uploading', 'importing'].some(status => state.statusCounts[status] > 0) || state.current?.storage?.provider === '115' && state.current.storage.state !== 'ready' || state.documents.some(d => d.storage?.provider === '115' && d.storage.state !== 'ready'))) await load(undefined, true);
      if (!editing.value && state.current && (['queued', 'processing', 'importing'].includes(state.current.status) || state.current.storage?.provider === '115' && state.current.storage.state !== 'ready')) await open(state.current.id, true);
    } catch { /* Keep existing content during temporary connection loss. */ }
    finally { polling = false; }
  }, 5000);
}

function toggleSettings() { settingsOpen.value = !settingsOpen.value; }
function openUpload() {
  state.resume = null;
  $('upload-heading').textContent = '从一个视频开始';
  uploadOpen.value = true;
}
function closeUpload() { uploadOpen.value = false; }
function onUploadReset() {
  $('selected-video').textContent = '支持拖拽或多选视频，每批最多100个';
  queueMicrotask(() => linkImport.reset());
}
function onSearchSubmit() { load(0).catch(setError); }
function onFilterChange() { load(0).catch(setError); }
function onNotesPrev() { if (can('notes:view')) load(state.offset - 30).catch(setError); }
function onNotesNext() { if (can('notes:view')) load(state.offset + 30).catch(setError); }
function batchAll() {
  for (const d of state.documents) if (d.status === 'ready' && state.selected.size < 100) state.selected.set(d.id, d.revision);
  renderList();
}
function batchClear() { state.selected.clear(); renderList(); }
async function batchSave() {
  if (batchBusy.value || !state.selected.size) return;
  const visibility = batchVisibility.value;
  const documents = [...state.selected].map(([id, revision]) => ({ id, revision }));
  if (!window.confirm(`将选中的 ${documents.length} 篇笔记设为${visibility === 'public' ? '公开' : '私有'}？` + (visibility === 'public' ? '访客将能读取标题、分类、标签和完整正文，请确认不含私人信息。' : '公开知识库将不再展示这些笔记。'))) return;
  batchBusy.value = true;
  renderList();
  try {
    const result = await send('/documents/visibility', 'PUT', { visibility, documents });
    state.selected.clear();
    await load();
    if (state.current && documents.some(d => d.id === state.current.id) && !editing.value) await open(state.current.id);
    messageText.value = `已将 ${result.count} 篇笔记设为${visibility === 'public' ? '公开' : '私有'}。`;
  } catch (e) { setError(e); }
  finally { batchBusy.value = false; renderList(); }
}
async function onBackendChange() {
  try {
    await send('/settings', 'PUT', { backend: $('backend').value });
    state.modelDirty = false;
    await loadSettings();
    messageText.value = '已切换默认总结方式。';
  } catch (e) { setError(e); }
}
function onModelInput() { state.modelDirty = true; }
function onConcurrencyChange() { state.concurrencyDirty = true; }
async function saveConcurrency() {
  $('concurrency-save').disabled = true;
  try {
    await send('/settings', 'PUT', { mediaConcurrency: Number($('media-concurrency').value), summaryConcurrency: Number($('summary-concurrency').value) });
    state.concurrencyDirty = false;
    await loadSettings();
    messageText.value = '并发设置已保存，每个工作器独立生效；降低并发不会中断已运行的任务。';
  } catch (e) { setError(e); }
  finally { $('concurrency-save').disabled = false; }
}
function onAsrInput() { state.asrDirty = true; }
async function saveAsr() {
  if (!can('asr:edit') || !can('settings:edit')) return;
  $('asr-save').disabled = true;
  try {
    await send('/settings', 'PUT', { asrModel: $('asr-model').value, asrLanguage: $('asr-language').value, asrProfile: $('asr-profile').value, asrHotwords: $('asr-hotwords').value.trim() });
    state.asrDirty = false;
    await loadSettings();
    messageText.value = '语音设置已保存，用于新任务、失败重试和重新提取原视频；复用已有素材不会重新转写。首次使用新模型需要下载，请耐心等待。';
  } catch (e) { setError(e); }
  finally { $('asr-save').disabled = false; }
}
async function saveModel() {
  const prefix = state.settings.backend === 'codex' ? 'codex' : (state.settings.backend === 'gemini' ? 'gemini' : 'api');
  try {
    await send('/settings', 'PUT', { [prefix + 'Model']: $('summary-model').value.trim(), ...(prefix !== 'gemini' ? { [prefix + 'Effort']: $('summary-effort').value } : {}) });
    state.modelDirty = false;
    await loadSettings();
    messageText.value = '模型设置已保存，用于新上传和失败重试；已排队和正在处理的任务保留原配置。';
  } catch (e) { setError(e); }
}
async function renewWorkerToken() {
  if (state.settings.worker.configured && !window.confirm('这会撤销旧版共享凭据，使用该凭据的工作器需重新配置；独立绑定的设备不受影响。继续？')) return;
  try {
    const result = await send('/worker-token', 'POST');
    $('new-token').value = result.token;
    $('token-result').hidden = false;
    await loadSettings();
  } catch (e) { setError(e); }
}
function onTabClick(event) {
  const button = event.target.closest('[data-tab]');
  if (button) tab(button.dataset.tab);
}
async function retryStorage() {
  try {
    await send('/documents/' + state.current.id + '/storage-retry', 'POST');
    await open(state.current.id, true);
    await load();
  } catch (e) { setError(e); }
}
async function retryFailed(all) {
  if (retrying.value || !can('process:edit') || all && !can('process:batch:edit')) return;
  const id = state.current?.id;
  retrying.value = true;
  $('retry').disabled = $('retry-failed').disabled = true;
  clearError();
  try {
    const result = await send(all ? '/documents/retry-failed' : '/documents/' + id + '/retry', 'POST', {});
    messageText.value = all
      ? `已重新排队 ${result.accepted} 个失败任务；未重试 ${result.skipped} 个。` + [...new Set(result.results.filter(r => r.error).map(r => r.error))].join('；')
      : '已重新排队，使用当前处理方式和模型设置。';
    if (state.current && (all || state.current.id === id)) await open(state.current.id);
    await load();
  } catch (e) { setError(e); }
  finally { retrying.value = false; $('retry').disabled = false; renderList(); }
}
function resumeUpload() {
  $('upload-mode').value = 'file';
  linkImport.mode();
  state.resume = state.current;
  $('upload-title').value = state.current.title;
  $('upload-heading').textContent = '继续上传：' + state.current.title;
  uploadOpen.value = true;
  $('video-file').click();
}
async function deleteDocument() {
  if (!window.confirm('删除这篇笔记及其原视频、转写和截图？')) return;
  try {
    await api('/documents/' + state.current.id, { method: 'DELETE' });
    state.selected.delete(state.current.id);
    state.current = null;
    editing.value = false;
    sourcePlayer.reset(null);
    documentOpen.value = false;
    await load();
  } catch (e) { setError(e); }
}
function startEdit() {
  const d = state.current;
  editing.value = true;
  editTitle.value = d.title;
  editTopic.value = d.topic;
  editTags.value = d.tags.join(', ');
  editSource.value = d.sourceUrl;
  editNotes.value = d.notes;
  tab('notes');
}
function cancelEdit() { renderDocument(state.current); }
async function saveVisibility() {
  const value = documentVisibility.value;
  if (value === 'public' && state.current.visibility !== 'public'
    && !window.confirm('公开后，任何有浏览权限的访客都能读取这篇笔记的标题、分类、标签和完整正文。请确认正文不含私人信息。继续公开？')) return;
  $('visibility-save').disabled = true;
  try {
    await send('/documents/' + state.current.id + '/visibility', 'PUT', { visibility: value, revision: state.current.revision });
    await open(state.current.id);
    messageText.value = value === 'public' ? '笔记正文已公开，可在公开知识库中浏览。' : '已撤回公开，笔记恢复为私有。';
    await load();
  } catch (e) { setError(e); }
  finally { $('visibility-save').disabled = false; }
}
async function submitEdit() {
  try {
    const result = await send('/documents/' + state.current.id, 'PUT', {
      title: editTitle.value, topic: editTopic.value, tags: tags(editTags.value),
      sourceUrl: editSource.value, notes: editNotes.value, revision: state.current.revision
    });
    renderDocument(result.document);
    messageText.value = '笔记已保存。';
    await load();
  } catch (e) { setError(e); }
}
function onTranscriptScript() { if (state.current) renderTranscript(state.current); }
function retryLocal(id) { localQueue.retry(id); }
function cancelLocal(id) { localQueue.cancel(id); }
function beforeUnload(event) {
  if (editing.value || uploading.value || localQueue?.pending()) { event.preventDefault(); event.returnValue = ''; }
}

onMounted(async () => {
  try {
  sourcePlayer = createSourcePlayer({
    player: $('player'), frame: $('original-frame'), select: $('playback-source'),
    link: $('original-link'), hint: $('playback-hint'), allowed: () => can('source:view')
  });
  notePager = createNotePager(params => api('/documents?' + new URLSearchParams(params)));
  linkImport = bindLinkImport({
    element: $, can: () => can('import:edit'),
    canBatch: () => can('queue:edit') && can('import:edit'),
    send, busy: () => uploading.value, onError: setError, clearError
  });
  const queueUrl = '/knowledge/queue.js?v=vue-queue-1';
  const queueModule = await import(queueUrl);
  parseBatchLinks = queueModule.parseBatchLinks;
  uploadQueue = queueModule.createUploadQueuePanel({ element: $, can, api, send, onError: setError, openDocument: open });
  reanalysisPanel = createReanalysisPanel({
    element: $, can, state, api, send, onError: setError,
    onDone: async () => { if (state.current) await open(state.current.id); await load(); }
  });
  localQueue = createFileQueue({
    capacity: () => uploading.value ? Promise.resolve({ active: 5, capacity: 5, blocked: true }) : api('/upload-queue'),
    upload: (entry, report) => uploadFile(entry.file, entry.metadata, entry, report),
    changed: renderLocalQueue
  });
  bindVideoDrop({
    zone: $('video-drop'), input: $('video-file'), busy: () => uploading.value,
    multiple: () => can('queue:edit') && can('queue:view'),
    maxBytes: () => state.settings?.maxBytes || 1024 ** 3, error: setError,
    selected: (file, files) => {
      clearError();
      $('selected-video').textContent = (files.length > 1 ? '已选 ' + files.length + ' 个视频 · ' : '') + file.name + ' · ' + (file.size / 1024 ** 2).toFixed(1) + ' MB';
      if (!state.resume) $('upload-title').value = file.name.replace(/\.[^.]+$/, '').slice(0, 160);
    }
  });
  window.addEventListener('beforeunload', beforeUnload);
  boot().catch(setError);
  } catch (error) {
    setError(error);
  }
});

onBeforeUnmount(() => {
  clearInterval(pollTimer);
  window.removeEventListener('beforeunload', beforeUnload);
  notesView?.dispose();
});
</script>

<template>
  <div class="kb-page">
    <header class="kb-heading"><div><a href="/" class="kb-muted">← 我的服务</a><h1>让看过的内容，成为自己的知识</h1><p class="kb-muted">上传视频，留下完整笔记、时间线和可回看的原始材料。</p></div><div class="kb-actions"><a class="btn ghost" href="/knowledge/public/">公开知识库</a><button id="settings-toggle" type="button" class="btn ghost" @click="toggleSettings">处理设置</button><button id="upload-toggle" type="button" class="btn primary" hidden @click="openUpload">上传视频</button></div></header>
    <p id="error" role="alert" :hidden="!errorText">{{ errorText }} <a v-if="errorLink" :href="errorLink.href">{{ errorLink.text }}</a></p><p id="message" role="status" aria-live="polite">{{ messageText }}</p>
    <section id="settings" class="kb-panel" :hidden="!settingsOpen"><h2>处理设置</h2><div class="kb-settings-grid"><div><label>默认总结方式<select id="backend" @change="onBackendChange"><option value="codex">Codex CLI · 使用工作器已登录账号</option><option value="openai">兼容 OpenAI 的 API</option><option value="gemini">Gemini API · 直接分析原视频</option></select></label><p id="backend-description" class="kb-muted"></p><label>总结模型<input id="summary-model" maxlength="120" list="summary-models" placeholder="留空使用工作器默认模型" autocomplete="off" @input="onModelInput"></label><datalist id="summary-models"><option value="gpt-6-luna">省用量：Luna</option><option value="gpt-6.1-sol">均衡：Sol</option><option value="gpt-6-sol"></option><option value="gpt-6-astra">复杂内容：Astra</option></datalist><label id="summary-effort-label">推理强度<select id="summary-effort" @change="onModelInput"><option value="">跟随工作器默认</option><option value="low">low · 低</option><option value="medium">medium · 中</option><option value="high">high · 高</option><option value="xhigh">xhigh · 更高</option><option value="max">max · 最高</option><option value="ultra">ultra · 仅部分模型支持</option></select></label><button id="model-save" type="button" class="btn ghost" :hidden="!modelSaveVisible" @click="saveModel">保存模型设置</button><p class="kb-hint">批量笔记可先试 GPT-6 Luna + high；重要案例可用 GPT-6.1 Sol + low，内容复杂时再选 medium。模型与强度需当前账号或API支持；不自动升级模型重试。</p><p class="kb-hint">保存后用于新上传和失败重试，已排队、处理中和已生成的笔记保留原模型记录。各方式分别保存模型设置。Gemini 会将原视频发送至 Google API。</p></div><div><section id="bilibili-settings" hidden><h3>B站账号与视频清晰度</h3><p id="bilibili-status" class="kb-hint" role="status"></p><div class="kb-actions"><button id="bilibili-login" class="btn ghost" type="button" hidden>扫码绑定 / 重新绑定B站</button><button id="bilibili-check" class="btn ghost" type="button" hidden>检查登录状态</button><button id="bilibili-unlink" class="btn ghost" type="button" hidden>解除绑定</button></div><img id="bilibili-qr" width="240" height="240" alt="用B站手机端扫描，确认将账号绑定到当前知识库" hidden><p id="bilibili-login-status" class="kb-hint" role="status"></p><div id="bilibili-quality-settings" hidden><label>默认视频清晰度<select id="bilibili-default-quality"><option value="80">1080p</option><option value="64">720p</option><option value="32">480p</option><option value="16">360p</option></select></label><label>清晰度不足时<select id="bilibili-default-mode"><option value="strict">严格模式：停止并提示</option><option value="auto">自动降级：使用最高可用清晰度</option></select></label><button id="bilibili-save-quality" class="btn ghost" type="button">保存清晰度设置</button></div><p class="kb-hint">默认严格要求1080p，拿不到时不会静默降级。登录凭据按当前知识库账号加密保存，可随时解除绑定；可用清晰度仍取决于视频与账号权限。</p></section><section id="asr-settings" :hidden="!asrSettingsVisible"><h3>语音转写</h3><label>语音模型<select id="asr-model" @input="onAsrInput"><option value="small">small · 节省显存</option><option value="turbo">large-v3-turbo · 速度优先</option><option value="large-v3">large-v3 · 质量优先</option></select></label><label>视频语言<select id="asr-language" @input="onAsrInput"><option value="zh">中文（默认）</option><option value="auto">自动识别语言</option></select></label><label>术语提示<select id="asr-profile" @input="onAsrInput"><option value="auto">按标题、分类和标签识别命理视频</option><option value="general">通用</option><option value="bazi">八字命理</option></select></label><label>补充术语<input id="asr-hotwords" maxlength="120" placeholder="如：印绶，禄神，丙火；仅填少量术语" @input="onAsrInput"></label><button id="asr-save" class="btn ghost" type="button" @click="saveAsr">保存语音设置</button><p class="kb-hint">仅使用GPU；同一电脑的GPU转写依次执行，抽帧和总结仍可并发。新模型首次需下载；不会因显存不足切换CPU。新设置用于新任务、失败重试和“重新提取原视频”；复用已有素材不会重新识别。</p><p class="kb-hint">时间线默认显示简体，可切换原始识别文字。简繁转换不修正同音字；术语提示有助识别，仍需回看原片核对。</p></section><div id="concurrency-settings" :hidden="!concurrencySettingsVisible"><h3>并发设置</h3><label>每个工作器的素材任务并发<select id="media-concurrency" @change="onConcurrencyChange"><option value="1">1 路（默认，节省显存）</option><option value="2">2 路（抽帧并行，GPU转写依次执行）</option></select></label><label>每个工作器的总结并发<select id="summary-concurrency" @change="onConcurrencyChange"><option value="1">1 路</option><option value="2" selected>2 路（默认）</option><option value="3">3 路</option><option value="4">4 路</option></select></label><button id="concurrency-save" type="button" class="btn ghost" @click="saveConcurrency">保存并发设置</button><p class="kb-hint">转写完成即可释放GPU，由Codex继续总结。不同工作器独立接单；降低并发不会中断当前任务。旧版设备需空闲更新后启用分阶段并发。</p></div><h3>视频工作器</h3><p id="worker-status" class="kb-muted"></p><p class="kb-hint">工作器可运行在服务器或自己的电脑上，负责提取音视频与调用模型。每个工作器只处理其绑定账号的视频。</p><button type="button" id="worker-install" class="btn primary" hidden>安装并连接这台电脑</button><button type="button" id="worker-install-zip" class="btn ghost" hidden>下载脚本安装包（ZIP）</button><p class="kb-hint">如EXE被浏览器拦截，可下载ZIP脚本安装包，全部解压后运行其中的安装脚本；无需关闭浏览器安全保护。</p><p id="device-install-status" class="kb-hint" role="status"></p><div id="device-manager" hidden><h3>我的处理设备</h3><div id="worker-devices"></div><form id="device-pair-form" hidden><label>设备配对码<input id="device-pair-code" maxlength="8" pattern="[A-Fa-f0-9]{8}" placeholder="安装程序显示的8位码" required></label><button type="submit" class="btn ghost">查看设备</button></form><p id="device-pair-description" class="kb-hint"></p><button type="button" id="device-pair-confirm" class="btn primary" hidden>确认连接此设备</button></div><details><summary>高级设置：旧版共享凭据</summary><p class="kb-hint">平时无需操作。更换会使旧版工作器断线，独立绑定设备不受影响。</p><button type="button" id="worker-token" class="btn ghost" hidden @click="renewWorkerToken">生成 / 更换工作器凭据</button><div id="token-result" hidden><label>新凭据（仅显示本次）<input id="new-token" readonly autocomplete="off"></label><p class="kb-hint">填入工作器私有配置的 token；更换会撤销旧凭据，正在处理的任务需重试。不要放进 Git 或公开笔记。</p></div></details></div></div></section>
    <section id="upload-panel" class="kb-panel" :hidden="!uploadOpen"><div class="kb-section-heading"><h2 id="upload-heading">从一个视频开始</h2><button id="upload-close" type="button" class="btn ghost" @click="closeUpload">收起</button></div><form id="upload-form" @submit.prevent="upload" @reset="onUploadReset"><label id="upload-mode-label" hidden>视频来源<select id="upload-mode"><option value="link" selected>粘贴B站视频链接</option><option id="upload-batch-option" value="batch" hidden>批量B站链接</option><option value="file">上传本地视频（可多选）</option></select></label><div class="kb-settings-grid"><div id="video-link-controls" hidden><label id="video-link-single">B站视频链接<input id="video-link" type="text" maxlength="1500" placeholder="视频页或b23.tv分享链接，支持带p参数的分P"></label><label id="batch-links-label" hidden>批量B站视频链接<textarea id="batch-links" rows="6" maxlength="150000" placeholder="每行一条链接，也支持粘贴多条分享文本；每批最多100条"></textarea></label><button id="video-link-preview" class="btn ghost" type="button">读取视频信息</button><p id="video-link-status" class="kb-hint" role="status"></p><label>本次视频清晰度<select id="link-quality"><option value="80">1080p</option><option value="64">720p</option><option value="32">480p</option><option value="16">360p</option></select></label><label>本次清晰度策略<select id="link-mode"><option value="strict">严格模式：没有所选清晰度则停止</option><option value="auto">自动降级：使用不高于目标的最高可用清晰度</option></select></label><p id="link-quality-status" class="kb-hint" role="status"></p><p class="kb-hint">自动填写标题、分类建议、标签和来源链接，可修改后提交。单条可编辑自动填写的信息；批量时每条分别自动填写，分类和标签可作为共同补充。每条链接导入一个分P。</p></div><label id="video-drop" class="kb-file">拖拽视频到这里，或选择视频<input id="video-file" type="file" multiple accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov" required><span id="selected-video" class="kb-hint" role="status">支持拖拽或多选视频，每批最多100个</span><span class="kb-hint">MP4 / WebM / MOV，最大 1GB、4小时。</span></label><div><label id="upload-title-label">笔记标题<input id="upload-title" maxlength="160" required placeholder="视频主题或课程名称"></label><label>分类<input id="upload-topic" maxlength="60" list="topics" placeholder="如：技术、命理、课程"></label><label>标签<input id="upload-tags" placeholder="用逗号分隔，最多20个标签"></label><label id="upload-source-label">来源链接（可选）<input id="upload-source" type="url" maxlength="1000" placeholder="有链接时默认嵌入原视频，可切换115归档"></label></div></div><div class="kb-actions"><button id="upload-submit" class="btn primary" type="submit">上传并生成笔记</button><span id="upload-status" class="kb-muted" role="status"></span></div><p id="local-input-status" class="kb-hint" role="status"></p><progress id="upload-progress" :value="uploadProgress" max="100" :hidden="!uploadProgressVisible"></progress></form></section>
    <section id="upload-queue-panel" class="kb-panel" hidden><details open><summary>上传队列</summary><p id="queue-counts" class="kb-hint" role="status"></p><div class="kb-settings-grid"><div><h3>B站链接队列</h3><p class="kb-hint">服务器持久保存，关闭页面后继续。每批最多100条，最多500条等待/失败任务；已有5个处理中任务时自动等待。</p><div id="link-queue-list" class="kb-queue-list"></div><div class="kb-actions"><button id="queue-prev" type="button" class="btn ghost">上一页</button><span id="queue-page" class="kb-hint"></span><button id="queue-next" type="button" class="btn ghost">下一页</button></div></div><div><h3>本地文件队列</h3><p class="kb-hint">按顺序自动上传，请保持此页面打开；已上传的视频会在后台继续处理。多个文件使用各自文件名作为标题。</p><div id="file-queue-list" class="kb-queue-list"><div v-for="entry in localQueueItems" :key="entry.id" class="kb-queue-row"><strong>{{ entry.name }}</strong><p>{{ entry.message }}</p><template v-if="can('queue:manage')"><button v-if="entry.state === 'failed'" type="button" class="btn ghost" @click="retryLocal(entry.id)">重试上传</button><button v-if="['waiting','failed'].includes(entry.state)" type="button" class="btn ghost" @click="cancelLocal(entry.id)">取消等待</button></template></div></div></div></div><p id="queue-submit-result" class="kb-hint" role="status"></p></details></section>
    <datalist id="topics"><option v-for="name in topicNames" :key="name" :value="name"></option></datalist>
    <div class="kb-library-toolbar"><form id="search-form" @submit.prevent="onSearchSubmit"><label class="kb-sr">搜索</label><input id="search" type="search" maxlength="120" aria-label="搜索标题、标签、正文或转写" placeholder="搜索标题、标签、笔记或转写" v-model="search"><div class="kb-filter-row"><select id="topic-filter" aria-label="分类筛选" v-model="topicFilter" @change="onFilterChange"><option value="">全部分类</option><option v-for="item in topicOptions" :key="item.value" :value="item.value">{{ item.label }}</option></select><select id="status-filter" aria-label="状态筛选" v-model="statusFilter" @change="onFilterChange"><option v-for="item in statusOptions" :key="item.value" :value="item.value">{{ item.label }}</option></select><button type="submit" class="btn ghost">搜索</button><button id="retry-failed" type="button" class="btn ghost" :hidden="!retryFailedVisible" :disabled="retrying" title="当前账号全部失败笔记，不受筛选和分页影响" @click="retryFailed(true)">一键重试全部失败</button><button id="reanalyze-batch" type="button" class="btn ghost" hidden>批量重新分析</button></div></form></div><div class="kb-workspace"><aside class="kb-library kb-panel"><div class="kb-section-heading"><h2>我的知识库</h2><span id="total" class="kb-muted">{{ total }} 篇</span></div><div id="batch-publication" class="kb-batch" :hidden="!batchVisible"><p id="batch-count" class="kb-hint" role="status">{{ batchCount }}</p><div class="kb-actions"><button id="batch-all" type="button" class="btn ghost" :disabled="batchAllDisabled" @click="batchAll">全选本页笔记</button><button id="batch-clear" type="button" class="btn ghost" :disabled="batchAllDisabled" @click="batchClear">清空选择</button></div><label>批量可见范围<select id="batch-visibility" v-model="batchVisibility"><option value="private">私有</option><option value="public">公开</option></select></label><button id="batch-save" type="button" class="btn ghost" :disabled="batchSaveDisabled" @click="batchSave">应用到所选笔记</button><p class="kb-hint">仅已生成的笔记可选；公开只展示笔记正文，原视频、转写及截图保持私有。</p></div><div id="documents" ref="notesHost" class="kb-documents" :aria-busy="listLoading"></div><nav id="notes-pagination" class="kb-pagination" aria-label="笔记分页" :hidden="!notesVisible"><button id="notes-prev" type="button" class="btn ghost" :disabled="notesPrevDisabled" @click="onNotesPrev">上一页</button><span id="notes-page" class="kb-hint" role="status" aria-live="polite">{{ notesPage }}</span><button id="notes-next" type="button" class="btn ghost" :disabled="notesNextDisabled" @click="onNotesNext">下一页</button></nav></aside>
      <section class="kb-reading kb-panel"><div id="empty" class="kb-empty" :hidden="documentOpen"><p class="kb-eyebrow">记录 · 回看 · 积累</p><h2>每段内容，都有迹可循</h2><p class="kb-muted">从左侧打开笔记，或上传视频开始。<br>笔记、视频与截图按当前账号独立保存。</p></div><article id="detail" :hidden="!documentOpen"><header><div class="kb-section-heading"><h2 id="document-title">{{ documentTitle }}</h2><div class="kb-actions"><button type="button" id="edit" class="btn ghost" :hidden="!editVisible" @click="startEdit">编辑</button><button id="reanalyze" type="button" class="btn ghost" hidden>重新分析</button><a id="export" class="btn ghost" :hidden="!exportVisible" :href="exportHref">导出 Markdown</a><button type="button" id="delete" class="btn ghost danger" :hidden="!deleteVisible" @click="deleteDocument">删除</button></div></div><p id="document-meta" class="kb-muted">{{ documentMeta }}</p><div id="document-tags" class="kb-tags"><span v-for="tag in documentTags" :key="tag">{{ tag }}</span></div><div id="publication" :hidden="!publicationVisible"><label>笔记可见范围<select id="document-visibility" v-model="documentVisibility"><option value="private">私有（仅自己可见）</option><option value="public">公开正文</option></select></label><button id="visibility-save" type="button" class="btn ghost" @click="saveVisibility">保存可见范围</button><p class="kb-hint">公开仅包含标题、分类、标签和正文。请检查正文中的私人信息；原视频、转写和截图不随之公开。</p></div><p id="storage-policy" class="kb-hint">{{ storagePolicy }}</p><p id="storage-status" class="kb-hint" role="status">{{ storageStatus }}</p><button id="storage-retry" type="button" class="btn ghost" :hidden="!storageRetryVisible" @click="retryStorage">重试保存至115</button><div id="job-status" role="status" :class="jobStatusClass">{{ jobStatus }}</div><button id="retry" type="button" class="btn primary" :hidden="!retryVisible" @click="retryFailed(false)">一键重试此任务</button><button id="resume-upload" type="button" class="btn primary" :hidden="!resumeVisible" @click="resumeUpload">重新选择原文件继续上传</button></header>
        <details id="history-panel" hidden><summary>历史版本（保留最近10版）</summary><label>选择旧版本<select id="history-select"></select></label><pre id="history-notes" class="kb-history-notes"></pre><button id="history-restore" type="button" class="btn ghost" hidden>恢复此版本</button></details><nav id="tabs" class="kb-tabs" aria-label="笔记内容" @click="onTabClick"><button type="button" data-tab="notes" :aria-pressed="activeTab === 'notes' && !editing">完整笔记</button><button type="button" data-tab="source" :hidden="!can('source:view')" :aria-pressed="activeTab === 'source' && !editing">原视频</button><button type="button" data-tab="transcript" :hidden="!can('transcript:view')" :aria-pressed="activeTab === 'transcript' && !editing">时间线转写</button><button type="button" data-tab="frames" :hidden="!can('frames:view')" :aria-pressed="activeTab === 'frames' && !editing">关键画面</button></nav>
        <div id="notes-view" :hidden="editing || activeTab !== 'notes'"><p id="provenance" class="kb-hint">{{ provenance }}</p><nav id="outline" class="kb-outline" aria-label="笔记目录"><a v-for="item in outlineLinks" :key="item.id" :href="'#' + item.id">{{ item.text }}</a></nav><div id="note-content" class="kb-markdown" v-html="noteHtml"></div></div>
        <div id="source-view" :hidden="editing || activeTab !== 'source'"><div class="kb-playback-toolbar"><label>播放来源<select id="playback-source"><option value="original">原视频链接</option><option value="archive">115 归档视频</option></select></label><a id="original-link" target="_blank" rel="noopener noreferrer" hidden>打开原网页 ↗</a></div><p id="playback-hint" class="kb-hint"></p><iframe id="original-frame" title="原视频页面" sandbox="allow-scripts allow-forms allow-popups allow-presentation" allow="fullscreen; picture-in-picture" referrerpolicy="no-referrer" allowfullscreen hidden></iframe><video id="player" controls preload="metadata" hidden></video></div>
        <div id="transcript-view" :hidden="editing || activeTab !== 'transcript'"><label id="transcript-script-label" :hidden="!transcriptScriptVisible">文字显示<select id="transcript-script" v-model="transcriptScript" @change="onTranscriptScript"><option value="simplified">简体中文（默认）</option><option value="raw">原始识别文字</option></select></label><p class="kb-hint">自动转写可能存在同音字、术语或数字错误。点击时间回看原视频。</p><p id="asr-provenance" class="kb-hint"></p><div id="transcript"><div v-for="(segment, index) in transcriptRows" :key="index" class="kb-segment"><button type="button" :disabled="!can('source:view')" @click="jumpTo(segment.start)">{{ time(segment.start) }}</button><p>{{ segment.text }}</p></div></div></div>
        <div id="frames-view" :hidden="editing || activeTab !== 'frames'"><p class="kb-hint">画面为抽样提取，不能保证覆盖所有幻灯片或瞬间信息。</p><div id="frames" class="kb-frames"><figure v-for="frame in framesList" :key="frame.name"><img :src="frame.src" :alt="frame.label" loading="lazy"><figcaption>{{ frame.caption }}</figcaption></figure></div></div>
        <form id="edit-form" :hidden="!editing" @submit.prevent="submitEdit"><h3>编辑笔记</h3><label>标题<input id="edit-title" maxlength="160" required v-model="editTitle"></label><div class="kb-settings-grid"><label>分类<input id="edit-topic" maxlength="60" list="topics" v-model="editTopic"></label><label>标签（逗号分隔）<input id="edit-tags" v-model="editTags"></label></div><label>来源链接<input id="edit-source" type="url" maxlength="1000" v-model="editSource"></label><label>Markdown 正文<textarea id="edit-notes" rows="24" maxlength="500000" v-model="editNotes"></textarea></label><div class="kb-actions"><button class="btn primary" type="submit">保存笔记</button><button id="cancel-edit" type="button" class="btn ghost" @click="cancelEdit">取消</button></div></form>
      </article></section></div>
    <dialog id="reanalysis-dialog"><h2 id="reanalysis-heading">重新分析</h2><p id="reanalysis-scope"></p><label>处理方式<select id="reanalysis-mode"><option value="reuse">复用已有转写和关键画面（默认）</option><option value="full">重新提取原视频（重新转写、抽帧）</option></select></label><p class="kb-hint">使用当前模型和强度，旧正文与素材先保存为历史版本。默认方式不会补充漏掉的画面；需要补画面请选择重新提取原视频。任务只由GPU工作器领取，新版工作器就绪前保留排队。</p><p id="reanalysis-preview" role="status"></p><div class="kb-actions"><button id="reanalysis-confirm" type="button" class="btn primary" disabled>确认重新分析</button><button id="reanalysis-close" type="button" class="btn ghost">取消</button></div></dialog>
  </div>
</template>
