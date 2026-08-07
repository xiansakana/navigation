import { computeBacklinks } from './links.js';

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

export function buildNoteTree(notes, notebookId, enrichCtx, sortMode) {
  if (enrichCtx === undefined) enrichCtx = null;
  if (sortMode === undefined) sortMode = 'updated';
  const items = notes
    .filter(function(n) { return n.notebookId === notebookId; })
    .map(function(n) {
      return enrichCtx ? enrichNoteSummaryLite(n, enrichCtx) : noteSummary(n);
    });

  function enrichNoteSummaryLite(note, ctx) {
    const directChildren = ctx.directChildren.get(note.id) || 0;
    return {
      ...noteSummary(note),
      preview: makePreview(note.content),
      wordCount: countWords(note.content),
      childCount: directChildren,
      descendantCount: ctx.totalChildren.get(note.id) || 0,
      backlinkCount: ctx.backlinkCounts[note.id] || 0,
      hasChildren: directChildren > 0
    };
  }

  const byParent = new Map();
  items.forEach(function(note) {
    const key = note.parentId || '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(note);
  });

  function sortList(list) {
    const mode = sortMode === 'title' ? 'title' : 'updated';
    list.sort(function(a, b) {
      if (mode === 'title') {
        return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN');
      }
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
  }

  function attach(parentId, depth) {
    const list = byParent.get(parentId || '') || [];
    sortList(list);
    return list.map(function(note) {
      return {
        ...note,
        depth,
        children: attach(note.id, depth + 1)
      };
    });
  }
  return attach('', 0);
}

function makePreview(content) {
  const text = extractPlainText(content);
  if (!text) return '';
  if (text.length <= 72) return text;
  return text.slice(0, 72) + '…';
}

function countWords(content) {
  const text = extractPlainText(content);
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const words = text.split(/\s+/).filter(Boolean).length;
  return cjk + Math.max(0, words - 1);
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
  if (node.type === 'image') {
    parts.push(node.attrs?.alt || '[图片]');
  }
  if (node.type === 'embedBlock') {
    parts.push(node.attrs?.title || node.attrs?.src || '[嵌入]');
  }
  if (node.type === 'calloutBlock') {
    parts.push('[标注]');
  }
  if (Array.isArray(node.content)) node.content.forEach(function(child) { walkNodes(child, parts); });
}

export function buildEnrichedContext(notes, notebookId) {
  const backlinkMap = computeBacklinks(notes);
  const backlinkCounts = {};
  Object.keys(backlinkMap).forEach(function(id) {
    backlinkCounts[id] = backlinkMap[id].length;
  });
  const counts = childCounts(notes, notebookId);
  return {
    directChildren: counts.direct,
    totalChildren: counts.total,
    backlinkCounts
  };
}

function childCounts(notes, notebookId) {
  const direct = new Map();
  const total = new Map();
  const nbNotes = notes.filter(function(n) { return n.notebookId === notebookId; });

  nbNotes.forEach(function(note) {
    if (note.parentId) {
      direct.set(note.parentId, (direct.get(note.parentId) || 0) + 1);
    }
  });

  function totalDescendants(id) {
    if (total.has(id)) return total.get(id);
    let count = 0;
    nbNotes.forEach(function(n) {
      if (n.parentId === id) count += 1 + totalDescendants(n.id);
    });
    total.set(id, count);
    return count;
  }

  nbNotes.forEach(function(n) { totalDescendants(n.id); });
  return { direct, total };
}

export function notebookStats(notes, notebookId) {
  const list = notes.filter(function(n) { return n.notebookId === notebookId; });
  const tagSet = new Set();
  list.forEach(function(n) {
    (n.tags || []).forEach(function(t) { if (t) tagSet.add(t); });
  });
  return {
    noteCount: list.length,
    tagCount: tagSet.size,
    totalWords: list.reduce(function(sum, n) { return sum + countWords(n.content); }, 0)
  };
}
