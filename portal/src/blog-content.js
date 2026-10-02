import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

const window = new JSDOM('').window;
const purifier = createDOMPurify(window);
const richOptions = {
  ALLOWED_TAGS: ['p', 'div', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a'],
  ALLOWED_ATTR: ['href'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  RETURN_DOM_FRAGMENT: true
};
purifier.addHook('afterSanitizeAttributes', node => {
  if (node.nodeName !== 'A') { node.removeAttribute('href'); return; }
  if (!/^(https?:\/\/|mailto:)/i.test(node.getAttribute('href') || '')) node.removeAttribute('href');
  node.setAttribute('target', '_blank');
  node.setAttribute('rel', 'noopener noreferrer');
});

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
  const fragment = purifier.sanitize(value, richOptions);
  const plain = fragment.textContent;
  if (!plain.trim() && !allowEmpty) throw new Error('请输入博客内容或添加媒体');
  if (plain.length > 10000) throw new Error('博客内容最多 10000 字');
  const container = window.document.createElement('div');
  container.appendChild(fragment);
  return plain.trim() ? container.innerHTML.trim() : '';
}

export function normalizeTags(value = []) {
  if (!Array.isArray(value) || value.some(tag => typeof tag !== 'string')) throw new Error('标签参数无效');
  const tags = [...new Set(value.map(tag => tag.trim().replace(/^#+/, '').normalize('NFC')).filter(Boolean))];
  if (tags.length > 20) throw new Error('每篇博客最多 20 个标签');
  if (tags.some(tag => tag.length > 30 || /[\u0000-\u001f\u007f]/.test(tag))) throw new Error('标签最多 30 字，不能包含换行');
  return tags;
}
