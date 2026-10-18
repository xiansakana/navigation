export function bindVideoDrop({ zone, input, busy, maxBytes, selected, error }) {
  function validate(files) {
    if (files.length !== 1) throw new Error('请一次选择一个视频文件');
    const file = files[0];
    if (!/\.(mp4|webm|mov)$/i.test(file.name)) throw new Error('请选择 MP4、WebM 或 MOV 视频');
    if (!file.size) throw new Error('视频文件不能为空');
    if (file.size > maxBytes()) throw new Error('视频超过上传大小限制');
    return file;
  }
  input.addEventListener('change', () => {
    try { selected(validate(input.files)); } catch (e) { input.value = ''; error(e); }
  });
  let depth = 0;
  const isFile = event => Array.from(event.dataTransfer?.types || []).includes('Files');
  zone.addEventListener('dragenter', event => {
    if (!isFile(event)) return;
    event.preventDefault(); if (!busy()) { depth++; zone.classList.add('is-dragging'); }
  });
  zone.addEventListener('dragover', event => {
    if (!isFile(event)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = busy() ? 'none' : 'copy';
  });
  zone.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; zone.classList.remove('is-dragging'); } });
  zone.addEventListener('drop', event => {
    if (!isFile(event)) return;
    event.preventDefault(); depth = 0; zone.classList.remove('is-dragging');
    if (busy()) return;
    try {
      const file = validate(event.dataTransfer.files), transfer = new DataTransfer();
      transfer.items.add(file); input.files = transfer.files; selected(file);
    } catch (e) { error(e); }
  });
}
