import { Editor } from 'https://esm.sh/@tiptap/core@2.11.5';
import StarterKit from 'https://esm.sh/@tiptap/starter-kit@2.11.5';
import Placeholder from 'https://esm.sh/@tiptap/extension-placeholder@2.11.5';
import { NoteReference, insertNoteReference } from './note-link.js';

const $ = (id) => document.getElementById(id);

const toastOk = (msg) => window.portalToast?.success(msg) ?? null;
const toastErr = (msg) => window.portalToast?.error(msg) ?? window.alert(msg);

let notebooks = [];
let notes = [];
let noteTree = [];
let allTags = [];
let activeNotebookId = '';
let activeNoteId = '';
let editor = null;
let saveTimer = null;
let searchTimer = null;
let saving = false;
let dirty = false;
let suppressEditorUpdate = false;
let searchResults = null;

async function api(path, options) {
  const resp = await fetch('./api/' + path, options || {});
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const data = await resp.json();
    if (!resp.ok || data.ok === false) throw new Error(data.error || resp.statusText);
    return data;
  }
  if (!resp.ok) throw new Error(resp.statusText);
  return resp;
}

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function setSaveStatus(text) {
  $('save-status').textContent = text;
}

function markDirty() {
  dirty = true;
  setSaveStatus('编辑中…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function() { saveCurrentNote(true); }, 800);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function noteById(id) {
  return notes.find(function(n) { return n.id === id; });
}

function parseTagsInput(raw) {
  return String(raw || '').split(/[,，\s]+/).map(function(t) { return t.trim(); }).filter(Boolean);
}

async function loadBootstrap() {
  const prevNotebook = activeNotebookId;
  const data = await api('bootstrap');
  notebooks = data.notebooks || [];
  notes = data.notes || [];
  allTags = data.tags || [];
  activeNotebookId = prevNotebook && notebooks.some(function(n) { return n.id === prevNotebook; })
    ? prevNotebook
    : (notebooks[0]?.id || '');
  await refreshTree();
  renderNotebooks();
  renderTagFilter();
  renderNoteList();
}

async function refreshTree() {
  if (!activeNotebookId) { noteTree = []; return; }
  const data = await api('notes/tree?notebookId=' + encodeURIComponent(activeNotebookId));
  noteTree = data.tree || [];
}

function renderNotebooks() {
  const select = $('notebook-select');
  select.innerHTML = '';
  notebooks.forEach(function(nb) {
    const opt = document.createElement('option');
    opt.value = nb.id;
    opt.textContent = nb.title;
    if (nb.id === activeNotebookId) opt.selected = true;
    select.appendChild(opt);
  });
}

async function refreshTags() {
  const data = await api('tags?notebookId=' + encodeURIComponent(activeNotebookId || ''));
  allTags = data.tags || [];
  renderTagFilter();
}

function renderTagFilter() {
  const select = $('tag-filter');
  const current = select.value;
  select.innerHTML = '<option value="">全部标签</option>';
  allTags.forEach(function(item) {
    const opt = document.createElement('option');
    opt.value = item.tag;
    opt.textContent = item.tag + ' (' + item.count + ')';
    select.appendChild(opt);
  });
  if ([...select.options].some(function(o) { return o.value === current; })) {
    select.value = current;
  }
}

function isFiltering() {
  return $('note-search').value.trim() || $('tag-filter').value;
}

async function runSearch() {
  if (!isFiltering()) {
    searchResults = null;
    renderNoteList();
    return;
  }
  const params = new URLSearchParams();
  params.set('notebookId', activeNotebookId);
  const q = $('note-search').value.trim();
  const tag = $('tag-filter').value;
  if (q) params.set('q', q);
  if (tag) params.set('tag', tag);
  const data = await api('search?' + params.toString());
  searchResults = data.notes || [];
  renderNoteList();
}

function renderTreeNodes(nodes, container) {
  nodes.forEach(function(node) {
    const li = document.createElement('li');
    li.className = 'notes-tree-item';
    const row = document.createElement('div');
    row.className = 'notes-list-item' + (node.id === activeNoteId ? ' active' : '');
    row.style.paddingLeft = (12 + node.depth * 16) + 'px';
    row.dataset.id = node.id;
    const tags = (node.tags || []).slice(0, 2).map(function(t) {
      return '<span class="notes-tag-chip">' + escapeHtml(t) + '</span>';
    }).join('');
    row.innerHTML = '<div class="notes-list-title">' + escapeHtml(node.title || '无标题') + '</div>'
      + (tags ? '<div class="notes-list-tags">' + tags + '</div>' : '')
      + '<div class="notes-list-meta">' + formatTime(node.updatedAt) + '</div>';
    row.addEventListener('click', function() { openNote(node.id); });
    li.appendChild(row);
    container.appendChild(li);
    if (node.children && node.children.length) renderTreeNodes(node.children, container);
  });
}

function renderNoteList() {
  const list = $('note-list');
  list.innerHTML = '';

  if (searchResults) {
    if (!searchResults.length) {
      list.innerHTML = '<li class="notes-list-meta" style="padding:12px">无匹配笔记</li>';
      return;
    }
    searchResults.forEach(function(note) {
      const li = document.createElement('li');
      li.className = 'notes-list-item' + (note.id === activeNoteId ? ' active' : '');
      li.dataset.id = note.id;
      li.innerHTML = '<div class="notes-list-title">' + escapeHtml(note.title || '无标题') + '</div>'
        + (note.snippet ? '<div class="notes-list-snippet">' + escapeHtml(note.snippet) + '</div>' : '')
        + '<div class="notes-list-meta">' + formatTime(note.updatedAt) + '</div>';
      li.addEventListener('click', function() { openNote(note.id); });
      list.appendChild(li);
    });
    return;
  }

  if (!noteTree.length) {
    list.innerHTML = '<li class="notes-list-meta" style="padding:12px">暂无笔记</li>';
    return;
  }
  renderTreeNodes(noteTree, list);
}

function showEditor(show) {
  $('notes-empty').classList.toggle('hidden', show);
  $('notes-editor-wrap').classList.toggle('hidden', !show);
}

function destroyEditor() {
  if (editor) {
    editor.destroy();
    editor = null;
  }
}

function updateToolbarState() {
  if (!editor) return;
  document.querySelectorAll('.notes-tool[data-cmd]').forEach(function(btn) {
    const cmd = btn.dataset.cmd;
    let active = false;
    if (cmd === 'bold') active = editor.isActive('bold');
    else if (cmd === 'italic') active = editor.isActive('italic');
    else if (cmd === 'strike') active = editor.isActive('strike');
    else if (cmd === 'code') active = editor.isActive('code');
    else if (cmd === 'h1') active = editor.isActive('heading', { level: 1 });
    else if (cmd === 'h2') active = editor.isActive('heading', { level: 2 });
    else if (cmd === 'h3') active = editor.isActive('heading', { level: 3 });
    else if (cmd === 'bulletList') active = editor.isActive('bulletList');
    else if (cmd === 'orderedList') active = editor.isActive('orderedList');
    else if (cmd === 'blockquote') active = editor.isActive('blockquote');
    else if (cmd === 'codeBlock') active = editor.isActive('codeBlock');
    btn.classList.toggle('is-active', active);
  });
}

function initEditor(content) {
  destroyEditor();
  editor = new Editor({
    element: $('note-editor'),
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Placeholder.configure({
        placeholder: '块级编辑：段落、标题、列表… 用 🔗 插入块引用 [[标题|id]]'
      }),
      NoteReference
    ],
    content: content || { type: 'doc', content: [{ type: 'paragraph' }] },
    onUpdate: function() {
      if (suppressEditorUpdate) return;
      markDirty();
      updateToolbarState();
    },
    onSelectionUpdate: updateToolbarState
  });

  $('note-editor').onclick = function(e) {
    const ref = e.target.closest('[data-note-ref]');
    if (!ref) return;
    e.preventDefault();
    const id = ref.getAttribute('data-note-ref');
    if (id) openNote(id);
  };

  updateToolbarState();
}

function renderBreadcrumb(note) {
  const nav = $('note-breadcrumb');
  const chain = [];
  let cur = note;
  while (cur) {
    chain.unshift(cur);
    cur = cur.parentId ? noteById(cur.parentId) : null;
  }
  if (chain.length <= 1) {
    nav.classList.add('hidden');
    nav.innerHTML = '';
    return;
  }
  nav.classList.remove('hidden');
  nav.innerHTML = chain.map(function(item, i) {
    if (i === chain.length - 1) return '<span>' + escapeHtml(item.title) + '</span>';
    return '<button type="button" class="notes-crumb" data-id="' + item.id + '">' + escapeHtml(item.title) + '</button><span class="notes-crumb-sep">/</span>';
  }).join('');
  nav.querySelectorAll('.notes-crumb').forEach(function(btn) {
    btn.addEventListener('click', function() { openNote(btn.dataset.id); });
  });
}

async function loadBacklinks(noteId) {
  const panel = $('backlinks-panel');
  const list = $('backlinks-list');
  const data = await api('notes/' + noteId + '/backlinks');
  const links = data.backlinks || [];
  if (!links.length) {
    panel.classList.add('hidden');
    list.innerHTML = '';
    return;
  }
  panel.classList.remove('hidden');
  list.innerHTML = '';
  links.forEach(function(item) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'notes-backlink-item';
    btn.textContent = item.title || '无标题';
    btn.addEventListener('click', function() { openNote(item.id); });
    li.appendChild(btn);
    list.appendChild(li);
  });
}

async function openNote(noteId) {
  if (dirty && activeNoteId && activeNoteId !== noteId) {
    await saveCurrentNote(true);
  }
  activeNoteId = noteId;
  renderNoteList();
  showEditor(true);

  const data = await api('notes/' + noteId);
  const note = data.note;
  const summary = noteSummaryFromFull(note);
  const idx = notes.findIndex(function(n) { return n.id === note.id; });
  if (idx >= 0) notes[idx] = summary;
  else notes.push(summary);

  $('note-title').value = note.title || '';
  $('note-tags').value = (note.tags || []).join(', ');
  renderBreadcrumb(summary);
  suppressEditorUpdate = true;
  initEditor(note.content);
  suppressEditorUpdate = false;
  dirty = false;
  setSaveStatus('已加载 · ' + formatTime(note.updatedAt));
  loadBacklinks(noteId).catch(function() {});
}

function noteSummaryFromFull(note) {
  return {
    id: note.id,
    notebookId: note.notebookId,
    parentId: note.parentId || null,
    title: note.title,
    tags: note.tags || [],
    createdAt: note.createdAt,
    updatedAt: note.updatedAt
  };
}

async function saveCurrentNote(silent) {
  if (!activeNoteId || !editor || saving) return;
  saving = true;
  setSaveStatus('保存中…');
  try {
    const title = $('note-title').value.trim() || '无标题';
    const tags = parseTagsInput($('note-tags').value);
    const content = editor.getJSON();
    const data = await api('notes/' + activeNoteId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, tags, content })
    });
    const note = noteSummaryFromFull(data.note);
    const idx = notes.findIndex(function(n) { return n.id === note.id; });
    if (idx >= 0) notes[idx] = note;
    else notes.unshift(note);
    dirty = false;
    await refreshTree();
    await refreshTags();
    renderNoteList();
    renderBreadcrumb(note);
    setSaveStatus('已保存 · ' + formatTime(note.updatedAt));
    if (!silent) toastOk('笔记已保存');
  } catch (err) {
    setSaveStatus('保存失败');
    toastErr(err.message);
  } finally {
    saving = false;
  }
}

async function createNote(parentId) {
  if (!activeNotebookId) return;
  if (dirty && activeNoteId) await saveCurrentNote(true);
  const data = await api('notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      notebookId: activeNotebookId,
      parentId: parentId || null,
      title: parentId ? '无标题子页面' : '无标题'
    })
  });
  const summary = noteSummaryFromFull(data.note);
  notes.unshift(summary);
  await refreshTree();
  renderNoteList();
  await openNote(data.note.id);
  toastOk(parentId ? '已创建子页面' : '已创建笔记');
  $('note-title').focus();
  $('note-title').select();
}

async function deleteActiveNote() {
  if (!activeNoteId) return;
  if (!window.confirm('确定删除这篇笔记及其全部子页面？')) return;
  await api('notes/' + activeNoteId, { method: 'DELETE' });
  activeNoteId = '';
  destroyEditor();
  showEditor(false);
  await loadBootstrap();
  toastOk('笔记已删除');
}

async function duplicateActiveNote() {
  if (!activeNoteId) return;
  if (dirty) await saveCurrentNote(true);
  const data = await api('notes/' + activeNoteId + '/duplicate', { method: 'POST' });
  notes.unshift(noteSummaryFromFull(data.note));
  await refreshTree();
  renderNoteList();
  await openNote(data.note.id);
  toastOk('已复制笔记');
}

async function exportMarkdown() {
  if (!activeNoteId) return;
  if (dirty) await saveCurrentNote(true);
  window.location.href = './api/notes/' + activeNoteId + '/export.md';
  toastOk('正在导出 Markdown');
}

async function importMarkdownFile(file) {
  if (!file || !activeNotebookId) return;
  const text = await file.text();
  const data = await api('notes/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      notebookId: activeNotebookId,
      parentId: activeNoteId || null,
      markdown: text,
      title: file.name.replace(/\.(md|markdown|txt)$/i, '')
    })
  });
  notes.unshift(noteSummaryFromFull(data.note));
  await refreshTree();
  await refreshTags();
  searchResults = null;
  renderNoteList();
  await openNote(data.note.id);
  toastOk('Markdown 已导入');
}

function pickNoteForReference() {
  const candidates = notes.filter(function(n) {
    return n.notebookId === activeNotebookId && n.id !== activeNoteId;
  });
  if (!candidates.length) {
    toastErr('当前笔记本没有其他笔记可引用');
    return;
  }
  const lines = candidates.slice(0, 30).map(function(n, i) {
    return (i + 1) + '. ' + (n.title || '无标题');
  }).join('\n');
  const input = window.prompt('输入序号插入块引用：\n' + lines, '1');
  if (input == null) return;
  const idx = Number(input) - 1;
  const picked = candidates[idx];
  if (!picked) {
    toastErr('无效序号');
    return;
  }
  insertNoteReference(editor, picked.id, picked.title);
  markDirty();
}

async function addNotebook() {
  const title = window.prompt('笔记本名称', '新笔记本');
  if (title == null) return;
  const data = await api('notebooks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title.trim() || '新笔记本' })
  });
  notebooks.push(data.notebook);
  activeNotebookId = data.notebook.id;
  await refreshTree();
  renderNotebooks();
  renderNoteList();
  toastOk('笔记本已创建');
}

async function renameNotebook() {
  const nb = notebooks.find(function(n) { return n.id === activeNotebookId; });
  if (!nb) return;
  const title = window.prompt('笔记本名称', nb.title);
  if (title == null || !title.trim()) return;
  const data = await api('notebooks/' + nb.id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title.trim() })
  });
  nb.title = data.notebook.title;
  renderNotebooks();
  toastOk('笔记本已重命名');
}

async function deleteNotebook() {
  if (!activeNotebookId) return;
  if (!window.confirm('删除笔记本及其全部笔记？')) return;
  await api('notebooks/' + activeNotebookId, { method: 'DELETE' });
  const removedId = activeNotebookId;
  notebooks = notebooks.filter(function(n) { return n.id !== removedId; });
  notes = notes.filter(function(n) { return n.notebookId !== removedId; });
  activeNotebookId = notebooks[0]?.id || '';
  activeNoteId = '';
  destroyEditor();
  showEditor(false);
  await refreshTree();
  renderNotebooks();
  renderNoteList();
  toastOk('笔记本已删除');
}

function runToolbarCmd(cmd) {
  if (!editor) return;
  const chain = editor.chain().focus();
  if (cmd === 'bold') chain.toggleBold().run();
  else if (cmd === 'italic') chain.toggleItalic().run();
  else if (cmd === 'strike') chain.toggleStrike().run();
  else if (cmd === 'code') chain.toggleCode().run();
  else if (cmd === 'h1') chain.toggleHeading({ level: 1 }).run();
  else if (cmd === 'h2') chain.toggleHeading({ level: 2 }).run();
  else if (cmd === 'h3') chain.toggleHeading({ level: 3 }).run();
  else if (cmd === 'bulletList') chain.toggleBulletList().run();
  else if (cmd === 'orderedList') chain.toggleOrderedList().run();
  else if (cmd === 'blockquote') chain.toggleBlockquote().run();
  else if (cmd === 'codeBlock') chain.toggleCodeBlock().run();
  else if (cmd === 'hr') chain.setHorizontalRule().run();
  else if (cmd === 'undo') chain.undo().run();
  else if (cmd === 'redo') chain.redo().run();
  updateToolbarState();
}

$('notebook-select').addEventListener('change', async function() {
  if (dirty && activeNoteId) await saveCurrentNote(true);
  activeNotebookId = this.value;
  activeNoteId = '';
  searchResults = null;
  $('note-search').value = '';
  $('tag-filter').value = '';
  destroyEditor();
  showEditor(false);
  await refreshTree();
  await refreshTags();
  renderNoteList();
});

$('note-search').addEventListener('input', function() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 300);
});

$('tag-filter').addEventListener('change', runSearch);
$('note-title').addEventListener('input', markDirty);
$('note-tags').addEventListener('input', markDirty);
$('btn-note-add').addEventListener('click', function() { createNote(null); });
$('btn-subpage').addEventListener('click', function() {
  if (!activeNoteId) return;
  createNote(activeNoteId);
});
$('btn-notebook-add').addEventListener('click', addNotebook);
$('btn-notebook-rename').addEventListener('click', renameNotebook);
$('btn-notebook-delete').addEventListener('click', deleteNotebook);
$('btn-note-delete').addEventListener('click', deleteActiveNote);
$('btn-note-duplicate').addEventListener('click', duplicateActiveNote);
$('btn-export-md').addEventListener('click', exportMarkdown);
$('btn-insert-ref').addEventListener('click', pickNoteForReference);
$('btn-import-md').addEventListener('click', function() { $('import-file').click(); });
$('import-file').addEventListener('change', function(e) {
  const file = e.target.files?.[0];
  if (file) importMarkdownFile(file);
  e.target.value = '';
});

$('notes-toolbar').addEventListener('click', function(e) {
  const btn = e.target.closest('[data-cmd]');
  if (!btn) return;
  e.preventDefault();
  runToolbarCmd(btn.dataset.cmd);
});

document.addEventListener('keydown', function(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveCurrentNote(false);
  }
});

window.addEventListener('beforeunload', function(e) {
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

loadBootstrap().catch(function(err) {
  toastErr(err.message);
});
