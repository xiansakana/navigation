(function () {
  var KEY = 'portal-theme';

  function stored() {
    try {
      var t = localStorage.getItem(KEY);
      if (t === 'light' || t === 'dark') return t;
    } catch (e) { /* ignore */ }
    return null;
  }

  function effective() {
    var s = stored();
    if (s) return s;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function updateButtons(theme) {
    var isLight = theme === 'light';
    document.querySelectorAll('.navbar-theme-btn').forEach(function (btn) {
      var label = isLight ? '切换到夜间模式' : '切换到日间模式';
      btn.setAttribute('aria-label', label);
      btn.title = label;
      var icon = btn.querySelector('.navbar-theme-icon');
      if (icon) icon.textContent = isLight ? '🌙' : '☀️';
      var text = btn.querySelector('.navbar-theme-label');
      if (text) text.textContent = isLight ? '夜间' : '日间';
    });
  }

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    updateButtons(theme);
  }

  function setTheme(theme) {
    if (theme !== 'light' && theme !== 'dark') return;
    try { localStorage.setItem(KEY, theme); } catch (e) { /* ignore */ }
    apply(theme);
  }

  function toggle() {
    setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
  }

  apply(effective());

  document.addEventListener('click', function (e) {
    if (e.target.closest('.navbar-theme-btn')) {
      e.preventDefault();
      toggle();
    }
  });

  window.portalTheme = { toggle: toggle, set: setTheme, get: function () { return document.documentElement.getAttribute('data-theme'); } };
})();
