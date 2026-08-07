import { Editor } from 'https://esm.sh/@tiptap/core@2.11.5';
import StarterKit from 'https://esm.sh/@tiptap/starter-kit@2.11.5';
import Placeholder from 'https://esm.sh/@tiptap/extension-placeholder@2.11.5';
import { NoteReference, insertNoteReference } from './note-link.js';
import { createDropdown } from './dropdown.js';
import { blockExtensions, setupBlockEditor, openNotePicker } from './blocks.js';
import { openContextMenu } from './context-menu.js';

const $ = (id) => document.getElementById(id);

const toastOk = (msg) => window.portalToast?.success(msg) ?? null;
const toastErr = (msg) => window.portalToast?.error(msg) ?? window.alert(msg);

async function dlgConfirm(message, opts) {
  if (window.portalDialog?.confirm) return window.portalDialog.confirm(message, opts);
  return window.confirm(message);
}

async function dlgPrompt(message, defaultValue, opts) {
  if (window.portalDialog?.prompt) return window.portalDialog.prompt(message, defaultValue, opts);
  return window.prompt(message, defaultValue);
}

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
let sidebarStats = { noteCount: 0, tagCount: 0, totalWords: 0 };
let treeSort = localStorage.getItem('notes-tree-sort') || 'updated';
let collapsedIds = new Set();
let notebookDropdown = null;
let tagFilterDropdown = null;
let treeSortDropdown = null;
let blockEditorCleanup = null;
let noteTags = [];
let sidebarCollapsed = localStorage.getItem('notes-sidebar-collapsed') === '1';

function collapsedStorageKey() {
  return 'notes-collapsed-' + (activeNotebookId || 'default');
}

function loadCollapsed() {
  try {
    collapsedIds = new Set(JSON.parse(localStorage.getItem(collapsedStorageKey()) || '[]'));
  } catch {
    collapsedIds = new Set();
  }
}

function saveCollapsed() {
  try {
    localStorage.setItem(collapsedStorageKey(), JSON.stringify([...collapsedIds]));
  } catch { /* ignore */ }
}

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

function formatRelative(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + ' 分钟前';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + ' 小时前';
  const day = Math.floor(hr / 24);
  if (day === 1) return '昨天';
  if (day < 7) return day + ' 天前';
  return formatTime(iso);
}

function renderSidebarStats() {
  const el = $('sidebar-stats');
  if (!el) return;
  const s = sidebarStats;
  el.textContent = s.noteCount + ' 篇 · ' + s.tagCount + ' 标签 · ' + s.totalWords.toLocaleString() + ' 字';
}

function noteIcon(node) {
  if (node.hasChildren) return '📁';
  if ((node.tags || []).length) return '🏷';
  return '📄';
}

function buildStatBadges(node) {
  const parts = [];
  if (node.wordCount > 0) parts.push('<span class="notes-stat-badge">' + node.wordCount + ' 字</span>');
  if (node.childCount > 0) {
    parts.push('<span class="notes-stat-badge">' + node.childCount + ' 子页</span>');
  }
  if (node.backlinkCount > 0) {
    parts.push('<span class="notes-stat-badge">' + node.backlinkCount + ' 反链</span>');
  }
  return parts.join('');
}

function buildNoteItemHtml(node, opts) {
  opts = opts || {};
  const isActive = node.id === activeNoteId;
  const isDirty = isActive && dirty;
  const tags = (node.tags || []).slice(0, 3).map(function(t) {
    return '<span class="notes-tag-chip">' + escapeHtml(t) + '</span>';
  }).join('');
  const preview = opts.snippet || node.preview || node.snippet || '';
  const stats = buildStatBadges(node);
  return ''
    + '<div class="notes-list-item-head">'
    + '<span class="notes-list-icon">' + noteIcon(node) + '</span>'
    + '<div class="notes-list-title">' + escapeHtml(node.title || '无标题') + '</div>'
    + (isDirty ? '<span class="notes-list-dot" title="未保存"></span>' : '')
    + '</div>'
    + (preview ? '<div class="notes-list-preview">' + escapeHtml(preview) + '</div>' : '')
    + (tags ? '<div class="notes-list-tags">' + tags + '</div>' : '')
    + (stats ? '<div class="notes-list-stats">' + stats + '</div>' : '')
    + '<div class="notes-list-meta">' + formatRelative(node.updatedAt) + '</div>';
}

function setSaveStatus(text) {
  $('save-status').textContent = text;
}

function markDirty() {
  dirty = true;
  setSaveStatus('编辑中…');
  renderNoteList();
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

function applySidebarCollapsed() {
  const app = $('notes-app');
  const expandBtn = $('btn-sidebar-expand');
  if (!app) return;
  app.classList.toggle('notes-sidebar-collapsed', sidebarCollapsed);
  expandBtn?.classList.toggle('hidden', !sidebarCollapsed);
}

function setSidebarCollapsed(collapsed) {
  sidebarCollapsed = collapsed;
  localStorage.setItem('notes-sidebar-collapsed', collapsed ? '1' : '0');
  applySidebarCollapsed();
}

function noteMenuItems(noteId) {
  return [
    { id: 'open', label: '打开', icon: '📄' },
    { id: 'subpage', label: '新建子页面', icon: '📁' },
    { id: 'duplicate', label: '复制', icon: '⎘' },
    { id: 'export', label: '导出 Markdown', icon: '↓' },
    { divider: true },
    { id: 'delete', label: '删除', icon: '🗑', danger: true }
  ];
}

async function runNoteMenuAction(action, noteId) {
  if (action === 'open') {
    await openNote(noteId);
    return;
  }
  if (action === 'subpage') {
    if (activeNoteId !== noteId) await openNote(noteId);
    await createNote(noteId);
    return;
  }
  if (action === 'duplicate') {
    if (activeNoteId !== noteId) await openNote(noteId);
    await duplicateActiveNote();
    return;
  }
  if (action === 'export') {
    if (activeNoteId !== noteId) await openNote(noteId);
    await exportMarkdown();
    return;
  }
  if (action === 'delete') {
    if (activeNoteId !== noteId) await openNote(noteId);
    await deleteActiveNote();
  }
}

function showNoteContextMenu(noteId, anchorOrEvent) {
  const items = noteMenuItems(noteId);
  const opts = {
    items: items,
    onSelect: function(id) { runNoteMenuAction(id, noteId); }
  };
  if (anchorOrEvent instanceof HTMLElement) {
    opts.anchor = anchorOrEvent;
  } else if (anchorOrEvent && anchorOrEvent.clientX != null) {
    opts.x = anchorOrEvent.clientX;
    opts.y = anchorOrEvent.clientY;
  }
  openContextMenu(opts);
}

function showPageMenu(anchorOrEvent) {
  if (!activeNoteId) return;
  const opts = {
    items: [
      { id: 'subpage', label: '新建子页面', icon: '📁' },
      { id: 'duplicate', label: '复制', icon: '⎘' },
      { id: 'export', label: '导出 Markdown', icon: '↓' },
      { divider: true },
      { id: 'delete', label: '删除', icon: '🗑', danger: true }
    ],
    onSelect: function(id) { runNoteMenuAction(id, activeNoteId); }
  };
  if (anchorOrEvent instanceof HTMLElement && anchorOrEvent.clientX == null) {
    opts.anchor = anchorOrEvent;
  } else if (anchorOrEvent && anchorOrEvent.clientX != null) {
    opts.x = anchorOrEvent.clientX;
    opts.y = anchorOrEvent.clientY;
  }
  openContextMenu(opts);
}

function showNotebookMenu(anchor) {
  openContextMenu({
    anchor: anchor,
    items: [
      { id: 'add', label: '新建笔记本', icon: '+' },
      { id: 'rename', label: '重命名', icon: '✎' },
      { divider: true },
      { id: 'delete', label: '删除笔记本', icon: '🗑', danger: true }
    ],
    onSelect: function(id) {
      if (id === 'add') addNotebook();
      else if (id === 'rename') renameNotebook();
      else if (id === 'delete') deleteNotebook();
    }
  });
}

function attachNoteItemInteractions(item, noteId) {
  item.addEventListener('click', function(e) {
    if (e.target.closest('.notes-item-more')) return;
    openNote(noteId);
  });
  item.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    e.stopPropagation();
    showNoteContextMenu(noteId, e);
  });
  const moreBtn = item.querySelector('.notes-item-more');
  if (moreBtn) {
    moreBtn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      showNoteContextMenu(noteId, moreBtn);
    });
  }
}

function parseTagsInput(raw) {
  return String(raw || '').split(/[,，\s]+/).map(function(t) { return t.trim(); }).filter(Boolean);
}

function renderTagChips() {
  const wrap = $('note-tags-chips');
  if (!wrap) return;
  wrap.innerHTML = noteTags.map(function(tag, i) {
    return '<span class="notes-tag-pill">' + escapeHtml(tag)
      + '<button type="button" class="notes-tag-remove" data-idx="' + i + '" title="移除">×</button></span>';
  }).join('');
  wrap.querySelectorAll('.notes-tag-remove').forEach(function(btn) {
    btn.addEventListener('click', function() {
      noteTags.splice(Number(btn.dataset.idx), 1);
      renderTagChips();
      markDirty();
    });
  });
}

function setNoteTags(tags) {
  noteTags = (tags || []).slice();
  renderTagChips();
}

function addTagFromInput(raw) {
  const tag = String(raw || '').trim().replace(/[,，]+$/, '');
  if (!tag) return;
  if (!noteTags.includes(tag)) {
    noteTags.push(tag);
    renderTagChips();
    markDirty();
  }
}

function initDropdowns() {
  notebookDropdown = createDropdown($('notebook-dropdown'), {
    placeholder: '选择笔记本',
    onChange: function(val) { onNotebookChange(val); }
  });
  tagFilterDropdown = createDropdown($('tag-filter-dropdown'), {
    placeholder: '全部标签',
    compact: true,
    onChange: function() { runSearch(); }
  });
  treeSortDropdown = createDropdown($('tree-sort-dropdown'), {
    value: treeSort,
    compact: true,
    items: [
      { value: 'updated', label: '最近更新' },
      { value: 'title', label: '按标题' }
    ],
    onChange: function(val) { onTreeSortChange(val); }
  });
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
  renderSidebarStats();
  renderNoteList();
}

async function refreshTree() {
  if (!activeNotebookId) {
    noteTree = [];
    sidebarStats = { noteCount: 0, tagCount: 0, totalWords: 0 };
    return;
  }
  loadCollapsed();
  const data = await api('notes/tree?notebookId=' + encodeURIComponent(activeNotebookId)
    + '&sort=' + encodeURIComponent(treeSort));
  noteTree = data.tree || [];
  sidebarStats = data.stats || { noteCount: 0, tagCount: 0, totalWords: 0 };
}

function renderNotebooks() {
  if (!notebookDropdown) return;
  notebookDropdown.setItems(notebooks.map(function(nb) {
    return { value: nb.id, label: nb.title, icon: '📓' };
  }));
  notebookDropdown.setValue(activeNotebookId);
}

async function refreshTags() {
  const data = await api('tags?notebookId=' + encodeURIComponent(activeNotebookId || ''));
  allTags = data.tags || [];
  renderTagFilter();
}

function renderTagFilter() {
  if (!tagFilterDropdown) return;
  const current = tagFilterDropdown.getValue();
  tagFilterDropdown.setItems([
    { value: '', label: '全部标签', icon: '🏷' }
  ].concat(allTags.map(function(item) {
    return { value: item.tag, label: item.tag, hint: item.count + ' 篇', icon: '◆' };
  })));
  const values = [''].concat(allTags.map(function(t) { return t.tag; }));
  tagFilterDropdown.setValue(values.includes(current) ? current : '');
}

function isFiltering() {
  return $('note-search').value.trim() || tagFilterDropdown?.getValue();
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
  const tag = tagFilterDropdown?.getValue() || '';
  if (q) params.set('q', q);
  if (tag) params.set('tag', tag);
  const data = await api('search?' + params.toString());
  searchResults = data.notes || [];
  renderNoteList();
}

function expandAncestors(noteId) {
  let cur = noteById(noteId);
  while (cur && cur.parentId) {
    collapsedIds.delete(cur.parentId);
    cur = noteById(cur.parentId);
  }
  saveCollapsed();
}

function renderTreeBranch(node, container) {
  const li = document.createElement('li');
  li.className = 'notes-tree-branch';
  li.dataset.id = node.id;

  const row = document.createElement('div');
  row.className = 'notes-tree-row';

  const hasKids = node.children && node.children.length;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'notes-tree-toggle' + (hasKids ? '' : ' placeholder');
  if (hasKids) {
    const expanded = !collapsedIds.has(node.id);
    toggle.classList.toggle('expanded', expanded);
    toggle.textContent = '▸';
    toggle.title = expanded ? '折叠' : '展开';
    toggle.addEventListener('click', function(e) {
      e.stopPropagation();
      if (collapsedIds.has(node.id)) collapsedIds.delete(node.id);
      else collapsedIds.add(node.id);
      saveCollapsed();
      renderNoteList();
    });
  }

  const item = document.createElement('div');
  item.className = 'notes-list-item' + (node.id === activeNoteId ? ' active' : '');
  item.dataset.id = node.id;
  item.innerHTML = '<div class="notes-list-item-body">' + buildNoteItemHtml(node) + '</div>'
    + '<button type="button" class="notes-item-more" title="更多">⋯</button>';
  attachNoteItemInteractions(item, node.id);

  row.appendChild(toggle);
  row.appendChild(item);
  li.appendChild(row);

  if (hasKids) {
    const childUl = document.createElement('ul');
    childUl.className = 'notes-tree-children';
    if (collapsedIds.has(node.id)) childUl.classList.add('collapsed');
    node.children.forEach(function(child) { renderTreeBranch(child, childUl); });
    li.appendChild(childUl);
  }

  container.appendChild(li);
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
      li.className = 'notes-tree-branch';
      const row = document.createElement('div');
      row.className = 'notes-tree-row';
      const spacer = document.createElement('button');
      spacer.type = 'button';
      spacer.className = 'notes-tree-toggle placeholder';
      spacer.tabIndex = -1;
      const item = document.createElement('div');
      item.className = 'notes-list-item' + (note.id === activeNoteId ? ' active' : '');
      item.innerHTML = '<div class="notes-list-item-body">' + buildNoteItemHtml(note, { snippet: note.snippet }) + '</div>'
        + '<button type="button" class="notes-item-more" title="更多">⋯</button>';
      attachNoteItemInteractions(item, note.id);
      row.appendChild(spacer);
      row.appendChild(item);
      li.appendChild(row);
      list.appendChild(li);
    });
    return;
  }

  if (!noteTree.length) {
    list.innerHTML = '<li class="notes-list-meta" style="padding:12px">暂无笔记，点击「新建」开始</li>';
    return;
  }
  noteTree.forEach(function(node) { renderTreeBranch(node, list); });
}

function showEditor(show) {
  $('notes-empty').classList.toggle('hidden', show);
  $('notes-editor-wrap').classList.toggle('hidden', !show);
}

function destroyEditor() {
  if (blockEditorCleanup) {
    blockEditorCleanup();
    blockEditorCleanup = null;
  }
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
    else if (cmd === 'taskList') active = editor.isActive('taskList');
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
        placeholder: function({ node }) {
          if (node.type.name === 'heading') return '标题';
          return '输入 / 块命令，@ 提及笔记…';
        }
      }),
      NoteReference,
      ...blockExtensions()
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

  blockEditorCleanup = setupBlockEditor(editor, {
    shell: $('note-editor-shell'),
    onNoteRef: pickNoteForReference,
    getNotes: function() {
      return notes.filter(function(n) {
        return n.notebookId === activeNotebookId && n.id !== activeNoteId;
      });
    },
    insertNoteReference: insertNoteReference
  });

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
  expandAncestors(noteId);
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
  setNoteTags(note.tags || []);
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
    const tags = noteTags.slice();
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
    renderSidebarStats();
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
  if (!await dlgConfirm('确定删除这篇笔记及其全部子页面？', { title: '删除笔记', danger: true, okText: '删除' })) return;
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
  openNotePicker($('note-editor-shell'), candidates, activeNoteId, function(picked) {
    insertNoteReference(editor, picked.id, picked.title);
    markDirty();
  });
}

async function addNotebook() {
  const title = await dlgPrompt('输入笔记本名称', '新笔记本', { title: '新建笔记本' });
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
  const title = await dlgPrompt('输入笔记本名称', nb.title, { title: '重命名笔记本' });
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
  if (!await dlgConfirm('删除笔记本及其全部笔记？', { title: '删除笔记本', danger: true, okText: '删除' })) return;
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
  else if (cmd === 'taskList') chain.toggleTaskList().run();
  else if (cmd === 'blockquote') chain.toggleBlockquote().run();
  else if (cmd === 'codeBlock') chain.toggleCodeBlock().run();
  else if (cmd === 'hr') chain.setHorizontalRule().run();
  else if (cmd === 'undo') chain.undo().run();
  else if (cmd === 'redo') chain.redo().run();
  updateToolbarState();
}

async function onNotebookChange(val) {
  if (val === activeNotebookId) return;
  if (dirty && activeNoteId) await saveCurrentNote(true);
  activeNotebookId = val;
  activeNoteId = '';
  searchResults = null;
  $('note-search').value = '';
  tagFilterDropdown?.setValue('');
  destroyEditor();
  showEditor(false);
  await refreshTree();
  await refreshTags();
  renderSidebarStats();
  renderNoteList();
}

async function onTreeSortChange(val) {
  treeSort = val;
  localStorage.setItem('notes-tree-sort', treeSort);
  await refreshTree();
  renderSidebarStats();
  renderNoteList();
}

$('note-search').addEventListener('input', function() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 300);
});

$('note-tags-input')?.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    addTagFromInput(this.value);
    this.value = '';
  } else if (e.key === 'Backspace' && !this.value && noteTags.length) {
    noteTags.pop();
    renderTagChips();
    markDirty();
  }
});

$('note-tags-input')?.addEventListener('blur', function() {
  if (this.value.trim()) {
    addTagFromInput(this.value);
    this.value = '';
  }
});

$('note-title').addEventListener('input', markDirty);

$('btn-tree-expand').addEventListener('click', function() {
  collapsedIds.clear();
  saveCollapsed();
  renderNoteList();
});

$('btn-tree-collapse').addEventListener('click', function() {
  function collectIds(nodes) {
    nodes.forEach(function(n) {
      if (n.children && n.children.length) {
        collapsedIds.add(n.id);
        collectIds(n.children);
      }
    });
  }
  collectIds(noteTree);
  saveCollapsed();
  renderNoteList();
});

$('btn-note-add').addEventListener('click', function() { createNote(null); });
$('btn-empty-new')?.addEventListener('click', function() { createNote(null); });
$('btn-notebook-add').addEventListener('click', addNotebook);
$('btn-notebook-menu')?.addEventListener('click', function(e) {
  showNotebookMenu(e.currentTarget);
});
$('btn-page-menu')?.addEventListener('click', function(e) {
  showPageMenu(e.currentTarget);
});
$('notes-page-header')?.addEventListener('contextmenu', function(e) {
  if (!activeNoteId) return;
  if (e.target.closest('input, button, .notes-tag-pill')) return;
  e.preventDefault();
  showPageMenu(e);
});
$('btn-sidebar-collapse')?.addEventListener('click', function() {
  setSidebarCollapsed(true);
});
$('btn-sidebar-expand')?.addEventListener('click', function() {
  setSidebarCollapsed(false);
});
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

initDropdowns();
applySidebarCollapsed();
loadBootstrap().catch(function(err) {
  toastErr(err.message);
});
