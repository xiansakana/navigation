import { Extension } from 'https://esm.sh/@tiptap/core@2.11.5';
import { Plugin } from 'https://esm.sh/@tiptap/pm/state@1.25.0';

const BLOCK_TYPES = new Set([
  'paragraph', 'heading', 'blockquote', 'codeBlock', 'horizontalRule',
  'bulletList', 'orderedList', 'taskList', 'toggleBlock', 'calloutBlock',
  'image', 'embedBlock'
]);

function newBlockId() {
  return crypto.randomUUID();
}

export const BlockId = Extension.create({
  name: 'blockId',

  addGlobalAttributes() {
    return [{
      types: [...BLOCK_TYPES],
      attributes: {
        id: {
          default: null,
          parseHTML: function(element) {
            return element.getAttribute('data-block-id');
          },
          renderHTML: function(attributes) {
            if (!attributes.id) return {};
            return { 'data-block-id': attributes.id };
          }
        }
      }
    }];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: function(transactions, _oldState, newState) {
          if (!transactions.some(function(tr) { return tr.docChanged; })) return null;
          const toFix = [];
          newState.doc.descendants(function(node, pos) {
            if (BLOCK_TYPES.has(node.type.name) && !node.attrs.id) {
              toFix.push({ pos: pos, node: node });
            }
          });
          if (!toFix.length) return null;
          let tr = newState.tr;
          toFix.reverse().forEach(function(item) {
            tr.setNodeMarkup(item.pos, undefined, { ...item.node.attrs, id: newBlockId() });
          });
          return tr;
        }
      })
    ];
  }
});

export function extractHeadings(doc) {
  const items = [];
  if (!doc?.content) return items;
  doc.content.forEach(function(node) {
    walkHeading(node, items, 0);
  });
  return items;
}

function walkHeading(node, items, depth) {
  if (node.type === 'heading') {
    items.push({
      id: node.attrs?.id || null,
      level: node.attrs?.level || 1,
      text: inlineText(node.content),
      depth: depth
    });
  }
  if (Array.isArray(node.content)) {
    node.content.forEach(function(child) {
      if (node.type === 'toggleBlock' || node.type === 'calloutBlock' || node.type === 'blockquote') {
        walkHeading(child, items, depth + 1);
      }
    });
  }
}

function inlineText(nodes) {
  if (!Array.isArray(nodes)) return '';
  return nodes.map(function(n) {
    if (n.type === 'text') return n.text || '';
    if (n.type === 'noteReference') return n.attrs?.title || '';
    if (n.content) return inlineText(n.content);
    return '';
  }).join('');
}
