const providers = ['gemini', 'openai'];

export function createKnowledgeModelPicker({ element: $, api, send, onError, refresh }) {
  let backend = '', catalog = [], generation = 0, busy = false;
  const field = $('summary-model'), status = $('model-catalog-status'), refreshButton = $('model-catalog-refresh');
  const form = $('provider-credentials'), key = $('provider-api-key');
  let settings, permitted = false;

  function options(selected) {
    const option = (label, value) => new Option(label, value);
    const items = [option('使用默认模型', ''), ...catalog.map(model => option(model.name, model.id))];
    if (selected && !catalog.some(model => model.id === selected)) {
      const unavailable = option(selected + '（当前列表未确认）', selected);
      unavailable.disabled = true;
      items.push(unavailable);
    }
    field.replaceChildren(...items);
    field.value = selected;
    const preferred = backend === 'gemini' ? settings?.gemini?.model : '';
    if (preferred) items[0].textContent = '使用默认模型 · ' + preferred;
  }
  async function reload() {
    const ticket = ++generation, provider = backend, selected = field.value;
    if (!providers.includes(provider)) return;
    status.textContent = '正在读取可用模型…';
    try {
      const result = await api('/settings/models/' + provider);
      if (ticket !== generation) return;
      catalog = result.models;
      options(field.value || selected);
      status.textContent = catalog.length ? (result.source === 'worker' ? '来自在线工作器所连接的 API' : '已读取服务商返回的模型') : '服务商未返回可用于总结的模型';
    } catch (error) {
      if (ticket !== generation) return;
      catalog = [];
      options(field.value || selected);
      status.textContent = error.message;
    }
  }
  async function save(remove = false) {
    if (!permitted || busy || !providers.includes(backend)) return;
    const provider = backend, value = remove ? null : key.value.trim();
    if (!remove && !value) { key.focus(); return; }
    busy = true;
    $('provider-key-save').disabled = $('provider-key-remove').disabled = true;
    try {
      await send('/settings/credentials/' + provider, 'PUT', { apiKey: value });
      key.value = '';
      await refresh();
      if (provider === backend) await reload();
    } catch (error) { onError(error); }
    finally { busy = false; $('provider-key-save').disabled = false; $('provider-key-remove').disabled = false; }
  }
  refreshButton.addEventListener('click', reload);
  $('provider-key-save').addEventListener('click', () => save());
  $('provider-key-remove').addEventListener('click', () => save(true));
  return {
    render(input, selection, canEdit) {
      settings = input;
      permitted = canEdit;
      const changed = backend !== input.backend;
      if (changed) {
        backend = input.backend;
        ++generation;
        catalog = [];
        key.value = '';
        status.textContent = '';
      }
      const hasProvider = providers.includes(backend);
      form.hidden = !hasProvider || !canEdit;
      refreshButton.hidden = !hasProvider || !canEdit;
      $('provider-key-remove').hidden = !input.credentials?.[backend];
      const configured = input.credentials?.[backend] || backend === 'gemini' && input.gemini?.configured;
      $('provider-key-status').textContent = (configured ? '已配置 Key，输入新的 Key 可替换。' : '尚未配置 Key。')
        + (backend === 'openai' ? ' 服务地址 ' + (input.openaiBaseUrl || '') + '。' : '');
      if (backend === 'codex') {
        catalog = (input.worker?.capabilities?.codex?.models || []).map(id => ({ id, name: id }));
        status.textContent = catalog.length ? '来自在线工作器的 Codex CLI' : '等待工作器提供模型列表，可使用 CLI 默认模型';
      }
      options(selection);
      if (changed && hasProvider && canEdit) void reload();
    },
    canSave(value) { return !value || catalog.some(model => model.id === value); }
  };
}
