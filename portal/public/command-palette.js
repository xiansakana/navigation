(function () {
  if (window.__portalCommandPaletteInstalled) return;
  window.__portalCommandPaletteInstalled = true;

  var KEY = 'Escape';
  var host = null;
  var shadow = null;
  var panel = null;
  var input = null;
  var list = null;
  var items = [];
  var filtered = [];
  var cursor = 0;
  var loaded = null;
  var openState = false;

  var STYLE = `
    :host {
      --cp-bg: #121826;
      --cp-bg-soft: #171f30;
      --cp-border: rgba(148, 170, 205, .22);
      --cp-text: #edf2fa;
      --cp-muted: #8d9bb2;
      --cp-accent: #6ba1ff;
      --cp-accent-soft: rgba(107, 161, 255, .14);
      --cp-shadow: 0 28px 80px rgba(0, 0, 0, .55);
      all: initial;
      font-family: var(--ds-font, system-ui, -apple-system, "Segoe UI", sans-serif);
    }
    *, *::before, *::after { box-sizing: border-box; }
    .overlay {
      position: fixed; inset: 0; z-index: 2147483000;
      display: flex; align-items: flex-start; justify-content: center;
      padding: min(14vh, 120px) 16px 16px;
      background: rgba(6, 9, 16, .62);
      backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
      color: var(--cp-text);
      opacity: 0; pointer-events: none; transition: opacity .16s ease;
    }
    .overlay[data-open="true"] { opacity: 1; pointer-events: auto; }
    .panel {
      width: min(600px, 100%);
      background: var(--cp-bg);
      border: 1px solid var(--cp-border);
      border-radius: 16px;
      box-shadow: var(--cp-shadow);
      overflow: hidden;
      transform: translateY(-8px) scale(.985);
      transition: transform .18s cubic-bezier(.2, .8, .2, 1);
    }
    .overlay[data-open="true"] .panel { transform: translateY(0) scale(1); }
    .search-row {
      display: flex; align-items: center; gap: 12px;
      padding: 15px 18px;
      border-bottom: 1px solid var(--cp-border);
    }
    .search-icon { width: 18px; height: 18px; flex: none; color: var(--cp-muted); }
    input {
      flex: 1; min-width: 0; border: 0; outline: 0; background: transparent;
      color: var(--cp-text); font: inherit; font-size: 15px;
    }
    input::placeholder { color: var(--cp-muted); }
    .esc {
      font-size: 11px; color: var(--cp-muted);
      border: 1px solid var(--cp-border); border-radius: 6px;
      padding: 3px 7px; white-space: nowrap;
    }
    .results { max-height: min(52vh, 420px); overflow-y: auto; padding: 8px; }
    .group {
      font-size: 11px; font-weight: 650; letter-spacing: .09em;
      text-transform: uppercase; color: var(--cp-muted);
      padding: 10px 10px 6px;
    }
    .item {
      display: flex; align-items: center; gap: 12px;
      width: 100%; padding: 10px 12px; border: 0; border-radius: 10px;
      background: transparent; color: inherit; font: inherit; text-align: left;
      cursor: pointer; transition: background .12s ease;
    }
    .item:hover, .item[data-active="true"] { background: var(--cp-accent-soft); }
    .item-icon {
      width: 30px; height: 30px; flex: none; display: grid; place-items: center;
      border-radius: 8px; background: var(--cp-bg-soft);
      border: 1px solid var(--cp-border); font-size: 15px;
    }
    .item-body { min-width: 0; flex: 1; }
    .item-title { display: block; font-size: 13.5px; font-weight: 550; }
    .item-sub { display: block; font-size: 11.5px; color: var(--cp-muted); margin-top: 1px; }
    .item-hint { font-size: 11px; color: var(--cp-muted); flex: none; }
    .empty { padding: 36px 16px; text-align: center; color: var(--cp-muted); font-size: 13px; }
    .footer {
      display: flex; gap: 16px; align-items: center; flex-wrap: wrap;
      padding: 10px 18px; border-top: 1px solid var(--cp-border);
      font-size: 11px; color: var(--cp-muted);
    }
    .footer kbd {
      border: 1px solid var(--cp-border); border-radius: 4px;
      padding: 1px 5px; font: inherit; margin-right: 4px;
    }
    @media (max-width: 640px) {
      .overlay { padding-top: 8vh; }
      .footer { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .overlay, .panel { transition: none; }
    }
  `;

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function can(permissions, permission) {
    if (!permission) return true;
    return permissions.some(function (p) {
      return p === '*' || p === permission || p === permission.replace(/:view$/, ':edit') ||
        (p.endsWith(':*') && permission.startsWith(p.slice(0, -1)));
    });
  }

  function score(haystack, needle) {
    if (!needle) return 1;
    var text = haystack.toLowerCase();
    var q = needle.toLowerCase();
    if (text.indexOf(q) !== -1) return 100 - text.indexOf(q);
    var qi = 0;
    for (var i = 0; i < text.length && qi < q.length; i++) if (text[i] === q[qi]) qi++;
    return qi === q.length ? 20 : 0;
  }

  function iconFor(title) {
    var map = {
      '股票管理': '📈', '抄底监控': '📉', '量化分析': '🧮', '持仓': '💼',
      '知识库': '📚', '命理': '☯', '资源管理': '🖥', '权限管理': '🔐',
      '通知管理': '🔔', '记账': '🧾', 'Torn': '🛠', '购物助手': '🛒',
      '监控': '👁', '压价助手': '💰', '公司申请监听': '🏢', '博客': '✍️'
    };
    for (var key in map) if (title.indexOf(key) !== -1) return map[key];
    return '⚡';
  }

  async function buildItems() {
    if (loaded) return loaded;
    loaded = (async function () {
      var catalog = { services: [] }, me = { permissions: [] };
      try {
        var results = await Promise.all([
          window.portalPage.services().catch(function () { return { services: [] }; }),
          window.portalPage.user().catch(function () { return { permissions: [] }; })
        ]);
        catalog = results[0] || catalog;
        me = results[1] || me;
      } catch (e) { /* palette still offers local actions */ }
      var permissions = me.permissions || [];
      var out = [];

      (catalog.services || []).forEach(function (service) {
        var href = service.path || service.url;
        if (!href) return;
        out.push({
          title: service.title,
          sub: service.description || '打开服务',
          href: href,
          group: '服务',
          icon: service.icon || iconFor(service.title),
          newTab: service.newTab,
          keywords: service.title + ' ' + (service.description || '') + ' ' + (service.id || '')
        });
      });

      var submenus = [
        ['持仓', '/stock-manage/', 'service:stock-manage:view', '股票'],
        ['抄底监控', '/stock-manage/dip/', 'service:qqq-dip:view', '股票'],
        ['量化分析', '/stock-manage/quant/', 'service:stock-manage:tab-quant:view', '股票'],
        ['购物助手', '/torn-toolbox/shopping/', 'torn-shopping:view', 'Torn'],
        ['监控', '/torn-toolbox/chain/', 'torn-chain:view', 'Torn'],
        ['压价助手', '/torn-toolbox/undercut/', 'service:torn-undercut:view', 'Torn'],
        ['公司申请监听', '/torn-toolbox/company/', 'service:torn-company:view', 'Torn']
      ];
      submenus.forEach(function (entry) {
        if (!can(permissions, entry[2])) return;
        out.push({
          title: entry[0], sub: entry[3] + ' 子模块', href: entry[1],
          group: '子模块', icon: iconFor(entry[0]), keywords: entry[0] + ' ' + entry[3]
        });
      });

      out.push({
        title: '切换主题', sub: '在日间与夜间模式之间切换', group: '操作', icon: '🌗',
        keywords: 'theme dark light 主题 夜间 日间',
        action: function () { if (window.portalTheme) window.portalTheme.toggle(); }
      });
      out.push({
        title: '切换全宽布局', sub: '展开或收起页面宽度限制', group: '操作', icon: '⛶',
        keywords: 'layout full width 全宽 布局',
        action: function () { if (window.portalLayout) window.portalLayout.toggle(); }
      });

      return out;
    })();
    return loaded;
  }

  function render() {
    if (!shadow) return;
    var query = input.value.trim();
    filtered = items.map(function (item) {
      return { item: item, rank: score(item.title + ' ' + item.keywords, query) };
    }).filter(function (entry) { return entry.rank > 0; })
      .sort(function (a, b) { return b.rank - a.rank; })
      .map(function (entry) { return entry.item; })
      .slice(0, 40);
    if (cursor >= filtered.length) cursor = 0;

    if (!filtered.length) {
      list.innerHTML = '<div class="empty">没有找到匹配的服务或操作</div>';
      return;
    }
    var html = '', lastGroup = null;
    filtered.forEach(function (item, index) {
      if (item.group !== lastGroup) {
        html += '<div class="group">' + escapeHtml(item.group) + '</div>';
        lastGroup = item.group;
      }
      html += '<button type="button" class="item" data-index="' + index + '" data-active="' + (index === cursor) + '">' +
        '<span class="item-icon">' + escapeHtml(item.icon || '⚡') + '</span>' +
        '<span class="item-body"><span class="item-title">' + escapeHtml(item.title) + '</span>' +
        '<span class="item-sub">' + escapeHtml(item.sub) + '</span></span>' +
        '<span class="item-hint">' + (index === cursor ? '↵' : '') + '</span></button>';
    });
    list.innerHTML = html;
    Array.prototype.forEach.call(list.querySelectorAll('.item'), function (button) {
      button.addEventListener('mouseenter', function () { setCursor(+button.dataset.index); });
      button.addEventListener('click', function () { activate(+button.dataset.index); });
    });
  }

  function setCursor(index) {
    if (index === cursor) return;
    cursor = index;
    Array.prototype.forEach.call(list.querySelectorAll('.item'), function (button) {
      var active = +button.dataset.index === cursor;
      button.dataset.active = active;
      button.querySelector('.item-hint').textContent = active ? '↵' : '';
    });
  }

  function move(delta) {
    if (!filtered.length) return;
    setCursor((cursor + delta + filtered.length) % filtered.length);
    var active = list.querySelector('.item[data-active="true"]');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function activate(index) {
    var item = filtered[index];
    if (!item) return;
    close();
    if (item.action) { item.action(); return; }
    try {
      var url = new URL(item.href, location.origin);
      if (!['http:', 'https:'].includes(url.protocol)) return;
      if (item.newTab) window.open(url.href, '_blank', 'noopener,noreferrer');
      else location.href = url.href;
    } catch (e) { /* ignore malformed targets */ }
  }

  function close() {
    if (!openState) return;
    openState = false;
    if (host) host.shadowRoot.querySelector('.overlay').dataset.open = 'false';
    document.documentElement.style.removeProperty('overflow');
  }

  async function open() {
    if (openState) return;
    if (!host) mount();
    openState = true;
    host.shadowRoot.querySelector('.overlay').dataset.open = 'true';
    document.documentElement.style.overflow = 'hidden';
    input.value = '';
    list.innerHTML = '<div class="empty">正在加载服务目录…</div>';
    try {
      items = await buildItems();
      render();
    } catch (e) {
      list.innerHTML = '<div class="empty">服务目录暂时不可用</div>';
    }
    requestAnimationFrame(function () { input.focus(); });
  }

  function mount() {
    host = document.createElement('div');
    host.setAttribute('data-portal-command-palette', '');
    shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = STYLE;
    var overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.dataset.open = 'false';
    overlay.innerHTML =
      '<div class="panel" role="dialog" aria-modal="true" aria-label="命令面板">' +
        '<div class="search-row">' +
          '<svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' +
          '<input type="text" placeholder="搜索服务、模块或操作…" aria-label="搜索命令" autocomplete="off" spellcheck="false">' +
          '<span class="esc">ESC</span>' +
        '</div>' +
        '<div class="results" role="listbox" aria-label="搜索结果"></div>' +
        '<div class="footer"><span><kbd>↑↓</kbd>选择</span><span><kbd>↵</kbd>打开</span><span><kbd>esc</kbd>关闭</span></div>' +
      '</div>';
    shadow.append(style, overlay);
    document.body.append(host);

    panel = overlay.querySelector('.panel');
    input = overlay.querySelector('input');
    list = overlay.querySelector('.results');

    input.addEventListener('input', render);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
      else if (event.key === 'Enter') { event.preventDefault(); activate(cursor); }
      else if (event.key === 'Escape') { event.preventDefault(); close(); }
    });
    overlay.addEventListener('mousedown', function (event) {
      if (event.target === overlay) close();
    });
  }

  document.addEventListener('keydown', function (event) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      var target = event.target;
      if (target && (target.matches('input, textarea, [contenteditable="true"]') || target.isContentEditable)) return;
      event.preventDefault();
      if (openState) close(); else open();
    } else if (event.key === KEY && openState) {
      event.preventDefault();
      close();
    }
  }, true);

  window.portalCommandPalette = { open: open, close: close };

  var hint = document.createElement('button');
  hint.type = 'button';
  hint.setAttribute('data-portal-command-hint', '');
  hint.title = '命令面板 (Ctrl/⌘ + K)';
  hint.setAttribute('aria-label', '打开命令面板');
  hint.textContent = '⌘K';
  hint.addEventListener('click', open);
  document.addEventListener('DOMContentLoaded', function () {
    var navbar = document.querySelector('.navbar-inner');
    if (!navbar) return;
    var actions = navbar.querySelector('.navbar-actions');
    if (actions) actions.prepend(hint);
  });
  if (document.readyState !== 'loading' && document.querySelector('.navbar-inner')) {
    var actions = document.querySelector('.navbar-actions');
    if (actions) actions.prepend(hint);
  }
})();
