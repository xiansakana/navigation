export function bindLinkImport({ element, can, send, busy, onError }) {
  const $ = element;
  let sequence = 0, loading = '';
  const mode = () => {
    const link = $('upload-mode').value === 'link' && can();
    $('video-drop').hidden = link; $('video-file').disabled = link; $('video-file').required = !link;
    $('video-link-controls').hidden = !link; $('video-link').required = link;
    $('upload-submit').textContent = link ? '导入并生成笔记' : '上传并生成笔记';
  };
  $('upload-mode').onchange = () => { if (!busy()) mode(); };
  async function preview() {
    if (busy() || !can() || $('upload-mode').value !== 'link' || !$('video-link').value.trim()) return;
    const input = $('video-link').value;
    if (loading === input) return;
    const seq = ++sequence;
    loading = input;
    $('video-link-status').textContent = '正在读取视频信息…';
    try {
      const { metadata: m } = await send('/imports/preview', 'POST', { url: input });
      if (seq !== sequence || input !== $('video-link').value || $('upload-mode').value !== 'link') return;
      $('upload-title').value = m.title; $('upload-topic').value = m.topic;
      $('upload-tags').value = m.tags.join(', '); $('upload-source').value = m.sourceUrl;
      $('video-link-status').textContent = `已读取：${m.title} · ${Math.ceil(m.duration / 60)}分钟 · ${m.uploader}。${m.warnings.join(' ')}`;
    } catch (e) { if (seq === sequence && input === $('video-link').value) { $('video-link-status').textContent = e.message; onError(e); } }
    finally { if (loading === input) loading = ''; }
  }
  $('video-link-preview').onclick = preview;
  $('video-link').onchange = preview;
  $('video-link').addEventListener('input', () => { sequence++; $('video-link-status').textContent = '链接已改变，请读取视频信息后确认标题等字段。'; });
  return { mode, preview };
}
