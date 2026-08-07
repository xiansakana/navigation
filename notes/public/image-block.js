import Image from 'https://esm.sh/@tiptap/extension-image@2.11.5';

export const NotesImage = Image.extend({
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
      width: {
        default: null,
        parseHTML: function(element) {
          const w = element.getAttribute('width') || element.style.width;
          if (!w) return null;
          const n = parseInt(String(w).replace('px', ''), 10);
          return Number.isFinite(n) ? n : null;
        },
        renderHTML: function(attributes) {
          if (!attributes.width) return {};
          return { width: attributes.width, style: 'width:' + attributes.width + 'px' };
        }
      }
    };
  },

  addNodeView() {
    return function(props) {
      const { node, getPos, editor } = props;
      let current = node;

      const wrap = document.createElement('div');
      wrap.className = 'notes-image-wrap';
      wrap.contentEditable = 'false';

      const img = document.createElement('img');
      img.className = 'notes-image-block';
      img.draggable = false;

      const handle = document.createElement('span');
      handle.className = 'notes-image-resize-handle';
      handle.title = '拖拽缩放';

      wrap.appendChild(img);
      wrap.appendChild(handle);

      function applyNode(n) {
        img.src = n.attrs.src || '';
        img.alt = n.attrs.alt || '';
        img.title = n.attrs.title || '';
        if (n.attrs.width) img.style.width = n.attrs.width + 'px';
        else img.style.width = '';
      }
      applyNode(current);

      handle.addEventListener('pointerdown', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = img.offsetWidth || 320;
        handle.setPointerCapture(e.pointerId);
        function onMove(ev) {
          const w = Math.max(80, Math.min(1200, startW + ev.clientX - startX));
          img.style.width = w + 'px';
        }
        function onUp(ev) {
          handle.releasePointerCapture(ev.pointerId);
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
          const w = Math.round(img.offsetWidth);
          const pos = getPos();
          if (typeof pos !== 'number') return;
          editor.chain().focus().command(function(cmd) {
            cmd.tr.setNodeMarkup(pos, undefined, { ...current.attrs, width: w });
            return true;
          }).run();
        }
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
      });

      return {
        dom: wrap,
        update: function(updated) {
          if (updated.type.name !== 'image') return false;
          current = updated;
          applyNode(updated);
          return true;
        },
        ignoreMutation: function() { return true; }
      };
    };
  }
}).configure({
  inline: false,
  allowBase64: false
});

export async function uploadImageFile(file, apiFn) {
  if (!file || !file.type.startsWith('image/')) {
    throw new Error('请选择图片文件');
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new Error('图片不能超过 5MB');
  }
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const data = await apiFn('uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      mime: file.type,
      data: btoa(binary)
    })
  });
  return data.url;
}

export function insertImage(editor, src, alt, width) {
  if (!editor || !src) return;
  const attrs = { src: src, alt: alt || '' };
  if (width) attrs.width = width;
  editor.chain().focus().setImage(attrs).run();
}

export function isValidImageUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
