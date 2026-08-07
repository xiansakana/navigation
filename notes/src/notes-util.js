export function normalizeNote(note) {
  return {
    id: note.id,
    notebookId: note.notebookId,
    parentId: note.parentId || null,
    title: note.title || '无标题',
    content: note.content && typeof note.content === 'object'
      ? note.content
      : { type: 'doc', content: [{ type: 'paragraph' }] },
    tags: Array.isArray(note.tags) ? note.tags.filter(Boolean) : [],
    createdAt: note.createdAt,
    updatedAt: note.updatedAt
  };
}

export function noteSummary(note) {
  return {
    id: note.id,
    notebookId: note.notebookId,
    parentId: note.parentId || null,
    title: note.title,
    tags: Array.isArray(note.tags) ? note.tags : [],
    createdAt: note.createdAt,
    updatedAt: note.updatedAt
  };
}

export function extractPlainText(content) {
  if (!content) return '';
  const parts = [];
  walkNodes(content, parts);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function walkNodes(node, parts) {
  if (!node) return;
  if (node.type === 'text' && node.text) parts.push(node.text);
  if (node.type === 'noteReference') {
    parts.push(node.attrs?.title || '');
  }
  if (Array.isArray(node.content)) node.content.forEach(function(child) { walkNodes(child, parts); });
}

export function buildNoteTree(notes, notebookId) {
  const items = notes
    .filter(function(n) { return n.notebookId === notebookId; })
    .map(noteSummary);
  const byParent = new Map();
  items.forEach(function(note) {
    const key = note.parentId || '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(note);
  });
  byParent.forEach(function(list) {
    list.sort(function(a, b) {
      return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN');
    });
  });
  function attach(parentId, depth) {
    return (byParent.get(parentId || '') || []).map(function(note) {
      return {
        ...note,
        depth,
        children: attach(note.id, depth + 1)
      };
    });
  }
  return attach('', 0);
}
