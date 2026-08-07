(function () {
  var KEY = 'smFullWidthLayout';

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw != null) return JSON.parse(raw) === true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function updateButtons(on) {
    document.querySelectorAll('.navbar-layout-btn').forEach(function (btn) {
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.title = on ? '退出全宽布局' : '全宽布局';
    });
  }

  function apply(on) {
    var app = document.querySelector('.sm-app');
    if (app) app.classList.toggle('sm-app--full', on);
    updateButtons(on);
  }

  function set(on) {
    try { localStorage.setItem(KEY, JSON.stringify(!!on)); } catch (e) { /* ignore */ }
    apply(!!on);
    window.dispatchEvent(new CustomEvent('portal-layout-change', { detail: { fullWidth: !!on } }));
  }

  function toggle() {
    set(!load());
  }

  function boot() {
    if (!document.body.classList.contains('stock-proxied')) return;
    apply(load());
    document.addEventListener('click', function (e) {
      if (e.target.closest('.navbar-layout-btn')) {
        e.preventDefault();
        toggle();
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.portalLayout = { toggle: toggle, set: set, get: load };
})();
