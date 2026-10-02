import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';

window.createUnifiedBlogEditor = function(root, post) {
  const plain = document.createElement('div');
  (post?.content || '').split('\n').forEach((line, index) => {
    if (index) plain.appendChild(document.createElement('br'));
    plain.appendChild(document.createTextNode(line));
  });
  const content = post?.contentFormat === 'markdown' ? post.contentHtml
    : post?.contentFormat === 'html' ? post.content : plain.innerHTML;
  root.replaceChildren();
  const editor = new Editor({
    element: root,
    extensions: [StarterKit.configure({ link: { openOnClick: false } }), TableKit, Image],
    content: DOMPurify.sanitize(content || ''),
    editorProps: {
      attributes: { class: 'blog-rich-editor blog-rich-content', role: 'textbox', 'aria-label': '写点什么', 'aria-multiline': 'true', 'data-placeholder': '直接输入或粘贴 Markdown，也可使用上方工具栏' },
      handlePaste(view, event) {
        const clipboard = event.clipboardData;
        if (!clipboard || clipboard.getData('text/html')) return false;
        const text = clipboard.getData('text/plain');
        if (!text) return false;
        event.preventDefault();
        editor.commands.insertContent(DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true })));
        return true;
      }
    },
    onUpdate: () => root.dispatchEvent(new Event('input', { bubbles: true }))
  });
  const toolbar = document.createElement('div');
  toolbar.className = 'blog-rich-toolbar'; toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', '文字格式');
  const actions = [
    ['加粗', () => editor.chain().focus().toggleBold().run()],
    ['斜体', () => editor.chain().focus().toggleItalic().run()],
    ['下划线', () => editor.chain().focus().toggleUnderline().run()],
    ['删除线', () => editor.chain().focus().toggleStrike().run()],
    ['标题', () => editor.chain().focus().toggleHeading({ level: 2 }).run()],
    ['正文', () => editor.chain().focus().setParagraph().run()],
    ['无序列表', () => editor.chain().focus().toggleBulletList().run()],
    ['有序列表', () => editor.chain().focus().toggleOrderedList().run()],
    ['引用', () => editor.chain().focus().toggleBlockquote().run()],
    ['代码块', () => editor.chain().focus().toggleCodeBlock().run()],
    ['链接', () => {
      const href = prompt('输入链接地址（https://、http:// 或 mailto:）');
      if (!href) return;
      if (!/^(https?:\/\/|mailto:)/i.test(href.trim())) return window.portalToast?.error('请输入有效链接');
      editor.chain().focus().setLink({ href: href.trim() }).run();
    }],
    ['移除链接', () => editor.chain().focus().unsetLink().run()],
    ['清除格式', () => editor.chain().focus().clearNodes().unsetAllMarks().run()]
  ];
  actions.forEach(([label, action]) => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.addEventListener('mousedown', event => event.preventDefault()); button.addEventListener('click', action); toolbar.appendChild(button);
  });
  root.before(toolbar);
  return {
    content: () => editor.getHTML(), format: () => 'html', focus: () => editor.commands.focus(),
    length: () => editor.getText().length, isEmpty: () => editor.isEmpty,
    clear: () => editor.commands.clearContent(), destroy: () => editor.destroy()
  };
};
