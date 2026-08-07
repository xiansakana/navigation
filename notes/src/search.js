import { extractPlainText, noteSummary } from './notes-util.js';

export function searchNotes(notes, opts) {
  const q = String(opts.q || '').trim().toLowerCase();
  const tag = String(opts.tag || '').trim().toLowerCase();
  const notebookId = opts.notebookId || '';

  let result = notes.slice();
  if (notebookId) {
    result = result.filter(function(note) { return note.notebookId === notebookId; });
  }
  if (tag) {
    result = result.filter(function(note) {
      return (note.tags || []).some(function(t) { return String(t).toLowerCase() === tag; });
    });
  }
  if (q) {
    result = result.filter(function(note) {
      const hay = [
        note.title || '',
        (note.tags || []).join(' '),
        extractPlainText(note.content)
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  return result
    .map(function(note) {
      const text = extractPlainText(note.content);
      const preview = text.length > 72 ? text.slice(0, 72) + '…' : text;
      return {
        ...noteSummary(note),
        snippet: q ? makeSnippet(note, q) : preview,
        preview: preview,
        wordCount: text ? (text.match(/[\u4e00-\u9fff]/g) || []).length + Math.max(0, text.split(/\s+/).filter(Boolean).length - 1) : 0
      };
    })
    .sort(function(a, b) {
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
}

function makeSnippet(note, q) {
  const text = extractPlainText(note.content);
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return '';
  const start = Math.max(0, idx - 24);
  const end = Math.min(text.length, idx + q.length + 40);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

export function collectTags(notes, notebookId) {
  const counts = new Map();
  notes.forEach(function(note) {
    if (notebookId && note.notebookId !== notebookId) return;
    (note.tags || []).forEach(function(tag) {
      const key = String(tag).trim();
      if (!key) return;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
  });
  return [...counts.entries()]
    .map(function(entry) { return { tag: entry[0], count: entry[1] }; })
    .sort(function(a, b) { return b.count - a.count || a.tag.localeCompare(b.tag, 'zh-CN'); });
}
