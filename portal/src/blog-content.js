import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';

const window = new JSDOM('').window;
const purifier = createDOMPurify(window);
const richOptions = {
  ALLOWED_TAGS: ['p', 'div', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img'],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  RETURN_DOM_FRAGMENT: true
};
purifier.addHook('afterSanitizeAttributes', node => {
  if (node.nodeName === 'IMG' && !/^(https?:\/\/|\/api\/blog\/images\/)/i.test(node.getAttribute('src') || '')) { node.remove(); return; }
  if (node.nodeName !== 'A') { node.removeAttribute('href'); return; }
  if (!/^(https?:\/\/|mailto:)/i.test(node.getAttribute('href') || '')) node.removeAttribute('href');
  node.setAttribute('target', '_blank');
  node.setAttribute('rel', 'noopener noreferrer');
});

export function normalizeContent(value, format = 'text', allowEmpty = false) {
  if (!['text', 'html', 'markdown'].includes(format)) throw new Error('博客内容格式无效');
  if (typeof value !== 'string') throw new Error('请输入博客内容');
  if (format === 'text') {
    const content = value.trim();
    if (!content && !allowEmpty) throw new Error('请输入博客内容或添加媒体');
    if (content.length > 10000) throw new Error('博客内容最多 10000 字');
    return content;
  }
  if (format === 'markdown') {
    const content = value.trim();
    if (content.length > 10000) throw new Error('博客内容最多 10000 字');
    if (!content && !allowEmpty) throw new Error('请输入博客内容或添加媒体');
    if (content) normalizeContent(marked.parse(content, { gfm: true, breaks: true }), 'html', allowEmpty);
    return content;
  }
  if (value.length > 80000) throw new Error('博客富文本内容过大');
  const fragment = purifier.sanitize(value, richOptions);
  const plain = fragment.textContent;
  const hasContent = plain.trim() || fragment.querySelector('img[src]');
  if (!hasContent && !allowEmpty) throw new Error('请输入博客内容或添加媒体');
  if (plain.length > 10000) throw new Error('博客内容最多 10000 字');
  const container = window.document.createElement('div');
  container.appendChild(fragment);
  return hasContent ? container.innerHTML.trim() : '';
}

export function renderMarkdown(content) {
    return normalizeContent(marked.parse(content, { gfm: true, breaks: true }), 'html', true);
}

export function contentSearchText(content, format = 'text') {
  if (format === 'text') return content.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const fragment = purifier.sanitize(format === 'markdown' ? marked.parse(content) : content, richOptions);
  fragment.querySelectorAll('p, div, br, li, h1, h2, h3, h4, h5, h6, tr, td, th, blockquote, pre').forEach(node => node.appendChild(window.document.createTextNode(' ')));
  return fragment.textContent.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function normalizeSearch(value = '') {
  if (typeof value !== 'string' || value.length > 200) throw new Error('搜索关键词最多 200 字');
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function normalizeLocation(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('定位参数无效');
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  if (label.length > 120 || /[\u0000-\u001f\u007f]/.test(label)) throw new Error('位置名称最多 120 字');
  const hasCoordinates = value.latitude != null || value.longitude != null;
  if (hasCoordinates && (typeof value.latitude !== 'number' || typeof value.longitude !== 'number'
      || !Number.isFinite(value.latitude) || !Number.isFinite(value.longitude)
      || Math.abs(value.latitude) > 90 || Math.abs(value.longitude) > 180)) throw new Error('定位坐标无效');
  if (!label && !hasCoordinates) return null;
  return { label, ...(hasCoordinates ? { latitude: Number(value.latitude.toFixed(6)), longitude: Number(value.longitude.toFixed(6)) } : {}) };
}

export function normalizeTags(value = []) {
  if (!Array.isArray(value) || value.some(tag => typeof tag !== 'string')) throw new Error('标签参数无效');
  const tags = [...new Set(value.map(tag => tag.trim().replace(/^#+/, '').normalize('NFC')).filter(Boolean))];
  if (tags.length > 20) throw new Error('每篇博客最多 20 个标签');
  if (tags.some(tag => tag.length > 30 || /[\u0000-\u001f\u007f]/.test(tag))) throw new Error('标签最多 30 字，不能包含换行');
  return tags;
}
