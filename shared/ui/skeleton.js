(function () {
  const regions = new Map();
  const line = '<span class="nav-skeleton-line"></span>';
  const short = '<span class="nav-skeleton-line nav-skeleton-short"></span>';
  const card = `<div class="nav-skeleton-card">${short}${line}${short}</div>`;

  function start(key = 'page') {
    const root = document.querySelector(`[data-skeleton-key="${key}"]`);
    if (!root || regions.has(key)) return;
    const overlay = document.createElement('div');
    overlay.className = 'nav-skeleton';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-label', '正在加载，请稍候');
    const type = root.dataset.skeleton;
    overlay.innerHTML = '<div aria-hidden="true"><span class="nav-skeleton-line nav-skeleton-title"></span>'
      + (type === 'form' ? `<div class="nav-skeleton-form">${line.repeat(5)}</div>`
        : `<div class="nav-skeleton-grid">${card.repeat(3)}</div>`
          + (type === 'cards' ? `<div class="nav-skeleton-grid">${card.repeat(3)}</div>`
            : `<span class="nav-skeleton-line nav-skeleton-chart"></span>${(`<div class="nav-skeleton-row">${line.repeat(4)}</div>`).repeat(5)}`))
      + '</div>';
    const previousBusy = root.getAttribute('aria-busy');
    root.removeAttribute('data-skeleton-ready');
    root.setAttribute('data-skeleton-active', '');
    root.setAttribute('aria-busy', 'true');
    root.appendChild(overlay);
    regions.set(key, { root, overlay, previousBusy });
  }

  function finish(key = 'page') {
    const region = regions.get(key);
    if (!region) return;
    region.overlay.remove();
    region.root.removeAttribute('data-skeleton-active');
    region.root.setAttribute('data-skeleton-ready', '');
    if (region.previousBusy === null) region.root.removeAttribute('aria-busy');
    else region.root.setAttribute('aria-busy', region.previousBusy);
    regions.delete(key);
    // Charts initialized while hidden keep their dimensions; redraw when shown.
    window.dispatchEvent(new Event('resize'));
  }

  window.navigationSkeleton = { start, finish };
  document.querySelectorAll('[data-skeleton-key]:not([data-skeleton-ready])').forEach((root) => start(root.dataset.skeletonKey));
  if (regions.size) {
    document.documentElement.classList.remove('portal-loading');
    document.documentElement.removeAttribute('aria-busy');
  }
  // Static pages have no data request to await.
  if (document.querySelector('[data-skeleton-static]')) {
    if (document.readyState === 'complete') finish();
    else window.addEventListener('load', () => finish(), { once: true });
  }
})();
