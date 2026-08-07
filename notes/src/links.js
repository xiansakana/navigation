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
