(function () {
  if (window.portalNavbarDropdown) return;
  window.portalNavbarDropdown = true;
  var style = document.createElement('link'); style.rel = 'stylesheet'; style.href = '/navbar-dropdown.css?v=1'; document.head.append(style);
  async function boot() {
    var navbar = document.querySelector('.navbar');
    if (!navbar) return;
    try {
      var results = await Promise.all([fetch('/api/services'), fetch('/api/me')]);
      if (results.some(function (r) { return !r.ok; })) return;
      var services = (await results[0].json()).services || [], me = await results[1].json();
      var permissions = me.permissions || [];
      var can = function (p) { return permissions.includes('*') || permissions.includes(p) || permissions.includes(p.replace(/:view$/, ':edit')) || permissions.some(function (g) { return g.endsWith(':*') && p.startsWith(g.slice(0, -1)); }); };
      var path = location.pathname, active = null;
      var home = services.map(function (s) { return { title: s.title, href: s.path || s.url, newTab: s.newTab }; });
      var torn = [
        ['购物助手', '/torn-toolbox/shopping/', 'torn-shopping:view'],
        ['监控', '/torn-toolbox/chain/', 'torn-chain:view'],
        ['压价助手', '/torn-toolbox/undercut/', 'service:torn-undercut:view'],
        ['公司申请监听', '/torn-toolbox/company/', 'service:torn-company:view']
      ].filter(function (s) { return can(s[2]); }).map(function (s) { return { title: s[0], href: s[1] }; });
      var stock = [
        ['持仓', '/stock-manage/', 'service:stock-manage:view'],
        ['抄底监控', '/stock-manage/dip/', 'service:qqq-dip:view'],
        ['量化分析', '/stock-manage/quant/', 'service:stock-manage:tab-quant:view'],
        ['梭哈', '/stock-manage/yolo/', 'service:stock-manage:tab-yolo:view']
      ].filter(function (s) { return can(s[2]); }).map(function (s) { return { title: s[0], href: s[1] }; });
      function close() { if (!active) return; active.panel.remove(); active.button.setAttribute('aria-expanded', 'false'); active = null; }
      function attach(element, name, entries) {
        if (!element || element.closest('.portal-nav-dropdown') || !entries().length) return;
        var wrap = document.createElement('span'); wrap.className = 'portal-nav-dropdown';
        element.before(wrap); wrap.append(element);
        var button = document.createElement('button'); button.type = 'button'; button.className = 'portal-nav-toggle'; button.textContent = '▾';
        button.setAttribute('aria-label', '展开' + name + '子模块'); button.setAttribute('aria-expanded', 'false');
        wrap.append(button);
        var timer;
        function open() {
          clearTimeout(timer);
          if (active?.button === button) return;
          close();
          var items = entries(); if (!items.length) return;
          var panel = document.createElement('nav'); panel.className = 'portal-nav-menu'; panel.setAttribute('aria-label', name + '子模块');
          items.forEach(function (item) {
            var link = document.createElement(item.action ? 'button' : 'a'); link.textContent = item.title;
            if (item.action) { link.type = 'button'; link.onclick = function () { close(); item.action(); }; }
            else {
              try { var url = new URL(item.href, location.origin); if (!['https:', 'http:'].includes(url.protocol)) return; link.href = url.href; } catch { return; }
              if (item.newTab) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
              if (new URL(link.href).pathname === path) link.setAttribute('aria-current', 'page');
            }
            panel.append(link);
          });
          if (!panel.children.length) return;
          document.body.append(panel); active = { panel: panel, button: button, wrap: wrap };
          var rect = wrap.getBoundingClientRect(); panel.style.left = Math.max(8, Math.min(rect.left, innerWidth - panel.offsetWidth - 8)) + 'px'; panel.style.top = Math.min(rect.bottom + 4, innerHeight - 80) + 'px';
          panel.style.maxHeight = Math.max(60, innerHeight - rect.bottom - 16) + 'px';
          button.setAttribute('aria-expanded', 'true');
          panel.addEventListener('pointerenter', function () { clearTimeout(timer); }); panel.addEventListener('pointerleave', deferClose);
        }
        function deferClose() { timer = setTimeout(close, 180); }
        wrap.addEventListener('pointerenter', function (event) { if (event.pointerType !== 'touch') open(); });
        wrap.addEventListener('pointerleave', deferClose);
        button.addEventListener('click', function () { if (active?.button === button && active.clicked) close(); else { open(); if (active?.button === button) active.clicked = true; } });
        button.addEventListener('keydown', function (event) { if (event.key === 'ArrowDown') { event.preventDefault(); open(); active?.panel.querySelector('a,button')?.focus(); } });
      }
      attach(navbar.querySelector('.navbar-brand'), '服务导航', function () { return home; });
      navbar.querySelectorAll('.navbar-link, .navbar-title').forEach(function (el) {
        var href = el.getAttribute('href') || '', label = el.textContent.trim();
        if (href.replace(/\/$/, '') === '/torn-toolbox' || label === 'Torn 工具箱') attach(el, 'Torn 工具箱', function () { return torn; });
        else if (href === '/' || label === '首页') attach(el, '首页', function () { return home; });
        else attach(el, label, function () {
          var items = path.startsWith('/stock-manage/') ? stock.slice() : path === '/torn-toolbox/' ? torn.slice() : [];
          var seen = new Set(items.map(function (i) { return i.href; }));
          document.querySelectorAll('main nav a, main nav button, .quant-sidebar nav button, .toolbox-card').forEach(function (target) {
            if (!target.getClientRects().length || target.hidden || target.disabled || target.closest('.portal-nav-menu')) return;
            var title = target.textContent.trim().replace(/\s+/g, ' '), href = target.getAttribute('href');
            if (!title || seen.has(href || title)) return;
            seen.add(href || title);
            items.push(href ? { title: title, href: href } : { title: title, action: function () { target.click(); target.scrollIntoView({ block: 'nearest' }); } });
          });
          return items;
        });
      });
      document.addEventListener('pointerdown', function (event) { if (active && !active.wrap.contains(event.target) && !active.panel.contains(event.target)) close(); });
      document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && active) { var button = active.button; close(); button.focus(); } });
      document.addEventListener('focusin', function (event) { if (active && !active.wrap.contains(event.target) && !active.panel.contains(event.target)) close(); });
      window.addEventListener('resize', close); window.addEventListener('scroll', close);
    } catch { /* Existing navigation links remain usable if the menu cannot load. */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
