<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue';
import { escapeHtml, formatDate, klineOption, sourceLabel } from './quant-views';

const props = defineProps<{ symbol: string; period?: string }>();
const emit = defineEmits<{ close: [] }>();

const status = ref('准备加载行情…');
const period = ref(props.period || '1y');
const chartEl = ref<HTMLElement | null>(null);
let chart: any = null;
let candles: any[] = [];
let loadingOlder = false;
let hasMore = true;
let boundaryTimer: any = null;
let wheelHandler: ((event: WheelEvent) => void) | null = null;

async function api(path: string, options: any = {}) {
  const response = await fetch(`../api${path}`, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText || '请求失败');
  return data;
}

function zoomIndex(dates: string[], value: any, percent: any, fallback: number) {
  if (typeof value === 'string') {
    const index = dates.indexOf(value);
    if (index >= 0) return index;
  }
  if (Number.isFinite(Number(value))) {
    return Math.max(0, Math.min(dates.length - 1, Math.round(Number(value))));
  }
  const ratio = Number.isFinite(Number(percent)) ? Number(percent) : fallback;
  return Math.max(0, Math.min(dates.length - 1, Math.round(ratio / 100 * (dates.length - 1))));
}

function zoomAtPointer(event: WheelEvent) {
  if (!chart || candles.length < 2) return;
  event.preventDefault();
  event.stopPropagation();
  const dates = candles.map((item) => new Date(Number(item.timestamp)).toISOString().slice(0, 10));
  const zoom = chart.getOption().dataZoom?.[0] || { start: 0, end: 100 };
  const startIndex = zoomIndex(dates, zoom.startValue, zoom.start, 0);
  const endIndex = zoomIndex(dates, zoom.endValue, zoom.end, 100);
  const host = event.currentTarget as HTMLElement;
  const hostRect = host.getBoundingClientRect();
  const scaleX = hostRect.width ? chart.getWidth() / hostRect.width : 1;
  const pointerX = (event.clientX - hostRect.left) * scaleX;
  const gridRect = chart.getModel()?.getComponent('grid', 0)?.coordinateSystem?.getRect();
  const gridLeft = Number(gridRect?.x) || 62;
  const gridWidth = Number(gridRect?.width) || Math.max(1, chart.getWidth() - 86);
  const focusRatio = Math.max(0, Math.min(1, (pointerX - gridLeft) / gridWidth));
  const currentSpan = Math.max(2, endIndex - startIndex + 1);
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? hostRect.height : 1;
  const delta = Math.max(-300, Math.min(300, event.deltaY * unit));
  const nextSpan = Math.max(Math.min(10, dates.length), Math.min(dates.length, Math.round(currentSpan * Math.exp(delta * 0.002))));
  if (nextSpan === currentSpan) return;
  const anchorIndex = Math.round(startIndex + focusRatio * (currentSpan - 1));
  let nextStart = Math.round(anchorIndex - focusRatio * (nextSpan - 1));
  nextStart = Math.max(0, Math.min(dates.length - nextSpan, nextStart));
  chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, startValue: dates[nextStart], endValue: dates[nextStart + nextSpan - 1] });
}

function checkBoundary() {
  if (!chart || loadingOlder || !hasMore) return;
  const zoom = chart.getOption().dataZoom?.[0] || {};
  let nearLeft = Number.isFinite(Number(zoom.start)) && Number(zoom.start) <= 5;
  if (!nearLeft && zoom.startValue != null) {
    const dates = candles.map((item) => new Date(Number(item.timestamp)).toISOString().slice(0, 10));
    const index = typeof zoom.startValue === 'number' ? zoom.startValue : dates.indexOf(String(zoom.startValue));
    nearLeft = index >= 0 && index <= 3;
  }
  if (nearLeft) void loadOlder();
}

async function load(symbol: string, nextPeriod: string) {
  const host = chartEl.value;
  if (!host) return;
  status.value = '正在加载真实历史行情…';
  if (chart && wheelHandler) host.removeEventListener('wheel', wheelHandler, true);
  wheelHandler = null;
  chart?.dispose();
  chart = null;
  try {
    const result = await api(`/quant/history/${encodeURIComponent(symbol)}?period=${encodeURIComponent(nextPeriod)}`);
    candles = result.candles || [];
    hasMore = result.hasMore !== false;
    status.value = `${candles.length} 根日 K · ${sourceLabel(result.source)}${result.adjustedForSplits ? ' · 拆股复权' : ''} · 左移到边界自动加载更早行情`;
    if (!(globalThis as any).echarts) throw new Error('图表组件加载失败');
    chart = (globalThis as any).echarts.init(host, null, { renderer: 'canvas' });
    chart.setOption(klineOption(candles));
    chart.on('datazoom', () => {
      clearTimeout(boundaryTimer);
      boundaryTimer = setTimeout(checkBoundary, 80);
    });
    wheelHandler = zoomAtPointer;
    host.addEventListener('wheel', wheelHandler, { passive: false, capture: true });
  } catch (error: any) {
    status.value = error.message || 'K 线加载失败';
    host.innerHTML = `<div class="quant-kline-error">${escapeHtml(error.message || 'K 线加载失败')}</div>`;
  }
}

async function loadOlder() {
  if (loadingOlder || !hasMore || !candles.length || !chart) return;
  loadingOlder = true;
  const oldest = Number(candles[0].timestamp);
  const oldLength = candles.length;
  const zoom = chart.getOption().dataZoom?.[0] || { start: 0, end: 100 };
  const oldDates = candles.map((item) => new Date(Number(item.timestamp)).toISOString().slice(0, 10));
  const visibleStart = oldDates[zoomIndex(oldDates, zoom.startValue, zoom.start, 0)];
  const visibleEnd = oldDates[zoomIndex(oldDates, zoom.endValue, zoom.end, 100)];
  status.value = `正在加载 ${formatDate(oldest)} 之前的行情…`;
  try {
    const result = await api(`/quant/history/${encodeURIComponent(props.symbol)}?before=${oldest}&days=730`);
    const merged = new Map([...result.candles, ...candles].map((candle: any) => [Number(candle.timestamp), candle]));
    candles = [...merged.values()].sort((a: any, b: any) => Number(a.timestamp) - Number(b.timestamp));
    const added = candles.length - oldLength;
    hasMore = result.hasMore !== false && added > 0;
    const option = klineOption(candles);
    option.dataZoom.forEach((item: any) => { delete item.start; delete item.end; item.startValue = visibleStart; item.endValue = visibleEnd; });
    chart.setOption(option, true);
    status.value = `${candles.length} 根日 K · ${sourceLabel(result.source)}${result.adjustedForSplits ? ' · 拆股复权' : ''}${hasMore ? ' · 左移继续加载' : ' · 已到可用历史起点'}`;
  } catch (error: any) {
    status.value = `更早行情加载失败：${error.message}`;
  } finally {
    loadingOlder = false;
  }
}

function onResize() { chart?.resize(); }
function onKeydown(event: KeyboardEvent) { if (event.key === 'Escape') emit('close'); }

let pointerDownOnBackdrop = false;
function onPointerDown(event: PointerEvent) {
  pointerDownOnBackdrop = event.target === event.currentTarget;
}
function onPointerUp(event: PointerEvent) {
  if (pointerDownOnBackdrop && event.target === event.currentTarget) emit('close');
  pointerDownOnBackdrop = false;
}

onMounted(async () => {
  await nextTick();
  void load(props.symbol, period.value);
  window.addEventListener('resize', onResize);
  document.addEventListener('keydown', onKeydown);
});
onUnmounted(() => {
  clearTimeout(boundaryTimer);
  if (chart && wheelHandler && chartEl.value) chartEl.value.removeEventListener('wheel', wheelHandler, true);
  chart?.dispose();
  window.removeEventListener('resize', onResize);
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="sm-modal-backdrop quant-kline-backdrop" @pointerdown="onPointerDown" @pointerup="onPointerUp">
    <div class="sm-modal sm-modal--xl quant-kline-modal" role="dialog" aria-modal="true" aria-labelledby="kline-title">
      <div class="sm-modal-head">
        <div><h3 id="kline-title">{{ symbol }} · 日 K 线</h3><p id="kline-status">{{ status }}</p></div>
        <button type="button" class="btn link" @click="$emit('close')">关闭</button>
      </div>
      <div class="quant-kline-toolbar">
        <label>初始范围 <select v-model="period" @change="load(symbol, period)">
          <option value="3m">近 3 个月</option><option value="6m">近 6 个月</option><option value="1y">近 1 年</option><option value="2y">近 2 年</option><option value="5y">近 5 年</option>
        </select></label>
        <span>滚轮缩放或拖动到左边界时，会自动加载更早行情</span>
      </div>
      <div class="sm-modal-body quant-kline-body"><div id="kline-chart" ref="chartEl"></div></div>
    </div>
  </div>
</template>
