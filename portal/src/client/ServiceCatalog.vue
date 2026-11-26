<script setup>
defineProps({
  services: { type: Array, required: true },
  hasServices: { type: Boolean, required: true }
});

function serviceLink(service) {
  const target = service.path || service.url;
  if (!target) return '#';
  try {
    const url = new URL(target, location.href);
    if (['http:', 'https:'].includes(url.protocol)) return url.href;
  } catch {
    // Keep cards with no navigable target on the current page.
  }
  return '#';
}
</script>

<template>
  <a v-for="service in services" :key="service.id" class="service-card"
     :href="serviceLink(service)" :target="service.newTab ? '_blank' : undefined"
     :rel="service.newTab ? 'noopener noreferrer' : undefined">
    <div class="icon">{{ service.icon || '📦' }}</div>
    <h2>{{ service.title }}</h2>
    <p>{{ service.description || '' }}</p>
    <span class="tag">{{ ['proxy', 'hub'].includes(service.type) ? '内置' : '外链' }}</span>
  </a>
  <p v-if="!services.length" class="service-empty">
    {{ hasServices ? '没有找到匹配的服务，请尝试其他关键词。' : '当前账号暂无可访问的服务。' }}
  </p>
</template>
