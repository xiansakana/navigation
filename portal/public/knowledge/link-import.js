export function bindLinkImport({ element, can, send, busy, onError }) {
  const $ = element;
  let sequence = 0, loading = '', dirty = false, queued = false, savedDefaults = null;
  const selection = () => ({ quality: Number($('link-quality').value || 80), strict: $('link-mode').value !== 'auto' });
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
    const requestKey = input + ':' + JSON.stringify(selection());
    if (loading) { if (loading !== requestKey) queued = true; return; }
    const seq = ++sequence;
    loading = requestKey;
    $('video-link-status').textContent = '正在读取视频信息…';
    try {
      const { metadata: m } = await send('/imports/preview', 'POST', { url: input, ...selection() });
      if (seq !== sequence || input !== $('video-link').value || $('upload-mode').value !== 'link') return;
      $('upload-title').value = m.title; $('upload-topic').value = m.topic;
      $('upload-tags').value = m.tags.join(', '); $('upload-source').value = m.sourceUrl;
      $('video-link-status').textContent = `已读取：${m.title} · ${Math.ceil(m.duration / 60)}分钟 · ${m.uploader}。${m.warnings.join(' ')}`;
      if (m.playback) {
        const label = q => ({ 80: '1080p', 64: '720p', 32: '480p', 16: '360p' })[q];
        $('link-quality-status').textContent = `当前可用：${m.playback.availableQualities.map(label).join('、') || '无'}。` +
          (m.playback.canImport ? '本次将使用' + label(m.playback.selectedQuality) + (m.playback.selectedQuality !== selection().quality ? '（已选择自动降级）' : '') : m.playback.reason);
      }
    } catch (e) { if (seq === sequence && input === $('video-link').value) { $('video-link-status').textContent = e.message; onError(e); } }
    finally { loading = ''; if (queued) { queued = false; preview(); } }
  }
  $('video-link-preview').onclick = preview;
  $('video-link').onchange = preview;
  $('video-link').addEventListener('input', () => { sequence++; $('video-link-status').textContent = '链接已改变，请读取视频信息后确认标题等字段。'; });
  $('link-quality').onchange = $('link-mode').onchange = () => { dirty = true; sequence++; preview(); };
  const defaults = s => { if (s) savedDefaults = s; if (!dirty && s) { $('link-quality').value = String(s.quality); $('link-mode').value = s.strict ? 'strict' : 'auto'; } };
  return { mode, preview, selection, defaults, reset() { dirty = false; sequence++; defaults(savedDefaults); } };
}
