(function () {
  var DEFAULT_DURATION = 3200;
  var host = null;

  function ensureHost() {
    if (host && document.body.contains(host)) return host;
    host = document.createElement('div');
    host.className = 'portal-toast-host';
    host.setAttribute('aria-live', 'polite');
    host.setAttribute('aria-relevant', 'additions');
    document.body.appendChild(host);
    return host;
  }

  function dismiss(el) {
    if (!el || el.classList.contains('portal-toast--out')) return;
    el.classList.add('portal-toast--out');
    setTimeout(function () { el.remove(); }, 200);
  }

  function show(message, opts) {
    opts = opts || {};
    var type = opts.type || 'info';
    var duration = opts.duration != null ? opts.duration : DEFAULT_DURATION;
    var text = String(message == null ? '' : message).trim();
    if (!text) return;

    var el = document.createElement('div');
    el.className = 'portal-toast portal-toast--' + type;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.textContent = text;

    var root = ensureHost();
    root.appendChild(el);

    var timer = setTimeout(function () { dismiss(el); }, duration);
    el.addEventListener('click', function () {
      clearTimeout(timer);
      dismiss(el);
    });
  }

  var api = {
    show: show,
    info: function (m, o) { show(m, Object.assign({}, o, { type: 'info' })); },
    success: function (m, o) { show(m, Object.assign({}, o, { type: 'success' })); },
    error: function (m, o) { show(m, Object.assign({}, o, { type: 'error', duration: o && o.duration != null ? o.duration : 4200 })); },
    warn: function (m, o) { show(m, Object.assign({}, o, { type: 'warn', duration: o && o.duration != null ? o.duration : 3800 })); }
  };

  window.portalToast = api;

  window.alert = function (msg) {
    if (msg == null || msg === '') return;
    api.info(String(msg).replace(/\n+/g, ' · '));
  };
})();
