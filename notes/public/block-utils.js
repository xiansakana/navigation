/** Parents whose direct block children can be dragged/reordered. */
export const DRAG_PARENT_TYPES = new Set([
  'doc', 'toggleBlock', 'blockquote', 'bulletList', 'orderedList', 'taskList', 'calloutBlock'
]);

export function getDraggableBlock(view, pos) {
  const $pos = view.state.doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    const parent = $pos.node(d - 1);
    if (DRAG_PARENT_TYPES.has(parent.type.name)) {
      return {
        node: $pos.node(d),
        pos: $pos.before(d),
        index: $pos.index(d),
        parentPos: $pos.before(d - 1),
        parentType: parent.type.name
      };
    }
  }
  return null;
}

export function listSiblingBlocks(doc, parentPos) {
  const parent = doc.nodeAt(parentPos);
  if (!parent) return [];
  const blocks = [];
  let offset = parentPos + 1;
  parent.forEach(function(child) {
    blocks.push({ node: child, pos: offset });
    offset += child.nodeSize;
  });
  return blocks;
}

export function blockDomAtPos(view, blockInfo) {
  if (!blockInfo) return null;
  try {
    const dom = view.nodeDOM(blockInfo.pos);
    if (dom && dom.nodeType === 1) return dom;
    if (dom?.parentElement) {
      const hit = dom.parentElement.closest('[data-embed-block], .notes-image-wrap, .notes-toggle-block, .notes-callout-block, .ProseMirror > *, li[data-type="taskItem"]');
      if (hit) return hit;
    }
  } catch { /* ignore */ }
  return null;
}

export function moveSiblingBlock(editor, fromPos, toIndex, parentPos) {
  const { state } = editor;
  const siblings = listSiblingBlocks(state.doc, parentPos);
  const fromIndex = siblings.findIndex(function(s) { return s.pos === fromPos; });
  if (fromIndex < 0) return;
  if (toIndex < 0 || toIndex > siblings.length) return;
  if (toIndex === fromIndex || toIndex === fromIndex + 1) return;

  const node = state.doc.nodeAt(fromPos);
  if (!node) return;
  const size = node.nodeSize;

  let tr = state.tr.delete(fromPos, fromPos + size);
  const mappedParent = tr.mapping.map(parentPos);
  const remaining = listSiblingBlocks(tr.doc, mappedParent);
  let insertPos;
  if (toIndex >= remaining.length) {
    const parentNode = tr.doc.nodeAt(mappedParent);
    insertPos = mappedParent + (parentNode ? parentNode.nodeSize - 1 : 0);
  } else {
    const targetIndex = toIndex > fromIndex ? toIndex - 1 : toIndex;
    insertPos = remaining[targetIndex]?.pos ?? mappedParent + 1;
  }
  tr.insert(insertPos, node);
  editor.view.dispatch(tr.scrollIntoView());
}
