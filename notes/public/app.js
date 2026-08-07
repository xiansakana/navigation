import { Editor } from 'https://esm.sh/@tiptap/core@2.11.5';
import StarterKit from 'https://esm.sh/@tiptap/starter-kit@2.11.5';
import Placeholder from 'https://esm.sh/@tiptap/extension-placeholder@2.11.5';

const $ = (id) => document.getElementById(id);

const toastOk = (msg) => window.portalToast?.success(msg) ?? null;
const toastErr = (msg) => window.portalToast?.error(msg) ?? window.alert(msg);

let notebooks = [];
let notes = [];
let activeNotebookId = '';
let activeNoteId = '';
let editor = null;
let saveTimer = null;
let saving = false;
let dirty = false;
let suppressEditorUpdate = false;

async function api(path, options) {
  const resp = await fetch('./api/' + path, options || {});
  const data = await resp.json();
  if (!resp.ok || data.ok === false) throw new Error(data.error || resp.statusText);
  return data;
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
  saveTimer = setTimeout(saveCurrentNote, 800);
}

async function loadBootstrap() {
  const data = await api('bootstrap');
  notebooks = data.notebooks || [];
  notes = data.notes || [];
  if (!activeNotebookId && notebooks.length) {
    activeNotebookId = notebooks[0].id;
  }
  renderNotebooks();
  renderNoteList();
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

function filteredNotes() {
  const q = $('note-search').value.trim().toLowerCase();
  return notes
    .filter(function(note) { return note.notebookId === activeNotebookId; })
    .filter(function(note) {
      if (!q) return true;
      return String(note.title || '').toLowerCase().includes(q);
    })
    .sort(function(a, b) {
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
}

function renderNoteList() {
  const list = $('note-list');
  list.innerHTML = '';
  const items = filteredNotes();
  if (!items.length) {
    list.innerHTML = '<li class="notes-list-meta" style="padding:12px">暂无笔记</li>';
    return;
  }
  items.forEach(function(note) {
    const li = document.createElement('li');
    li.className = 'notes-list-item' + (note.id === activeNoteId ? ' active' : '');
    li.dataset.id = note.id;
    li.innerHTML = '<div class="notes-list-title">' + escapeHtml(note.title || '无标题') + '</div>'
      + '<div class="notes-list-meta">' + formatTime(note.updatedAt) + '</div>';
    li.addEventListener('click', function() { openNote(note.id); });
    list.appendChild(li);
  });
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
      StarterKit.configure({
        heading: { levels: [1, 2, 3] }
      }),
      Placeholder.configure({
        placeholder: '输入 / 或使用工具栏排版，每个段落即一个内容块…'
      })
    ],
    content: content || { type: 'doc', content: [{ type: 'paragraph' }] },
    onUpdate: function() {
      if (suppressEditorUpdate) return;
      markDirty();
      updateToolbarState();
    },
    onSelectionUpdate: updateToolbarState
  });
  updateToolbarState();
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
  $('note-title').value = note.title || '';
  suppressEditorUpdate = true;
  initEditor(note.content);
  suppressEditorUpdate = false;
  dirty = false;
  setSaveStatus('已加载 · ' + formatTime(note.updatedAt));
}

async function saveCurrentNote(silent) {
  if (!activeNoteId || !editor || saving) return;
  saving = true;
  setSaveStatus('保存中…');
  try {
    const title = $('note-title').value.trim() || '无标题';
    const content = editor.getJSON();
    const data = await api('notes/' + activeNoteId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content })
    });
    const note = data.note;
    const idx = notes.findIndex(function(n) { return n.id === note.id; });
    const summary = {
      id: note.id,
      notebookId: note.notebookId,
      title: note.title,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt
    };
    if (idx >= 0) notes[idx] = summary;
    else notes.unshift(summary);
    dirty = false;
    renderNoteList();
    setSaveStatus('已保存 · ' + formatTime(note.updatedAt));
    if (!silent) toastOk('笔记已保存');
  } catch (err) {
    setSaveStatus('保存失败');
    toastErr(err.message);
  } finally {
    saving = false;
  }
}

async function createNote() {
  if (!activeNotebookId) return;
  if (dirty && activeNoteId) await saveCurrentNote(true);
  const data = await api('notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notebookId: activeNotebookId, title: '无标题' })
  });
  notes.unshift({
    id: data.note.id,
    notebookId: data.note.notebookId,
    title: data.note.title,
    createdAt: data.note.createdAt,
    updatedAt: data.note.updatedAt
  });
  renderNoteList();
  await openNote(data.note.id);
  toastOk('已创建笔记');
  $('note-title').focus();
  $('note-title').select();
}

async function deleteActiveNote() {
  if (!activeNoteId) return;
  if (!window.confirm('确定删除这篇笔记？')) return;
  await api('notes/' + activeNoteId, { method: 'DELETE' });
  notes = notes.filter(function(n) { return n.id !== activeNoteId; });
  activeNoteId = '';
  destroyEditor();
  showEditor(false);
  renderNoteList();
  toastOk('笔记已删除');
}

async function duplicateActiveNote() {
  if (!activeNoteId) return;
  if (dirty) await saveCurrentNote(true);
  const data = await api('notes/' + activeNoteId + '/duplicate', { method: 'POST' });
  notes.unshift({
    id: data.note.id,
    notebookId: data.note.notebookId,
    title: data.note.title,
    createdAt: data.note.createdAt,
    updatedAt: data.note.updatedAt
  });
  renderNoteList();
  await openNote(data.note.id);
  toastOk('已复制笔记');
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
  destroyEditor();
  showEditor(false);
  renderNoteList();
});

$('note-search').addEventListener('input', renderNoteList);
$('note-title').addEventListener('input', markDirty);
$('btn-note-add').addEventListener('click', createNote);
$('btn-notebook-add').addEventListener('click', addNotebook);
$('btn-notebook-rename').addEventListener('click', renameNotebook);
$('btn-notebook-delete').addEventListener('click', deleteNotebook);
$('btn-note-delete').addEventListener('click', deleteActiveNote);
$('btn-note-duplicate').addEventListener('click', duplicateActiveNote);

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
