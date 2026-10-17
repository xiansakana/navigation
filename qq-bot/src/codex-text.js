import { Marked } from 'marked';

const markdown = new Marked({ gfm: true });
function decode(text) {
  return String(text || '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (raw, value) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (value[0] !== '#') return named[value.toLowerCase()] || raw;
    const code = value[1].toLowerCase() === 'x' ? parseInt(value.slice(2), 16) : Number(value.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : raw;
  });
}

function inline(tokens = []) {
  return tokens.map(token => {
    if (['strong', 'em', 'del'].includes(token.type)) return inline(token.tokens);
    if (token.type === 'codespan') return token.text;
    if (token.type === 'br') return '\n';
    if (['link', 'image'].includes(token.type)) {
      const label = inline(token.tokens) || decode(token.text), href = decode(token.href);
      return label && label !== href ? label + '（' + href + '）' : href;
    }
    if (token.type === 'html') return decode(token.text.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, ''));
    if (token.tokens) return inline(token.tokens);
    return decode(token.text ?? token.raw);
  }).join('');
}

function blocks(tokens = []) {
  return tokens.map(token => {
    switch (token.type) {
      case 'space': return '';
      case 'heading': case 'paragraph': return inline(token.tokens) + '\n\n';
      case 'text': return (token.tokens ? inline(token.tokens) : decode(token.text)) + '\n';
      case 'code': return token.text + '\n\n';
      case 'hr': return '────────\n\n';
      case 'blockquote': return '引用：\n' + blocks(token.tokens).trimEnd().split('\n').map(line => '  ' + line).join('\n') + '\n\n';
      case 'list': return token.items.map((item, index) => {
        const prefix = item.task ? (item.checked ? '☑ ' : '☐ ') : token.ordered ? (Number(token.start) + index) + '. ' : '• ';
        const lines = blocks(item.tokens).trimEnd().split('\n');
        return prefix + lines.join('\n' + ' '.repeat(prefix.length));
      }).join('\n') + '\n\n';
      case 'table': {
        const headers = token.header.map(cell => inline(cell.tokens));
        return (token.rows.length ? token.rows.map(row => row.map((cell, index) => (headers[index] || '列' + (index + 1)) + '：' + inline(cell.tokens)).join('；')).join('\n') : headers.join('；')) + '\n\n';
      }
      case 'html': return inline([token]) + '\n\n';
      case 'def': return '';
      default: return inline([token]);
    }
  }).join('');
}

// Convert the complete message before chunking, so code fences and links never
// straddle a parser boundary. Keep the original Markdown in the job/history.
export function codexQqText(message) {
  return blocks(markdown.lexer(String(message).replace(/\r\n?/g, '\n'))).trimEnd();
}

export function codexQqChunks(message) {
  let text = codexQqText(message).replace(/\[CQ:/gi, '［CQ:').slice(0, 10000);
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  const chunks = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 1500, text.length);
    const newline = text.lastIndexOf('\n', end - 1);
    if (end < text.length && newline >= start + 750) end = newline + 1;
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    chunks.push(text.slice(start, end));start = end;
  }
  return chunks;
}
