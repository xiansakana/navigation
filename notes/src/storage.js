import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();

export function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  const example = path.join(ROOT, 'config.example.json');
  if (!fs.existsSync(file)) {
    if (fs.existsSync(example)) {
      fs.copyFileSync(example, file);
      throw new Error('已创建 config.json，请确认配置后重启');
    }
    throw new Error('缺少 config.json');
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    server: {
      host: raw.server?.host || '127.0.0.1',
      port: Number(raw.server?.port) || 5001
    },
    dataFile: raw.dataFile || 'data/notes.json'
  };
}

export function resolveDataPath(config) {
  const p = config.dataFile;
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

function nowIso() {
  return new Date().toISOString();
}

function defaultNotebook() {
  const ts = nowIso();
  return {
    id: crypto.randomUUID(),
    title: '默认笔记本',
    sort: 0,
    createdAt: ts,
    updatedAt: ts
  };
}

const EMPTY = { notebooks: [], notes: [] };

export function createStore(dataPath) {
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });

  function read() {
    if (!fs.existsSync(dataPath)) {
      const nb = defaultNotebook();
      const initial = { notebooks: [nb], notes: [] };
      write(initial);
      return initial;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      const notebooks = Array.isArray(raw.notebooks) ? raw.notebooks : [];
      const notes = Array.isArray(raw.notes) ? raw.notes : [];
      if (!notebooks.length) {
        const nb = defaultNotebook();
        notebooks.push(nb);
        write({ notebooks, notes });
      }
      return { notebooks, notes };
    } catch {
      const nb = defaultNotebook();
      return { notebooks: [nb], notes: [] };
    }
  }

  function write(data) {
    const payload = {
      notebooks: Array.isArray(data.notebooks) ? data.notebooks : [],
      notes: Array.isArray(data.notes) ? data.notes : [],
      updatedAt: nowIso()
    };
    const tmp = dataPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
    fs.renameSync(tmp, dataPath);
    return payload;
  }

  return { read, write };
}

export function noteSummary(note) {
  return {
    id: note.id,
    notebookId: note.notebookId,
    title: note.title,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt
  };
}
