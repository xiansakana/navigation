import { createApp, h, shallowRef } from 'vue';

export interface QueueEntry {
  id: string;
  url: string;
  state: string;
  title?: string;
  error?: string;
  documentId?: string;
  documentStatus?: string;
  documentStage?: string;
  documentTitle?: string;
}

interface QueueActions {
  can(action: string): boolean;
  open(id: string): Promise<void>;
  manage(action: 'retry' | 'cancel', id: string): Promise<void>;
}

const stateLabels: Record<string, string> = {
  pending: '等待空闲位置，尚未下载',
  resolving: '正在读取视频信息',
  failed: '导入失败',
  cancelled: '已取消',
  duplicate: '重复视频，已跳过',
};

export function mountQueueView(host: HTMLElement, actions: QueueActions) {
  const entries = shallowRef<QueueEntry[]>([]);
  const busy = shallowRef<string[]>([]);
  const pending = (id: string, action: string) => busy.value.includes(id + ':' + action);

  const button = (entry: QueueEntry, action: 'retry' | 'cancel', label: string) => h('button', {
    type: 'button',
    class: 'btn ghost',
    disabled: pending(entry.id, action),
    onClick: async () => {
      busy.value = [...busy.value, entry.id + ':' + action];
      try { await actions.manage(action, entry.id); }
      finally { busy.value = busy.value.filter(key => key !== entry.id + ':' + action); }
    }
  }, label);

  const app = createApp(() => entries.value.length ? entries.value.map(entry => {
    const actionsCell: ReturnType<typeof h>[] = [];
    if (entry.documentId && entry.documentStatus && actions.can('notes:view')) {
      actionsCell.push(h('button', {
        type: 'button',
        class: 'btn ghost',
        disabled: pending(entry.id, 'open'),
        onClick: async () => {
          busy.value = [...busy.value, entry.id + ':open'];
          try { await actions.open(entry.documentId!); }
          finally { busy.value = busy.value.filter(key => key !== entry.id + ':open'); }
        }
      }, '打开笔记'));
    }
    if (actions.can('queue:manage')) {
      if (entry.state === 'failed') actionsCell.push(button(entry, 'retry', '重试'));
      if (['pending', 'resolving', 'failed'].includes(entry.state)) actionsCell.push(button(entry, 'cancel', '取消等待'));
    }
    return h('div', { key: entry.id, class: 'kb-queue-row' }, [
      h('strong', entry.documentTitle || entry.title || entry.url),
      h('p', entry.error || (entry.state === 'submitted' ? entry.documentStage || '已提交，关联笔记已删除' : stateLabels[entry.state] || entry.state)),
      h('a', { href: entry.url, target: '_blank', rel: 'noopener noreferrer' }, '来源视频'),
      h('div', { class: 'kb-actions' }, actionsCell)
    ]);
  }) : [h('p', '批量提交的B站链接会保存在这里，关闭页面后仍会自动接续。')]);

  app.mount(host);
  return {
    update(next: QueueEntry[]) { entries.value = next; },
    dispose() { app.unmount(); }
  };
}
