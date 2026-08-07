import CodeBlockLowlight from 'https://esm.sh/@tiptap/extension-code-block-lowlight@2.11.5';
import { createLowlight, common } from 'https://esm.sh/lowlight@3.1.0';

const lowlight = createLowlight(common);

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
  { id: 'markdown', label: 'Markdown' },
  { id: 'yaml', label: 'YAML' },
  { id: 'xml', label: 'XML' }
];

export const NotesCodeBlock = CodeBlockLowlight.configure({
  lowlight,
  defaultLanguage: 'text',
  HTMLAttributes: { class: 'notes-code-block hljs' }
});

export function insertCodeBlock(editor, language) {
  if (!editor) return;
  editor.chain().focus().insertContent({
    type: 'codeBlock',
    attrs: { language: language || 'text' },
    content: [{ type: 'text', text: '' }]
  }).run();
}

/**
 * Language selector shown in toolbar when cursor is in a code block.
 */
export function setupCodeLangBar(toolbar, editor) {
  const group = document.createElement('div');
  group.className = 'notes-toolbar-group notes-code-lang-group hidden';
  group.innerHTML =
    '<div class="notes-code-lang-bar">'
    + '<label class="notes-code-lang-label">语言</label>'
    + '<select class="notes-code-lang-select"></select>'
    + '</div>'
    + '<span class="notes-tool-sep"></span>';
  toolbar.insertBefore(group, toolbar.firstChild);

  const select = group.querySelector('.notes-code-lang-select');
  select.innerHTML = LANGUAGES.map(function(lang) {
    return '<option value="' + lang.id + '">' + lang.label + '</option>';
  }).join('');

  function updateBar() {
    if (!editor.isFocused || !editor.isActive('codeBlock')) {
      group.classList.add('hidden');
      return;
    }
    const lang = editor.getAttributes('codeBlock').language || 'text';
    select.value = LANGUAGES.some(function(l) { return l.id === lang; }) ? lang : 'text';
    group.classList.remove('hidden');
  }

  select.addEventListener('change', function() {
    editor.chain().focus().updateAttributes('codeBlock', { language: select.value }).run();
  });

  editor.on('selectionUpdate', updateBar);
  editor.on('update', updateBar);
  editor.on('blur', function() {
    setTimeout(function() {
      if (!group.contains(document.activeElement)) group.classList.add('hidden');
    }, 120);
  });

  return function cleanup() {
    editor.off('selectionUpdate', updateBar);
    editor.off('update', updateBar);
    group.remove();
  };
}
