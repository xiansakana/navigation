<script setup>
import { onMounted, ref } from 'vue';

const providers = ref([]);
const pending = ref(false);
const error = ref(new URLSearchParams(location.search).get('error') || '');

onMounted(async () => {
  if (error.value) window.portalToast?.error(error.value);
  try {
    const response = await fetch('/api/oauth/providers', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return;
    const data = await response.json();
    if (Array.isArray(data.providers)) {
      providers.value = data.providers.filter(provider => ['github', 'google'].includes(provider?.id));
    }
  } catch {
    // The password form remains usable when provider discovery is unavailable.
  } finally {
    window.navigationSkeleton?.finish();
  }
});

async function submit(event) {
  if (pending.value) return;
  const fields = new FormData(event.currentTarget);
  pending.value = true;
  error.value = '';
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: String(fields.get('username') || '').trim(), password: fields.get('password') })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '登录失败');
    location.href = '/';
  } catch (failure) {
    error.value = failure.message;
    window.portalToast?.error(error.value);
    pending.value = false;
  }
}
</script>

<template>
  <div id="oauth-buttons" class="oauth-buttons" :hidden="!providers.length">
    <a v-for="provider in providers" :key="provider.id"
       :class="['btn', 'oauth-btn', 'oauth-btn--' + provider.id]"
       :href="'/api/oauth/' + provider.id + '/start'">使用 {{ provider.label }} 登录</a>
  </div>
  <p id="oauth-divider" class="oauth-divider" :hidden="!providers.length">或</p>
  <form id="login-form" :aria-busy="pending" @submit.prevent="submit">
    <label for="username">用户名</label>
    <input id="username" name="username" autocomplete="username" required>
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit" class="btn primary" :disabled="pending">{{ pending ? '登录中…' : '登录' }}</button>
    <p id="error" class="error" role="alert" :hidden="!error">{{ error }}</p>
  </form>
</template>
