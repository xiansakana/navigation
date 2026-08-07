function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let activeMenu = null;
let docHandlers = null;

function removeDocHandlers() {
  if (!docHandlers) return;
  document.removeEventListener('mousedown', docHandlers.down, true);
  document.removeEventListener('keydown', docHandlers.key, true);
  document.removeEventListener('scroll', docHandlers.scroll, true);
  docHandlers = null;
}

export function closeContextMenu() {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
  removeDocHandlers();
}

/**
 * @param {{ x?: number, y?: number, anchor?: HTMLElement, items: Array<{id?:string,label?:string,icon?:string,danger?:boolean,disabled?:boolean,divider?:boolean}>, onSelect?: (id:string)=>void }} opts
 */
export function openContextMenu(opts) {
  closeContextMenu();
  const items = opts.items || [];
  if (!items.length) return;

  const menu = document.createElement('div');
  menu.className = 'notes-context-menu';
  menu.setAttribute('role', 'menu');

  const list = document.createElement('ul');
  list.className = 'notes-context-menu-list';

  items.forEach(function(item) {
    if (item.divider) {
      const sep = document.createElement('li');
      sep.className = 'notes-context-menu-sep';
      sep.setAttribute('role', 'separator');
      list.appendChild(sep);
      return;
    }
    const li = document.createElement('li');
    li.className = 'notes-context-menu-item'
      + (item.danger ? ' is-danger' : '')
      + (item.disabled ? ' is-disabled' : '');
    li.dataset.id = item.id || '';
    li.setAttribute('role', 'menuitem');
    li.innerHTML =
      (item.icon ? '<span class="notes-context-menu-icon">' + item.icon + '</span>' : '')
      + '<span>' + escapeHtml(item.label || '') + '</span>';
    if (!item.disabled) {
      li.addEventListener('mousedown', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const id = item.id || '';
        closeContextMenu();
        opts.onSelect?.(id);
      });
    }
    list.appendChild(li);
  });

  menu.appendChild(list);
  document.body.appendChild(menu);
  activeMenu = menu;

  const pad = 8;
  const rect = menu.getBoundingClientRect();
  let left = opts.x ?? 0;
  let top = opts.y ?? 0;

  if (opts.anchor) {
    const ar = opts.anchor.getBoundingClientRect();
    left = ar.right - rect.width;
    top = ar.bottom + 4;
    if (left < pad) left = ar.left;
  }

  if (left + rect.width > window.innerWidth - pad) {
    left = window.innerWidth - rect.width - pad;
  }
  if (top + rect.height > window.innerHeight - pad) {
    top = (opts.anchor ? opts.anchor.getBoundingClientRect().top : opts.y || 0) - rect.height - 4;
  }
  if (top < pad) top = pad;
  if (left < pad) left = pad;

  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  docHandlers = {
    down: function(e) {
      if (!menu.contains(e.target) && e.target !== opts.anchor) closeContextMenu();
    },
    key: function(e) {
      if (e.key === 'Escape') closeContextMenu();
    },
    scroll: function() { closeContextMenu(); }
  };
  document.addEventListener('mousedown', docHandlers.down, true);
  document.addEventListener('keydown', docHandlers.key, true);
  document.addEventListener('scroll', docHandlers.scroll, true);
}

export function bindContextMenu(el, getItems, onSelect) {
  el.addEventListener('contextmenu', function(e) {
    const items = getItems();
    if (!items || !items.length) return;
    e.preventDefault();
    e.stopPropagation();
    openContextMenu({ x: e.clientX, y: e.clientY, items: items, onSelect: onSelect });
  });
}
