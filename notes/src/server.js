import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, createStore, resolveDataPath, noteSummary } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');

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

function sortNotes(notes) {
  return notes.slice().sort(function(a, b) {
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/bootstrap', (_req, res) => {
  const data = store.read();
  res.json({
    ok: true,
    notebooks: sortNotebooks(data.notebooks),
    notes: sortNotes(data.notes).map(noteSummary)
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

app.get('/api/notes', (req, res) => {
  const data = store.read();
  let notes = data.notes;
  const notebookId = req.query.notebookId;
  if (notebookId) notes = notes.filter(function(note) { return note.notebookId === notebookId; });
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q) {
    notes = notes.filter(function(note) {
      return String(note.title || '').toLowerCase().includes(q);
    });
  }
  res.json({ ok: true, notes: sortNotes(notes).map(noteSummary) });
});

app.get('/api/notes/:id', (req, res) => {
  const data = store.read();
  const note = findNote(data, req.params.id);
  if (!note) return res.status(404).json({ ok: false, error: '笔记不存在' });
  res.json({ ok: true, note });
});

app.post('/api/notes', (req, res) => {
  const data = store.read();
  const notebookId = req.body?.notebookId;
  const notebook = findNotebook(data, notebookId);
  if (!notebook) return res.status(400).json({ ok: false, error: '请选择笔记本' });
  const ts = nowIso();
  const note = {
    id: crypto.randomUUID(),
    notebookId,
    title: String(req.body?.title || '无标题').trim() || '无标题',
    content: req.body?.content && typeof req.body.content === 'object' ? req.body.content : { type: 'doc', content: [{ type: 'paragraph' }] },
    createdAt: ts,
    updatedAt: ts
  };
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
  if (req.body?.notebookId != null) {
    const notebook = findNotebook(data, req.body.notebookId);
    if (!notebook) return res.status(400).json({ ok: false, error: '笔记本不存在' });
    note.notebookId = req.body.notebookId;
  }
  note.updatedAt = nowIso();
  const notebook = findNotebook(data, note.notebookId);
  if (notebook) notebook.updatedAt = note.updatedAt;
  store.write(data);
  res.json({ ok: true, note });
});

app.delete('/api/notes/:id', (req, res) => {
  const data = store.read();
  const idx = data.notes.findIndex(function(note) { return note.id === req.params.id; });
  if (idx < 0) return res.status(404).json({ ok: false, error: '笔记不存在' });
  data.notes.splice(idx, 1);
  store.write(data);
  res.json({ ok: true });
});

app.post('/api/notes/:id/duplicate', (req, res) => {
  const data = store.read();
  const source = findNote(data, req.params.id);
  if (!source) return res.status(404).json({ ok: false, error: '笔记不存在' });
  const ts = nowIso();
  const note = {
    id: crypto.randomUUID(),
    notebookId: source.notebookId,
    title: source.title + ' (副本)',
    content: JSON.parse(JSON.stringify(source.content || { type: 'doc', content: [{ type: 'paragraph' }] })),
    createdAt: ts,
    updatedAt: ts
  };
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
