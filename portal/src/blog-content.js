import sanitizeHtml from 'sanitize-html';
import { decodeHTML } from 'entities';

const richOptions = {
  allowedTags: ['p', 'div', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a'],
  allowedAttributes: { a: ['href', 'rel', 'target'] },
  allowedSchemes: ['https', 'http', 'mailto'],
  allowProtocolRelative: false,
  transformTags: {
    a: (tagName, attributes) => ({ tagName, attribs: { href: attributes.href || '', target: '_blank', rel: 'noopener noreferrer' } })
  }
};

export function normalizeContent(value, format = 'text', allowEmpty = false) {
  if (format !== 'text' && format !== 'html') throw new Error('博客内容格式无效');
  if (typeof value !== 'string') throw new Error('请输入博客内容');
  if (format === 'text') {
    const content = value.trim();
    if (!content && !allowEmpty) throw new Error('请输入博客内容或添加媒体');
    if (content.length > 10000) throw new Error('博客内容最多 10000 字');
    return content;
  }
  if (value.length > 80000) throw new Error('博客富文本内容过大');
  const content = sanitizeHtml(value, richOptions).trim();
  let text = '';
  sanitizeHtml(content, { allowedTags: [], allowedAttributes: {}, textFilter: part => { text += part; return part; } });
  const plain = decodeHTML(text);
  if (!plain.trim() && !allowEmpty) throw new Error('请输入博客内容或添加媒体');
  if (plain.length > 10000) throw new Error('博客内容最多 10000 字');
  return plain.trim() ? content : '';
}

export function normalizeTags(value = []) {
  if (!Array.isArray(value) || value.some(tag => typeof tag !== 'string')) throw new Error('标签参数无效');
  const tags = [...new Set(value.map(tag => tag.trim().replace(/^#+/, '').normalize('NFC')).filter(Boolean))];
  if (tags.length > 20) throw new Error('每篇博客最多 20 个标签');
  if (tags.some(tag => tag.length > 30 || /[\u0000-\u001f\u007f]/.test(tag))) throw new Error('标签最多 30 字，不能包含换行');
  return tags;
}
