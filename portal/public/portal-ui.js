/**
 * Portal UI facade — one entry point for transient UI.
 *
 * Historically the portal had three coexisting patterns:
 *   - window.portalDialog (promise based, styled)
 *   - native <dialog> elements (form style modals)
 *   - window.confirm / window.prompt (browser chrome)
 *
 * portalUI keeps the styled implementations in one place and gives every
 * module a single, stable API. dialog.js owns confirm/alert/prompt,
 * toast.js owns transient notices, and both stay usable on their own so
 * existing call sites keep working while they migrate.
 */
(function () {
  if (window.portalUI) return;

  function dialog() {
    var api = window.portalDialog;
    return api && typeof api.confirm === 'function' ? api : null;
  }

  function toast() {
    return window.portalToast || null;
  }

  function alert(message, opts) {
    var api = dialog();
    if (api) return api.alert(message, opts);
    if (window.alert) window.alert(message);
    return Promise.resolve();
  }

  function confirm(message, opts) {
    var api = dialog();
    if (api) return api.confirm(message, opts);
    return Promise.resolve(window.confirm ? window.confirm(message) : true);
  }

  function prompt(message, defaultValue, opts) {
    var api = dialog();
    if (api) return api.prompt(message, defaultValue, opts);
    return Promise.resolve(window.prompt ? window.prompt(message, defaultValue == null ? '' : defaultValue) : null);
  }

  function notify(type) {
    return function (message, opts) {
      var api = toast();
      if (api && typeof api[type] === 'function') return api[type](message, opts);
      return undefined;
    };
  }

  window.portalUI = {
    // Confirm / alert / prompt (all promise based).
    alert: alert,
    confirm: confirm,
    prompt: prompt,
    // Optional chaining friendly aliases: `portalDialog` may be absent on
    // pages that never load dialog.js, portalUI always resolves.
    available: function () { return !!dialog(); },
    // Transient notices.
    toast: {
      show: function (message, opts) {
        var api = toast();
        return api && typeof api.show === 'function' ? api.show(message, opts) : undefined;
      },
      info: notify('info'),
      success: notify('success'),
      error: notify('error'),
      warn: notify('warn')
    }
  };
})();
