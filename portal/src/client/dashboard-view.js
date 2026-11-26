import { createApp, computed, ref, watchEffect, h } from 'vue';
import ServiceCatalog from './ServiceCatalog.vue';

export function mountServiceCatalog(grid, search, status, services) {
  const keyword = ref(search.value);
  const visible = computed(() => {
    const term = keyword.value.trim().toLocaleLowerCase();
    return services.filter(service => (service.title + ' ' + (service.description || '')).toLocaleLowerCase().includes(term));
  });
  const app = createApp({
    setup() {
      watchEffect(() => { status.textContent = '显示 ' + visible.value.length + ' 项服务'; });
      return () => h(ServiceCatalog, { services: visible.value, hasServices: services.length > 0 });
    },
  });
  app.mount(grid);
  search.addEventListener('input', () => { keyword.value = search.value; });
}
