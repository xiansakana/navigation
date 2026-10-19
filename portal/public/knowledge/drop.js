export function bindVideoDrop({ zone, input, busy, maxBytes, selected, error, multiple = () => false }) {
  function validate(files) {
    if (!files.length || files.length > (multiple() ? 100 : 1)) throw new Error(multiple() ? '每次最多选择100个视频' : '请一次选择一个视频文件');
    for (const file of files) {
      if (!/\.(mp4|webm|mov)$/i.test(file.name)) throw new Error('请选择 MP4、WebM 或 MOV 视频');
      if (!file.size) throw new Error('视频文件不能为空');
      if (file.size > maxBytes()) throw new Error('视频超过上传大小限制');
    }
    return Array.from(files);
  }
  input.addEventListener('change', () => {
    try { const files = validate(input.files); selected(files[0], files); } catch (e) { input.value = ''; error(e); }
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
      const files = validate(event.dataTransfer.files), transfer = new DataTransfer();
      for (const file of files) transfer.items.add(file); input.files = transfer.files; selected(files[0], files);
    } catch (e) { error(e); }
  });
}
