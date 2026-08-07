import Image from 'https://esm.sh/@tiptap/extension-image@2.11.5';

export const NotesImage = Image.configure({
  inline: false,
  allowBase64: false,
  HTMLAttributes: { class: 'notes-image-block' }
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

export function insertImage(editor, src, alt) {
  if (!editor || !src) return;
  editor.chain().focus().setImage({ src: src, alt: alt || '' }).run();
}
