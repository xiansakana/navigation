import { createApp, h, shallowRef } from 'vue';

type Metric = [label: string, value: string, usage: number | null | undefined, detail: string];
interface ServiceRow {
  key: string | number;
  name: string;
  detail: string;
  state: string;
  online: boolean;
  statusDetail?: string;
  metrics: string[];
}

function mountMetrics(host: HTMLElement) {
  const metrics = shallowRef<Metric[]>([]);
  const app = createApp(() => metrics.value.map(([label, value, usage, detail]) => {
    const meter = usage == null ? null : h('div', {
      class: ['resource-meter', { danger: usage >= 95, warn: usage >= 85 && usage < 95 }]
    }, [h('i', { style: { width: Math.min(100, Math.max(0, usage)) + '%' } })]);
    return h('article', { class: 'resource-stat', key: label }, [
      h('span', { class: 'resource-label' }, label), h('strong', value), meter, h('small', detail)
    ]);
  }));
  app.mount(host);
  return { update(rows: Metric[]) { metrics.value = rows; }, dispose() { app.unmount(); } };
}

function mountServices(host: HTMLElement) {
  const model = shallowRef<{ rows: ServiceRow[]; empty: string }>({ rows: [], empty: '' });
  const app = createApp(() => model.value.rows.length ? model.value.rows.map(row => h('tr', { key: row.key }, [
    h('td', [h('strong', row.name), h('small', { title: row.detail }, row.detail)]),
    h('td', [
      h('span', { class: ['resource-badge', row.online ? 'good' : 'bad'] }, row.state),
      row.statusDetail ? h('small', row.statusDetail) : null
    ]),
    ...row.metrics.map(value => h('td', value))
  ])) : [h('tr', [h('td', { colspan: 8, class: 'resource-empty' }, model.value.empty)])]);
  app.mount(host);
  return {
    update(rows: ServiceRow[], empty: string) { model.value = { rows, empty }; },
    dispose() { app.unmount(); }
  };
}

export function mountResourcesView(hosts: { overview: HTMLElement; processes: HTMLElement; containers: HTMLElement }) {
  const overview = mountMetrics(hosts.overview);
  const processes = mountServices(hosts.processes);
  const containers = mountServices(hosts.containers);
  return {
    updateMetrics: overview.update,
    updateProcesses: processes.update,
    updateContainers: containers.update,
    dispose() { overview.dispose(); processes.dispose(); containers.dispose(); }
  };
}
