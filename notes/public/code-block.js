import CodeBlock from 'https://esm.sh/@tiptap/extension-code-block@2.11.5';

export const LANGUAGES = [
  { id: 'text', label: 'Plain Text' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'java', label: 'Java' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'sql', label: 'SQL' },
  { id: 'json', label: 'JSON' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'bash', label: 'Bash' },
  { id: 'markdown', label: 'Markdown' }
];

export const NotesCodeBlock = CodeBlock.configure({
  HTMLAttributes: { class: 'notes-code-block' }
});

export function insertCodeBlock(editor, language) {
  if (!editor) return;
  editor.chain().focus().insertContent({
    type: 'codeBlock',
    attrs: { language: language || 'text' },
    content: [{ type: 'text', text: '' }]
  }).run();
}
