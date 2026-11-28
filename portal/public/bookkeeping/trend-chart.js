/**
 * Shared trend chart for the bookkeeping module.
 *
 * Both the account balance card and the billing card use this component so the
 * two screens read as one product: ECharts candlestick/line, dataZoom, crosshair
 * and the same period buttons.
 *
 * Only stock series (balances, cumulative totals) become candles — a flow such
 * as monthly income has no open/high/low/close and turns into a row of bars.
 * Flow series are drawn as lines on a second axis when their magnitude differs
 * a lot from the stock series.
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

  window.createBookkeepingTrendChart = function (host) {
    var chart = null;
    var observer = null;
    var lastKey = '';
    var state = { points: [], series: [], currency: 'CNY', unit: 'day', mode: 'candle', onPick: null };

    function stockSeries() {
      return state.series.filter(function (item) { return item.stock; });
    }

    function candlesFor(series) {
      if (!window.bkCandles || !series) return [];
      return window.bkCandles.buildCandles(state.points, series.key, { unit: state.unit });
    }

    function fingerprint() {
      var first = state.points[0], last = state.points[state.points.length - 1];
      return [
        state.mode, state.unit, state.currency, state.points.length,
        first && first.date, last && last.date,
        state.series.map(function (item) { return item.key + (item.stock ? 's' : 'f'); }).join(',')
      ].join('|');
    }

    function magnitude(item) {
      var values = state.points.map(function (point) { return Math.abs(Number(point[item.key])); }).filter(Number.isFinite);
      return values.length ? Math.max.apply(null, values) : 0;
    }

    function buildOption(theme) {
      var useCandle = state.mode === 'candle' && stockSeries().length > 0 && !!window.bkCandles;
      var stock = stockSeries(), flow = state.series.filter(function (item) { return !item.stock; });
      var series = [], candles = [], category = [];

      if (useCandle) {
        var target = stock[0];
        candles = candlesFor(target);
        category = candles.map(function (candle) { return candle.label; });
        series.push({
          type: 'candlestick',
          name: target.label,
          data: candles.map(function (candle) { return [candle.open, candle.close, candle.low, candle.high]; }),
          barMaxWidth: 18,
          itemStyle: { color: theme.green, color0: theme.red, borderColor: theme.green, borderColor0: theme.red, borderWidth: 1 }
        });
      } else {
        category = state.points.map(function (point) { return point.date; });
        var stockMax = Math.max.apply(null, stock.map(magnitude).concat([0]));
        var flowMax = Math.max.apply(null, flow.map(magnitude).concat([0]));
        var dual = stock.length > 0 && flow.length > 0 && stockMax > 0 && flowMax > 0 && stockMax / flowMax > 8;
        stock.concat(flow).forEach(function (item) {
          series.push({
            type: 'line',
            name: item.label,
            yAxisIndex: dual && flow.indexOf(item) >= 0 ? 1 : 0,
            data: state.points.map(function (point) { return Number.isFinite(point[item.key]) ? point[item.key] : null; }),
            showSymbol: state.points.length <= 2,
            sampling: 'lttb',
            connectNulls: false,
            lineStyle: { color: item.color, width: 2.25 },
            itemStyle: { color: item.color }
          });
        });
        var rightAxis = series.some(function (item) { return item.yAxisIndex === 1; });
      }

      var dualAxis = series.some(function (item) { return item.yAxisIndex === 1; }) || false;
      var axis = { type: 'value', scale: true, splitLine: { lineStyle: { color: theme.border, opacity: 0.55 } }, axisLabel: { color: theme.muted, formatter: compact } };

      return {
        animation: false,
        backgroundColor: 'transparent',
        grid: { left: 16, right: dualAxis ? 60 : 18, top: 22, bottom: 56, containLabel: true },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'cross', label: { backgroundColor: theme.card, color: theme.text } },
          backgroundColor: theme.card,
          borderColor: theme.border,
          textStyle: { color: theme.text, fontSize: 13 },
          formatter: function (params) {
            var list = Array.isArray(params) ? params : [params];
            var hit = list.filter(function (item) { return item.seriesType === 'candlestick'; })[0];
            if (hit) {
              var candle = candles[hit.dataIndex];
              if (!candle) return '';
              var change = candle.close - candle.open;
              return '<div style="color:' + theme.muted + ';margin-bottom:4px">' + candle.label + ' · ' + candle.count + ' 个观测</div>'
                + '<div>开 <b>' + money(candle.open, state.currency) + '</b></div>'
                + '<div>高 <b>' + money(candle.high, state.currency) + '</b></div>'
                + '<div>低 <b>' + money(candle.low, state.currency) + '</b></div>'
                + '<div>收 <b>' + money(candle.close, state.currency) + '</b></div>'
                + '<div style="margin-top:4px;color:' + (change >= 0 ? theme.green : theme.red) + '">区间变化 ' + (change >= 0 ? '+' : '') + money(change, state.currency) + '</div>';
            }
            var first = list[0];
            if (!first) return '';
            return '<div style="color:' + theme.muted + ';margin-bottom:4px">' + first.axisValue + '</div>'
              + list.map(function (item) {
                return '<div>' + item.marker + item.seriesName + ' <b>' + money(item.value, state.currency) + '</b></div>';
              }).join('');
          }
        },
        xAxis: {
          type: 'category',
          data: category,
          boundaryGap: useCandle,
          axisLine: { lineStyle: { color: theme.border } },
          axisLabel: {
            color: theme.muted, hideOverlap: true,
            formatter: function (value) {
              if (useCandle) return value;
              return typeof value === 'string' && value.length === 10 ? value.slice(5).replace('-', '/') : value;
            }
          },
          axisTick: { show: false }
        },
        yAxis: dualAxis ? [axis, { type: 'value', scale: true, splitLine: { show: false }, axisLabel: { color: theme.muted, formatter: compact } }] : axis,
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
        series: series
      };
    }

    function draw() {
      chart.setOption(buildOption(colors()), { notMerge: true });
      requestAnimationFrame(function () { chart && chart.resize(); });
    }

    function settle() {
      requestAnimationFrame(function () { chart && chart.resize(); });
      setTimeout(function () { chart && chart.resize(); }, 260);
    }

    function fail(message) {
      host.innerHTML = '<div class="bk-empty" role="status">' + message + '</div>';
    }

    function mount() {
      host.innerHTML = '';
      // A cached stylesheet may not carry the height yet; without it ECharts
      // initialises a 0-height canvas and the chart looks missing.
      if (host.clientHeight < 40) host.style.height = '320px';
      loadEcharts().then(function (echarts) {
        chart = echarts.init(host, null, { renderer: 'canvas' });
        chart.getZr().on('dblclick', function () {
          if (chart) chart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
        });
        chart.on('click', function (params) {
          if (!state.onPick || params.seriesType !== 'candlestick') return;
          var candle = candlesFor(stockSeries()[0])[params.dataIndex];
          if (candle) state.onPick(candle);
        });
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(function () { chart && chart.resize(); });
          observer.observe(host);
        }
        lastKey = '';
        // Keep the current state (unit/mode) across the async mount.
        render({});
      }).catch(function () {
        fail('图表组件加载失败，请刷新重试');
      });
    }

    function render(next) {
      if (next) {
        if (next.points) state.points = next.points;
        if (next.series) state.series = next.series;
        if (next.currency) state.currency = next.currency;
        if (next.unit) state.unit = next.unit;
        if (next.mode) state.mode = next.mode;
        if ('onPick' in next) state.onPick = next.onPick;
      }
      if (!chart) {
        if (!host.isConnected) return;
        mount();
        return;
      }
      var key = fingerprint();
      if (key === lastKey) {
        settle();
        return;
      }
      lastKey = key;
      draw();
      settle();
    }

    function dispose() {
      if (observer) observer.disconnect();
      observer = null;
      if (chart) chart.dispose();
      chart = null;
      lastKey = '';
    }

    return { render: render, dispose: dispose };
  };
})();
