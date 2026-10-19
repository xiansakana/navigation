(function () {
  const $ = id => document.getElementById(id);
  let documents = [], offset = 0, query = 0;
  async function api(path) {
    const response = await fetch('/api/knowledge/public/' + path, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '公开笔记暂不可用');
    return data;
  }
  function error(e) { $('public-error').textContent = e.message; }
  async function open(id) {
    const { document: item } = await api('documents/' + id);
    $('public-title').textContent = item.title;
    $('public-meta').textContent = [item.topic, ...item.tags, '更新于 ' + new Date(item.updatedAt).toLocaleDateString('zh-CN')].filter(Boolean).join(' · ');
    $('public-notes').innerHTML = DOMPurify.sanitize(marked.parse(item.notes || ''), { USE_PROFILES: { html: true },
      FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'form', 'input', 'button', 'style'], FORBID_ATTR: ['style', 'id', 'name'] });
    for (const link of $('public-notes').querySelectorAll('a')) { link.rel = 'noopener noreferrer'; link.target = '_blank'; }
    history.replaceState(null, '', '?document=' + id);
  }
  async function load(append = false) {
    const request = ++query;
    const data = await api('documents?' + new URLSearchParams({ search: $('public-search').value, offset: append ? offset : 0 }));
    if (request !== query) return;
    documents = append ? documents.concat(data.documents) : data.documents; offset = documents.length;
    $('public-total').textContent = data.total + ' 篇'; $('public-more').hidden = offset >= data.total;
    const list = $('public-documents'); list.replaceChildren();
    if (!documents.length) list.textContent = '暂无公开笔记。私人资料不会自动公开。';
    for (const item of documents) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'kb-document';
      const title = document.createElement('strong'); title.textContent = item.title;
      const preview = document.createElement('p'); preview.textContent = item.preview;
      button.append(title, preview); button.onclick = () => open(item.id).catch(error); list.append(button);
    }
  }
  $('public-search-form').onsubmit = event => { event.preventDefault(); void load().catch(error); };
  $('public-more').onclick = () => load(true).catch(error);
  fetch('/api/me').then(response => response.json()).then(me => {
    if (me.ok && !me.isGuest) { $('private-library').textContent = '我的知识库'; $('private-library').href = '/knowledge/'; }
  }).catch(() => {});
  load().then(() => { const id = new URL(location.href).searchParams.get('document'); if (/^[a-f0-9]{32}$/.test(id || '')) return open(id); }).catch(error);
})();
