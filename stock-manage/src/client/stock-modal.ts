import { createApp, defineComponent, h, nextTick } from 'vue';

export const $ = (selector: string, root: ParentNode = document) => root.querySelector(selector) as HTMLElement | null;
export const $$ = (selector: string, root: ParentNode = document) => [...root.querySelectorAll(selector)] as HTMLElement[];

export async function api(path: string, opts: any = {}) {
  const res = await fetch('./api' + path, {
    headers: opts.body && !(opts.body instanceof ArrayBuffer) && !(opts.body instanceof Blob)
      ? { 'Content-Type': 'application/json', ...(opts.headers || {}) } : opts.headers,
    ...opts,
    body: opts.body instanceof ArrayBuffer || opts.body instanceof Blob ? opts.body
      : opts.body != null ? JSON.stringify(opts.body) : undefined
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const ModalShell = defineComponent({
  name: 'StockLegacyModal',
  props: {
    title: { type: String, default: '' },
    bodyHtml: { type: String, default: '' },
    footHtml: { type: String, default: '' },
    size: { type: String, default: '' },
    hasSubmit: { type: Boolean, default: false }
  },
  setup(props) {
    return () => {
      const sizeClass = props.size === 'trade' ? ' sm-modal--trade'
        : props.size === 'xl' ? ' sm-modal--xl' : ' sm-modal--wide';
      const bodyClass = props.size === 'trade' ? ' sm-modal-body--trade' : '';
      const foot = props.footHtml
        ? h('div', { class: 'sm-modal-foot', innerHTML: props.footHtml })
        : h('div', { class: 'sm-modal-foot' }, [
          h('button', { type: 'button', class: 'btn ghost', 'data-close': '' }, '取消'),
          h('button', { type: 'button', class: 'btn primary', 'data-modal-save': '' }, '保存')
        ]);
      return h('div', { class: 'sm-modal-backdrop' }, [
        h('div', { class: 'sm-modal' + sizeClass, role: 'dialog', 'aria-modal': 'true' }, [
          h('div', { class: 'sm-modal-head' }, [
            h('h3', props.title),
            h('button', { type: 'button', class: 'btn link', 'data-close': '' }, '关闭')
          ]),
          h('div', { class: ('sm-modal-body' + bodyClass).trim(), innerHTML: props.bodyHtml }),
          foot,
          h('div', { class: 'sm-modal-busy', hidden: true }, [
            h('div', { class: 'sm-spinner', 'aria-hidden': 'true' }),
            h('span', { class: 'sm-modal-busy-label' }, '保存中…')
          ])
        ])
      ]);
    };
  }
});

export interface ModalOptions {
  size?: 'trade' | 'xl' | 'wide';
  busyLabel?: string;
  successMessage?: string;
  reload?: boolean;
}

export function setModalBusy(layer: HTMLElement | null, busy: boolean, label?: string) {
  if (!layer) return;
  layer.dataset.busy = busy ? '1' : '0';
  layer.classList.toggle('is-busy', busy);
  const busyEl = layer.querySelector('.sm-modal-busy') as HTMLElement | null;
  const labelEl = layer.querySelector('.sm-modal-busy-label');
  if (labelEl && label) labelEl.textContent = label;
  if (busyEl) busyEl.hidden = !busy;
  layer.querySelectorAll('button').forEach((el: any) => {
    if (el.closest('.sm-modal-busy')) return;
    if (busy) {
      el.dataset.wasDisabled = el.disabled ? '1' : '0';
      el.disabled = true;
    } else if (el.dataset.wasDisabled != null) {
      el.disabled = el.dataset.wasDisabled === '1';
      delete el.dataset.wasDisabled;
    }
  });
}

export function closeModal(layerEl?: HTMLElement | null) {
  const root = $('#modal-root');
  if (!root) return;
  const target = layerEl || (root.querySelector('.sm-modal-backdrop:last-of-type') as HTMLElement | null);
  if (!target) return;
  const layer = target as any;
  if (layer === (window as any)._tradeHistoryLayer) {
    layer.disposeTradeTable?.();
    layer.disposeTradeFilters?.();
    (window as any)._refreshTradeModal = null;
    (window as any)._tradeHistoryLayer = null;
  }
  layer.disposeTradeEditor?.();
  layer.disposeTradeTable?.();
  layer.disposeTradeFilters?.();
  const app = layer.__vueApp;
  const host = layer.__vueHost as HTMLElement | undefined;
  app?.unmount?.();
  host?.remove();
  if (target.isConnected && !host) target.remove();
}

export function openModal(
  title: string,
  bodyHtml: string,
  footHtml: string | null,
  onSubmit: ((layer: HTMLElement) => Promise<string | void> | string | void) | null,
  opts: ModalOptions = {}
): HTMLElement {
  const root = $('#modal-root');
  if (!root) throw new Error('缺少弹窗容器');
  const host = document.createElement('div');
  host.className = 'sm-modal-host';
  root.appendChild(host);
  const app = createApp(ModalShell, {
    title,
    bodyHtml,
    footHtml: footHtml || '',
    size: opts.size || '',
    hasSubmit: Boolean(onSubmit)
  });
  app.mount(host);
  const layer = host.firstElementChild as HTMLElement;
  (layer as any).__vueApp = app;
  (layer as any).__vueHost = host;
  layer.style.zIndex = String(1100 + root.querySelectorAll('.sm-modal-backdrop').length * 10);

  let pointerDownOnBackdrop = false;
  layer.addEventListener('pointerdown', (e) => {
    pointerDownOnBackdrop = e.button === 0 && e.target === layer;
  });
  layer.addEventListener('pointerup', (e) => {
    const shouldClose = pointerDownOnBackdrop && e.button === 0 && e.target === layer && layer.dataset.busy !== '1';
    pointerDownOnBackdrop = false;
    if (shouldClose) closeModal(layer);
  });
  nextTick(() => {
    layer.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => {
      if (layer.dataset.busy === '1') return;
      closeModal(layer);
    }));
    if (onSubmit) {
      layer.querySelector('[data-modal-save]')?.addEventListener('click', async () => {
        if (layer.dataset.busy === '1') return;
        const form = layer.querySelector('form:not([hidden])') as HTMLFormElement | null;
        if (form?.hasAttribute('data-validate') && !form.reportValidity()) return;
        if (form) (layer as any)._formData = new FormData(form);
        setModalBusy(layer, true, opts.busyLabel || '保存中…');
        try {
          const msg = await onSubmit(layer);
          closeModal(layer);
          TOAST_OK(msg || opts.successMessage || '已保存');
          if (opts.reload !== false) (window as any)._stockReload?.();
          (window as any)._refreshTradeModal?.();
        } catch (err: any) {
          setModalBusy(layer, false);
          TOAST_ERR(err.message);
        }
      });
    }
  });
  return layer;
}

function TOAST_OK(message: string) {
  if (typeof (window as any).portalToast?.success === 'function') (window as any).portalToast.success(message);
  else window.alert(message);
}
function TOAST_ERR(message: string) {
  if (typeof (window as any).portalToast?.error === 'function') (window as any).portalToast.error(message);
  else window.alert(message);
}

export async function readProgressResponse(
  response: Response,
  onProgress: (event: any) => void,
  messages: { failed?: string; interrupted?: string } = {}
): Promise<any> {
  if (!response.headers.get('Content-Type')?.includes('text/event-stream')) {
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) throw new Error(data?.error || messages.failed || '请求失败，请重新预览');
    return data;
  }
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(messages.interrupted || '进度连接已中断，请重新预览核对结果');
      pending += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n\n')) !== -1) {
        const packet = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (!packet.startsWith('data: ')) continue;
        const event = JSON.parse(packet.slice(6));
        if (event.error) throw new Error(event.error);
        if (Object.hasOwn(event, 'result')) return event.result;
        if (event.phase) onProgress(event);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
