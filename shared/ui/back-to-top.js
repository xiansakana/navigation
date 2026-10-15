(function () {
  if (window.navigationBackToTop) return;
  window.navigationBackToTop = true;

  function init() {
    const host = document.createElement('div');
    host.id = 'navigation-back-to-top';
    // Isolate the control from styles in proxied applications.
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host { position: fixed; right: max(20px, env(safe-area-inset-right));
        bottom: calc(88px + env(safe-area-inset-bottom)); z-index: 1000; }
      button { display: grid; place-items: center; width: 44px; height: 44px;
        padding: 0; border: 1px solid var(--border, #77889966); border-radius: 50%;
        background: var(--surface, #fff); color: var(--text, #243247);
        box-shadow: 0 3px 14px #0002; cursor: pointer; }
      button[hidden] { display: none; }
      button:hover { box-shadow: 0 4px 18px #0004; }
      button:focus-visible { outline: 3px solid #4c8dff; outline-offset: 3px; }
      @media (prefers-color-scheme: dark) {
        button { background: var(--surface, #253040); color: var(--text, #f4f6fa); }
      }
    </style><button type="button" aria-label="回到顶部" title="回到顶部" hidden>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M5 4h14M6 13l6-6 6 6M12 7v14"/>
      </svg></button>`;
    document.body.appendChild(host);
    const button = root.querySelector('button');
    let current = null;
    let queued = false;
    const pageRoot = () => document.scrollingElement || document.documentElement;
    const threshold = (target) => Math.max(240, Math.min(480, (target.clientHeight || window.innerHeight) * 0.6));
    function eligible(target) {
      if (target === pageRoot()) return true;
      if (!(target instanceof HTMLElement) || !target.isConnected) return false;
      if (target.closest('[role="dialog"], dialog, [aria-modal="true"], .modal, textarea, [contenteditable]:not([contenteditable="false"])')) return false;
      return target.clientHeight >= 120 && /auto|scroll/.test(getComputedStyle(target).overflowY);
    }
    function update() {
      queued = false;
      if (!current || !eligible(current) || current.scrollTop <= threshold(current)) current = pageRoot();
      button.hidden = current.scrollTop <= threshold(current);
    }
    function schedule() {
      if (!queued) { queued = true; requestAnimationFrame(update); }
    }
    document.addEventListener('scroll', function (event) {
      const target = event.target === document ? pageRoot() : event.target;
      if (eligible(target)) { current = target; schedule(); }
    }, { capture: true, passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    window.addEventListener('pageshow', schedule);
    // SPA navigation and content replacement can remove the active scrolling region.
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    button.addEventListener('click', function () {
      if (!current || !eligible(current)) current = pageRoot();
      const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
      current.scrollTo({ top: 0, left: current.scrollLeft, behavior });
    });
    update();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
