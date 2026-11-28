<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';

const sectionEl = ref(null);
const contentHost = ref(null);
const tagHost = ref(null);
const locationHost = ref(null);
const visibilityHost = ref(null);
const previewHost = ref(null);
const feedHost = ref(null);
const tagFilterHost = ref(null);

const visible = ref(false);
const canPost = ref(false);
const canManage = ref(false);
const canViewComments = ref(false);
const canComment = ref(false);
const isGuest = ref(false);
const userId = ref('');
const loading = ref(false);
const hasMore = ref(false);
const composerOpen = ref(false);
const writeBusy = ref(false);
const saving = ref(false);
const preparing = ref(0);
const uploadStatus = ref('');
const count = ref(0);
const search = ref('');
const searchStatus = ref('输入关键词搜索，清空可查看全部动态');
const tag = ref('');
const tags = shallowRef([]);
const posts = shallowRef([]);
const editingId = ref(null);

const canCompose = computed(() => canPost.value || canManage.value);

const state = {
  posts: new Map(),
  lastId: null,
  pending: [],
  refreshPending: false,
  editing: null,
};
let feedView;
let tagView;
let richEditor;
let tagEditor;
let locationEditor;
let visibilityEditor;
let searchTimer;
let intervalExpire;
let intervalRefresh;
let shortcutEl;
let feedGeneration = 0;
let committedSearch = '';
const commentDrafts = new Map();

function request(path, options) {
  return fetch('/api/blog/' + path, options || {}).then(async response => {
    let data;
    try { data = await response.json(); }
    catch { throw new Error('请求失败（HTTP ' + response.status + '），请稍后重试'); }
    if (!response.ok || !data.ok) throw new Error(data.error || '请求失败');
    return data;
  });
}

function feedEmptyText() {
  return search.value ? '没有找到匹配的博客，试试其他关键词或清空搜索。'
    : tag.value ? '这个标签下还没有动态。' : '还没有动态，写下第一篇吧。';
}

function currentModel() {
  return {
    posts: posts.value,
    userId: userId.value,
    canPost: canPost.value,
    canManage: canManage.value,
    canViewComments: canViewComments.value,
    empty: feedEmptyText(),
    generation: feedGeneration,
  };
}

function renderFeed() {
  if (!feedView) return;
  feedView.render(currentModel());
}

function restoreFeed() {
  feedGeneration++;
  renderFeed();
}

function renderTagFilter() {
  if (tagView) tagView.render(tags.value, tag.value);
}

function editItems(post) {
  return (post.images || []).map(item => Object.assign({ kind: 'image' }, item))
    .concat((post.videos || []).map(item => Object.assign({ kind: 'video' }, item)))
    .sort((a, b) => (a.position || 0) - (b.position || 0));
}

function loadEditor() {
  return window.portalPage.loadScript('/blog-rich-editor.js?v=blog-unified-1');
}

async function openComposer() {
  if (!canCompose.value || writeBusy.value) return;
  writeBusy.value = true;
  try {
    await loadEditor();
    if (!canCompose.value) return;
    richEditor ||= window.createBlogEditor(contentHost.value);
    composerOpen.value = true;
    locationEditor.start();
    richEditor.focus();
  } catch (error) {
    window.portalToast?.error(error.message);
  } finally {
    writeBusy.value = false;
  }
}

function convertToJpeg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, 2560 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) return reject(new Error('浏览器无法处理这张图片'));
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => {
        if (blob) resolve(new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }));
        else reject(new Error('图片转换失败'));
      }, 'image/jpeg', 0.82);
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('浏览器无法识别此图片')); };
    image.src = url;
  });
}

function release(items) {
  items.forEach(item => URL.revokeObjectURL(item.preview));
}

async function addFiles(files, kind, target, render) {
  const added = [];
  try {
    for (let file of files) {
      if (kind === 'video' && !file.type) {
        const extension = file.name.split('.').at(-1).toLowerCase();
        const videoTypes = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
        if (videoTypes[extension]) file = new File([file], file.name, { type: videoTypes[extension] });
      }
      if (kind === 'video' && !['video/mp4', 'video/webm', 'video/quicktime'].includes(file.type)) throw new Error('视频仅支持 MP4、WebM、MOV');
      const payload = kind === 'image' ? await convertToJpeg(file) : file;
      added.push({ kind, file: payload, preview: URL.createObjectURL(payload) });
    }
    target.push.apply(target, added);
    render();
  } catch (error) { release(added); throw error; }
}

function renderPreview(root, existing, pending, existingAction, pendingAction) {
  const list = existing.map(item => Object.assign({}, item, { removeAction: existingAction(item) }));
  pending.forEach((item, index) => list.push({ url: item.preview, kind: item.kind, removeAction: pendingAction(index) }));
  window.renderBlogGallery(root, list);
}

function renderComposerPreview() {
  renderPreview(previewHost.value, [], state.pending, () => ({}), index => ({ action: 'remove-pending', index }));
}

function acceptPastedImages(editorRoot, lockRoot, getTarget, render, allowed) {
  window.bindBlogImagePaste(editorRoot, async files => {
    if (saving.value || preparing.value || !allowed()) return;
    const unlock = lockEditor(lockRoot);
    preparing.value++;
    try {
      await addFiles(files, 'image', getTarget(), render);
      window.portalToast?.success('已添加 ' + files.length + ' 张图片，发布或保存时上传');
    } finally { preparing.value--; unlock(); }
  });
}

async function load(reset) {
  if (state.editing) return;
  if (loading.value) { if (reset) state.refreshPending = true; return; }
  const query = search.value, currentTag = tag.value;
  loading.value = true;
  if (!state.posts.size) window.navigationSkeleton?.start('blog');
  searchStatus.value = '正在加载动态…';
  try {
    const params = new URLSearchParams();
    if (!reset && state.lastId) params.set('before', state.lastId);
    if (tag.value) params.set('tag', tag.value);
    if (query) params.set('q', query);
    const data = await request('posts?' + params.toString());
    if (query !== search.value || currentTag !== tag.value) return;
    committedSearch = query;
    tags.value = data.tags || [];
    tagEditor?.suggestions(tags.value);
    renderTagFilter();
    if (reset) { state.posts.clear(); posts.value = []; }
    userId.value = data.userId;
    isGuest.value = data.isGuest;
    canPost.value = data.canPost;
    canManage.value = data.canManage;
    canViewComments.value = data.canViewComments;
    canComment.value = data.canComment;
    const canWrite = canPost.value || canManage.value;
    if (canWrite && richEditor) composerOpen.value = true;
    if (!canWrite) composerOpen.value = false;
    if (shortcutEl) {
      shortcutEl.textContent = canPost.value ? '写博客' : '查看动态';
      shortcutEl.classList.remove('hidden');
    }
    data.posts.forEach(post => state.posts.set(post.id, post));
    posts.value = Array.from(state.posts.values());
    renderFeed();
    state.lastId = data.posts.length ? data.posts.at(-1).id : null;
    hasMore.value = data.posts.length >= 20;
    searchStatus.value = (search.value || tag.value ? '当前筛选' : '全部动态') + '：已显示 ' + state.posts.size + ' 篇'
      + (data.posts.length === 20 ? '，可加载更多' : '');
    visible.value = true;
  } catch (error) {
    searchStatus.value = '加载失败，请重新输入关键词重试';
    if (error.message !== '无权查看博客') window.portalToast?.error('博客加载失败：' + error.message);
  } finally {
    window.navigationSkeleton?.finish('blog');
    loading.value = false;
    if (state.refreshPending) { state.refreshPending = false; load(true); }
  }
}

function onSearchInput(event) {
  if (event.isComposing) return;
  if (state.editing) { search.value = committedSearch; event.target.value = committedSearch; window.portalToast?.warn('请先完成当前编辑'); return; }
  search.value = event.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { load(true); }, 300);
}

function onTagFilterClick(event) {
  const button = event.target.closest('button[data-tag]');
  if (button) selectTag(button);
}

function onEditorInput() {
  if (richEditor) count.value = richEditor.length();
}

function lockEditor(root) {
  const controls = Array.from(root.querySelectorAll('button, input, select'));
  const disabled = controls.map(control => control.disabled);
  const editable = Array.from(root.querySelectorAll('[contenteditable]'));
  const attributes = editable.map(control => control.getAttribute('contenteditable'));
  controls.forEach(control => { control.disabled = true; });
  editable.forEach(control => control.setAttribute('contenteditable', 'false'));
  return () => {
    controls.forEach((control, index) => { control.disabled = disabled[index]; });
    editable.forEach((control, index) => { control.setAttribute('contenteditable', attributes[index]); });
  };
}

async function uploadLargeVideo(id, item, position, progress) {
  let upload;
  try {
    progress('transfer', 0);
    upload = await request('posts/' + id + '/video-uploads', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ size: item.file.size, mimeType: item.file.type, position })
    });
    const countParts = Math.ceil(item.file.size / upload.chunkBytes);
    const loaded = new Array(countParts).fill(0);
    await window.runBlogUploads(Array.from({ length: countParts }, (_, index) => index + 1), async part => {
      const chunk = item.file.slice((part - 1) * upload.chunkBytes, part * upload.chunkBytes);
      for (let attempt = 0; ; attempt++) {
        try {
          await window.uploadBlogBytes('video-uploads/' + upload.id + '/parts/' + part, chunk, 'application/octet-stream', bytes => {
            loaded[part - 1] = bytes;
            progress('transfer', loaded.reduce((sum, value) => sum + value, 0) / item.file.size * 100);
          });
          break;
        } catch (error) { if (attempt >= 2) throw error; }
      }
      return part;
    }, 2);
    await request('video-uploads/' + upload.id, { method: 'POST' });
    let errors = 0;
    for (;;) {
      let result;
      try { result = await request('video-uploads/' + upload.id); errors = 0; }
      catch (error) { if (++errors > 3) throw error; await new Promise(resolve => setTimeout(resolve, 2000)); continue; }
      if (result.state === 'failed') throw new Error(result.error || '视频处理失败');
      if (result.state === 'done') {
        await request('video-uploads/' + upload.id, { method: 'DELETE' }).catch(() => {});
        return result;
      }
      progress(result.state === 'queued' ? 'waiting' : result.state, result.progress);
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
  } catch (error) {
    if (upload) await request('video-uploads/' + upload.id, { method: 'DELETE' }).catch(() => {});
    throw error;
  } finally { uploadStatus.value = ''; }
}

async function uploadAll(id, items, root) {
  const existing = state.posts.has(id) ? editItems(state.posts.get(id)) : [];
  const base = existing.reduce((max, item, index) => Math.max(max, item.position == null ? index : item.position), -1) + 1;
  const panel = window.createBlogUploadProgress(root, items);
  const result = await window.runBlogUploads(items.slice(), async (item, index) => {
    const position = base + index;
    const progress = (phase, percent) => panel.update(index, phase, percent);
    let uploaded;
    try {
      uploaded = item.kind === 'video'
        ? await uploadLargeVideo(id, item, position, progress)
        : await window.uploadBlogBytes('posts/' + id + '/media?kind=image&position=' + position, item.file, item.file.type, bytes => {
          progress(bytes >= item.file.size ? 'imageProcessing' : 'transfer', bytes / item.file.size * 100);
        });
    } catch (error) { progress('failed', 0); throw error; }
    progress('done', 100);
    return uploaded;
  }, 2);
  panel.clear();
  return result;
}

async function publish() {
  if (!richEditor || !canCompose.value || preparing.value) return;
  if (saving.value || state.editing) { window.portalToast?.warn('请先完成当前编辑或上传'); return; }
  if (richEditor.isEmpty() && !state.pending.length) { window.portalToast?.error('请输入博客内容或添加媒体'); return; }
  saving.value = true;
  const composerEl = document.getElementById('blog-composer');
  unlock = lockEditor(composerEl || sectionEl.value);
  let created;
  try {
    created = await request('posts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: richEditor.content(), contentFormat: richEditor.format(),
        visibility: visibilityEditor.value(), location: await locationEditor.value({ wait: false }),
        tags: tagEditor.value(), hasMedia: state.pending.length > 0
      })
    });
    await uploadAll(created.id, state.pending, composerEl || sectionEl.value);
    release(state.pending);
    state.pending = [];
    richEditor.clear(); tagEditor.clear(); locationEditor.clear(); visibilityEditor.clear();
    count.value = 0;
    renderComposerPreview();
    await load(true);
    window.portalToast?.success('发布成功');
  } catch (error) {
    if (created && !error.uploaded?.length) {
      await request('posts/' + created.id, { method: 'DELETE' }).catch(() => {});
      window.portalToast?.error('上传失败，内容已保留在编辑框：' + error.message);
    } else if (created) {
      release(state.pending); state.pending = [];
      richEditor.clear(); tagEditor.clear(); locationEditor.clear(); visibilityEditor.clear();
      count.value = 0;
      renderComposerPreview();
      await load(true);
      window.portalToast?.error('媒体上传中断，已发布的内容可在编辑中继续补充：' + error.message);
    } else window.portalToast?.error(error.message);
  } finally { unlock?.(); saving.value = false; }
}
let unlock;

async function renderComments(article, before, detailPanel) {
  const id = article.dataset.id;
  const panel = detailPanel || article.querySelector('.blog-comments-content');
  const toggle = article.querySelector('[data-action="comments"]');
  panel.hidden = false;
  if (!detailPanel) toggle.setAttribute('aria-expanded', 'true');
  toggle.disabled = true;
  const indicator = document.createElement('p');
  indicator.className = 'blog-comment-status';
  indicator.textContent = '正在加载评论…';
  indicator.setAttribute('role', 'status');
  panel.appendChild(indicator);
  try {
    const data = await request('posts/' + id + '/comments' + (before ? '?before=' + before : ''));
    if (!before) panel.replaceChildren();
    else panel.querySelector('[data-comment-more]')?.remove();
    data.comments.forEach(comment => {
      const row = document.createElement('div'); row.className = 'blog-comment'; row.dataset.commentId = comment.id;
      const meta = document.createElement('div'); meta.className = 'blog-comment-meta';
      const author = document.createElement('strong'); author.textContent = comment.authorName;
      const time = document.createElement('time'); time.dateTime = comment.createdAt; time.textContent = new Date(comment.createdAt).toLocaleString('sv-SE');
      meta.append(author, time);
      if (comment.canDelete) {
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '删除评论'; remove.className = 'blog-action';
        remove.addEventListener('click', async () => {
          if (!(await window.portalUI.confirm('确定删除这条评论吗？', { title: '删除评论', danger: true, okText: '删除' }))) return;
          remove.disabled = true;
          try { await request('comments/' + comment.id, { method: 'DELETE' }); await renderComments(article, null, detailPanel); }
          catch (error) { window.portalToast?.error(error.message); remove.disabled = false; }
        });
        meta.appendChild(remove);
      }
      const text = document.createElement('div'); text.className = 'blog-comment-body';
      if (comment.contentFormat === 'markdown' && comment.contentHtml != null) {
        text.classList.add('blog-rich-content');
        text.innerHTML = window.DOMPurify.sanitize(comment.contentHtml);
      } else text.textContent = comment.content;
      row.append(meta, text); panel.appendChild(row);
    });
    if (data.next) {
      const moreComments = document.createElement('button');
      moreComments.type = 'button'; moreComments.className = 'blog-action'; moreComments.textContent = '加载更早的评论';
      moreComments.dataset.commentMore = 'true';
      moreComments.addEventListener('click', () => { moreComments.disabled = true; renderComments(article, data.next, detailPanel); });
      panel.appendChild(moreComments);
    }
    if (!panel.querySelector('.blog-comment')) {
      const empty = document.createElement('p'); empty.textContent = '还没有评论，聊聊你的想法。'; panel.appendChild(empty);
    }
    if (canComment.value && !panel.querySelector('form')) {
      const form = document.createElement('form'); form.className = 'blog-comment-form';
      const input = document.createElement('textarea');
      input.maxLength = 2000; input.rows = 3;
      input.placeholder = '写下评论，支持 Markdown（加粗、列表、链接、代码等）…';
      input.setAttribute('aria-label', '评论内容');
      input.value = commentDrafts.get(id) || '';
      input.addEventListener('input', () => { commentDrafts.set(id, input.value); });
      const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'btn primary'; submit.textContent = '发表评论';
      form.append(input, submit); panel.appendChild(form);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!input.value.trim()) return;
        input.disabled = submit.disabled = true;
        try {
          await request('posts/' + id + '/comments', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: input.value })
          });
          commentDrafts.delete(id);
          await renderComments(article, null, detailPanel);
        } catch (error) { window.portalToast?.error(error.message); input.disabled = submit.disabled = false; }
      });
    }
    toggle.textContent = '评论 (' + panel.querySelectorAll('.blog-comment').length + (data.next ? '+' : '') + ')';
  } catch (error) {
    indicator.textContent = '评论加载失败：' + error.message;
    window.portalToast?.error(error.message);
  } finally {
    if (indicator.textContent === '正在加载评论…') indicator.remove();
    toggle.disabled = false;
  }
}

window.renderBlogDetailComments = (article, panel) => renderComments(article, null, panel);

function renderEditPreview(article) {
  const editing = state.editing;
  if (!editing) return;
  const root = article.querySelector('.blog-edit-preview');
  const existing = editItems(state.posts.get(editing.id)).filter(item => editing.keepMediaIds.includes(item.id));
  renderPreview(root, existing, editing.pending,
    item => ({ action: 'remove-media', source: 'existing', mediaId: item.id }),
    index => ({ action: 'remove-media', source: 'pending', index }));
}

async function onFeedClick(event) {
  const commentsToggle = event.target.closest('[data-action="comments"]');
  if (commentsToggle) {
    const article = commentsToggle.closest('.blog-post');
    const panel = article.querySelector('.blog-comments-content');
    if (!panel.hidden) { panel.hidden = true; commentsToggle.setAttribute('aria-expanded', 'false'); }
    else renderComments(article);
    return;
  }
  const tagButton = event.target.closest('button[data-tag]');
  if (tagButton) { await selectTag(tagButton); return; }
  const removeButton = event.target.closest('button[data-action="remove-media"]');
  if (removeButton && state.editing) {
    if (removeButton.dataset.source === 'existing') {
      state.editing.keepMediaIds = state.editing.keepMediaIds.filter(id => id !== removeButton.dataset.mediaId);
    } else release(state.editing.pending.splice(Number(removeButton.dataset.index), 1));
    renderEditPreview(removeButton.closest('.blog-post'));
    return;
  }
  const actionButton = event.target.closest('button[data-action="edit"], button[data-action="delete"], button[data-action="save"], button[data-action="cancel"]');
  if (!actionButton) return;
  const action = actionButton.dataset.action;
  if (action === 'delete') {
    if (state.saving) { window.portalToast?.warn('请等待当前上传完成'); return; }
    if (!(await window.portalUI.confirm('确定删除这篇动态吗？', { title: '删除动态', danger: true, okText: '删除' }))) return;
    try {
      const result = await request('posts/' + actionButton.dataset.id, { method: 'DELETE' });
      state.editing?.editor.destroy();
      state.editing = null;
      await load(true);
      window.portalToast?.success(result.cleanupPending ? '已删除，媒体将在后台清理' : '已删除');
    } catch (error) { window.portalToast?.error(error.message); }
    return;
  }
  if (action === 'cancel') {
    if (!state.editing) { restoreFeed(); load(true); return; }
    release(state.editing.pending);
    state.editing.editor.destroy();
    state.editing = null;
    editingId.value = null;
    restoreFeed();
    return load(true);
  }
  if (action === 'save') {
    if (state.preparing) return;
    if (state.saving) return;
    if (!state.editing) { restoreFeed(); return; }
    state.saving = true;
    const unlockSave = lockEditor(actionButton.closest('.blog-post'));
    try {
      const editing = state.editing;
      const nextTags = editing.tags.value();
      const visibility = editing.visibility.value();
      if (editing.editor.length() > 10000) throw new Error('博客内容最多 10000 字');
      const uploaded = await uploadAll(editing.id, editing.pending, actionButton.closest('.blog-post'));
      editing.keepMediaIds.push.apply(editing.keepMediaIds, uploaded.map(item => item.id));
      release(editing.pending); editing.pending = [];
      const saved = await request('posts/' + editing.id, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: editing.editor.content(), contentFormat: editing.editor.format(),
          visibility, location: await editing.location.value({ wait: false }), tags: nextTags,
          keepMediaIds: editing.keepMediaIds
        })
      });
      release(editing.pending); editing.editor.destroy(); state.editing = null;
      editingId.value = null;
      restoreFeed();
      await load(true);
      window.portalToast?.success(saved.cleanupPending ? '保存成功，移除的媒体将在后台清理' : '保存成功');
    } catch (error) {
      if (error.uploaded?.length) {
        if (state.editing) release(state.editing.pending);
        state.editing?.editor.destroy(); state.editing = null; editingId.value = null;
        restoreFeed();
        await load(true);
        window.portalToast?.error('部分媒体已上传，请重新编辑文章：' + error.message);
      } else window.portalToast?.error(error.message);
    } finally { unlockSave(); state.saving = false; }
    return;
  }
  if (action !== 'edit') return;
  if (state.saving) { window.portalToast?.warn('请等待当前上传完成'); return; }
  if (state.editing) { window.portalToast?.warn('请先完成当前编辑'); return; }
  try { await loadEditor(); }
  catch (error) { window.portalToast?.error(error.message); return; }
  const article = actionButton.closest('.blog-post');
  if (state.editing || state.saving || !article.isConnected) return;
  const post = state.posts.get(actionButton.dataset.id);
  if (!post) return;
  state.editing = { id: post.id, keepMediaIds: editItems(post).map(item => item.id), pending: [] };
  editingId.value = post.id;
  const body = article.querySelector('.blog-post-content');
  const editor = document.createElement('div');
  editor.className = 'blog-edit-host';
  body.replaceWith(editor);
  state.editing.editor = window.createBlogEditor(editor, post);
  const editingTarget = state.editing;
  acceptPastedImages(editor, article, () => editingTarget.pending, () => { renderEditPreview(article); }, () => state.editing === editingTarget);
  const editVisibility = document.createElement('div'); editor.after(editVisibility);
  state.editing.visibility = window.createBlogVisibility(editVisibility, post.visibility);
  article.querySelector('.blog-post-tags')?.remove();
  article.querySelector('.blog-post-location')?.remove();
  const editLocation = document.createElement('div'); editor.after(editLocation);
  state.editing.location = window.createBlogLocation(editLocation, post.location);
  state.editing.location.start();
  const editTags = document.createElement('div');
  editor.after(editTags);
  state.editing.tags = window.createBlogTags(editTags, post.tags, tags.value);
  article.querySelector('.blog-post-images')?.remove();
  const tools = document.createElement('div');
  tools.className = 'blog-edit-tools';
  const editPreview = document.createElement('div');
  editPreview.className = 'blog-image-preview blog-edit-preview';
  tools.appendChild(editPreview);
  [['image', '📷 添加图片', 'image/*,.heic,.heif'], ['video', '🎬 添加视频', 'video/mp4,video/webm,video/quicktime,.mov']]
    .forEach(spec => {
      const chooser = document.createElement('input');
      chooser.type = 'file'; chooser.accept = spec[2]; chooser.multiple = true; chooser.hidden = true;
      chooser.id = 'blog-edit-' + spec[0] + '-' + post.id;
      chooser.dataset.editKind = spec[0];
      const label = document.createElement('label');
      label.className = 'btn ghost blog-upload-label'; label.htmlFor = chooser.id; label.textContent = spec[1];
      tools.append(label, chooser);
    });
  const actions = article.querySelector('.blog-actions');
  article.querySelector('.blog-post-footer').before(tools);
  actions.replaceChildren(
    actionButtonFor('保存', 'save', post.id),
    actionButtonFor('取消', 'cancel', post.id)
  );
  renderEditPreview(article);
  state.editing.editor.focus();
}

function actionButtonFor(label, action, id) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'blog-action';
  button.textContent = label;
  button.dataset.action = action;
  button.dataset.id = id;
  return button;
}

async function onFeedChange(event) {
  const chooser = event.target.closest('input[data-edit-kind]');
  if (!chooser || !state.editing) return;
  try {
    await addFiles(Array.from(chooser.files), chooser.dataset.editKind, state.editing.pending,
      () => { renderEditPreview(chooser.closest('.blog-post')); });
  } catch (error) { window.portalToast?.error(error.message); }
  chooser.value = '';
}

async function selectTag(button) {
  if (!button || loading.value) return;
  if (state.editing) { window.portalToast?.warn('请先完成当前编辑'); return; }
  tag.value = button.dataset.tag;
  await load(true);
}

async function onImageChange(event) {
  const input = event.target;
  try { await addFiles(Array.from(input.files), 'image', state.pending, renderComposerPreview); }
  catch (error) { window.portalToast?.error(error.message); }
  input.value = '';
}

async function onVideoChange(event) {
  const input = event.target;
  try { await addFiles(Array.from(input.files), 'video', state.pending, renderComposerPreview); }
  catch (error) { window.portalToast?.error(error.message); }
  input.value = '';
}

function onPreviewClick(event) {
  const button = event.target.closest('button[data-action="remove-pending"]');
  if (!button) return;
  release(state.pending.splice(Number(button.dataset.index), 1));
  renderComposerPreview();
}

async function initialize() {
  try {
    const user = await window.portalPage.user();
    const permissions = user.permissions || [];
    const canView = user.isGuest || permissions.includes('blog:feed:view')
      || (!user.isGuest && (permissions.includes('blog:post:edit') || permissions.includes('blog:manage:edit')));
    if (!canView) return;
    visible.value = true;
    await load(true);
  } catch (error) { window.portalToast?.error('博客加载失败：' + error.message); }
}

function syncShortcut() {
  shortcutEl = document.getElementById('blog-shortcut');
  if (!shortcutEl) return;
  shortcutEl.addEventListener('click', onShortcut);
}
function onShortcut(event) {
  if (!canPost.value) return;
  event.preventDefault();
  openComposer();
}

onMounted(async () => {
  tagEditor = window.createBlogTags(tagHost.value);
  locationEditor = window.createBlogLocation(locationHost.value);
  visibilityEditor = window.createBlogVisibility(visibilityHost.value);
  acceptPastedImages(contentHost.value, sectionEl.value, () => state.pending, renderComposerPreview, () => canPost.value);
  syncShortcut();

  const feedUrl = '/generated/blog-feed-view.js?v=2';
  const tagUrl = '/generated/blog-tag-filter-view.js?v=1';
  const [feedModule, tagModule] = await Promise.all([
    import(feedUrl),
    import(tagUrl),
  ]).catch(() => []);
  const mountBlogFeed = feedModule?.mountBlogFeed;
  const mountBlogTagFilter = tagModule?.mountBlogTagFilter;
  if (mountBlogFeed) {
    feedView = mountBlogFeed(feedHost.value, {
      editItems,
      renderGallery: (host, items) => { window.renderBlogGallery(host, items); },
      locationSource: () => window.createBlogLocationSource(),
      resolveAddress: location => window.resolveBlogAddress(location),
    });
  }
  if (mountBlogTagFilter) {
    tagView = mountBlogTagFilter(tagFilterHost.value);
    renderTagFilter();
  }

  intervalExpire = setInterval(() => {
    const now = Date.now();
    let expired = false;
    state.posts.forEach((post, id) => {
      if (!canManage.value && (isGuest.value || post.authorId !== userId.value)
        && post.visibility?.endsAt && Date.parse(post.visibility.endsAt) <= now) {
        state.posts.delete(id); expired = true;
      }
    });
    if (expired) {
      posts.value = Array.from(state.posts.values());
      document.querySelector('dialog[aria-label="媒体预览"]')?.close();
      load(true);
    }
  }, 1000);
  intervalRefresh = setInterval(() => {
    if (!document.hidden && !state.editing && !document.querySelector('.blog-media-viewer[open]')
      && !feedHost.value?.querySelector('.blog-comments-content:not([hidden])') && visible.value) load(true);
  }, 60000);
  document.addEventListener('visibilitychange', onVisibility);
  await initialize();
});

function onVisibility() {
  if (!document.hidden && !state.editing && !saving.value && !document.querySelector('.blog-media-viewer[open]')
    && !feedHost.value?.querySelector('.blog-comments-content:not([hidden])') && visible.value) load(true);
}

onBeforeUnmount(() => {
  clearTimeout(searchTimer);
  clearInterval(intervalExpire);
  clearInterval(intervalRefresh);
  document.removeEventListener('visibilitychange', onVisibility);
  shortcutEl?.removeEventListener('click', onShortcut);
  feedView?.dispose();
  tagView?.dispose();
  state.editing?.editor?.destroy();
});
</script>

<template>
  <section ref="sectionEl" class="blog-section" id="blog-section" :class="{ hidden: !visible }" aria-label="博客动态">
    <div class="blog-layout">
      <div class="blog-timeline">
        <div class="blog-heading">
          <div><h2>博客动态</h2><p>记录想法，分享此刻。</p></div>
          <button type="button" class="btn primary" id="blog-write"
                  :class="{ hidden: !canCompose || composerOpen }" :disabled="writeBusy"
                  @click="openComposer">写博客</button>
        </div>
        <form class="blog-composer" id="blog-composer" :class="{ hidden: !composerOpen }" @submit.prevent="publish">
          <label for="blog-content">写点什么</label>
          <div id="blog-content" ref="contentHost" @input="onEditorInput"></div>
          <details class="blog-compose-options"><summary>标签、位置与可见范围</summary>
            <div id="blog-tags" ref="tagHost"></div>
            <div id="blog-location" ref="locationHost"></div>
            <div id="blog-visibility" ref="visibilityHost"></div>
          </details>
          <div class="blog-image-preview" id="blog-preview" ref="previewHost" @click="onPreviewClick"></div>
          <div class="blog-upload-row">
            <label class="btn ghost blog-upload-label" for="blog-images">📷 添加图片</label>
            <input id="blog-images" type="file" accept="image/*,.heic,.heif" multiple hidden @change="onImageChange">
            <label class="btn ghost blog-upload-label" for="blog-videos">🎬 添加视频</label>
            <input id="blog-videos" type="file" accept="video/mp4,video/webm,video/quicktime,.mov" multiple hidden @change="onVideoChange">
            <span>支持直接粘贴图片。图片与视频可以混合发布，左右滑动查看。</span>
          </div>
          <p class="blog-upload-hint">视频将自动压缩为 MP4，发布和编辑均显示上传与压缩进度。</p>
          <div class="blog-composer-footer">
            <span id="blog-upload-status" role="status">{{ uploadStatus }}</span>
            <span id="blog-count">{{ count }} / 10000</span>
            <button class="btn primary" type="submit" id="blog-submit" :disabled="saving || preparing > 0">发布动态</button>
          </div>
        </form>
        <div class="blog-feed" id="blog-feed" ref="feedHost" aria-live="polite"
             @click="onFeedClick" @change="onFeedChange"></div>
        <div class="blog-loading" id="blog-loading" role="status" :class="{ hidden: !loading }">
          <span class="blog-spinner" aria-hidden="true"></span><span>正在加载博客…</span>
        </div>
        <button type="button" class="btn ghost blog-more" id="blog-more"
                :class="{ hidden: !hasMore }" :disabled="loading" @click="load(false)">加载更多</button>
      </div>
      <aside class="blog-sidebar" aria-label="博客搜索与标签">
        <div class="blog-search-bar">
          <label for="blog-search">搜索博客<input id="blog-search" type="search" maxlength="200" autocomplete="off"
            placeholder="搜索正文、作者、标签或地址…" aria-controls="blog-feed" aria-describedby="blog-search-status"
            :value="search" @input="onSearchInput"></label>
          <span id="blog-search-status" role="status">{{ searchStatus }}</span>
        </div>
        <div class="blog-tag-filter" id="blog-tag-filter" ref="tagFilterHost" aria-label="按标签筛选"
             @click="onTagFilterClick"></div>
      </aside>
    </div>
  </section>
</template>
