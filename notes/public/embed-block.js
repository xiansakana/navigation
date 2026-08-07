import { Node, mergeAttributes } from 'https://esm.sh/@tiptap/core@2.11.5';

export const EmbedBlock = Node.create({
  name: 'embedBlock',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      title: { default: '' },
      height: { default: 360 }
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-embed-block]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-embed-block': '',
        class: 'notes-embed-block',
        style: '--embed-height:' + (HTMLAttributes.height || 360) + 'px'
      }),
      [
        'iframe',
        {
          src: HTMLAttributes.src,
          title: HTMLAttributes.title || 'embed',
          loading: 'lazy',
          referrerpolicy: 'no-referrer',
          sandbox: 'allow-scripts allow-same-origin allow-popups allow-forms allow-presentation'
        }
      ]
    ];
  },

  addNodeView() {
    return function(props) {
      const { node, getPos, editor } = props;
      const wrap = document.createElement('div');
      wrap.className = 'notes-embed-block';
      wrap.dataset.embedBlock = '';

      const head = document.createElement('div');
      head.className = 'notes-embed-head';
      head.innerHTML = '<span class="notes-embed-label">嵌入</span><span class="notes-embed-url"></span>';

      const iframe = document.createElement('iframe');
      iframe.loading = 'lazy';
      iframe.referrerPolicy = 'no-referrer';
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-forms allow-presentation');

      const resize = document.createElement('div');
      resize.className = 'notes-embed-resize';
      resize.title = '拖拽调整高度';

      wrap.appendChild(head);
      wrap.appendChild(iframe);
      wrap.appendChild(resize);

      function applyNode(n) {
        iframe.src = n.attrs.src || '';
        iframe.title = n.attrs.title || 'embed';
        wrap.style.setProperty('--embed-height', (n.attrs.height || 360) + 'px');
        head.querySelector('.notes-embed-url').textContent = n.attrs.src || '';
      }
      applyNode(node);

      resize.addEventListener('pointerdown', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const startY = e.clientY;
        const startH = node.attrs.height || 360;
        resize.setPointerCapture(e.pointerId);
        function onMove(ev) {
          const h = Math.max(160, Math.min(900, startH + ev.clientY - startY));
          wrap.style.setProperty('--embed-height', h + 'px');
        }
        function onUp(ev) {
          resize.releasePointerCapture(ev.pointerId);
          resize.removeEventListener('pointermove', onMove);
          resize.removeEventListener('pointerup', onUp);
          const h = parseInt(wrap.style.getPropertyValue('--embed-height'), 10) || startH;
          const pos = getPos();
          if (typeof pos !== 'number') return;
          editor.chain().focus().command(function(cmd) {
            cmd.tr.setNodeMarkup(pos, undefined, { ...node.attrs, height: h });
            return true;
          }).run();
        }
        resize.addEventListener('pointermove', onMove);
        resize.addEventListener('pointerup', onUp);
      });

      return {
        dom: wrap,
        update: function(updated) {
          if (updated.type.name !== 'embedBlock') return false;
          node = updated;
          applyNode(updated);
          return true;
        }
      };
    };
  }
});

export function insertEmbedBlock(editor, src, height) {
  if (!editor || !src) return;
  editor.chain().focus().insertContent({
    type: 'embedBlock',
    attrs: { src: src, title: '', height: height || 360 }
  }).run();
}
