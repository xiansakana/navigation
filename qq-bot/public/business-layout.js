// Recompute masonry spans from actual card heights, not viewport breakpoints.
// ResizeObserver also fires for browser zoom, font changes and dynamic forms.
(function () {
  const host = document.querySelector('.business-panels');
  if (!host) return;
  let frame = 0;
  const observed = new Set();
  function schedule() { if (!frame) frame = requestAnimationFrame(layout); }
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  function layout() {
    frame = 0;
    host.classList.add('masonry-ready');
    const style = getComputedStyle(host), gap = parseFloat(style.rowGap) || 0;
    const unit = (parseFloat(style.gridAutoRows) || 1) + gap;
    const cards = new Set(host.querySelectorAll('.business-card'));
    for (const card of observed) if (!cards.has(card)) { resize?.unobserve(card); observed.delete(card); }
    for (const card of cards) {
      if (!observed.has(card)) { observed.add(card); resize?.observe(card); }
      if (!card.getClientRects().length) continue;
      const span = 'span ' + Math.ceil((card.getBoundingClientRect().height + gap) / unit);
      if (card.style.gridRowEnd !== span) card.style.gridRowEnd = span;
    }
  }
  resize?.observe(host);
  new MutationObserver(schedule).observe(host, { childList:true, subtree:true, attributes:true, attributeFilter:['hidden'] });
  window.addEventListener('resize', schedule);
  document.fonts?.ready.then(schedule);
  schedule();
}());
