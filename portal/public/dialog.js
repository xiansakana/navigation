(function () {
  var queue = [];
  var busy = false;
  var host = null;
  var lastFocus = null;

  function ensureHost() {
    if (host && document.body.contains(host)) return host;
    host = document.createElement('div');
    host.className = 'portal-dialog-host';
    host.hidden = true;
    document.body.appendChild(host);
    return host;
  }

  function normalizeOpts(message, arg2, arg3) {
    var opts = {};
    var defaultValue = '';
    if (typeof arg2 === 'object' && arg2 !== null) {
      opts = arg2;
    } else {
      defaultValue = arg2 == null ? '' : String(arg2);
      if (typeof arg3 === 'object' && arg3 !== null) opts = arg3;
    }
    return {
      message: String(message == null ? '' : message),
      defaultValue: defaultValue,
      title: opts.title || '',
      okText: opts.okText || '确定',
      cancelText: opts.cancelText || '取消',
      danger: !!opts.danger
    };
  }

  function enqueue(type, message, arg2, arg3) {
    var opts = normalizeOpts(message, arg2, arg3);
    return new Promise(function (resolve) {
      queue.push({ type: type, opts: opts, resolve: resolve });
      pump();
    });
  }

  function pump() {
    if (busy || !queue.length) return;
    busy = true;
    var item = queue.shift();
    render(item);
  }

  function finish(result) {
    busy = false;
    if (host) host.hidden = true;
    if (host) host.innerHTML = '';
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus(); } catch (e) { /* ignore */ }
    }
    lastFocus = null;
    document.body.classList.remove('portal-dialog-open');
    pump();
    return result;
  }

  function render(item) {
    var root = ensureHost();
    lastFocus = document.activeElement;
    document.body.classList.add('portal-dialog-open');

    var o = item.opts;
    var isPrompt = item.type === 'prompt';
    var isConfirm = item.type === 'confirm';
    var showCancel = isConfirm || isPrompt;

    root.innerHTML = ''
      + '<div class="portal-dialog-backdrop" data-action="backdrop"></div>'
      + '<div class="portal-dialog" role="dialog" aria-modal="true"'
      + (o.title ? ' aria-labelledby="portal-dialog-title"' : ' aria-label="对话框"')
      + '>'
      + (o.title ? '<h2 class="portal-dialog-title" id="portal-dialog-title">' + escapeHtml(o.title) + '</h2>' : '')
      + '<div class="portal-dialog-message">' + formatMessage(o.message) + '</div>'
      + (isPrompt ? '<input type="text" class="portal-dialog-input" value="' + escapeAttr(o.defaultValue) + '">' : '')
      + '<div class="portal-dialog-actions">'
      + (showCancel ? '<button type="button" class="btn ghost" data-action="cancel">' + escapeHtml(o.cancelText) + '</button>' : '')
      + '<button type="button" class="btn primary' + (o.danger ? ' portal-dialog-danger' : '') + '" data-action="ok">' + escapeHtml(o.okText) + '</button>'
      + '</div></div>';

    root.hidden = false;

    var dialog = root.querySelector('.portal-dialog');
    var input = root.querySelector('.portal-dialog-input');
    var okBtn = root.querySelector('[data-action="ok"]');

    function resolveOk() {
      var value = isPrompt && input ? input.value : true;
      item.resolve(finish(isPrompt ? value : true));
    }

    function resolveCancel() {
      item.resolve(finish(isPrompt ? null : false));
    }

    okBtn.addEventListener('click', resolveOk);
    root.querySelector('[data-action="cancel"]')?.addEventListener('click', resolveCancel);
    root.querySelector('[data-action="backdrop"]')?.addEventListener('click', resolveCancel);

    dialog.addEventListener('click', function (e) { e.stopPropagation(); });

    root.onkeydown = function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        resolveCancel();
      } else if (e.key === 'Enter' && (!isPrompt || e.target === input)) {
        e.preventDefault();
        resolveOk();
      }
    };

    if (input) {
      input.focus();
      input.select();
    } else {
      okBtn.focus();
    }
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(text) {
    return escapeHtml(text).replace(/'/g, '&#39;');
  }

  function formatMessage(text) {
    return escapeHtml(text).replace(/\n/g, '<br>');
  }

  window.portalDialog = {
    alert: function (message, opts) {
      return enqueue('alert', message, opts).then(function () {});
    },
    confirm: function (message, opts) {
      return enqueue('confirm', message, opts);
    },
    prompt: function (message, defaultValue, opts) {
      return enqueue('prompt', message, defaultValue, opts);
    }
  };
})();
