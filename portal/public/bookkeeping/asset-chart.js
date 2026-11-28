/**
 * Asset balance chart for the bookkeeping accounts tab.
 *
 * Rendered with ECharts on purpose: the portfolio page already uses the same
 * candlestick + dataZoom chart, and the two pages should read as one product.
 * ECharts is lazy-loaded from /vendor only when this chart actually mounts, so
 * the statistics tab never pays for it.
 *
 * Candles come from candles.js (same OHLC rule as the other K-line views); the
 * line mode plots the raw observations.
 */
(function () {
  'use strict';

  var loading = null;

  function loadEcharts() {
    if (window.echarts) return Promise.resolve(window.echarts);
    if (!loading) {
      loading = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = '/vendor/echarts.min.js';
        script.onload = function () {
          if (window.echarts) resolve(window.echarts);
          else reject(new Error('图表组件未初始化'));
        };
        script.onerror = function () { reject(new Error('图表组件加载失败')); };
        document.head.appendChild(script);
      }).catch(function (error) {
        loading = null;
        throw error;
      });
    }
    return loading;
  }

  function cssVar(name, fallback) {
    var value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function colors() {
    return {
      text: cssVar('--text', '#e8edf5'),
      muted: cssVar('--muted', '#9aa4b2'),
      border: cssVar('--border', '#2a3140'),
      card: cssVar('--card', '#171b22'),
      gold: cssVar('--bk-gold', '#d8a13a'),
      green: cssVar('--green', '#3ddc84'),
      red: cssVar('--red', '#ff7b7b')
    };
  }

  function money(value, currency) {
    return (currency || 'CNY') + ' ' + Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function compact(value) {
    return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  }

  window.createBookkeepingAssetChart = function (host) {
    var chart = null;
    var observer = null;
    var mode = 'candle';
    var state = { points: [], currency: 'CNY', bucket: null };
    var lastKey = '';

    function fingerprint() {
      var first = state.points[0], last = state.points[state.points.length - 1];
      return [mode, state.currency, state.points.length, first && first.date, last && last.date, last && last.balance].join('|');
    }

    function candleOption(theme) {
      var candles = window.bkCandles.buildCandles(state.points, 'balance', state.bucket);
      return {
        animation: false,
        backgroundColor: 'transparent',
        grid: { left: 16, right: 18, top: 22, bottom: 56, containLabel: true },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'cross', label: { backgroundColor: theme.card, color: theme.text } },
          backgroundColor: theme.card,
          borderColor: theme.border,
          textStyle: { color: theme.text, fontSize: 13 },
          formatter: function (params) {
            var list = Array.isArray(params) ? params : [params];
            var hit = list.filter(function (item) { return item.seriesType === 'candlestick'; })[0] || list[0];
            var candle = candles[hit && hit.dataIndex];
            if (!candle) return '';
            var change = candle.close - candle.open;
            return '<div style="color:' + theme.muted + ';margin-bottom:4px">' + candle.label + ' · ' + candle.count + ' 个观测</div>'
              + '<div>开 <b>' + money(candle.open, state.currency) + '</b></div>'
              + '<div>高 <b>' + money(candle.high, state.currency) + '</b></div>'
              + '<div>低 <b>' + money(candle.low, state.currency) + '</b></div>'
              + '<div>收 <b>' + money(candle.close, state.currency) + '</b></div>'
              + '<div style="margin-top:4px;color:' + (change >= 0 ? theme.green : theme.red) + '">区间变化 ' + (change >= 0 ? '+' : '') + money(change, state.currency) + '</div>';
          }
        },
        xAxis: {
          type: 'category',
          data: candles.map(function (candle) { return candle.label; }),
          axisLine: { lineStyle: { color: theme.border } },
          axisLabel: { color: theme.muted, hideOverlap: true },
          axisTick: { show: false }
        },
        yAxis: {
          type: 'value',
          scale: true,
          splitLine: { lineStyle: { color: theme.border, opacity: 0.55 } },
          axisLabel: { color: theme.muted, formatter: compact }
        },
        dataZoom: [
          { type: 'inside', xAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: true, moveOnMouseMove: true, moveOnMouseWheel: false, preventDefaultMouseMove: true },
          {
            type: 'slider', xAxisIndex: 0, filterMode: 'none', height: 18, bottom: 6,
            borderColor: theme.border, fillerColor: 'rgba(216, 161, 58, 0.18)',
            handleStyle: { color: theme.gold, borderColor: theme.gold },
            moveHandleStyle: { color: theme.gold },
            emphasis: { handleStyle: { color: theme.gold } },
            textStyle: { color: theme.muted }
          }
        ],
        series: [{
          type: 'candlestick',
          name: '资产余额',
          barMaxWidth: 18,
          data: candles.map(function (candle) { return [candle.open, candle.close, candle.low, candle.high]; }),
          itemStyle: { color: theme.green, color0: theme.red, borderColor: theme.green, borderColor0: theme.red, borderWidth: 1 }
        }]
      };
    }

    function lineOption(theme) {
      return {
        animation: false,
        backgroundColor: 'transparent',
        grid: { left: 16, right: 18, top: 22, bottom: 56, containLabel: true },
        tooltip: {
          trigger: 'axis',
          backgroundColor: theme.card,
          borderColor: theme.border,
          textStyle: { color: theme.text, fontSize: 13 },
          formatter: function (params) {
            var list = Array.isArray(params) ? params : [params];
            var point = list[0];
            if (!point) return '';
            return '<div style="color:' + theme.muted + ';margin-bottom:4px">' + point.axisValue + '</div>'
              + '<div>净资产 <b>' + money(point.value, state.currency) + '</b></div>';
          }
        },
        xAxis: {
          type: 'category',
          boundaryGap: false,
          data: state.points.map(function (point) { return point.date; }),
          axisLine: { lineStyle: { color: theme.border } },
          axisLabel: { color: theme.muted, hideOverlap: true, formatter: function (value) { return typeof value === 'string' && value.length === 10 ? value.slice(5).replace('-', '/') : value; } },
          axisTick: { show: false }
        },
        yAxis: {
          type: 'value',
          scale: true,
          splitLine: { lineStyle: { color: theme.border, opacity: 0.55 } },
          axisLabel: { color: theme.muted, formatter: compact }
        },
        dataZoom: [
          { type: 'inside', xAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: true, moveOnMouseMove: true, moveOnMouseWheel: false, preventDefaultMouseMove: true },
          {
            type: 'slider', xAxisIndex: 0, filterMode: 'none', height: 18, bottom: 6,
            borderColor: theme.border, fillerColor: 'rgba(216, 161, 58, 0.18)',
            handleStyle: { color: theme.gold, borderColor: theme.gold },
            moveHandleStyle: { color: theme.gold },
            emphasis: { handleStyle: { color: theme.gold } },
            textStyle: { color: theme.muted }
          }
        ],
        series: [{
          type: 'line',
          name: '净资产',
          data: state.points.map(function (point) { return point.balance; }),
          showSymbol: state.points.length <= 2,
          sampling: 'lttb',
          lineStyle: { color: theme.gold, width: 2.25 },
          itemStyle: { color: theme.gold },
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(216, 161, 58, 0.26)' },
                { offset: 1, color: 'rgba(216, 161, 58, 0.02)' }
              ]
            }
          }
        }]
      };
    }

    function draw() {
      var theme = colors();
      // Without candles.js (or a bucket) the OHLC path cannot run; degrade to the
      // line instead of throwing and leaving an empty canvas.
      var useCandle = mode === 'candle' && window.bkCandles && state.bucket;
      chart.setOption(useCandle ? candleOption(theme) : lineOption(theme), { notMerge: true });
      requestAnimationFrame(function () { chart && chart.resize(); });
    }

    function fail(message) {
      host.innerHTML = '<div class="bk-empty" role="status">' + message + '</div>';
    }

    function mount() {
      host.innerHTML = '';
      // A cached stylesheet may not carry .bk-asset-chart's height yet; without
      // it ECharts initialises a 0-height canvas and the chart looks missing.
      if (host.clientHeight < 40) host.style.height = '320px';
      loadEcharts().then(function (echarts) {
        chart = echarts.init(host, null, { renderer: 'canvas' });
        chart.getZr().on('dblclick', function () {
          if (!chart) return;
          chart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
        });
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(function () { chart && chart.resize(); });
          observer.observe(host);
        }
        lastKey = '';
        render(state.points, state.currency);
      }).catch(function () {
        fail('图表组件加载失败，请刷新重试');
      });
    }

    function render(points, currency, bucket) {
      state.points = Array.isArray(points) ? points : [];
      state.currency = currency || 'CNY';
      state.bucket = bucket || null;
      if (!chart) {
        if (!host.isConnected) return;
        mount();
        return;
      }
      var key = fingerprint();
      // The accounts tab starts hidden; a chart mounted while it is display:none
      // has a 0x0 canvas until something re-measures it.
      var settle = function () {
        requestAnimationFrame(function () { chart && chart.resize(); });
        setTimeout(function () { chart && chart.resize(); }, 260);
      };
      if (key === lastKey) {
        settle();
        return;
      }
      lastKey = key;
      draw();
      settle();
    }

    function setMode(next) {
      if (next !== 'candle' && next !== 'line') return;
      if (next === mode) return;
      mode = next;
      lastKey = '';
      if (chart) draw();
    }

    function dispose() {
      observer && observer.disconnect();
      observer = null;
      chart && chart.dispose();
      chart = null;
      lastKey = '';
    }

    return { render: render, setMode: setMode, dispose: dispose, mode: function () { return mode; } };
  };
})();
