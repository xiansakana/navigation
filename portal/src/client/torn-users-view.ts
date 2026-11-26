import { createApp, h, shallowRef } from 'vue';

export interface UsersRow {
  id: number | string;
  name?: string;
  status: string;
  hospitalUntil?: number;
  reminderAt?: number;
  checkedAt?: number;
  error?: string;
}

export interface UsersHistoryRow {
  id: number | string;
  name?: string;
  hospitalUntil?: number;
  detectedAt: number;
  remainingSeconds: number;
  notification: string;
}

const time = (value?: number) => Number.isFinite(value) ? new Date(Number(value) * 1000).toLocaleString('sv-SE') : '—';
const userLink = (row: UsersRow | UsersHistoryRow) => h('a', {
  href: 'https://www.torn.com/profiles.php?XID=' + row.id, target: '_blank', rel: 'noopener noreferrer'
}, (row.name || '用户') + ' [' + row.id + ']');
const notifications: Record<string, string> = {
  pending: '待确认', sent: '已提交渠道', disabled: '未开启渠道或无通知权限', failed: '失败，请检查通知管理'
};

export function mountUsersView(hosts: { rows: HTMLElement; history: HTMLElement }) {
  const rows = shallowRef<UsersRow[]>([]);
  const history = shallowRef<UsersHistoryRow[]>([]);

  const rowApp = createApp(() => rows.value.map(row => h('tr', { key: String(row.id) }, [
    h('td', { 'data-label': '用户' }, userLink(row)),
    h('td', { 'data-label': '状态' }, row.status === 'unknown' ? '状态不明' : row.status),
    h('td', { 'data-label': '预计出院' }, time(row.hospitalUntil)),
    h('td', { 'data-label': '剩余时间', 'data-until': row.hospitalUntil || undefined }, '—'),
    h('td', { 'data-label': '提醒时间' }, time(row.reminderAt)),
    h('td', { 'data-label': '最近核验 / 问题' }, time(row.checkedAt) + (row.error ? ' · ' + row.error : ''))
  ])));
  rowApp.mount(hosts.rows);

  const historyApp = createApp(() => history.value.length ? history.value.map(row => h('article', { key: String(row.id) + ':' + row.detectedAt }, [
    userLink(row),
    h('p', '预计出院 ' + time(row.hospitalUntil) + ' · 提醒于 ' + time(row.detectedAt) + ' · 当时剩余 ' + row.remainingSeconds + ' 秒'),
    h('p', '通知：' + (notifications[row.notification] || '未知'))
  ])) : [h('p', '尚无出院提醒记录')]);
  historyApp.mount(hosts.history);

  return {
    renderRows(next: UsersRow[]) { rows.value = next; },
    renderHistory(next: UsersHistoryRow[]) { history.value = next; },
    dispose() { rowApp.unmount(); historyApp.unmount(); }
  };
}
