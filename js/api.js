/* ============================================================
   AgriRobo — API client (WebSocket edition)
   Live mode : WebSocket to the ESP32  ws://<esp32-ip>:81
               - sends  "x,y,speedMode,stop,dispense"  20x / second
               - receives "S,<tempC>,<hum%>[,<soilRaw>]" every ~2 s
   Demo mode : clearly-labelled simulated data (no robot)
   Public API is unchanged, so app.js / charts.js keep working.
   ============================================================ */
(function () {
  'use strict';

  var WS_PORT = 81;          // must match WebSocketsServer ws(81) in firmware
  var SEND_MS = 50;          // firmware failsafe stops motors after 800 ms of silence
  var CONNECT_TIMEOUT_MS = 5000;

  var listeners = {};
  var ws = null, wsOpen = false, wantLive = false;
  var reconnectTimer = null, connectTimer = null, streamTimer = null;
  var cmd = { x: 0, y: 0, stop: 0, disp: 0 };
  var latest = null, lastStoredAt = 0, rawWaiters = [];

  // demo-only state
  var pollTimer = null, pumping = false, pumpOffTimer = null, demoTick = 0;

  /* ---------- helpers ---------- */
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, payload) {
    (listeners[evt] || []).forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error(e); }
    });
  }
  function isDemo() { return AgrStore.settings.mode === 'demo'; }

  function toNumberOrNull(v) {
    if (v === null || v === undefined || v === '' || v === 'null' || v === 'NaN' || v === 'err') return null;
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /* raw soil ADC -> 0-100 % (higher raw = drier on most capacitive sensors) */
  function rawToPercent(raw, calDry, calWet) {
    if (raw === null || calDry === calWet) return null;
    var pct = ((calDry - raw) / (calDry - calWet)) * 100;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }

  /* ESP32 address: if this page is itself served by the ESP32 (private IP) use that,
     otherwise take the host out of the "ESP32 base URL" setting. */
  function espHost() {
    var h = location.hostname;
    if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return h;
    return String(AgrStore.settings.baseUrl || '').trim()
      .replace(/^[a-z]+:\/\//i, '').replace(/[\/?#].*$/, '').replace(/:\d+$/, '');
  }

  function speedMode() {
    var m = Number(AgrStore.settings.speedMode);
    return (m === 0 || m === 1 || m === 2) ? m : 1;   // default SLOW (safest)
  }

  /* ---------- sensor message -> reading ---------- */
  // "S,28.5,61"  |  "S,28.5,61,2310"  |  "S,err"  |  "S,err,err,2310"
  function parseSensorMsg(text) {
    var p = String(text).split(',');
    if (p[0] !== 'S') return null;
    var s = AgrStore.settings;
    var temp = toNumberOrNull(p[1]);
    if (temp !== null && (temp < -40 || temp > 80)) temp = null;
    var hum = toNumberOrNull(p[2]);
    if (hum !== null && (hum < 0 || hum > 100)) hum = null;
    var soilRaw = toNumberOrNull(p[3]);
    var soilPct = null;
    if (soilRaw !== null) {
      soilPct = s.autoPercent ? Math.max(0, Math.min(100, Math.round(soilRaw)))
                              : rawToPercent(soilRaw, Number(s.calDry), Number(s.calWet));
    }
    return {
      soilMoisturePercent: soilPct,
      soilMoistureRaw: soilRaw,
      temperatureC: temp,
      humidityPercent: hum,
      timestamp: Date.now(),
      deviceStatus: 'connected',
      battery: null,
      pumpStatus: null,
      features: { pump: false, movement: true, seed: true, plough: false },
      mode: 'live'
    };
  }

  function storeAndEmit(rec) {
    lastStoredAt = Date.now();
    AgrStore.addReading(rec);
    emit('connected', rec);
    emit('reading', rec);
  }

  function onMessage(e) {
    var rec = parseSensorMsg(e.data);
    if (!rec) return;
    latest = rec;
    // ESP32 pushes every ~2 s; only record/render once per refresh interval
    var every = Math.max(2, Number(AgrStore.settings.refreshIntervalSec) || 5) * 1000;
    if (Date.now() - lastStoredAt >= every - 200) storeAndEmit(rec);
    var w = rawWaiters; rawWaiters = [];
    w.forEach(function (fn) { fn(rec); });
  }

  /* ---------- WebSocket plumbing ---------- */
  function streamTick() {
    if (!ws || ws.readyState !== 1) return;
    var line = cmd.x + ',' + cmd.y + ',' + speedMode() + ',' + (cmd.stop > 0 ? 1 : 0) + ',' + cmd.disp;
    try { ws.send(line); } catch (e) { return; }
    if (cmd.stop > 0) cmd.stop--;
    cmd.disp = 0;
  }
  function startStream() { stopStream(); streamTimer = setInterval(streamTick, SEND_MS); }
  function stopStream() { if (streamTimer) { clearInterval(streamTimer); streamTimer = null; } }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    if (!wantLive) return;
    reconnectTimer = setTimeout(connectWs, 2000);
  }

  function closeWs() {
    clearTimeout(reconnectTimer); clearTimeout(connectTimer);
    stopStream();
    if (ws) {
      try { if (ws.readyState === 1) ws.send('0,0,' + speedMode() + ',1,0'); } catch (e) {}
      ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null;
      try { ws.close(); } catch (e) {}
      ws = null;
    }
    wsOpen = false;
    cmd.x = 0; cmd.y = 0;
  }

  function connectWs() {
    clearTimeout(reconnectTimer); clearTimeout(connectTimer);
    if (ws) { closeWs(); }
    var host = espHost();
    if (!host) {
      emit('disconnected', { error: 'No ESP32 address set — enter it in Settings (e.g. 192.168.4.1).' });
      return;
    }
    if (location.protocol === 'https:') {
      emit('disconnected', { error: 'This page is on HTTPS, but the robot only speaks plain ws://. ' +
        'Open the app from http://' + host + ' (served by the ESP32) instead.' });
      return;
    }
    try { ws = new WebSocket('ws://' + host + ':' + WS_PORT + '/'); }
    catch (e) { emit('disconnected', { error: e.message || 'WebSocket blocked' }); scheduleReconnect(); return; }

    var mine = ws;
    connectTimer = setTimeout(function () { if (mine === ws && !wsOpen) { try { mine.close(); } catch (e) {} } }, CONNECT_TIMEOUT_MS);

    ws.onopen = function () {
      clearTimeout(connectTimer);
      wsOpen = true;
      cmd.x = 0; cmd.y = 0;          // always start centred so the robot arms safely
      startStream();
    };
    ws.onmessage = onMessage;
    ws.onerror = function () { try { mine.close(); } catch (e) {} };
    ws.onclose = function () {
      if (mine !== ws) return;
      var was = wsOpen;
      wsOpen = false; ws = null; stopStream();
      cmd.x = 0; cmd.y = 0;
      if (wantLive) {
        emit('disconnected', { error: was ? 'Connection to the robot was lost' : 'Cannot reach the robot at ' + host });
        scheduleReconnect();
      }
    };
  }

  function waitForData(ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return; done = true;
        reject(new Error(wsOpen ? 'Connected, but no sensor data yet' : 'Connection timed out'));
      }, ms);
      rawWaiters.push(function (rec) { if (done) return; done = true; clearTimeout(t); resolve(rec); });
    });
  }

  /* ---------- Live commands ---------- */
  var DIRS = { forward: [0, 100], backward: [0, -100], left: [-100, 0], right: [100, 0], stop: [0, 0] };

  function liveMove(direction) {
    var v = DIRS[direction];
    if (!v) return Promise.reject(new Error('Unknown direction: ' + direction));
    if (!wsOpen) return Promise.reject(new Error('Robot not connected'));
    cmd.x = v[0]; cmd.y = v[1];
    if (direction === 'stop') cmd.stop = 2;
    return Promise.resolve({ ok: true });
  }
  function liveEmergency() {
    cmd.x = 0; cmd.y = 0; cmd.stop = 5;       // firmware stops + disarms on the stop flag
    if (!wsOpen) return Promise.reject(new Error('Robot not connected — motors stop by themselves (failsafe)'));
    return Promise.resolve({ ok: true });
  }
  function liveSeed() {
    if (!wsOpen) return Promise.reject(new Error('Robot not connected'));
    cmd.disp = 1;
    return Promise.resolve({ ok: true, note: 'Seed gate opened — it closes automatically.' });
  }

  /* ---------- Demo mode (clearly simulated) ---------- */
  function demoStep() {
    demoTick++;
    var base = 45 + Math.sin(demoTick / 8) * 12;
    var soil = Math.max(5, Math.min(95, Math.round(base + (Math.random() * 8 - 4))));
    if (pumping) soil = Math.min(95, soil + 4);
    var rec = {
      soilMoisturePercent: soil, soilMoistureRaw: null,
      temperatureC: Math.round((26 + Math.sin(demoTick / 12) * 5 + Math.random() * 1.5) * 10) / 10,
      humidityPercent: Math.round(60 + Math.sin(demoTick / 10) * 15 + Math.random() * 4),
      timestamp: Date.now(), deviceStatus: 'demo', battery: null,
      pumpStatus: pumping ? 'on' : 'off',
      features: { pump: true, movement: true, seed: true, plough: false },
      mode: 'demo'
    };
    storeAndEmit(rec);
    return rec;
  }
  function demoCommand(path, body) {
    if (path.indexOf('/api/water') === 0) {
      if (body && body.action === 'on') { pumping = true; schedulePumpAutoOff(); } else pumping = false;
      return Promise.resolve({ ok: true, pump_status: pumping ? 'on' : 'off', demo: true });
    }
    return Promise.resolve({ ok: true, demo: true, note: 'Simulated only — no hardware in demo mode' });
  }
  function schedulePumpAutoOff() {
    clearInterval(pumpOffTimer);
    var left = Math.max(5, Number(AgrStore.settings.pumpMaxSec) || 30);
    emit('pump-timer', left);
    pumpOffTimer = setInterval(function () {
      left--; emit('pump-timer', left);
      if (left <= 0) { clearInterval(pumpOffTimer); sendWater('off').catch(function () {}); }
    }, 1000);
  }
  function clearPumpTimer() { clearInterval(pumpOffTimer); pumpOffTimer = null; emit('pump-timer', null); }

  /* ---------- Public API ---------- */
  function fetchOnce() {
    if (isDemo()) return new Promise(function (r) { setTimeout(function () { r(demoStep()); }, 250); });
    wantLive = true;
    if (!ws) connectWs();
    if (wsOpen && latest) { storeAndEmit(latest); return Promise.resolve(latest); }
    return waitForData(6000).then(function (rec) { return rec; });
  }

  function sendWater(action) {
    if (!isDemo()) return Promise.reject(new Error('This robot build has no water pump'));
    return demoCommand('/api/water', { action: action }).then(function (res) {
      if (action === 'on') { pumping = true; schedulePumpAutoOff(); } else { pumping = false; clearPumpTimer(); }
      emit('pump', { action: action, response: res });
      return res;
    });
  }

  function sendMove(direction) {
    var p = isDemo() ? demoCommand('/api/control/move', { direction: direction }) : liveMove(direction);
    return p.then(function (res) { emit('move', { direction: direction, response: res }); return res; });
  }
  function sendEmergency() {
    var p = isDemo() ? demoCommand('/api/control/emergency', {}) : liveEmergency();
    return p.then(function (res) { pumping = false; clearPumpTimer(); emit('emergency', res); return res; });
  }
  function sendSeed() {
    var p = isDemo() ? demoCommand('/api/control/seed', {}) : liveSeed();
    return p.then(function (res) { emit('seed', res); return res; });
  }
  function sendPlough() {
    if (!isDemo()) return Promise.reject(new Error('Ploughing is not implemented in the firmware'));
    return demoCommand('/api/control/plough', {}).then(function (res) { emit('plough', res); return res; });
  }

  function setSpeed(m) { AgrStore.saveSettings({ speedMode: Number(m) }); }   // 0 normal, 1 slow, 2 fast
  function getSpeed() { return speedMode(); }

  function testConnection() {
    if (isDemo()) return new Promise(function (r) {
      setTimeout(function () { r({ ok: true, demo: true, message: 'Demo mode — no hardware required.' }); }, 300);
    });
    wantLive = true;
    connectWs();                       // reconnect with the address currently in Settings
    return waitForData(7000).then(function (rec) {
      storeAndEmit(rec);
      return { ok: true, message: 'Connected! Temp ' + (rec.temperatureC !== null ? rec.temperatureC + ' °C' : 'n/a') +
        ', Humidity ' + (rec.humidityPercent !== null ? rec.humidityPercent + ' %' : 'n/a') +
        (rec.soilMoistureRaw !== null ? ', Soil raw ' + rec.soilMoistureRaw : '') };
    });
  }

  function startPolling() {
    stopPolling();
    if (isDemo()) {
      var ms = Math.max(2, Number(AgrStore.settings.refreshIntervalSec) || 5) * 1000;
      fetchOnce().catch(function () {});
      pollTimer = setInterval(function () { fetchOnce().catch(function () {}); }, ms);
    } else {
      wantLive = true;
      connectWs();
    }
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    wantLive = false;
    closeWs();
  }

  // Safety: if the tab is hidden / closed, stop driving immediately
  function haltDrive() { cmd.x = 0; cmd.y = 0; }
  document.addEventListener('visibilitychange', function () { if (document.hidden) haltDrive(); });
  window.addEventListener('pagehide', haltDrive);
  window.addEventListener('blur', haltDrive);

  window.AgrApi = {
    on: on, fetchOnce: fetchOnce, startPolling: startPolling, stopPolling: stopPolling,
    testConnection: testConnection, sendWater: sendWater, sendMove: sendMove,
    sendEmergency: sendEmergency, sendSeed: sendSeed, sendPlough: sendPlough,
    setSpeed: setSpeed, getSpeed: getSpeed,
    isPumping: function () { return pumping; },
    isConnected: function () { return wsOpen; },
    rawToPercent: rawToPercent
  };
})();
