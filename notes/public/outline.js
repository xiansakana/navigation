import { extractHeadings } from './block-id.js';

export function setupOutlinePanel(opts) {
  const panel = opts.panel;
  const listEl = opts.listEl;
  const filterEl = opts.filterEl;
  let filter = '';

  function render() {
    const editor = opts.getEditor?.();
    if (!editor) {
      listEl.innerHTML = '<li class="notes-outline-empty">无大纲</li>';
      return;
    }
    const headings = extractHeadings(editor.getJSON());
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? headings.filter(function(h) { return h.text.toLowerCase().includes(q); })
      : headings;

    listEl.innerHTML = '';
    if (!filtered.length) {
      listEl.innerHTML = '<li class="notes-outline-empty">' + (q ? '无匹配标题' : '添加标题以生成大纲') + '</li>';
      return;
    }

    filtered.forEach(function(item) {
      const li = document.createElement('li');
      li.className = 'notes-outline-item notes-outline-h' + item.level;
      li.style.paddingLeft = (8 + (item.level - 1) * 12) + 'px';
      li.textContent = item.text || '无标题';
      li.title = item.text || '无标题';
      li.addEventListener('click', function() {
        scrollToHeading(editor, item);
      });
      listEl.appendChild(li);
    });
  }

  if (filterEl) {
    filterEl.addEventListener('input', function() {
      filter = filterEl.value;
      render();
    });
  }

  return {
    refresh: render,
    cleanup: function() {
      if (filterEl) filterEl.replaceWith(filterEl.cloneNode(true));
    }
  };
}

function scrollToHeading(editor, item) {
  const doc = editor.state.doc;
  let targetPos = null;
  doc.descendants(function(node, pos) {
    if (targetPos != null) return false;
    if (node.type.name === 'heading'
      && node.attrs.level === item.level
      && headingText(node) === item.text
      && (!item.id || node.attrs.id === item.id)) {
      targetPos = pos;
      return false;
    }
  });
  if (targetPos == null) return;
  editor.chain().focus().setTextSelection(targetPos + 1).run();
  const dom = editor.view.nodeDOM(targetPos);
  if (dom && dom.scrollIntoView) {
    dom.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function headingText(node) {
  let text = '';
  node.forEach(function(child) {
    if (child.isText) text += child.text;
  });
  return text;
}
