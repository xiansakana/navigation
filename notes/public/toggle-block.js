import { Node, mergeAttributes } from 'https://esm.sh/@tiptap/core@2.11.5';

export const ToggleBlock = Node.create({
  name: 'toggleBlock',
  group: 'block',
  content: 'block+',
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      open: { default: true }
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-toggle-block]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-toggle-block': '',
        'data-open': node.attrs.open ? 'true' : 'false',
        class: 'notes-toggle-block' + (node.attrs.open ? ' is-open' : ' is-collapsed')
      }),
      0
    ];
  },

  addNodeView() {
    return function(nodeViewProps) {
      const { node, editor, getPos } = nodeViewProps;

      const dom = document.createElement('div');
      dom.className = 'notes-toggle-block' + (node.attrs.open ? ' is-open' : ' is-collapsed');
      dom.dataset.toggleBlock = '';

      const head = document.createElement('div');
      head.className = 'notes-toggle-head';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'notes-toggle-btn';
      btn.title = node.attrs.open ? '折叠' : '展开';
      btn.textContent = node.attrs.open ? '▾' : '▸';

      const contentDOM = document.createElement('div');
      contentDOM.className = 'notes-toggle-content';

      head.appendChild(btn);
      dom.appendChild(head);
      dom.appendChild(contentDOM);

      btn.addEventListener('mousedown', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const pos = getPos();
        if (typeof pos !== 'number') return;
        const current = editor.state.doc.nodeAt(pos);
        if (!current) return;
        editor.chain().focus().command(function(props) {
          props.tr.setNodeMarkup(pos, undefined, { open: !current.attrs.open });
          return true;
        }).run();
      });

      return {
        dom,
        contentDOM,
        update: function(updated) {
          if (updated.type.name !== 'toggleBlock') return false;
          dom.classList.toggle('is-open', updated.attrs.open);
          dom.classList.toggle('is-collapsed', !updated.attrs.open);
          btn.textContent = updated.attrs.open ? '▾' : '▸';
          btn.title = updated.attrs.open ? '折叠' : '展开';
          return true;
        }
      };
    };
  }
});

export function insertToggleBlock(editor) {
  if (!editor) return;
  editor.chain().focus().insertContent({
    type: 'toggleBlock',
    attrs: { open: true },
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: '折叠标题' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '点击 ▸ 展开或编辑内容…' }] }
    ]
  }).run();
}
