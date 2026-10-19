// File objects remain in memory until transferred. Server-side documents persist
// after upload; browsers cannot silently retain access to arbitrary local files.
export function createFileQueue({ capacity, upload, changed = () => {}, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const entries = []; let running = false, sequence = 0;
  const pending = () => entries.some(e => ['waiting', 'uploading', 'failed'].includes(e.state));
  async function run() {
    if (running) return;
    running = true;
    try {
      while (entries.some(e => e.state === 'waiting')) {
        const entry = entries.find(e => e.state === 'waiting');
        try {
          const slots = await capacity();
          if (entry.state !== 'waiting') continue;
          if (slots.blocked || !entry.resume && slots.active >= slots.capacity) { entry.message = '等待处理位置空闲（已上传的任务继续处理）'; changed(); await wait(5000); continue; }
          entry.state = 'uploading'; entry.message = '准备上传'; changed();
          await upload(entry, message => { entry.message = message; changed(); });
          entry.state = 'submitted'; entry.message = '已上传，后台继续生成笔记'; entry.file = null;
        } catch (e) {
          if (e.code === 'KNOWLEDGE_CAPACITY') { entry.state = 'waiting'; entry.message = '等待空闲位置'; changed(); await wait(5000); continue; }
          if (entry.state === 'waiting' && e.code !== 'KNOWLEDGE_ACCOUNT_CHANGED') { entry.message = '等待连接：' + e.message; changed(); await wait(5000); continue; }
          entry.state = 'failed'; entry.message = e.message;
        }
        changed();
      }
    } finally { running = false; }
  }
  return {
    entries, pending,
    add(files, metadata, resume = null) {
      const fresh = files.filter(file => !entries.some(e => e.file && e.file.name === file.name && e.file.size === file.size && e.file.lastModified === file.lastModified));
      if (!files.length || files.length > 100 || entries.filter(e => e.file).length + fresh.length > 100) throw new Error('本地等待队列最多100个视频');
      for (const file of fresh) entries.push({ id: String(++sequence), file, name: file.name, state: 'waiting', message: '等待上传', resume,
        metadata: { ...metadata, title: files.length === 1 ? metadata.title : file.name.replace(/\.[^.]+$/, '').slice(0, 160) } });
      changed(); run();
      return fresh.length;
    },
    retry(id) { const entry = entries.find(e => e.id === id); if (entry?.state === 'failed') { entry.state = 'waiting'; changed(); run(); } },
    cancel(id) { const entry = entries.find(e => e.id === id); if (entry && ['waiting', 'failed'].includes(entry.state)) { entry.state = 'cancelled'; entry.file = null; changed(); } }
  };
}
