import { extractNoteRefsFromMarkdown } from './links.js';

const NOTE_REF_INLINE = /\[\[([^\]|]+)(?:\|([0-9a-f-]{36}))?\]\]/;

export function tiptapToMarkdown(doc, title) {
  const lines = [];
  if (title) lines.push('# ' + title, '');
  if (doc && Array.isArray(doc.content)) {
    doc.content.forEach(function(node) {
      const block = blockToMd(node);
      if (block != null && block !== '') lines.push(block);
    });
  }
  return lines.join('\n\n').trim() + '\n';
}

function blockToMd(node) {
  if (!node) return '';
  switch (node.type) {
    case 'paragraph':
      return inlineToMd(node.content);
    case 'heading':
      return '#'.repeat(node.attrs?.level || 1) + ' ' + inlineToMd(node.content);
    case 'bulletList':
      return (node.content || []).map(function(item) {
        const p = item.content?.[0];
        return '- ' + inlineToMd(p?.content);
      }).join('\n');
    case 'orderedList':
      return (node.content || []).map(function(item, i) {
        const p = item.content?.[0];
        return (i + 1) + '. ' + inlineToMd(p?.content);
      }).join('\n');
    case 'taskList':
      return (node.content || []).map(function(item) {
        const checked = item.attrs?.checked;
        const p = item.content?.[0];
        return '- [' + (checked ? 'x' : ' ') + '] ' + inlineToMd(p?.content);
      }).join('\n');
    case 'toggleBlock': {
      const parts = node.content || [];
      const summary = parts[0] ? blockToMd(parts[0]) : '';
      const body = parts.slice(1).map(blockToMd).filter(Boolean).join('\n\n');
      return '▸ ' + summary + (body ? '\n\n' + body : '');
    }
    case 'blockquote':
      return (node.content || []).map(function(inner) {
        return '> ' + blockToMd(inner).replace(/\n/g, '\n> ');
      }).join('\n');
    case 'codeBlock': {
      const lang = node.attrs?.language;
      const code = node.content?.[0]?.text || '';
      const fence = lang && lang !== 'text' ? lang : '';
      return '```' + fence + '\n' + code + '\n```';
    }
    case 'image': {
      const alt = node.attrs?.alt || '';
      const src = node.attrs?.src || '';
      const w = node.attrs?.width;
      if (w) return '![' + alt + '|w=' + w + '](' + src + ')';
      return '![' + alt + '](' + src + ')';
    }
    case 'embedBlock': {
      const src = node.attrs?.src || '';
      const height = node.attrs?.height || 360;
      return ':::embed ' + height + '\n' + src + '\n:::';
    }
    case 'horizontalRule':
      return '---';
    default:
      return inlineToMd(node.content);
  }
}

function inlineToMd(nodes) {
  if (!Array.isArray(nodes)) return '';
  return nodes.map(function(node) {
    if (node.type === 'text') {
      let t = node.text || '';
      if (node.marks) {
        node.marks.forEach(function(mark) {
          if (mark.type === 'bold') t = '**' + t + '**';
          else if (mark.type === 'italic') t = '*' + t + '*';
          else if (mark.type === 'strike') t = '~~' + t + '~~';
          else if (mark.type === 'code') t = '`' + t + '`';
        });
      }
      return t;
    }
    if (node.type === 'noteReference') {
      const id = node.attrs?.id;
      const title = node.attrs?.title || '笔记';
      return id ? '[[' + title + '|' + id + ']]' : '[[' + title + ']]';
    }
    if (node.content) return inlineToMd(node.content);
    return '';
  }).join('');
}

export function markdownToTiptap(md, titleById) {
  const text = String(md || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const hr = /^---+\s*$/.exec(line);
    if (hr) { blocks.push({ type: 'horizontalRule' }); i++; continue; }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        attrs: { level: heading[1].length },
        content: parseInline(heading[2], titleById)
      });
      i++; continue;
    }

    const codeStart = /^```(\w*)\s*$/.exec(line);
    if (codeStart) {
      const codeLines = [];
      const language = codeStart[1] || 'text';
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({
        type: 'codeBlock',
        attrs: { language: language },
        content: codeLines.length ? [{ type: 'text', text: codeLines.join('\n') }] : []
      });
      continue;
    }

    const imageLine = /^!\[([^\]|]*)(?:\|w=(\d+))?\]\(([^)]+)\)\s*$/.exec(line);
    if (imageLine) {
      const attrs = { alt: imageLine[1], src: imageLine[3], title: null };
      if (imageLine[2]) attrs.width = parseInt(imageLine[2], 10);
      blocks.push({ type: 'image', attrs: attrs });
      i++;
      continue;
    }

    const embedStart = /^:::\s*embed(?:\s+(\d+))?\s*$/.exec(line);
    if (embedStart) {
      const height = embedStart[1] ? parseInt(embedStart[1], 10) : 360;
      i++;
      const urlLines = [];
      while (i < lines.length && !/^:::\s*$/.test(lines[i])) {
        urlLines.push(lines[i]);
        i++;
      }
      i++;
      const src = urlLines.join('\n').trim();
      if (src) {
        blocks.push({
          type: 'embedBlock',
          attrs: { src: src, title: '', height: height }
        });
      }
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({
        type: 'blockquote',
        content: quoteLines.map(function(q) {
          return { type: 'paragraph', content: parseInline(q, titleById) };
        })
      });
      continue;
    }

    if (/^[▸▾]\s+/.test(line)) {
      const summaryText = line.replace(/^[▸▾]\s+/, '');
      const bodyBlocks = [];
      i++;
      while (i < lines.length && lines[i].trim()) {
        bodyBlocks.push({ type: 'paragraph', content: parseInline(lines[i], titleById) });
        i++;
      }
      blocks.push({
        type: 'toggleBlock',
        attrs: { open: true },
        content: [
          { type: 'paragraph', content: parseInline(summaryText, titleById) },
          ...(bodyBlocks.length ? bodyBlocks : [{ type: 'paragraph' }])
        ]
      });
      continue;
    }

    if (/^[-*]\s+\[[ xX]\]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+\[[ xX]\]\s+/.test(lines[i])) {
        const checked = /^\[[xX]\]/.test(lines[i].replace(/^[-*]\s+/, ''));
        items.push({
          type: 'taskItem',
          attrs: { checked },
          content: [{ type: 'paragraph', content: parseInline(lines[i].replace(/^[-*]\s+\[[ xX]\]\s+/, ''), titleById) }]
        });
        i++;
      }
      blocks.push({ type: 'taskList', content: items });
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: parseInline(lines[i].replace(/^[-*]\s+/, ''), titleById) }]
        });
        i++;
      }
      blocks.push({ type: 'bulletList', content: items });
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: parseInline(lines[i].replace(/^\d+\.\s+/, ''), titleById) }]
        });
        i++;
      }
      blocks.push({ type: 'orderedList', content: items });
      continue;
    }

    blocks.push({ type: 'paragraph', content: parseInline(line, titleById) });
    i++;
  }

  if (!blocks.length) blocks.push({ type: 'paragraph' });
  return { type: 'doc', content: blocks };
}

function parseInline(text, titleById) {
  const nodes = [];
  let rest = String(text || '');
  while (rest.length) {
    const ref = NOTE_REF_INLINE.exec(rest);
    const bold = /^\*\*(.+?)\*\*/.exec(rest);
    const italic = /^\*(.+?)\*/.exec(rest);
    const strike = /^~~(.+?)~~/.exec(rest);
    const code = /^`([^`]+)`/.exec(rest);

    let match = null;
    let kind = '';
    if (ref && (match === null || ref.index < match.index)) { match = ref; kind = 'ref'; }
    if (bold && (match === null || bold.index < match.index)) { match = bold; kind = 'bold'; }
    if (italic && (match === null || italic.index < match.index)) { match = italic; kind = 'italic'; }
    if (strike && (match === null || strike.index < match.index)) { match = strike; kind = 'strike'; }
    if (code && (match === null || code.index < match.index)) { match = code; kind = 'code'; }

    if (!match) {
      nodes.push({ type: 'text', text: rest });
      break;
    }
    if (match.index > 0) nodes.push({ type: 'text', text: rest.slice(0, match.index) });

    if (kind === 'ref') {
      const title = match[1].trim();
      let id = match[2] || null;
      if (!id && titleById) {
        const found = Object.entries(titleById).find(function(entry) {
          return entry[1].toLowerCase() === title.toLowerCase();
        });
        if (found) id = found[0];
      }
      nodes.push({ type: 'noteReference', attrs: { id, title } });
    } else {
      const markType = kind === 'bold' ? 'bold' : kind === 'italic' ? 'italic' : kind === 'strike' ? 'strike' : 'code';
      nodes.push({ type: 'text', text: match[1], marks: [{ type: markType }] });
    }
    rest = rest.slice(match.index + match[0].length);
  }
  return nodes.length ? nodes : [{ type: 'text', text: '' }];
}

export function stripLeadingTitle(md, title) {
  if (!title) return md;
  const re = new RegExp('^#\\s+' + escapeRegExp(title) + '\\s*\\n+');
  return String(md || '').replace(re, '');
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function resolveRefsFromMarkdown(md, notes) {
  const titleById = {};
  notes.forEach(function(n) { titleById[n.id] = n.title; });
  return markdownToTiptap(md, titleById);
}

export { extractNoteRefsFromMarkdown };
