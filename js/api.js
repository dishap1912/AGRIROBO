/* ============================================================
   AgriRobo — API client
   Live mode: HTTP polling of the ESP32 local API
   Demo mode: clearly-labelled simulated data (no robot)
   ============================================================ */
(function () {
  'use strict';

  var pollTimer = null;
  var pumping = false;
  var pumpOffTimer = null;
  var listeners = {};
  var demoTick = 0;

  /* ---------- helpers ---------- */
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, payload) {
    (listeners[evt] || []).forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error(e); }
    });
  }

  function toNumberOrNull(v) {
    if (v === null || v === undefined || v === '' || v === 'null' || v === 'NaN') return null;
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /* Convert raw soil ADC to 0-100 % using calibration (dry > wet for most capacitive sensors) */
  function rawToPercent(raw, calDry, calWet) {
    if (raw === null) return null;
    if (calDry === calWet) return null;
    var pct = ((calDry - raw) / (calDry - calWet)) * 100;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }

  /* ---------- payload validation & normalisation ---------- */
  function normalizePayload(data, settings) {
    if (!data || typeof data !== 'object') throw new Error('Empty or invalid JSON from device');

    var soilRaw = toNumberOrNull(data.soil_moisture_raw);
    var soilPct = toNumberOrNull(data.soil_moisture_percent);

    if (soilPct === null && soilRaw !== null && !settings.autoPercent) {
      soilPct = rawToPercent(soilRaw, Number(settings.calDry), Number(settings.calWet));
    }

    var temp = toNumberOrNull(data.temperature_c);
    if (temp !== null && (temp < -40 || temp > 80)) temp = null; // DHT11 sanity range
    var hum = toNumberOrNull(data.humidity_percent);
    if (hum !== null && (hum < 0 || hum > 100)) hum = null;

    var tsStr = data.timestamp;
    var ts = tsStr ? Date.parse(tsStr) : NaN;
    if (!Number.isFinite(ts)) ts = Date.now(); // fall back to receive time

    var status = String(data.device_status || 'connected').toLowerCase();
    var battery = toNumberOrNull(data.battery_percent !== undefined ? data.battery_percent : data.battery_voltage);
    var pump = data.pump_status === undefined ? null : String(data.pump_status).toLowerCase();

    return {
      soilMoisturePercent: soilPct,
      soilMoistureRaw: soilRaw,
      temperatureC: temp,
      humidityPercent: hum,
      timestamp: ts,
      deviceStatus: status,
      battery: battery,
      pumpStatus: pump,
      features: data.features || null,
      mode: 'live'
    };
  }

  /* ---------- Live mode ---------- */
  function buildHeaders(settings) {
    var h = { 'Accept': 'application/json' };
    if (settings.apiToken) h['Authorization'] = 'Bearer ' + settings.apiToken;
    return h;
  }

  function liveFetchOnce() {
    var s = AgrStore.settings;
    var base = String(s.baseUrl || '').replace(/\/+$/, '');
    if (!base) return Promise.reject(new Error('No ESP32 URL configured — set it in Settings.'));
    var url = base + '/api/sensors';
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, 8000);

    return fetch(url, { headers: buildHeaders(s), signal: ctrl.signal, cache: 'no-store' })
      .then(function (res) {
        clearTimeout(to);
        if (!res.ok) throw new Error('Device responded HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) {
        var rec = normalizePayload(json, s);
        AgrStore.addReading(rec);
        emit('connected', rec);
        emit('reading', rec);
        return rec;
      })
      .catch(function (err) {
        clearTimeout(to);
        var msg = err.name === 'AbortError' ? 'Connection timed out' : (err.message || 'Network error');
        emit('disconnected', { error: msg });
        throw err;
      });
  }

  function liveCommand(path, body) {
    var s = AgrStore.settings;
    var base = String(s.baseUrl || '').replace(/\/+$/, '');
    if (!base) return Promise.reject(new Error('No ESP32 URL configured'));
    return fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: Object.assign({ 'Content-Type': 'application/json' }, buildHeaders(s)),
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    }).then(function (res) {
      if (!res.ok) throw new Error('Command failed (HTTP ' + res.status + ')');
      var ct = res.headers.get('content-type') || '';
      return ct.indexOf('json') >= 0 ? res.json() : { ok: true };
    });
  }

  /* ---------- Demo mode (clearly simulated) ---------- */
  function demoStep() {
    demoTick++;
    var s = AgrStore.settings;
    // Gentle random-walk simulation, explicitly labelled demo everywhere it is displayed
    var base = 45 + Math.sin(demoTick / 8) * 12;
    var soil = Math.max(5, Math.min(95, Math.round(base + (Math.random() * 8 - 4))));
    if (pumping) soil = Math.min(95, soil + 4);
    var rec = {
      soilMoisturePercent: soil,
      soilMoistureRaw: null,
      temperatureC: Math.round((26 + Math.sin(demoTick / 12) * 5 + Math.random() * 1.5) * 10) / 10,
      humidityPercent: Math.round(60 + Math.sin(demoTick / 10) * 15 + Math.random() * 4),
      timestamp: Date.now(),
      deviceStatus: 'demo',
      battery: null,
      pumpStatus: pumping ? 'on' : 'off',
      features: { pump: true, movement: true, seed: false, plough: false },
      mode: 'demo'
    };
    AgrStore.addReading(rec);
    emit('connected', rec);
    emit('reading', rec);
    return rec;
  }

  function demoCommand(path, body) {
    // In demo mode, control commands only change the simulated pump state
    if (path.indexOf('/api/water') === 0) {
      if (body && body.action === 'on') { pumping = true; schedulePumpAutoOff(); }
      else pumping = false;
      return Promise.resolve({ ok: true, pump_status: pumping ? 'on' : 'off', demo: true });
    }
    return Promise.resolve({ ok: true, demo: true, note: 'Simulated only — no hardware in demo mode' });
  }

  /* ---------- Pump safeguard (auto-off) ---------- */
  function schedulePumpAutoOff() {
    clearTimeout(pumpOffTimer);
    var maxSec = Math.max(5, Number(AgrStore.settings.pumpMaxSec) || 30);
    var left = maxSec;
    emit('pump-timer', left);
    pumpOffTimer = setInterval(function () {
      left--;
      emit('pump-timer', left);
      if (left <= 0) {
        clearInterval(pumpOffTimer);
        sendWater('off').catch(function () {});
      }
    }, 1000);
  }

  function clearPumpTimer() {
    clearTimeout(pumpOffTimer);
    clearInterval(pumpOffTimer);
    pumpOffTimer = null;
    emit('pump-timer', null);
  }

  /* ---------- Public API ---------- */
  function fetchOnce() {
    if (AgrStore.settings.mode === 'demo') {
      return new Promise(function (resolve) {
        setTimeout(function () { resolve(demoStep()); }, 250);
      });
    }
    return liveFetchOnce();
  }

  function sendWater(action) { // 'on' | 'off'
    var body = { action: action };
    var p = AgrStore.settings.mode === 'demo'
      ? demoCommand('/api/water', body)
      : liveCommand('/api/water', body);
    return p.then(function (res) {
      if (action === 'on') { pumping = true; schedulePumpAutoOff(); }
      else { pumping = false; clearPumpTimer(); }
      emit('pump', { action: action, response: res });
      return res;
    }).catch(function (err) {
      if (action === 'on') { pumping = false; clearPumpTimer(); }
      emit('pump-error', err);
      throw err;
    });
  }

  function sendMove(direction) { // forward|backward|left|right|stop
    var body = { direction: direction };
    var p = AgrStore.settings.mode === 'demo'
      ? demoCommand('/api/control/move', body)
      : liveCommand('/api/control/move', body);
    return p.then(function (res) { emit('move', { direction: direction, response: res }); return res; });
  }

  function sendEmergency() {
    var body = { action: 'stop_all' };
    var p = AgrStore.settings.mode === 'demo'
      ? demoCommand('/api/control/emergency', body)
      : liveCommand('/api/control/emergency', body);
    return p.then(function (res) {
      pumping = false; clearPumpTimer();
      emit('emergency', res);
      return res;
    });
  }

  function sendSeed() {
    var body = { action: 'dispense' };
    var p = AgrStore.settings.mode === 'demo'
      ? demoCommand('/api/control/seed', body)
      : liveCommand('/api/control/seed', body);
    return p.then(function (res) { emit('seed', res); return res; });
  }

  function sendPlough() {
    var body = { action: 'toggle' };
    var p = AgrStore.settings.mode === 'demo'
      ? demoCommand('/api/control/plough', body)
      : liveCommand('/api/control/plough', body);
    return p.then(function (res) { emit('plough', res); return res; });
  }

  function testConnection() {
    if (AgrStore.settings.mode === 'demo') {
      return new Promise(function (resolve) {
        setTimeout(function () { resolve({ ok: true, demo: true, message: 'Demo mode — no hardware required.' }); }, 300);
      });
    }
    return fetchOnce().then(function (rec) {
      return { ok: true, message: 'Connected! Soil ' + (rec.soilMoisturePercent !== null ? rec.soilMoisturePercent + '%' : 'n/a') +
        ', Temp ' + (rec.temperatureC !== null ? rec.temperatureC + ' °C' : 'n/a') };
    });
  }

  function startPolling() {
    stopPolling();
    var ms = Math.max(2, Number(AgrStore.settings.refreshIntervalSec) || 5) * 1000;
    fetchOnce().catch(function () {}); // immediate first attempt
    pollTimer = setInterval(function () { fetchOnce().catch(function () {}); }, ms);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  window.AgrApi = {
    on: on,
    fetchOnce: fetchOnce,
    startPolling: startPolling,
    stopPolling: stopPolling,
    testConnection: testConnection,
    sendWater: sendWater,
    sendMove: sendMove,
    sendEmergency: sendEmergency,
    sendSeed: sendSeed,
    sendPlough: sendPlough,
    isPumping: function () { return pumping; },
    rawToPercent: rawToPercent
  };
})();
