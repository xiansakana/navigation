import { Node, mergeAttributes } from 'https://esm.sh/@tiptap/core@2.11.5';

export const NoteReference = Node.create({
  name: 'noteReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      id: { default: null },
      title: { default: '笔记' }
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-note-ref]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-note-ref': HTMLAttributes.id,
        class: 'note-ref',
        title: '打开链接笔记'
      }),
      HTMLAttributes.title || '笔记'
    ];
  }
});

export function insertNoteReference(editor, id, title) {
  if (!editor) return;
  editor.chain().focus().insertContent({
    type: 'noteReference',
    attrs: { id, title: title || '笔记' }
  }).insertContent(' ').run();
}
