/* ============================================================
   AgriRobo — Charts (Chart.js wrapper)
   Renders soil / temperature / humidity history per time range
   ============================================================ */
(function () {
  'use strict';

  var charts = { soil: null, temp: null, hum: null };
  var currentRange = '1h';

  var RANGES = {
    '1h':  { ms: 60 * 60 * 1000,        label: 'Last hour' },
    '24h': { ms: 24 * 60 * 60 * 1000,   label: 'Last 24 hours' },
    '7d':  { ms: 7 * 24 * 60 * 60 * 1000, label: 'Last 7 days' }
  };

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#4caf50';
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    if (currentRange === '7d') {
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
             d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return sameDay
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
        d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function downsample(points, max) {
    if (points.length <= max) return points;
    var step = points.length / max;
    var out = [];
    for (var i = 0; i < max; i++) out.push(points[Math.floor(i * step)]);
    return out;
  }

  function seriesFor(field) {
    var to = Date.now();
    var from = to - RANGES[currentRange].ms;
    var rows = AgrStore.getHistory(from, to).filter(function (r) { return r[field] !== null && r[field] !== undefined; });
    var pts = rows.map(function (r) { return { x: r.timestamp, y: r[field] }; });
    var maxPts = currentRange === '1h' ? 120 : (currentRange === '24h' ? 180 : 220);
    return downsample(pts, maxPts);
  }

  function renderOne(key, canvasId, emptyId, data, color, unit) {
    var canvas = document.getElementById(canvasId);
    var empty = document.getElementById(emptyId);
    if (!canvas) return;

    if (!window.Chart) { return; } // Chart.js not loaded yet

    if (charts[key]) { charts[key].destroy(); charts[key] = null; }

    if (!data.length) {
      canvas.style.display = 'none';
      if (empty) empty.classList.remove('hidden');
      return;
    }
    canvas.style.display = 'block';
    if (empty) empty.classList.add('hidden');

    var gridColor = cssVar('--border');
    var textColor = cssVar('--text-2');
    var accent = color || cssVar('--green-600');

    charts[key] = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        datasets: [{
          label: unit,
          data: data,
          borderColor: accent,
          backgroundColor: accent + '33',
          fill: true,
          tension: 0.35,
          pointRadius: data.length > 40 ? 0 : 2.5,
          pointHitRadius: 8,
          borderWidth: 2.2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: function (items) { return items.length ? fmtTime(items[0].parsed.x) : ''; },
              label: function (item) { return ' ' + item.parsed.y + ' ' + unit; }
            }
          }
        },
        scales: {
          x: {
            type: 'linear',
            ticks: {
              color: textColor,
              maxTicksLimit: 5,
              callback: function (v) { return fmtTime(v); }
            },
            grid: { color: gridColor, drawBorder: false }
          },
          y: {
            ticks: { color: textColor, maxTicksLimit: 5 },
            grid: { color: gridColor, drawBorder: false },
            suggestedMin: 0
          }
        }
      }
    });
  }

  function renderAll() {
    if (!window.Chart) return;
    renderOne('soil', 'chart-soil', 'chart-soil-empty', seriesFor('soilMoisturePercent'), cssVar('--green-600'), '%');
    renderOne('temp', 'chart-temp', 'chart-temp-empty', seriesFor('temperatureC'), '#ef6c00', '°C');
    renderOne('hum',  'chart-hum',  'chart-hum-empty',  seriesFor('humidityPercent'), '#0277bd', '%');
  }

  function setRange(range) {
    if (RANGES[range]) { currentRange = range; renderAll(); }
  }

  // Re-render when Chart.js finishes loading (deferred script)
  document.addEventListener('DOMContentLoaded', function () {
    if (window.Chart) renderAll();
    else {
      var tries = 0;
      var iv = setInterval(function () {
        if (window.Chart) { renderAll(); clearInterval(iv); }
        else if (++tries > 40) clearInterval(iv);
      }, 100);
    }
  });

  window.AgrCharts = { renderAll: renderAll, setRange: setRange, getRange: function () { return currentRange; } };
})();
