function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let popoverEl = null;
let hideTimer = null;

function ensurePopover() {
  if (popoverEl) return popoverEl;
  popoverEl = document.createElement('div');
  popoverEl.className = 'notes-ref-popover hidden';
  document.body.appendChild(popoverEl);
  popoverEl.addEventListener('mouseenter', function() {
    clearTimeout(hideTimer);
  });
  popoverEl.addEventListener('mouseleave', function() {
    hideRefPopover();
  });
  return popoverEl;
}

export function hideRefPopover() {
  clearTimeout(hideTimer);
  if (popoverEl) popoverEl.classList.add('hidden');
}

export function setupRefPopover(editorShell, opts) {
  const fetchPreview = opts.fetchPreview;
  const onOpen = opts.onOpen;

  function showPopover(anchor, noteId, title) {
    const pop = ensurePopover();
    pop.innerHTML =
      '<div class="notes-ref-popover-head">'
      + '<span class="notes-ref-popover-title">' + escapeHtml(title || '笔记') + '</span>'
      + '<span class="notes-ref-popover-loading">加载中…</span>'
      + '</div>'
      + '<div class="notes-ref-popover-body"></div>';
    pop.classList.remove('hidden');

    const rect = anchor.getBoundingClientRect();
    pop.style.left = Math.min(rect.left, window.innerWidth - 320) + 'px';
    pop.style.top = (rect.bottom + 8) + 'px';

    fetchPreview(noteId).then(function(data) {
      const loading = pop.querySelector('.notes-ref-popover-loading');
      if (loading) loading.remove();
      const body = pop.querySelector('.notes-ref-popover-body');
      if (!body) return;
      body.textContent = data.preview || '（空笔记）';
      const titleEl = pop.querySelector('.notes-ref-popover-title');
      if (titleEl && data.title) titleEl.textContent = data.title;
    }).catch(function() {
      const loading = pop.querySelector('.notes-ref-popover-loading');
      if (loading) loading.textContent = '无法加载预览';
    });

    pop.onclick = function(e) {
      e.preventDefault();
      onOpen?.(noteId);
      hideRefPopover();
    };
  }

  editorShell.addEventListener('mouseover', function(e) {
    const ref = e.target.closest('[data-note-ref]');
    if (!ref) return;
    clearTimeout(hideTimer);
    const id = ref.getAttribute('data-note-ref');
    if (!id) return;
    showPopover(ref, id, ref.textContent.trim());
  });

  editorShell.addEventListener('mouseout', function(e) {
    const ref = e.target.closest('[data-note-ref]');
    if (!ref) return;
    hideTimer = setTimeout(hideRefPopover, 200);
  });

  return function cleanup() {
    hideRefPopover();
    if (popoverEl) {
      popoverEl.remove();
      popoverEl = null;
    }
  };
}
