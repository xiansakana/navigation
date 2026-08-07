import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, createStore, resolveDataPath } from './storage.js';
import { normalizeNote, noteSummary, buildNoteTree, buildEnrichedContext, notebookStats, extractPlainText } from './notes-util.js';
import { getBacklinksForNote, enrichBacklinks } from './links.js';
import { searchNotes, collectTags } from './search.js';
import { tiptapToMarkdown, stripLeadingTitle, resolveRefsFromMarkdown } from './markdown.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const store = createStore(resolveDataPath(config));
const app = express();

if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.use(express.json({ limit: '8mb' }));
app.use(express.text({ limit: '8mb', type: ['text/markdown', 'text/plain'] }));

function nowIso() {
  return new Date().toISOString();
}

function findNotebook(data, id) {
  return data.notebooks.find(function(nb) { return nb.id === id; });
}

function findNote(data, id) {
  return data.notes.find(function(note) { return note.id === id; });
}

function sortNotebooks(notebooks) {
  return notebooks.slice().sort(function(a, b) {
    return (a.sort || 0) - (b.sort || 0) || String(a.title).localeCompare(String(b.title), 'zh-CN');
  });
}

function collectDescendantIds(notes, rootId) {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    notes.forEach(function(note) {
      if (note.parentId && ids.has(note.parentId) && !ids.has(note.id)) {
        ids.add(note.id);
        changed = true;
      }
    });
  }
  return ids;
}

function isValidParent(data, noteId, parentId) {
  if (!parentId) return true;
  if (parentId === noteId) return false;
  const descendants = collectDescendantIds(data.notes, noteId);
  return !descendants.has(parentId);
}

function parseTags(raw) {
  if (Array.isArray(raw)) {
    return [...new Set(raw.map(function(t) { return String(t).trim(); }).filter(Boolean))];
  }
  if (typeof raw === 'string') {
    return [...new Set(raw.split(/[,，\s]+/).map(function(t) { return t.trim(); }).filter(Boolean))];
  }
  return [];
}

function titleByIdMap(notes) {
  const map = {};
  notes.forEach(function(n) { map[n.id] = n.title; });
  return map;
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/bootstrap', (_req, res) => {
  const data = store.read();
  res.json({
    ok: true,
    notebooks: sortNotebooks(data.notebooks),
    notes: data.notes.map(noteSummary),
    tree: buildNoteTree(data.notes, data.notebooks[0]?.id || ''),
    tags: collectTags(data.notes, '')
  });
});

app.get('/api/search', (req, res) => {
  const data = store.read();
  res.json({
    ok: true,
    notes: searchNotes(data.notes, {
      q: req.query.q,
      tag: req.query.tag,
      notebookId: req.query.notebookId
    })
  });
});

app.get('/api/tags', (req, res) => {
  const data = store.read();
  res.json({
    ok: true,
    tags: collectTags(data.notes, req.query.notebookId || '')
  });
});

app.get('/api/notebooks', (_req, res) => {
  const data = store.read();
  res.json({ ok: true, notebooks: sortNotebooks(data.notebooks) });
});

app.post('/api/notebooks', (req, res) => {
  const title = String(req.body?.title || '新笔记本').trim() || '新笔记本';
  const data = store.read();
  const ts = nowIso();
  const notebook = {
    id: crypto.randomUUID(),
    title,
    sort: data.notebooks.length,
    createdAt: ts,
    updatedAt: ts
  };
  data.notebooks.push(notebook);
  store.write(data);
  res.status(201).json({ ok: true, notebook });
});

app.patch('/api/notebooks/:id', (req, res) => {
  const data = store.read();
  const notebook = findNotebook(data, req.params.id);
  if (!notebook) return res.status(404).json({ ok: false, error: '笔记本不存在' });
  if (req.body?.title != null) notebook.title = String(req.body.title).trim() || notebook.title;
  if (req.body?.sort != null) notebook.sort = Number(req.body.sort) || 0;
  notebook.updatedAt = nowIso();
  store.write(data);
  res.json({ ok: true, notebook });
});

app.delete('/api/notebooks/:id', (req, res) => {
  const data = store.read();
  if (data.notebooks.length <= 1) {
    return res.status(400).json({ ok: false, error: '至少保留一个笔记本' });
  }
  const idx = data.notebooks.findIndex(function(nb) { return nb.id === req.params.id; });
  if (idx < 0) return res.status(404).json({ ok: false, error: '笔记本不存在' });
  data.notebooks.splice(idx, 1);
  data.notes = data.notes.filter(function(note) { return note.notebookId !== req.params.id; });
  store.write(data);
  res.json({ ok: true });
});

app.get('/api/notes/tree', (req, res) => {
  const data = store.read();
  const notebookId = req.query.notebookId;
  if (!notebookId) return res.status(400).json({ ok: false, error: '缺少 notebookId' });
  const sort = req.query.sort === 'title' ? 'title' : 'updated';
  const ctx = buildEnrichedContext(data.notes, notebookId);
  res.json({
    ok: true,
    tree: buildNoteTree(data.notes, notebookId, ctx, sort),
    stats: notebookStats(data.notes, notebookId)
  });
});

app.get('/api/notes', (req, res) => {
  const data = store.read();
  res.json({
    ok: true,
    notes: searchNotes(data.notes, {
      q: req.query.q,
      tag: req.query.tag,
      notebookId: req.query.notebookId
    })
  });
});

app.get('/api/notes/:id', (req, res) => {
  const data = store.read();
  const note = findNote(data, req.params.id);
  if (!note) return res.status(404).json({ ok: false, error: '笔记不存在' });
  res.json({ ok: true, note });
});

app.get('/api/notes/:id/backlinks', (req, res) => {
  const data = store.read();
  const note = findNote(data, req.params.id);
  if (!note) return res.status(404).json({ ok: false, error: '笔记不存在' });
  res.json({ ok: true, backlinks: enrichBacklinks(data.notes, note.id) });
});

app.get('/api/notes/:id/export.md', (req, res) => {
  const data = store.read();
  const note = findNote(data, req.params.id);
  if (!note) return res.status(404).json({ ok: false, error: '笔记不存在' });
  const md = tiptapToMarkdown(note.content, note.title);
  const filename = encodeURIComponent((note.title || 'note') + '.md');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename*=UTF-8\'\'' + filename);
  res.send(md);
});

app.post('/api/notes', (req, res) => {
  const data = store.read();
  const notebookId = req.body?.notebookId;
  const notebook = findNotebook(data, notebookId);
  if (!notebook) return res.status(400).json({ ok: false, error: '请选择笔记本' });

  const parentId = req.body?.parentId || null;
  if (parentId) {
    const parent = findNote(data, parentId);
    if (!parent || parent.notebookId !== notebookId) {
      return res.status(400).json({ ok: false, error: '父页面不存在' });
    }
  }

  const ts = nowIso();
  const note = normalizeNote({
    id: crypto.randomUUID(),
    notebookId,
    parentId,
    title: String(req.body?.title || '无标题').trim() || '无标题',
    tags: parseTags(req.body?.tags),
    content: req.body?.content && typeof req.body.content === 'object'
      ? req.body.content
      : { type: 'doc', content: [{ type: 'paragraph' }] },
    createdAt: ts,
    updatedAt: ts
  });
  data.notes.push(note);
  notebook.updatedAt = ts;
  store.write(data);
  res.status(201).json({ ok: true, note });
});

app.post('/api/notes/import', (req, res) => {
  const data = store.read();
  const notebookId = req.body?.notebookId || req.query?.notebookId;
  const notebook = findNotebook(data, notebookId);
  if (!notebook) return res.status(400).json({ ok: false, error: '请选择笔记本' });

  const md = typeof req.body === 'string' ? req.body : String(req.body?.markdown || req.body?.content || '');
  if (!md.trim()) return res.status(400).json({ ok: false, error: 'Markdown 内容为空' });

  const title = String(req.body?.title || '').trim()
    || (md.match(/^#\s+(.+)$/m)?.[1]?.trim())
    || '导入笔记';

  const content = resolveRefsFromMarkdown(stripLeadingTitle(md, title), data.notes);
  const ts = nowIso();
  const note = normalizeNote({
    id: crypto.randomUUID(),
    notebookId,
    parentId: req.body?.parentId || null,
    title,
    tags: parseTags(req.body?.tags),
    content,
    createdAt: ts,
    updatedAt: ts
  });
  data.notes.push(note);
  notebook.updatedAt = ts;
  store.write(data);
  res.status(201).json({ ok: true, note });
});

app.patch('/api/notes/:id', (req, res) => {
  const data = store.read();
  const note = findNote(data, req.params.id);
  if (!note) return res.status(404).json({ ok: false, error: '笔记不存在' });

  if (req.body?.title != null) note.title = String(req.body.title).trim() || '无标题';
  if (req.body?.content != null && typeof req.body.content === 'object') note.content = req.body.content;
  if (req.body?.tags != null) note.tags = parseTags(req.body.tags);
  if (req.body?.notebookId != null) {
    const notebook = findNotebook(data, req.body.notebookId);
    if (!notebook) return res.status(400).json({ ok: false, error: '笔记本不存在' });
    note.notebookId = req.body.notebookId;
  }
  if (req.body?.parentId !== undefined) {
    const parentId = req.body.parentId || null;
    if (parentId && !isValidParent(data, note.id, parentId)) {
      return res.status(400).json({ ok: false, error: '无效的父页面' });
    }
    if (parentId) {
      const parent = findNote(data, parentId);
      if (!parent || parent.notebookId !== note.notebookId) {
        return res.status(400).json({ ok: false, error: '父页面不存在' });
      }
    }
    note.parentId = parentId;
  }

  note.updatedAt = nowIso();
  const notebook = findNotebook(data, note.notebookId);
  if (notebook) notebook.updatedAt = note.updatedAt;
  store.write(data);
  res.json({ ok: true, note });
});

app.delete('/api/notes/:id', (req, res) => {
  const data = store.read();
  const note = findNote(data, req.params.id);
  if (!note) return res.status(404).json({ ok: false, error: '笔记不存在' });
  const removeIds = collectDescendantIds(data.notes, note.id);
  data.notes = data.notes.filter(function(n) { return !removeIds.has(n.id); });
  store.write(data);
  res.json({ ok: true, removed: removeIds.size });
});

app.post('/api/uploads', (req, res) => {
  const filename = String(req.body?.filename || 'image.png');
  const mime = String(req.body?.mime || 'application/octet-stream');
  const raw = String(req.body?.data || '');
  if (!raw) return res.status(400).json({ ok: false, error: '缺少图片数据' });
  if (!mime.startsWith('image/')) return res.status(400).json({ ok: false, error: '仅支持图片' });
  const ext = path.extname(filename).toLowerCase()
    || (mime.includes('png') ? '.png' : mime.includes('jpeg') || mime.includes('jpg') ? '.jpg' : mime.includes('gif') ? '.gif' : mime.includes('webp') ? '.webp' : '.bin');
  const id = crypto.randomUUID() + ext;
  try {
    fs.writeFileSync(path.join(UPLOADS_DIR, id), Buffer.from(raw, 'base64'));
  } catch (e) {
    return res.status(500).json({ ok: false, error: '保存失败' });
  }
  res.status(201).json({ ok: true, id, url: './api/uploads/' + encodeURIComponent(id) });
});

app.get('/api/uploads/:id', (req, res) => {
  const id = path.basename(req.params.id);
  const filePath = path.join(UPLOADS_DIR, id);
  if (!fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: '文件不存在' });
  res.sendFile(filePath);
});

app.post('/api/notes/:id/duplicate', (req, res) => {
  const data = store.read();
  const source = findNote(data, req.params.id);
  if (!source) return res.status(404).json({ ok: false, error: '笔记不存在' });
  const ts = nowIso();
  const note = normalizeNote({
    id: crypto.randomUUID(),
    notebookId: source.notebookId,
    parentId: source.parentId,
    title: source.title + ' (副本)',
    tags: source.tags.slice(),
    content: JSON.parse(JSON.stringify(source.content)),
    createdAt: ts,
    updatedAt: ts
  });
  data.notes.push(note);
  store.write(data);
  res.status(201).json({ ok: true, note });
});

app.use(express.static(PUBLIC));
app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC, 'index.html'));
});

const { host, port } = config.server;
app.listen(port, host, function() {
  console.log('notes http://' + host + ':' + port);
});
