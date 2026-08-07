import TaskList from 'https://esm.sh/@tiptap/extension-task-list@2.11.5';
import TaskItem from 'https://esm.sh/@tiptap/extension-task-item@2.11.5';
import { ToggleBlock, insertToggleBlock } from './toggle-block.js';

const SLASH_COMMANDS = [
  { id: 'paragraph', label: '正文', hint: '普通文本段落', icon: '¶', keywords: ['text', '段落', '正文'] },
  { id: 'h1', label: '标题 1', hint: '大号章节标题', icon: 'H1', keywords: ['heading', '标题'] },
  { id: 'h2', label: '标题 2', hint: '中号标题', icon: 'H2', keywords: ['heading', '标题'] },
  { id: 'h3', label: '标题 3', hint: '小号标题', icon: 'H3', keywords: ['heading', '标题'] },
  { id: 'toggle', label: '折叠块', hint: '可展开/收起的块', icon: '▸', keywords: ['toggle', '折叠', '展开'] },
  { id: 'bulletList', label: '无序列表', hint: '项目符号列表', icon: '•', keywords: ['list', '列表'] },
  { id: 'orderedList', label: '有序列表', hint: '编号列表', icon: '1.', keywords: ['list', '列表'] },
  { id: 'taskList', label: '待办清单', hint: '可勾选的任务', icon: '☑', keywords: ['todo', '待办', '任务'] },
  { id: 'blockquote', label: '引用', hint: '引用块', icon: '❝', keywords: ['quote', '引用'] },
  { id: 'codeBlock', label: '代码块', hint: '等宽代码', icon: '{ }', keywords: ['code', '代码'] },
  { id: 'hr', label: '分隔线', hint: '水平分割线', icon: '—', keywords: ['divider', '分割'] },
  { id: 'noteRef', label: '块引用', hint: '链接到其他笔记', icon: '🔗', keywords: ['link', '引用', 'ref'] }
];

const BLOCK_ACTIONS = [
  { id: 'paragraph', label: '转为正文', icon: '¶' },
  { id: 'h1', label: '转为标题 1', icon: 'H1' },
  { id: 'h2', label: '转为标题 2', icon: 'H2' },
  { id: 'h3', label: '转为标题 3', icon: 'H3' },
  { id: 'toggle', label: '转为折叠块', icon: '▸' },
  { id: 'bulletList', label: '转为无序列表', icon: '•' },
  { id: 'orderedList', label: '转为有序列表', icon: '○' },
  { id: 'taskList', label: '转为待办', icon: '☑' },
  { id: 'blockquote', label: '转为引用', icon: '❝' },
  { id: 'codeBlock', label: '转为代码块', icon: '{ }' },
  { id: 'divider', label: '—', icon: '' },
  { id: 'duplicate', label: '复制块', icon: '⎘' },
  { id: 'delete', label: '删除块', icon: '🗑', danger: true },
  { id: 'addBelow', label: '在下方添加', icon: '+' }
];

export function blockExtensions() {
  return [
    ToggleBlock,
    TaskList.configure({ HTMLAttributes: { class: 'notes-task-list' } }),
    TaskItem.configure({ nested: true, HTMLAttributes: { class: 'notes-task-item' } })
  ];
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getTopLevelBlock(view, pos) {
  const $pos = view.state.doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    const parent = $pos.node(d - 1);
    if (parent.type.name === 'doc') {
      return { node: $pos.node(d), pos: $pos.before(d), depth: d };
    }
  }
  return null;
}

function blockDomAtPos(view, pos) {
  const block = getTopLevelBlock(view, pos);
  if (!block) return null;
  if (block.node.type.name === 'toggleBlock') {
    try {
      const dom = view.nodeDOM(block.pos);
      if (dom && dom.nodeType === 1) return dom;
    } catch { /* ignore */ }
  }
  try {
    const dom = view.nodeDOM(block.pos);
    if (dom && dom.nodeType === 1) return dom;
    if (dom && dom.parentElement) return dom.parentElement.closest('.ProseMirror > *');
  } catch { /* ignore */ }
  return null;
}

function listTopLevelBlocks(doc) {
  const blocks = [];
  doc.forEach(function(node, offset) {
    if (node.isBlock) blocks.push({ node, pos: offset });
  });
  return blocks;
}

function runBlockCommand(editor, id) {
  const chain = editor.chain().focus();
  if (id === 'paragraph') chain.setParagraph().run();
  else if (id === 'h1') chain.setHeading({ level: 1 }).run();
  else if (id === 'h2') chain.setHeading({ level: 2 }).run();
  else if (id === 'h3') chain.setHeading({ level: 3 }).run();
  else if (id === 'toggle') insertToggleBlock(editor);
  else if (id === 'bulletList') chain.toggleBulletList().run();
  else if (id === 'orderedList') chain.toggleOrderedList().run();
  else if (id === 'taskList') chain.toggleTaskList().run();
  else if (id === 'blockquote') chain.toggleBlockquote().run();
  else if (id === 'codeBlock') chain.toggleCodeBlock().run();
  else if (id === 'hr') chain.setHorizontalRule().run();
}

function deleteTriggerQuery(editor, trigger) {
  const { state } = editor;
  const { $from } = state.selection;
  if (!$from.parent.isTextblock) return;
  const text = $from.parent.textContent;
  const offset = $from.parentOffset;
  const before = text.slice(0, offset);
  const re = new RegExp('(?:^|\\s)\\' + trigger + '([^\\s]*)$');
  const m = before.match(re);
  if (!m) return;
  const start = before.length - m[0].length + (m[0].startsWith(' ') ? 1 : 0);
  const from = $from.start() + start;
  const to = $from.start() + offset;
  editor.chain().focus().deleteRange({ from, to }).run();
}

function applySlashCommand(editor, id, onNoteRef) {
  deleteTriggerQuery(editor, '/');
  if (id === 'noteRef') {
    onNoteRef?.();
    return;
  }
  runBlockCommand(editor, id);
}

function insertMention(editor, note, insertNoteReference) {
  deleteTriggerQuery(editor, '@');
  insertNoteReference(editor, note.id, note.title);
}

function duplicateBlock(editor, blockPos) {
  const { state } = editor;
  const node = state.doc.nodeAt(blockPos);
  if (!node) return;
  const insertPos = blockPos + node.nodeSize;
  editor.chain().focus().insertContentAt(insertPos, node.toJSON()).run();
}

function deleteBlock(editor, blockPos) {
  const { state } = editor;
  const node = state.doc.nodeAt(blockPos);
  if (!node) return;
  editor.chain().focus().deleteRange({ from: blockPos, to: blockPos + node.nodeSize }).run();
}

function addBlockBelow(editor, blockPos) {
  const { state } = editor;
  const node = state.doc.nodeAt(blockPos);
  if (!node) return;
  const insertPos = blockPos + node.nodeSize;
  editor.chain().focus().insertContentAt(insertPos, { type: 'paragraph' }).setTextSelection(insertPos + 1).run();
}

function moveTopLevelBlock(editor, fromPos, toPos, after) {
  const { state } = editor;
  const node = state.doc.nodeAt(fromPos);
  if (!node) return;
  const size = node.nodeSize;
  if (toPos >= fromPos && toPos < fromPos + size) return;

  let tr = state.tr.delete(fromPos, fromPos + size);
  let insertPos = tr.mapping.map(toPos);
  if (after) {
    const target = tr.doc.nodeAt(insertPos);
    if (target) insertPos += target.nodeSize;
  }
  tr.insert(insertPos, node);
  editor.view.dispatch(tr.scrollIntoView());
}

/**
 * @param {import('@tiptap/core').Editor} editor
 * @param {{ shell: HTMLElement, onNoteRef?: ()=>void, getNotes?: ()=>Array, insertNoteReference?: Function }} opts
 */
export function setupBlockEditor(editor, opts) {
  const shell = opts.shell;
  let slashIdx = 0;
  let mentionIdx = 0;
  let blockMenuPos = null;
  let dragState = null;

  const slashEl = document.createElement('div');
  slashEl.className = 'notes-slash-menu hidden';
  slashEl.innerHTML = '<ul class="notes-slash-list"></ul>';

  const mentionEl = document.createElement('div');
  mentionEl.className = 'notes-mention-menu hidden';
  mentionEl.innerHTML = '<ul class="notes-mention-list"></ul>';

  const handleEl = document.createElement('button');
  handleEl.type = 'button';
  handleEl.className = 'notes-block-handle hidden';
  handleEl.title = '拖拽排序 · 点击菜单';
  handleEl.innerHTML = '<span class="notes-block-grip">⋮⋮</span>';

  const blockMenuEl = document.createElement('div');
  blockMenuEl.className = 'notes-block-menu hidden';
  blockMenuEl.innerHTML = '<ul class="notes-block-menu-list"></ul>';

  const dropLineEl = document.createElement('div');
  dropLineEl.className = 'notes-drop-line hidden';

  const dragGhostEl = document.createElement('div');
  dragGhostEl.className = 'notes-drag-ghost hidden';

  shell.classList.add('notes-editor-shell');
  shell.appendChild(handleEl);
  shell.appendChild(slashEl);
  shell.appendChild(mentionEl);
  shell.appendChild(blockMenuEl);
  shell.appendChild(dropLineEl);
  shell.appendChild(dragGhostEl);

  function hideSlash() { slashEl.classList.add('hidden'); }
  function hideMention() { mentionEl.classList.add('hidden'); }
  function hideBlockMenu() {
    blockMenuEl.classList.add('hidden');
    blockMenuPos = null;
  }
  function hideHandle() { handleEl.classList.add('hidden'); }
  function hideDropLine() { dropLineEl.classList.add('hidden'); }
  function hideDragGhost() { dragGhostEl.classList.add('hidden'); }

  function positionEl(el, rect, shellRect, alignRight) {
    const top = rect.top - shellRect.top + shell.scrollTop;
    const left = alignRight
      ? rect.right - shellRect.left - 8
      : rect.left - shellRect.left - 36;
    el.style.top = Math.max(0, top) + 'px';
    el.style.left = Math.max(0, left) + 'px';
  }

  function renderSlash(query) {
    const q = (query || '').toLowerCase();
    const list = slashEl.querySelector('.notes-slash-list');
    const filtered = SLASH_COMMANDS.filter(function(cmd) {
      if (!q) return true;
      return cmd.label.toLowerCase().includes(q)
        || cmd.hint.toLowerCase().includes(q)
        || cmd.keywords.some(function(k) { return k.includes(q); });
    });
    slashIdx = Math.min(slashIdx, Math.max(0, filtered.length - 1));
    list.innerHTML = '';
    filtered.forEach(function(cmd, i) {
      const li = document.createElement('li');
      li.className = 'notes-slash-item' + (i === slashIdx ? ' is-active' : '');
      li.dataset.id = cmd.id;
      li.innerHTML =
        '<span class="notes-slash-icon">' + cmd.icon + '</span>'
        + '<span class="notes-slash-body"><span class="notes-slash-label">' + escapeHtml(cmd.label) + '</span>'
        + '<span class="notes-slash-hint">' + escapeHtml(cmd.hint) + '</span></span>';
      li.addEventListener('mousedown', function(e) {
        e.preventDefault();
        applySlashCommand(editor, cmd.id, opts.onNoteRef);
        hideSlash();
      });
      list.appendChild(li);
    });
    if (!filtered.length) list.innerHTML = '<li class="notes-slash-empty">无匹配命令</li>';
    return filtered;
  }

  function renderMention(query) {
    const notes = opts.getNotes?.() || [];
    const q = (query || '').trim().toLowerCase();
    const filtered = q
      ? notes.filter(function(n) { return (n.title || '').toLowerCase().includes(q); })
      : notes.slice(0, 20);
    mentionIdx = Math.min(mentionIdx, Math.max(0, filtered.length - 1));
    const list = mentionEl.querySelector('.notes-mention-list');
    list.innerHTML = '';
    if (!filtered.length) {
      list.innerHTML = '<li class="notes-slash-empty">无匹配笔记</li>';
      return filtered;
    }
    filtered.forEach(function(note, i) {
      const li = document.createElement('li');
      li.className = 'notes-mention-item' + (i === mentionIdx ? ' is-active' : '');
      li.innerHTML =
        '<span class="notes-picker-icon">@</span>'
        + '<span class="notes-mention-body">'
        + '<span class="notes-slash-label">' + escapeHtml(note.title || '无标题') + '</span>'
        + '<span class="notes-slash-hint">提及并链接笔记</span></span>';
      li.addEventListener('mousedown', function(e) {
        e.preventDefault();
        insertMention(editor, note, opts.insertNoteReference);
        hideMention();
      });
      list.appendChild(li);
    });
    return filtered;
  }

  function getTriggerMatch(trigger) {
    const { state } = editor;
    const { $from } = state.selection;
    if (!$from.parent.isTextblock || !editor.isFocused) return null;
    const text = $from.parent.textContent;
    const before = text.slice(0, $from.parentOffset);
    const re = new RegExp('(?:^|\\s)\\' + trigger + '([^\\s]*)$');
    const m = before.match(re);
    if (!m) return null;
    return { query: m[1] || '', from: $from };
  }

  function updateTriggerMenus() {
    const slashMatch = getTriggerMatch('/');
    if (slashMatch) {
      hideMention();
      slashIdx = 0;
      renderSlash(slashMatch.query);
      const coords = editor.view.coordsAtPos(slashMatch.from.pos);
      const shellRect = shell.getBoundingClientRect();
      slashEl.classList.remove('hidden');
      slashEl.style.top = (coords.bottom - shellRect.top + shell.scrollTop + 6) + 'px';
      slashEl.style.left = Math.max(8, coords.left - shellRect.left) + 'px';
      return;
    }
    hideSlash();

    const mentionMatch = getTriggerMatch('@');
    if (mentionMatch && opts.getNotes) {
      mentionIdx = 0;
      renderMention(mentionMatch.query);
      const coords = editor.view.coordsAtPos(mentionMatch.from.pos);
      const shellRect = shell.getBoundingClientRect();
      mentionEl.classList.remove('hidden');
      mentionEl.style.top = (coords.bottom - shellRect.top + shell.scrollTop + 6) + 'px';
      mentionEl.style.left = Math.max(8, coords.left - shellRect.left) + 'px';
      return;
    }
    hideMention();
  }

  function showBlockMenu(blockPos, anchorRect) {
    blockMenuPos = blockPos;
    const list = blockMenuEl.querySelector('.notes-block-menu-list');
    list.innerHTML = '';
    BLOCK_ACTIONS.forEach(function(action) {
      if (action.id === 'divider') {
        const sep = document.createElement('li');
        sep.className = 'notes-block-menu-sep';
        list.appendChild(sep);
        return;
      }
      const li = document.createElement('li');
      li.className = 'notes-block-menu-item' + (action.danger ? ' is-danger' : '');
      li.innerHTML =
        (action.icon ? '<span class="notes-block-menu-icon">' + action.icon + '</span>' : '')
        + '<span>' + escapeHtml(action.label) + '</span>';
      li.addEventListener('mousedown', function(e) {
        e.preventDefault();
        hideBlockMenu();
        if (action.id === 'duplicate') duplicateBlock(editor, blockPos);
        else if (action.id === 'delete') deleteBlock(editor, blockPos);
        else if (action.id === 'addBelow') addBlockBelow(editor, blockPos);
        else runBlockCommand(editor, action.id);
      });
      list.appendChild(li);
    });
    const shellRect = shell.getBoundingClientRect();
    blockMenuEl.classList.remove('hidden');
    positionEl(blockMenuEl, anchorRect, shellRect, true);
  }

  function resolveDropTarget(clientY) {
    const view = editor.view;
    const blocks = listTopLevelBlocks(view.state.doc);
    if (!blocks.length) return null;
    for (let i = 0; i < blocks.length; i++) {
      const dom = blockDomAtPos(view, blocks[i].pos + 1);
      if (!dom) continue;
      const rect = dom.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (clientY < mid) {
        return { pos: blocks[i].pos, after: false, rect: rect };
      }
      if (i === blocks.length - 1 && clientY >= mid) {
        return { pos: blocks[i].pos, after: true, rect: rect };
      }
    }
    return { pos: blocks[blocks.length - 1].pos, after: true, rect: blockDomAtPos(view, blocks[blocks.length - 1].pos + 1)?.getBoundingClientRect() };
  }

  function showDropLine(target) {
    if (!target || !target.rect) {
      hideDropLine();
      return;
    }
    const shellRect = shell.getBoundingClientRect();
    const y = target.after
      ? target.rect.bottom - shellRect.top + shell.scrollTop
      : target.rect.top - shellRect.top + shell.scrollTop;
    dropLineEl.classList.remove('hidden');
    dropLineEl.style.top = y + 'px';
  }

  function onMouseMove(e) {
    if (dragState?.dragging) {
      const target = resolveDropTarget(e.clientY);
      dragState.dropTarget = target;
      showDropLine(target);
      dragGhostEl.style.left = (e.clientX + 12) + 'px';
      dragGhostEl.style.top = (e.clientY + 12) + 'px';
      return;
    }
    if (blockMenuEl.classList.contains('hidden') === false) return;
    const view = editor.view;
    const pos = view.posAtCoords({ left: e.clientX, top: e.clientY });
    if (!pos) {
      hideHandle();
      return;
    }
    const block = getTopLevelBlock(view, pos.pos);
    if (!block) {
      hideHandle();
      return;
    }
    const dom = blockDomAtPos(view, pos.pos);
    if (!dom) {
      hideHandle();
      return;
    }
    const rect = dom.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    handleEl.classList.remove('hidden');
    handleEl.dataset.blockPos = String(block.pos);
    positionEl(handleEl, rect, shellRect, false);
  }

  function onShellLeave() {
    if (!dragState?.dragging && blockMenuEl.classList.contains('hidden')) hideHandle();
  }

  function endDrag(commit) {
    if (dragState?.dragging && commit && dragState.dropTarget) {
      moveTopLevelBlock(editor, dragState.blockPos, dragState.dropTarget.pos, dragState.dropTarget.after);
    }
    dragState = null;
    hideDropLine();
    hideDragGhost();
    document.body.classList.remove('notes-is-dragging');
    document.removeEventListener('mousemove', onDocumentMouseMove);
    document.removeEventListener('mouseup', onDocumentMouseUp);
  }

  function onDocumentMouseMove(e) {
    if (!dragState) return;
    if (!dragState.dragging) {
      const dx = Math.abs(e.clientX - dragState.startX);
      const dy = Math.abs(e.clientY - dragState.startY);
      if (dx + dy < 5) return;
      dragState.dragging = true;
      document.body.classList.add('notes-is-dragging');
      const node = editor.state.doc.nodeAt(dragState.blockPos);
      dragGhostEl.textContent = node?.textContent?.slice(0, 40) || '块';
      dragGhostEl.classList.remove('hidden');
      hideBlockMenu();
    }
    onMouseMove(e);
  }

  function onDocumentMouseUp(e) {
    if (!dragState) return;
    if (dragState.dragging) {
      endDrag(true);
      return;
    }
    const blockPos = dragState.blockPos;
    dragState = null;
    document.removeEventListener('mousemove', onDocumentMouseMove);
    document.removeEventListener('mouseup', onDocumentMouseUp);
    const dom = blockDomAtPos(editor.view, blockPos + 1);
    if (dom) showBlockMenu(blockPos, dom.getBoundingClientRect());
  }

  handleEl.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragState = {
      blockPos: Number(handleEl.dataset.blockPos),
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
      dropTarget: null
    };
    document.addEventListener('mousemove', onDocumentMouseMove);
    document.addEventListener('mouseup', onDocumentMouseUp);
  });

  shell.addEventListener('mousemove', onMouseMove);
  shell.addEventListener('mouseleave', onShellLeave);

  document.addEventListener('mousedown', function(e) {
    if (!shell.contains(e.target)) {
      hideSlash();
      hideMention();
      hideBlockMenu();
    } else if (!blockMenuEl.contains(e.target) && e.target !== handleEl) {
      hideBlockMenu();
    }
  });

  editor.on('update', updateTriggerMenus);
  editor.on('selectionUpdate', updateTriggerMenus);
  function onEditorBlur() {
    setTimeout(function() {
      if (!slashEl.contains(document.activeElement) && !mentionEl.contains(document.activeElement)) {
        hideSlash();
        hideMention();
      }
    }, 120);
  }
  editor.on('blur', onEditorBlur);

  editor.view.dom.addEventListener('keydown', onMenuKeydown);

  function onMenuKeydown(e) {
    if (!slashEl.classList.contains('hidden')) {
      const filtered = SLASH_COMMANDS.filter(function(cmd) {
        const m = getTriggerMatch('/');
        const q = (m ? m.query : '').toLowerCase();
        if (!q) return true;
        return cmd.label.toLowerCase().includes(q) || cmd.keywords.some(function(k) { return k.includes(q); });
      });
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashIdx = Math.min(slashIdx + 1, filtered.length - 1);
        renderSlash(filtered[slashIdx]?.label || '');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashIdx = Math.max(slashIdx - 1, 0);
        renderSlash(filtered[slashIdx]?.label || '');
      } else if (e.key === 'Enter' && filtered[slashIdx]) {
        e.preventDefault();
        applySlashCommand(editor, filtered[slashIdx].id, opts.onNoteRef);
        hideSlash();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hideSlash();
      }
      return;
    }
    if (!mentionEl.classList.contains('hidden')) {
      const notes = opts.getNotes?.() || [];
      const m = getTriggerMatch('@');
      const q = (m ? m.query : '').trim().toLowerCase();
      const filtered = q
        ? notes.filter(function(n) { return (n.title || '').toLowerCase().includes(q); })
        : notes.slice(0, 20);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionIdx = Math.min(mentionIdx + 1, filtered.length - 1);
        renderMention(m?.query || '');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionIdx = Math.max(mentionIdx - 1, 0);
        renderMention(m?.query || '');
      } else if (e.key === 'Enter' && filtered[mentionIdx]) {
        e.preventDefault();
        insertMention(editor, filtered[mentionIdx], opts.insertNoteReference);
        hideMention();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hideMention();
      }
    }
  }

  return function cleanup() {
    endDrag(false);
    editor.off('update', updateTriggerMenus);
    editor.off('selectionUpdate', updateTriggerMenus);
    editor.off('blur', onEditorBlur);
    editor.view.dom.removeEventListener('keydown', onMenuKeydown);
    shell.removeEventListener('mousemove', onMouseMove);
    shell.removeEventListener('mouseleave', onShellLeave);
    handleEl.remove();
    slashEl.remove();
    mentionEl.remove();
    blockMenuEl.remove();
    dropLineEl.remove();
    dragGhostEl.remove();
    shell.classList.remove('notes-editor-shell');
  };
}

export function openNotePicker(container, notes, excludeId, onPick) {
  const existing = container.querySelector('.notes-picker');
  if (existing) existing.remove();

  const pop = document.createElement('div');
  pop.className = 'notes-picker';
  pop.innerHTML =
    '<div class="notes-picker-header">'
    + '<input type="search" class="notes-picker-search" placeholder="搜索笔记…" autofocus>'
    + '</div>'
    + '<ul class="notes-picker-list"></ul>';
  container.appendChild(pop);

  const search = pop.querySelector('.notes-picker-search');
  const list = pop.querySelector('.notes-picker-list');
  const candidates = notes.filter(function(n) { return n.id !== excludeId; });

  function render(filter) {
    const q = (filter || '').trim().toLowerCase();
    const filtered = q
      ? candidates.filter(function(n) { return (n.title || '').toLowerCase().includes(q); })
      : candidates.slice(0, 40);
    list.innerHTML = '';
    if (!filtered.length) {
      list.innerHTML = '<li class="notes-picker-empty">无匹配笔记</li>';
      return;
    }
    filtered.forEach(function(n) {
      const li = document.createElement('li');
      li.className = 'notes-picker-item';
      li.innerHTML =
        '<span class="notes-picker-icon">📄</span>'
        + '<span class="notes-picker-title">' + escapeHtml(n.title || '无标题') + '</span>';
      li.addEventListener('mousedown', function(e) {
        e.preventDefault();
        pop.remove();
        onPick(n);
      });
      list.appendChild(li);
    });
  }

  render('');
  search.addEventListener('input', function() { render(search.value); });

  function onDoc(e) {
    if (!pop.contains(e.target)) {
      pop.remove();
      document.removeEventListener('mousedown', onDoc, true);
    }
  }
  setTimeout(function() { document.addEventListener('mousedown', onDoc, true); }, 0);

  search.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      pop.remove();
      document.removeEventListener('mousedown', onDoc, true);
    }
  });
}
