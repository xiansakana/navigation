function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Lightweight Notion-style dropdown.
 * @param {HTMLElement} container
 * @param {{ items: Array<{value:string,label:string,hint?:string,icon?:string}>, value?: string, placeholder?: string, compact?: boolean, searchable?: boolean, onChange?: (value:string)=>void }} opts
 */
export function createDropdown(container, opts) {
  opts = opts || {};
  let items = opts.items || [];
  let value = opts.value ?? '';
  let open = false;
  let highlight = -1;

  container.classList.add('notes-dropdown');
  if (opts.compact) container.classList.add('notes-dropdown--compact');

  container.innerHTML =
    '<button type="button" class="notes-dropdown-trigger" aria-haspopup="listbox">'
    + '<span class="notes-dropdown-value"></span>'
    + '<span class="notes-dropdown-chevron" aria-hidden="true">▾</span>'
    + '</button>'
    + '<div class="notes-dropdown-panel hidden" role="listbox">'
    + (opts.searchable ? '<input type="search" class="notes-dropdown-search" placeholder="搜索…">' : '')
    + '<ul class="notes-dropdown-list"></ul>'
    + '</div>';

  const trigger = container.querySelector('.notes-dropdown-trigger');
  const valueEl = container.querySelector('.notes-dropdown-value');
  const panel = container.querySelector('.notes-dropdown-panel');
  const listEl = container.querySelector('.notes-dropdown-list');
  const searchEl = container.querySelector('.notes-dropdown-search');

  function labelFor(val) {
    const hit = items.find(function(it) { return it.value === val; });
    return hit ? hit.label : (opts.placeholder || '请选择');
  }

  function renderList(filter) {
    const q = (filter || '').trim().toLowerCase();
    const filtered = q
      ? items.filter(function(it) {
        return it.label.toLowerCase().includes(q) || (it.hint || '').toLowerCase().includes(q);
      })
      : items;
    listEl.innerHTML = '';
    if (!filtered.length) {
      listEl.innerHTML = '<li class="notes-dropdown-empty">无匹配项</li>';
      highlight = -1;
      return;
    }
    filtered.forEach(function(it, i) {
      const li = document.createElement('li');
      li.className = 'notes-dropdown-option'
        + (it.value === value ? ' is-selected' : '')
        + (i === highlight ? ' is-highlight' : '');
      li.dataset.value = it.value;
      li.setAttribute('role', 'option');
      li.innerHTML =
        (it.icon ? '<span class="notes-dropdown-option-icon">' + it.icon + '</span>' : '')
        + '<span class="notes-dropdown-option-body">'
        + '<span class="notes-dropdown-option-label">' + escapeHtml(it.label) + '</span>'
        + (it.hint ? '<span class="notes-dropdown-option-hint">' + escapeHtml(it.hint) + '</span>' : '')
        + '</span>'
        + (it.value === value ? '<span class="notes-dropdown-check" aria-hidden="true">✓</span>' : '');
      li.addEventListener('mousedown', function(e) {
        e.preventDefault();
        select(it.value);
      });
      listEl.appendChild(li);
    });
  }

  function syncTrigger() {
    valueEl.textContent = labelFor(value);
    valueEl.classList.toggle('is-placeholder', !items.some(function(it) { return it.value === value; }));
  }

  function openPanel() {
    if (open) return;
    open = true;
    highlight = -1;
    panel.classList.remove('hidden');
    trigger.setAttribute('aria-expanded', 'true');
    renderList(searchEl ? searchEl.value : '');
    if (searchEl) {
      searchEl.value = '';
      setTimeout(function() { searchEl.focus(); }, 0);
    }
    document.addEventListener('mousedown', onDocClick, true);
    document.addEventListener('keydown', onDocKey, true);
  }

  function closePanel() {
    if (!open) return;
    open = false;
    panel.classList.add('hidden');
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onDocClick, true);
    document.removeEventListener('keydown', onDocKey, true);
  }

  function select(val) {
    value = val;
    syncTrigger();
    closePanel();
    opts.onChange?.(val);
  }

  function onDocClick(e) {
    if (!container.contains(e.target)) closePanel();
  }

  function visibleOptions() {
    const q = searchEl ? searchEl.value.trim().toLowerCase() : '';
    return q
      ? items.filter(function(it) {
        return it.label.toLowerCase().includes(q) || (it.hint || '').toLowerCase().includes(q);
      })
      : items.slice();
  }

  function onDocKey(e) {
    if (!open) return;
    const vis = visibleOptions();
    if (e.key === 'Escape') {
      e.preventDefault();
      closePanel();
      trigger.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlight = Math.min(highlight + 1, vis.length - 1);
      renderList(searchEl ? searchEl.value : '');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlight = Math.max(highlight - 1, 0);
      renderList(searchEl ? searchEl.value : '');
    } else if (e.key === 'Enter' && highlight >= 0 && vis[highlight]) {
      e.preventDefault();
      select(vis[highlight].value);
    }
  }

  trigger.addEventListener('click', function() {
    if (open) closePanel();
    else openPanel();
  });

  trigger.addEventListener('keydown', function(e) {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPanel();
    }
  });

  if (searchEl) {
    searchEl.addEventListener('input', function() {
      highlight = 0;
      renderList(searchEl.value);
    });
    searchEl.addEventListener('keydown', function(e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
        onDocKey(e);
      }
    });
  }

  syncTrigger();
  renderList('');

  return {
    getValue: function() { return value; },
    setValue: function(val) {
      value = val;
      syncTrigger();
      if (open) renderList(searchEl ? searchEl.value : '');
    },
    setItems: function(next) {
      items = next || [];
      syncTrigger();
      if (open) renderList(searchEl ? searchEl.value : '');
    },
    close: closePanel,
    destroy: function() {
      closePanel();
      container.innerHTML = '';
      container.classList.remove('notes-dropdown', 'notes-dropdown--compact');
    }
  };
}
