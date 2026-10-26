/* ============================================================
   AgriRobo — Store
   Settings persistence + sensor history (localStorage)
   ============================================================ */
(function () {
  'use strict';

  var SETTINGS_KEY = 'agrirobo.settings.v1';
  var HISTORY_KEY = 'agrirobo.history.v1';
  var MAX_HISTORY = 12000; // safety cap (~8 days at 1/60s)

  var defaults = {
    mode: 'live',                    // 'live' | 'demo'
    baseUrl: 'http://192.168.4.1',
    apiToken: '',
    refreshIntervalSec: 5,
    deviceName: 'AgriRobo-01',
    autoPercent: false,              // ESP32 sends calibrated percent
    calDry: 3200,                    // raw ADC in dry air
    calWet: 1200,                    // raw ADC in wet soil
    soilThreshold: 40,               // watering recommendation threshold %
    soilAlert: 25,                   // low-moisture alert %
    tempHigh: 38,
    tempLow: 10,
    humHigh: 85,
    pumpMaxSec: 30,
    theme: 'system'                  // system | light | dark
  };

  var settings = load();
  var history = loadHistory();
  var lastReading = null;
  var lastSuccessAt = null;
  var listeners = {};

  function load() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return Object.assign({}, defaults);
      var parsed = JSON.parse(raw);
      return Object.assign({}, defaults, parsed);
    } catch (e) {
      return Object.assign({}, defaults);
    }
  }

  function saveSettings(patch) {
    Object.assign(settings, patch || {});
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
    emit('settings', settings);
    return settings;
  }

  function loadHistory() {
    try {
      var raw = localStorage.getItem(HISTORY_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function persistHistory() {
    try {
      if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (e) { /* quota — drop oldest silently */ }
  }

  function addReading(rec) {
    // rec: { soilMoisturePercent|null, temperatureC|null, humidityPercent|null, raw, timestamp }
    lastReading = rec;
    lastSuccessAt = Date.now();
    history.push(rec);
    // keep sorted by time
    if (history.length > 1 && history[history.length - 2].timestamp > rec.timestamp) {
      history.sort(function (a, b) { return a.timestamp - b.timestamp; });
    }
    persistHistory();
    emit('reading', rec);
  }

  function getHistory(fromTs, toTs) {
    return history.filter(function (r) {
      return r.timestamp >= fromTs && r.timestamp <= (toTs || Infinity);
    });
  }

  function clearHistory() {
    history = [];
    lastReading = null;
    lastSuccessAt = null;
    try { localStorage.removeItem(HISTORY_KEY); } catch (e) {}
    emit('history-cleared');
  }

  function on(evt, fn) {
    (listeners[evt] = listeners[evt] || []).push(fn);
  }

  function emit(evt, payload) {
    (listeners[evt] || []).forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error(e); }
    });
  }

  window.AgrStore = {
    defaults: defaults,
    get settings() { return settings; },
    get lastReading() { return lastReading; },
    get lastSuccessAt() { return lastSuccessAt; },
    get historyLength() { return history.length; },
    saveSettings: saveSettings,
    addReading: addReading,
    getHistory: getHistory,
    clearHistory: clearHistory,
    on: on
  };
})();
