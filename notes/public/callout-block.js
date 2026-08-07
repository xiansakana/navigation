import { Node, mergeAttributes } from 'https://esm.sh/@tiptap/core@2.11.5';

export const CALLOUT_TYPES = [
  { id: 'note', label: 'Note', icon: '✏️', color: '#5b9cff' },
  { id: 'tip', label: 'Tip', icon: '💡', color: '#3ddc84' },
  { id: 'important', label: 'Important', icon: '❗', color: '#a78bfa' },
  { id: 'warning', label: 'Warning', icon: '⚠️', color: '#fbbf24' },
  { id: 'caution', label: 'Caution', icon: '🚨', color: '#f87171' }
];

export const CalloutBlock = Node.create({
  name: 'calloutBlock',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      type: { default: 'note' },
      title: { default: '' }
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-callout-block]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const type = HTMLAttributes.type || 'note';
    const meta = CALLOUT_TYPES.find(function(t) { return t.id === type; }) || CALLOUT_TYPES[0];
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-callout-block': '',
        'data-callout-type': type,
        class: 'notes-callout-block notes-callout-' + type,
        style: '--callout-color:' + meta.color
      }),
      0
    ];
  },

  addNodeView() {
    return function(props) {
      const { node } = props;
      const dom = document.createElement('div');
      dom.className = 'notes-callout-block notes-callout-' + (node.attrs.type || 'note');
      dom.dataset.calloutBlock = '';
      dom.dataset.calloutType = node.attrs.type || 'note';

      const head = document.createElement('div');
      head.className = 'notes-callout-head';
      head.contentEditable = 'false';

      const contentDOM = document.createElement('div');
      contentDOM.className = 'notes-callout-content';

      dom.appendChild(head);
      dom.appendChild(contentDOM);

      function applyNode(n) {
        const type = n.attrs.type || 'note';
        const meta = CALLOUT_TYPES.find(function(t) { return t.id === type; }) || CALLOUT_TYPES[0];
        dom.className = 'notes-callout-block notes-callout-' + type;
        dom.dataset.calloutType = type;
        dom.style.setProperty('--callout-color', meta.color);
        head.innerHTML =
          '<span class="notes-callout-icon">' + meta.icon + '</span>'
          + '<span class="notes-callout-label">' + meta.label + '</span>'
          + (n.attrs.title ? '<span class="notes-callout-title">' + n.attrs.title + '</span>' : '');
      }
      applyNode(node);

      return {
        dom,
        contentDOM,
        update: function(updated) {
          if (updated.type.name !== 'calloutBlock') return false;
          applyNode(updated);
          return true;
        }
      };
    };
  }
});

export function insertCalloutBlock(editor, type) {
  if (!editor) return;
  const meta = CALLOUT_TYPES.find(function(t) { return t.id === type; }) || CALLOUT_TYPES[0];
  editor.chain().focus().insertContent({
    type: 'calloutBlock',
    attrs: { type: meta.id, title: '' },
    content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }]
  }).run();
}
