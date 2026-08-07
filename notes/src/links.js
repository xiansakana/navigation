const NOTE_REF_RE = /\[\[([^\]|]+)(?:\|([0-9a-f-]{36}))?\]\]/gi;

export function extractNoteRefs(content) {
  const ids = new Set();
  walk(content, ids);
  return [...ids];
}

function walk(node, ids) {
  if (!node) return;
  if (node.type === 'noteReference' && node.attrs?.id) ids.add(node.attrs.id);
  if (Array.isArray(node.content)) node.content.forEach(function(child) { walk(child, ids); });
}

export function extractNoteRefsFromMarkdown(md) {
  const ids = new Set();
  let m;
  const re = new RegExp(NOTE_REF_RE.source, 'gi');
  while ((m = re.exec(String(md || ''))) !== null) {
    if (m[2]) ids.add(m[2]);
  }
  return [...ids];
}

export function computeBacklinks(notes) {
  const map = {};
  notes.forEach(function(note) {
    extractNoteRefs(note.content).forEach(function(targetId) {
      if (!map[targetId]) map[targetId] = [];
      map[targetId].push({
        id: note.id,
        title: note.title,
        notebookId: note.notebookId,
        updatedAt: note.updatedAt
      });
    });
  });
  return map;
}

export function getBacklinksForNote(notes, noteId) {
  return computeBacklinks(notes)[noteId] || [];
}

export function extractPlainFromContent(content) {
  const parts = [];
  walkPlain(content, parts);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function walkPlain(node, parts) {
  if (!node) return;
  if (node.type === 'text' && node.text) parts.push(node.text);
  if (node.type === 'noteReference') parts.push(node.attrs?.title || '');
  if (Array.isArray(node.content)) node.content.forEach(function(c) { walkPlain(c, parts); });
}

export function findRefSnippet(content, targetId) {
  const snippets = [];
  collectRefContexts(content, targetId, [], snippets);
  if (!snippets.length) return '';
  return snippets[0].slice(0, 120);
}

function collectRefContexts(nodes, targetId, path, out) {
  if (!Array.isArray(nodes)) return;
  nodes.forEach(function(node) {
    if (node.type === 'noteReference' && node.attrs?.id === targetId) {
      const ctx = path.join(' ').trim();
      if (ctx) out.push(ctx);
    }
    if (node.type === 'paragraph' || node.type === 'heading') {
      const text = inlinePlain(node.content);
      if (text) path.push(text);
    }
    if (node.content) collectRefContexts(node.content, targetId, path.slice(), out);
  });
}

function inlinePlain(nodes) {
  if (!Array.isArray(nodes)) return '';
  return nodes.map(function(n) {
    if (n.type === 'text') return n.text || '';
    if (n.type === 'noteReference') return '@' + (n.attrs?.title || '');
    if (n.content) return inlinePlain(n.content);
    return '';
  }).join('');
}

export function enrichBacklinks(notes, noteId) {
  const raw = getBacklinksForNote(notes, noteId);
  return raw.map(function(item) {
    const source = notes.find(function(n) { return n.id === item.id; });
    return {
      ...item,
      snippet: source ? findRefSnippet(source.content, noteId) : '',
      preview: source ? extractPlainFromContent(source.content).slice(0, 160) : ''
    };
  });
}
