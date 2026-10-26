/* ============================================================
   AgriRobo — API client (dual-transport + state machine)
   Live mode : PRIMARY   WebSocket  ws://<esp32>:81
                     (sends "x,y,speed,stop,dispense" 20x/s,
                      receives "S,<tempC>,<hum%>,<soilRaw>" ~2s)
               FALLBACK  HTTP JSON  http://<esp32>/api/*
                      (auto-selected if the WebSocket cannot connect;
                       movement commands are re-sent every 300 ms while
                       held so the firmware's 800 ms failsafe stays fed)
   Demo mode : clearly-labelled simulated data (no robot)

   Connection state machine (emitted on the "state" event):
     idle -> connecting -> connected
                     \-> reconnecting -> connected | error
     error is unrecoverable (HTTPS page / no address / bad firmware)
   Public API is unchanged, so app.js / charts.js keep working.
   ============================================================ */
(function () {
  'use strict';

  var WS_PORT = 81;                 // must match WebSocketsServer ws(81)
  var SEND_MS = 50;                 // firmware failsafe: 800 ms without packets -> stop
  var CONNECT_TIMEOUT_MS = 5000;
  var HTTP_TIMEOUT_MS = 3500;
  var HTTP_MOVE_REPEAT_MS = 300;    // keep firmware failsafe fed while holding a command
  var HTTP_FAIL_LIMIT = 2;          // consecutive HTTP failures before falling back to WS
  var BACKOFF_MS = [2000, 2000, 4000, 4000, 8000, 8000];  // then 15000 cap
  var BACKOFF_CAP_MS = 15000;

  var STATES = { IDLE: 'idle', CONNECTING: 'connecting', CONNECTED: 'connected',
                 RECONNECTING: 'reconnecting', ERROR: 'error' };

  var listeners = {};
  var ws = null, wsOpen = false, wantLive = false;
  var transport = null;             // null | 'ws' | 'http'
  var reconnectTimer = null, connectTimer = null, streamTimer = null;
  var httpPollTimer = null, httpFails = 0;
  var moveRepeatTimer = null, lastMoveDir = 'stop';
  var cmd = { x: 0, y: 0, stop: 0, disp: 0 };
  var latest = null, lastStoredAt = 0, rawWaiters = [];

  var state = STATES.IDLE;
  var backoffIdx = 0;
  var diag = [];                    // ring buffer of {t, level, msg}
  var DIAG_MAX = 60;

  // injectable deps (tests / _configure); fall back to globals at call time
  var WebSocketImpl = null, fetchImpl = null;
  function getWS() { return WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null); }
  function getFetch() { return fetchImpl || (typeof fetch !== 'undefined' ? fetch : null); }

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

  function log(level, msg) {
    var entry = { t: Date.now(), level: level, msg: msg };
    diag.push(entry);
    if (diag.length > DIAG_MAX) diag.shift();
    var tag = '[AgrApi ' + level + ']';
    if (level === 'error') console.error(tag, msg);
    else if (level === 'warn') console.warn(tag, msg);
    else console.log(tag, msg);
  }

  function setState(next, detail) {
    if (state === next && !detail) return;
    var prev = state;
    state = next;
    log('state', prev + ' -> ' + next + (detail ? ' (' + detail + ')' : ''));
    emit('state', { state: next, prev: prev, detail: detail || null, transport: transport });
  }

  function nextBackoff() {
    var ms = backoffIdx < BACKOFF_MS.length ? BACKOFF_MS[backoffIdx] : BACKOFF_CAP_MS;
    if (backoffIdx < BACKOFF_MS.length) backoffIdx++;
    return ms;
  }

  function toNumberOrNull(v) {
    if (v === null || v === undefined || v === '' || v === 'null' || v === 'NaN' || v === 'err') return null;
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /* raw soil ADC -> 0-100 % (higher raw = drier on most capacitive sensors) */
  function rawToPercent(raw, calDry, calWet) {
    if (raw === null || calDry === calWet) return null;
    var pct = ((calDry - raw) * 100) / (calDry - calWet);
    return Math.max(0, Math.min(100, Math.round(pct)));
  }

  function soilPercentFrom(raw) {
    var s = AgrStore.settings;
    if (raw === null) return null;
    return s.autoPercent
      ? Math.max(0, Math.min(100, Math.round(raw)))
      : rawToPercent(raw, Number(s.calDry), Number(s.calWet));
  }

  /* ESP32 address: page served by the robot (private IP) wins, else Settings */
  function espHost() {
    var h = location.hostname;
    if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return h;
    return String(AgrStore.settings.baseUrl || '').trim()
      .replace(/^[a-z]+:\/\//i, '').replace(/[\/?#].*$/, '').replace(/:\d+$/, '');
  }

  /* RC2 fix: derive the HTTP base from the SAME host as the WebSocket so the
     two transports can never point at different machines. The ESP32 HTTP API
     always lives on port 80, so we always use http://<host>. */
  function espBase() {
    var h = espHost();
    return h ? 'http://' + h : '';
  }

  function speedMode() {
    var m = Number(AgrStore.settings.speedMode);
    return (m === 0 || m === 1 || m === 2) ? m : 1;   // default SLOW (safest)
  }

  /* ---------- human-readable failure guidance ---------- */
  function unreachableMsg(host) {
    return 'Cannot reach the robot at ' + (host || espHost() || '(no address)') +
      '. Check: 1) phone Wi-Fi = "AgriRobo" (password agrirobo123)  ' +
      '2) robot powered on  ' +
      '3) turn OFF mobile data / disable "switch to mobile data" — phones auto-leave Wi-Fi networks that have no internet  ' +
      '4) correct address in Settings (e.g. http://192.168.4.1).';
  }

  /* ---------- sensor message -> reading ---------- */
  // WebSocket: "S,28.5,61" | "S,28.5,61,2310" | "S,err" | "S,err,err,2310"
  function parseSensorMsg(text) {
    var p = String(text).split(',');
    if (p[0] !== 'S') return null;
    var temp = toNumberOrNull(p[1]);
    if (temp !== null && (temp < -40 || temp > 80)) temp = null;
    var hum = toNumberOrNull(p[2]);
    if (hum !== null && (hum < 0 || hum > 100)) hum = null;
    var soilRaw = toNumberOrNull(p[3]);
    return {
      soilMoisturePercent: soilPercentFrom(soilRaw),
      soilMoistureRaw: soilRaw,
      temperatureC: temp,
      humidityPercent: hum,
      timestamp: Date.now(),
      deviceStatus: 'connected',
      battery: null,
      pumpStatus: null,
      features: { pump: false, movement: true, seed: true, plough: false },
      transport: 'ws',
      mode: 'live'
    };
  }

  /* HTTP: /api/sensors JSON -> reading */
  function normalizeHttpPayload(data) {
    if (!data || typeof data !== 'object') throw new Error('Empty or invalid JSON from device');
    var soilRaw = toNumberOrNull(data.soil_moisture_raw);
    var soilPct = toNumberOrNull(data.soil_moisture_percent);
    if (soilPct === null) soilPct = soilPercentFrom(soilRaw);

    var temp = toNumberOrNull(data.temperature_c);
    if (temp !== null && (temp < -40 || temp > 80)) temp = null;
    var hum = toNumberOrNull(data.humidity_percent);
    if (hum !== null && (hum < 0 || hum > 100)) hum = null;

    var ts = data.timestamp ? Date.parse(data.timestamp) : NaN;
    if (!Number.isFinite(ts)) ts = Date.now();

    return {
      soilMoisturePercent: soilPct,
      soilMoistureRaw: soilRaw,
      temperatureC: temp,
      humidityPercent: hum,
      timestamp: ts,
      deviceStatus: String(data.device_status || 'connected').toLowerCase(),
      battery: toNumberOrNull(data.battery_percent !== undefined ? data.battery_percent : data.battery_voltage),
      pumpStatus: (data.pump && data.pump.status) ? String(data.pump.status).toLowerCase()
                                                   : (data.pump_status ? String(data.pump_status).toLowerCase() : null),
      features: data.features || { pump: false, movement: true, seed: true, plough: false },
      transport: 'http',
      mode: 'live'
    };
  }

  function shouldStore() {
    var every = Math.max(2, Number(AgrStore.settings.refreshIntervalSec) || 5) * 1000;
    if (Date.now() - lastStoredAt < every - 200) return false;
    return true;
  }

  function storeAndEmit(rec) {
    lastStoredAt = Date.now();
    latest = rec;
    backoffIdx = 0;                 // success -> reset the reconnect backoff
    AgrStore.addReading(rec);
    setState(STATES.CONNECTED, rec.transport);
    emit('connected', rec);
    emit('reading', rec);
  }

  function onWsMessage(e) {
    var rec = parseSensorMsg(e.data);
    if (!rec) { log('warn', 'Ignoring malformed sensor frame: ' + JSON.stringify(String(e.data).slice(0, 40))); return; }
    latest = rec;
    if (shouldStore()) storeAndEmit(rec);
    var w = rawWaiters; rawWaiters = [];
    w.forEach(function (fn) { fn(rec); });
  }

  /* ================= WEBSOCKET TRANSPORT ================= */
  function streamTick() {
    if (!ws || ws.readyState !== 1) return;
    var line = cmd.x + ',' + cmd.y + ',' + speedMode() + ',' + (cmd.stop > 0 ? 1 : 0) + ',' + cmd.disp;
    try { ws.send(line); } catch (e) { return; }
    if (cmd.stop > 0) cmd.stop--;
    cmd.disp = 0;
  }
  function startStream() { stopStream(); streamTimer = setInterval(streamTick, SEND_MS); }
  function stopStream() { if (streamTimer) { clearInterval(streamTimer); streamTimer = null; } }

  function scheduleReconnect(reason) {
    clearTimeout(reconnectTimer);
    if (!wantLive || transport === 'http') return;
    if (state === STATES.ERROR) return;      // unrecoverable -> do not retry
    var ms = nextBackoff();
    setState(STATES.RECONNECTING, reason + ' — retry in ' + ms + 'ms');
    log('info', 'Reconnecting in ' + ms + 'ms (attempt ' + backoffIdx + ')');
    reconnectTimer = setTimeout(connectLive, ms);
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
    if (ws) closeWs();
    var host = espHost();
    if (!host) {
      setState(STATES.ERROR, 'no-address');
      emit('disconnected', { error: 'No ESP32 address set — enter it in Settings (e.g. http://192.168.4.1).' });
      return;
    }
    if (location.protocol === 'https:') {
      setState(STATES.ERROR, 'https-page');
      emit('disconnected', { error: 'This page is on HTTPS, but the robot only speaks plain ws:// and http://. ' +
        'Open the app from http://' + host + ' (served by the ESP32 itself) instead, or switch to Demo mode in Settings.' });
      return;
    }
    if (state !== STATES.RECONNECTING) setState(STATES.CONNECTING, 'ws://' + host + ':' + WS_PORT);
    var WS = getWS();
    if (!WS) { emit('disconnected', { error: 'WebSocket API unavailable in this browser.' }); return; }
    try { ws = new WS('ws://' + host + ':' + WS_PORT + '/'); }
    catch (e) {
      log('warn', 'WebSocket constructor threw: ' + (e.message || e));
      emit('disconnected', { error: e.message || 'WebSocket blocked' });
      httpFallbackOrRetry(host, false);
      return;
    }

    var mine = ws;
    connectTimer = setTimeout(function () { if (mine === ws && !wsOpen) { try { mine.close(); } catch (e) {} } }, CONNECT_TIMEOUT_MS);

    ws.onopen = function () {
      clearTimeout(connectTimer);
      if (mine !== ws) return;
      wsOpen = true;
      transport = 'ws';
      backoffIdx = 0;
      stopHttpPolling();
      cmd.x = 0; cmd.y = 0;          // always start centred so the robot arms safely
      startStream();
      log('info', 'WebSocket open on ' + host + ':' + WS_PORT);
    };
    ws.onmessage = onWsMessage;
    ws.onerror = function () { try { mine.close(); } catch (e) {} };
    ws.onclose = function () {
      if (mine !== ws) return;
      var was = wsOpen;
      wsOpen = false; ws = null; stopStream();
      cmd.x = 0; cmd.y = 0;
      if (transport === 'ws') transport = null;
      if (!wantLive) return;
      if (was) {
        emit('disconnected', { error: 'Connection to the robot was lost' });
        scheduleReconnect('ws-lost');
      } else if (transport !== 'http') {
        // WS never opened -> try the HTTP API before giving up
        log('info', 'WebSocket did not open — trying HTTP fallback');
        emit('disconnected', { error: 'WebSocket on port 81 not responding — trying HTTP fallback…' });
        httpFallbackOrRetry(host, true);
      }
    };
  }

  /* ================= HTTP TRANSPORT (fallback) ================= */
  function fetchJson(url, method, body, ms) {
    var f = getFetch();
    if (!f) return Promise.reject(new Error('fetch API unavailable'));
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, ms || HTTP_TIMEOUT_MS);
    var opts = { method: method || 'GET', headers: { 'Accept': 'application/json' }, signal: ctrl.signal, cache: 'no-store' };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return f(url, opts).then(function (res) {
      clearTimeout(to);
      if (res.status === 404) { var e404 = new Error('API not present (HTTP 404)'); e404.http404 = true; throw e404; }
      if (!res.ok) throw new Error('Device responded HTTP ' + res.status);
      var ct = res.headers.get('content-type') || '';
      return ct.indexOf('json') >= 0 ? res.json() : {};
    }, function (err) { clearTimeout(to); throw err; });
  }

  function httpFetchOnce() {
    var base = espBase();
    if (!base) return Promise.reject(new Error('No ESP32 address configured'));
    return fetchJson(base + '/api/sensors').then(function (json) {
      var rec = normalizeHttpPayload(json);
      transport = 'http';
      httpFails = 0;
      storeAndEmit(rec);
      return rec;
    });
  }

  function startHttpPolling() {
    stopHttpPolling();
    var ms = Math.max(2, Number(AgrStore.settings.refreshIntervalSec) || 5) * 1000;
    httpFetchOnce().catch(handleHttpFail);
    httpPollTimer = setInterval(function () { httpFetchOnce().catch(handleHttpFail); }, ms);
  }
  function stopHttpPolling() {
    if (httpPollTimer) { clearInterval(httpPollTimer); httpPollTimer = null; }
    httpFails = 0;
  }
  function handleHttpFail(err) {
    httpFails++;
    log('warn', 'HTTP poll failed (' + httpFails + '): ' + (err && err.message || 'network'));
    emit('disconnected', { error: 'HTTP link error: ' + (err && err.message || 'network') });
    if (httpFails >= HTTP_FAIL_LIMIT) {
      stopHttpPolling();
      transport = null;
      emit('disconnected', { error: unreachableMsg(espHost()) });
      scheduleReconnect('http-failed');   // back to trying WebSocket
    }
  }

  /* probe /api/sensors: reachable? API present? */
  function httpProbe() {
    var base = espBase();
    if (!base) return Promise.reject(new Error('No ESP32 address configured'));
    return fetchJson(base + '/api/sensors').then(
      function () { return { reachable: true, sensorsOk: true }; },
      function (err) {
        if (err && err.http404) return { reachable: true, sensorsOk: false };
        throw err;
      }
    );
  }

  /* called when WS failed to open: switch to HTTP if it answers, else report */
  function httpFallbackOrRetry(host, retryWsAfter) {
    if (!wantLive || transport === 'http') return;
    httpProbe().then(function (info) {
      if (info.sensorsOk) {
        transport = 'http';
        startHttpPolling();                     // readings arrive -> 'connected' + 'reading' fire
      } else {
        setState(STATES.ERROR, 'firmware-no-api');
        emit('disconnected', { error: 'The robot answered on port 80 but has no /api/sensors — firmware is outdated. ' +
          'Flash firmware/AgriRobo_MDDS10_dht11.ino (v1.1.0 or newer) and upload the app files to LittleFS.' });
        if (retryWsAfter) scheduleReconnect('firmware-no-api');
      }
    }).catch(function () {
      emit('disconnected', { error: unreachableMsg(host) });
      scheduleReconnect('http-probe-failed');
    });
  }

  function waitForData(ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return; done = true;
        reject(new Error(wsOpen || transport === 'http' ? 'Connected, but no sensor data yet' : 'Connection timed out'));
      }, ms);
      rawWaiters.push(function (rec) { if (done) return; done = true; clearTimeout(t); resolve(rec); });
    });
  }

  /* ================= LIVE COMMANDS ================= */
  var DIRS = { forward: [0, 100], backward: [0, -100], left: [-100, 0], right: [100, 0], stop: [0, 0] };

  function liveMove(direction) {
    var v = DIRS[direction];
    if (!v) return Promise.reject(new Error('Unknown direction: ' + direction));
    if (!wsOpen) return Promise.reject(new Error('Robot not connected'));
    cmd.x = v[0]; cmd.y = v[1];
    if (direction === 'stop') cmd.stop = 2;
    return Promise.resolve({ ok: true, via: 'ws' });
  }

  function postMove(direction) {
    var base = espBase();
    return fetchJson(base + '/api/control/move', 'POST',
      { direction: direction, speed: speedMode() }).catch(function (err) {
        throw new Error('Move command failed: ' + (err && err.message || 'network'));
      });
  }

  function startMoveRepeat() {
    if (moveRepeatTimer) return;
    moveRepeatTimer = setInterval(function () {
      if (lastMoveDir === 'stop' || transport !== 'http') { stopMoveRepeat(); return; }
      postMove(lastMoveDir).catch(function () {});   // next poll surfaces failures
    }, HTTP_MOVE_REPEAT_MS);
  }
  function stopMoveRepeat() {
    if (moveRepeatTimer) { clearInterval(moveRepeatTimer); moveRepeatTimer = null; }
  }

  function httpMove(direction) {
    if (!DIRS[direction]) return Promise.reject(new Error('Unknown direction: ' + direction));
    lastMoveDir = direction;
    return postMove(direction).then(function (res) {
      if (direction === 'stop') stopMoveRepeat(); else startMoveRepeat();
      return { ok: true, via: 'http', response: res };
    });
  }

  function liveEmergency() {
    cmd.x = 0; cmd.y = 0; cmd.stop = 5;       // firmware stops + disarms on the stop flag
    lastMoveDir = 'stop'; stopMoveRepeat();
    if (!wsOpen) return Promise.reject(new Error('Robot not connected — motors stop by themselves (failsafe)'));
    return Promise.resolve({ ok: true, via: 'ws' });
  }
  function httpEmergency() {
    lastMoveDir = 'stop'; stopMoveRepeat();
    var base = espBase();
    return fetchJson(base + '/api/control/emergency', 'POST', { action: 'stop_all' })
      .then(function (r) { return { ok: true, via: 'http', response: r }; });
  }

  function liveSeed() {
    if (!wsOpen) return Promise.reject(new Error('Robot not connected'));
    cmd.disp = 1;
    return Promise.resolve({ ok: true, via: 'ws', note: 'Seed gate opened — it closes automatically.' });
  }
  function httpSeed() {
    var base = espBase();
    return fetchJson(base + '/api/control/seed', 'POST', { action: 'dispense' })
      .then(function () { return { ok: true, via: 'http', note: 'Seed gate opened — it closes automatically.' }; });
  }

  function notConnected() { return Promise.reject(new Error('Robot not connected — check Wi-Fi and Settings.')); }

  /* ================= DEMO MODE (clearly simulated) ================= */
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
      transport: null,
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

  /* ================= PUBLIC API ================= */
  function connectLive() {
    wantLive = true;
    if (isDemo()) return;
    if (transport === 'http') { startHttpPolling(); return; }
    if (wsOpen || ws) return;
    connectWs();
  }

  function fetchOnce() {
    if (isDemo()) return new Promise(function (r) { setTimeout(function () { r(demoStep()); }, 250); });
    if (wsOpen) {
      if (latest) { storeAndEmit(latest); return Promise.resolve(latest); }
      return waitForData(4000);
    }
    if (transport === 'http') return httpFetchOnce();
    // nothing connected: start the normal cycle, then actively probe as well
    connectLive();
    return waitForData(4500).catch(function (err) {
      if (transport === 'http' && latest) return latest;
      return httpProbe().then(function (info) {
        if (!info.sensorsOk) throw new Error(unreachableMsg(espHost()));
        transport = 'http';
        startHttpPolling();
        return httpFetchOnce();
      }).catch(function () { throw err; });
    });
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
    var p;
    if (isDemo()) p = demoCommand('/api/control/move', { direction: direction });
    else if (wsOpen) p = liveMove(direction);
    else if (transport === 'http') p = httpMove(direction);
    else p = notConnected();
    return p.then(function (res) { emit('move', { direction: direction, response: res }); return res; });
  }

  function sendEmergency() {
    var p;
    if (isDemo()) p = demoCommand('/api/control/emergency', {});
    else if (wsOpen) p = liveEmergency();
    else if (transport === 'http') p = httpEmergency();
    else p = notConnected();
    return p.then(function (res) { pumping = false; clearPumpTimer(); emit('emergency', res); return res; });
  }

  function sendSeed() {
    var p;
    if (isDemo()) p = demoCommand('/api/control/seed', {});
    else if (wsOpen) p = liveSeed();
    else if (transport === 'http') p = httpSeed();
    else p = notConnected();
    return p.then(function (res) { emit('seed', res); return res; });
  }

  function sendPlough() {
    if (!isDemo()) return Promise.reject(new Error('Ploughing is not implemented in the firmware'));
    return demoCommand('/api/control/plough', {}).then(function (res) { emit('plough', res); return res; });
  }

  function setSpeed(m) { AgrStore.saveSettings({ speedMode: Number(m) }); }   // 0 normal, 1 slow, 2 fast
  function getSpeed() { return speedMode(); }

  /* ---- verdict helpers for the connection doctor ---- */
  function wsVerdict(rec) {
    return { ok: true, transport: 'ws', message: 'Connected via WebSocket ✓  Temp ' + rec.temperatureC + ' °C, Humidity ' +
      rec.humidityPercent + ' %, Soil raw ' + rec.soilMoistureRaw };
  }
  function httpVerdict(rec) {
    return { ok: true, transport: 'http', message: 'Connected over HTTP fallback ✓ (WebSocket :81 silent — re-flash the latest firmware for full-speed control). ' +
      'Temp ' + rec.temperatureC + ' °C, Soil raw ' + rec.soilMoistureRaw };
  }

  /* RC1 fix: the doctor now tries the PRIMARY WebSocket transport FIRST.
     Only if WS stays silent does it probe HTTP — so a WS-only firmware build
     (v1.0, port 81 with no /api/* on port 80) reports a healthy WebSocket
     instead of a false "flash firmware" error. */
  function testConnection() {
    if (isDemo()) return new Promise(function (r) {
      setTimeout(function () { r({ ok: true, demo: true, message: 'Demo mode — no hardware required.' }); }, 300);
    });
    if (location.protocol === 'https:') {
      return Promise.reject(new Error('This page is HTTPS — the browser blocks plain ws:// and http:// robot links. ' +
        'Open http://' + (espHost() || '192.168.4.1') + ' (robot-served app), or use Demo mode.'));
    }
    if (!espHost()) {
      return Promise.reject(new Error('No ESP32 address set — enter it in Settings (e.g. http://192.168.4.1).'));
    }
    wantLive = true;
    backoffIdx = 0;
    setState(STATES.CONNECTING, 'doctor');

    // Fast path: already have a live link -> report it immediately.
    if (wsOpen && latest) return Promise.resolve(wsVerdict(latest));
    if (transport === 'http' && latest) return Promise.resolve(httpVerdict(latest));

    // 1) Try the PRIMARY WebSocket transport.
    if (!wsOpen && transport !== 'http') connectWs();

    return waitForData(6000).then(function (rec) {
      if (rec && rec.transport === 'ws') return wsVerdict(rec);
      if (rec && rec.transport === 'http') return httpVerdict(rec);
      return { ok: true, message: 'Connected.' };
    }).catch(function () {
      // 2) WS stayed silent — did the HTTP fallback already take over?
      if (transport === 'http' && latest) return httpVerdict(latest);
      // 3) Nothing flowed: probe HTTP purely to produce a precise diagnosis.
      return httpProbe().then(function (info) {
        if (info.sensorsOk) {
          transport = 'http';
          startHttpPolling();
          return httpFetchOnce().then(httpVerdict);
        }
        // reachable on :80 but no API -> legacy WS-only build (WS already failed above)
        throw new Error('The robot answered on port 80 but has no /api/sensors — flash firmware/AgriRobo_MDDS10_dht11.ino v1.1.0+.');
      }).catch(function (err) {
        if (/flash|firmware|HTTPS/i.test(err.message || '')) throw err;
        throw new Error(unreachableMsg(espHost()));
      });
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
      backoffIdx = 0;
      connectLive();
    }
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    stopHttpPolling();
    stopMoveRepeat();
    wantLive = false;
    transport = null;
    state = STATES.IDLE;
    backoffIdx = 0;
    closeWs();
  }

  // Safety: hidden / closed tab -> stop driving immediately
  function haltDrive() {
    cmd.x = 0; cmd.y = 0; lastMoveDir = 'stop';
    stopMoveRepeat();
    if (transport === 'http') postMove('stop').catch(function () {});
  }
  document.addEventListener('visibilitychange', function () { if (document.hidden) haltDrive(); });
  window.addEventListener('pagehide', haltDrive);
  window.addEventListener('blur', haltDrive);

  /* test hook: inject transport deps / timings without touching globals */
  function _configure(opts) {
    if (!opts) return;
    if ('WebSocket' in opts) WebSocketImpl = opts.WebSocket;
    if ('fetch' in opts) fetchImpl = opts.fetch;
    if (opts.connectTimeoutMs) CONNECT_TIMEOUT_MS = opts.connectTimeoutMs;
    if (opts.httpTimeoutMs) HTTP_TIMEOUT_MS = opts.httpTimeoutMs;
  }

  function getDiag() {
    return {
      state: state, transport: transport, host: espHost(),
      wsOpen: wsOpen, wantLive: wantLive, backoffIdx: backoffIdx,
      demo: isDemo(), log: diag.slice()
    };
  }

  window.AgrApi = {
    on: on, fetchOnce: fetchOnce, startPolling: startPolling, stopPolling: stopPolling,
    testConnection: testConnection, sendWater: sendWater, sendMove: sendMove,
    sendEmergency: sendEmergency, sendSeed: sendSeed, sendPlough: sendPlough,
    setSpeed: setSpeed, getSpeed: getSpeed,
    isPumping: function () { return pumping; },
    isConnected: function () { return wsOpen || transport === 'http'; },
    getTransport: function () { return transport; },
    getState: function () { return state; },
    getDiag: getDiag,
    _configure: _configure,
    rawToPercent: rawToPercent
  };
})();
