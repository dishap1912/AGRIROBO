/* Headless tests: AgriRobo app <-> mock ESP32 (WebSocket + HTTP fallback)
   Run:  node test/ws-client.test.js */
global.window = global;
global.localStorage = { _d: {}, getItem(k){return this._d[k]||null;}, setItem(k,v){this._d[k]=v;}, removeItem(k){delete this._d[k];} };
global.location = { hostname: 'localhost', protocol: 'http:' };
global.document = { addEventListener(){}, hidden: false };
global.addEventListener = function(){};

var fail = function (msg) { console.error('FAIL: ' + msg); process.exit(1); };

/* ---------- mocks ---------- */
var wsInstances = [];
function GoodWS(url) {
  this.url = url; this.readyState = 0; this._closed = false;
  var self = this;
  wsInstances.push(self);
  setTimeout(function () {
    if (self._closed) return;   // real sockets stay CLOSED; don't resurrect
    self.readyState = 1; self.onopen && self.onopen();
  }, 5);
}
GoodWS.prototype.send = function () {};
GoodWS.prototype.close = function () { this._closed = true; this.readyState = 3; this.onclose && this.onclose(); };

function FailingWS(url) {
  this.url = url; this.readyState = 0; this._closed = false;
  var self = this;
  wsInstances.push(self);
  setTimeout(function () {
    if (self._closed) return;
    self.onclose && self.onclose();
  }, 5);   // never opens
}
FailingWS.prototype.send = function () {};
FailingWS.prototype.close = function () { this._closed = true; this.readyState = 3; this.onclose && this.onclose(); };

var httpCalls = [];
var HTTP_JSON = {
  soil_moisture_raw: 2310, soil_moisture_percent: null,
  temperature_c: 27.1, humidity_percent: 55,
  device_status: 'connected',
  features: { pump: false, movement: true, seed: true, plough: false }
};
global.fetch = function (url, opts) {
  httpCalls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
  var ok = function (json) {
    return Promise.resolve({
      ok: true, status: 200,
      headers: { get: function (k) { return k.toLowerCase() === 'content-type' ? 'application/json' : null; } },
      json: function () { return Promise.resolve(json); }
    });
  };
  if (String(url).indexOf('/api/sensors') >= 0) return ok(HTTP_JSON);
  if (String(url).indexOf('/api/control/move') >= 0) return ok({ ok: true });
  if (String(url).indexOf('/api/control/emergency') >= 0) return ok({ ok: true, status: 'all_stopped' });
  if (String(url).indexOf('/api/control/seed') >= 0) return ok({ ok: true });
  return Promise.resolve({ ok: false, status: 404, headers: { get: function () { return null; } },
    json: function () { return Promise.resolve({}); } });
};

function freshLoad() {
  delete require.cache[require.resolve('../js/store.js')];
  delete require.cache[require.resolve('../js/api.js')];
  require('../js/store.js');
  require('../js/api.js');
  return { S: window.AgrStore, A: window.AgrApi };
}

/* save original fetch for restore after phase 5 override */
var originalFetch = global.fetch;

/* ================================================================
   PHASE 1 — WebSocket transport (primary)
   ================================================================ */
function phaseWs(done) {
  wsInstances = [];
  global.WebSocket = GoodWS;
  var m = freshLoad();
  var S = m.S, A = m.A;
  S.saveSettings({ mode: 'live', baseUrl: 'http://192.168.4.1', refreshIntervalSec: 2 });
  var readings = [];
  A.on('reading', function (r) { readings.push(r); });
  A.startPolling();

  setTimeout(function () {
    if (wsInstances.length !== 1) fail('WS: no connection attempted');
    if (wsInstances[0].url !== 'ws://192.168.4.1:81/') fail('WS: wrong url ' + wsInstances[0].url);
    wsInstances[0].onmessage({ data: 'S,28.5,61,2310' });

    setTimeout(function () {
      if (!readings.length) fail('WS: no reading stored');
      var r = readings[0];
      if (r.temperatureC !== 28.5 || r.humidityPercent !== 61) fail('WS: DHT values wrong');
      if (r.soilMoisturePercent !== 45) fail('WS: soil % wrong: ' + r.soilMoisturePercent);
      if (r.transport !== 'ws') fail('WS: transport label wrong: ' + r.transport);
      if (A.getTransport() !== 'ws') fail('WS: getTransport() = ' + A.getTransport());
      console.log('PHASE 1 (WebSocket) OK — T=' + r.temperatureC + ' H=' + r.humidityPercent +
        ' soil=' + r.soilMoisturePercent + '% transport=' + r.transport);

      A.sendMove('forward').then(function () {
        return A.sendMove('stop');
      }).then(function () {
        A.stopPolling();
        done();
      }).catch(function (e) { fail('WS: move rejected — ' + e.message); });
    }, 300);
  }, 200);
}

/* ================================================================
   PHASE 2 — HTTP fallback (WebSocket never opens)
   ================================================================ */
function phaseHttpFallback(done) {
  wsInstances = [];
  httpCalls = [];
  global.WebSocket = FailingWS;
  var m = freshLoad();
  var S = m.S, A = m.A;
  S.saveSettings({ mode: 'live', baseUrl: 'http://192.168.4.1', refreshIntervalSec: 2 });
  var readings = [];
  var disc = [];
  A.on('reading', function (r) { readings.push(r); });
  A.on('disconnected', function (d) { disc.push(d.error); });
  A.startPolling();

  /* flow: WS fails fast -> probe /api/sensors -> transport 'http' -> poll stores reading */
  setTimeout(function () {
    if (A.getTransport() !== 'http') fail('HTTP: fallback not engaged, transport=' + A.getTransport() + ' errs=' + JSON.stringify(disc));
    if (!httpCalls.some(function (c) { return c.url.indexOf('/api/sensors') >= 0; })) fail('HTTP: probe never hit /api/sensors');
    if (!readings.length) fail('HTTP: no reading from fallback');
    var r = readings[0];
    if (r.transport !== 'http') fail('HTTP: transport label wrong: ' + r.transport);
    if (r.temperatureC !== 27.1 || r.soilMoisturePercent !== 45) fail('HTTP: values wrong: ' + JSON.stringify(r));
    console.log('PHASE 2 (HTTP fallback) OK — T=' + r.temperatureC + ' soil=' + r.soilMoisturePercent +
      '% transport=' + r.transport);

    /* movement over HTTP must re-send while holding (feeds 800 ms failsafe) */
    httpCalls = [];
    A.sendMove('forward').then(function () {
      setTimeout(function () {
        var moves = httpCalls.filter(function (c) { return c.url.indexOf('/api/control/move') >= 0; });
        if (moves.length < 2) fail('HTTP: move not re-sent while holding (' + moves.length + ' posts)');
        A.sendMove('stop').then(function () {
          var after = httpCalls.filter(function (c) { return c.url.indexOf('/api/control/move') >= 0; }).length;
          setTimeout(function () {
            var later = httpCalls.filter(function (c) { return c.url.indexOf('/api/control/move') >= 0; }).length;
            if (later > after + 1) fail('HTTP: move repeat continued after stop');
            console.log('PHASE 2b (HTTP movement repeat) OK — held ' + moves.length + ' posts, stopped cleanly');
            done(A, S);
          }, 700);
        }).catch(function (e) { fail('HTTP: stop rejected — ' + e.message); });
      }, 750);
    }).catch(function (e) { fail('HTTP: move rejected — ' + e.message); });
  }, 2500);
}

/* ================================================================
   PHASE 3 — connection doctor (HTTP ok, WS dead) + exports
   ================================================================ */
function phaseDoctor(A, S, done) {
  A.testConnection().then(function (res) {
    if (!res.ok) fail('doctor: not ok');
    if (res.message.indexOf('HTTP fallback') < 0) fail('doctor: wrong verdict — ' + res.message);
    console.log('PHASE 3 (doctor) OK — ' + res.message);

    var used = ['fetchOnce','getSpeed','isPumping','on','sendEmergency','sendMove','sendPlough','sendSeed',
                'sendWater','setSpeed','startPolling','stopPolling','testConnection','getTransport'];
    var missing = used.filter(function (n) { return typeof A[n] !== 'function'; });
    if (missing.length) fail('AgrApi missing: ' + missing.join(', '));
    console.log('exports OK — ' + used.length + ' functions');

    A.stopPolling();
    console.log('ALL TESTS PASSED (WS + HTTP fallback + doctor)');
    done();
  }).catch(function (e) { fail('doctor rejected — ' + e.message); });
}

/* ================================================================
   PHASE 4 — state machine transitions
   ================================================================ */
function phaseStateMachine(done) {
  wsInstances = [];
  global.WebSocket = GoodWS;
  var m = freshLoad();
  var S = m.S, A = m.A;
  S.saveSettings({ mode: 'live', baseUrl: 'http://192.168.4.1', refreshIntervalSec: 2 });

  var states = [];
  A.on('state', function (info) { states.push(info.state); });

  if (A.getState() !== 'idle') fail('state: expected idle before start, got ' + A.getState());

  A.startPolling();
  // After startPolling, we should be in 'connecting' (or already 'connected' if WS opened fast)
  var afterStart = A.getState();
  if (afterStart !== 'connecting' && afterStart !== 'connected') {
    fail('state: expected connecting/connected after start, got ' + afterStart);
  }

  // Feed a sensor frame so storeAndEmit fires -> connected
  wsInstances[0].onmessage({ data: 'S,25.0,50,2000' });

  setTimeout(function () {
    if (A.getState() !== 'connected') fail('state: expected connected after reading, got ' + A.getState());
    if (states.indexOf('connecting') < 0 && states.indexOf('connected') < 0) {
      fail('state: no connecting/connected transition recorded: ' + JSON.stringify(states));
    }
    if (states.indexOf('connected') < 0) fail('state: connected never emitted: ' + JSON.stringify(states));
    console.log('PHASE 4 (state machine) OK — states: ' + states.join(' -> '));
    A.stopPolling();
    if (A.getState() !== 'idle') fail('state: expected idle after stop, got ' + A.getState());
    console.log('  stopPolling -> idle OK');
    done();
  }, 200);
}

/* ================================================================
   PHASE 5 — WS-only firmware doctor (WS works, HTTP has no API)
   Regression: doctor must NOT report "flash firmware" when WS is healthy.
   ================================================================ */
function phaseWsOnlyDoctor(done) {
  wsInstances = [];
  httpCalls = [];
  global.WebSocket = GoodWS;

  // Override fetch: every /api/* returns 404 (legacy firmware, no HTTP API)
  global.fetch = function (url, opts) {
    httpCalls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    return Promise.resolve({
      ok: false, status: 404,
      headers: { get: function () { return null; } },
      json: function () { return Promise.resolve({}); }
    });
  };

  var m = freshLoad();
  var S = m.S, A = m.A;
  S.saveSettings({ mode: 'live', baseUrl: 'http://192.168.4.1', refreshIntervalSec: 2 });

  // Open WS and feed data BEFORE calling doctor, so the fast-path reports WS.
  A.startPolling();
  setTimeout(function () {
    if (!wsInstances.length) fail('ws-only doctor: WS never attempted');
    wsInstances[0].onmessage({ data: 'S,30.1,70,1500' });

    setTimeout(function () {
      A.testConnection().then(function (res) {
        if (!res.ok) fail('ws-only doctor: not ok');
        if (res.message.indexOf('WebSocket') < 0) fail('ws-only doctor: wrong verdict (expected WebSocket) — ' + res.message);
        if (res.message.indexOf('flash') >= 0) fail('ws-only doctor: false "flash firmware" error — ' + res.message);
        console.log('PHASE 5 (WS-only firmware doctor) OK — ' + res.message);
        A.stopPolling();
        // restore normal fetch for later phases
        global.fetch = originalFetch;
        done();
      }).catch(function (e) { fail('ws-only doctor rejected — ' + e.message); });
    }, 200);
  }, 200);
}

/* ================================================================
   PHASE 6 — espBase consistency (RC2 regression)
   When page is served from the robot's private IP, espHost() must win
   over a stale baseUrl in settings, so WS and HTTP hit the SAME host.
   ================================================================ */
function phaseEspBaseConsistency(done) {
  wsInstances = [];
  httpCalls = [];
  global.WebSocket = GoodWS;

  // Simulate page served by robot at 192.168.4.1
  global.location = { hostname: '192.168.4.1', protocol: 'http:' };

  var m = freshLoad();
  var S = m.S, A = m.A;
  // Stale / wrong baseUrl in settings — must be IGNORED because location.hostname is a private IP
  S.saveSettings({ mode: 'live', baseUrl: 'http://10.99.99.99', refreshIntervalSec: 2 });

  A.startPolling();
  setTimeout(function () {
    if (!wsInstances.length) fail('espBase: WS never attempted');
    var wsUrl = wsInstances[0].url;
    if (wsUrl.indexOf('192.168.4.1') < 0) fail('espBase: WS hit wrong host — ' + wsUrl);

    // Feed WS data, then check a probe goes to 192.168.4.1 (not 10.99.99.99)
    wsInstances[0].onmessage({ data: 'S,22.2,44,1800' });
    setTimeout(function () {
      A.testConnection().then(function (res) {
        if (!res.ok) fail('espBase doctor: not ok');
        // The doctor should not have hit 10.99.99.99 at all
        var badHost = httpCalls.some(function (c) { return c.url.indexOf('10.99.99.99') >= 0; });
        if (badHost) fail('espBase: HTTP probe used stale baseUrl host 10.99.99.99');
        console.log('PHASE 6 (espBase consistency) OK — WS and HTTP both used 192.168.4.1, stale baseUrl ignored');
        A.stopPolling();
        global.location = { hostname: 'localhost', protocol: 'http:' };
        done();
      }).catch(function (e) {
        global.location = { hostname: 'localhost', protocol: 'http:' };
        fail('espBase doctor rejected — ' + e.message);
      });
    }, 200);
  }, 200);
}

/* ================================================================
   PHASE 7 — malformed sensor packets must not crash or store garbage
   ================================================================ */
function phaseMalformedPackets(done) {
  wsInstances = [];
  global.WebSocket = GoodWS;
  var m = freshLoad();
  var S = m.S, A = m.A;
  S.saveSettings({ mode: 'live', baseUrl: 'http://192.168.4.1', refreshIntervalSec: 2 });

  var readings = [];
  A.on('reading', function (r) { readings.push(r); });
  A.startPolling();

  setTimeout(function () {
    // Malformed frames: bad temp, out-of-range hum, non-numeric soil
    wsInstances[0].onmessage({ data: 'S,abc,999,xyz' });
    wsInstances[0].onmessage({ data: 'S,999,999,99999' });
    wsInstances[0].onmessage({ data: 'GARBAGE' });
    wsInstances[0].onmessage({ data: '' });

    setTimeout(function () {
      // None of the malformed frames should produce a reading with valid temp/hum
      readings.forEach(function (r, i) {
        if (r.temperatureC === 999) fail('malformed: stored garbage temp=999');
        if (r.humidityPercent === 999) fail('malformed: stored garbage hum=999');
      });
      // Wait out the shouldStore() rate-limit window (refreshIntervalSec=2 -> ~1.8s)
      // then a valid frame should still be accepted.
      setTimeout(function () {
        wsInstances[0].onmessage({ data: 'S,26.0,55,2100' });
        setTimeout(function () {
          var last = readings[readings.length - 1];
          if (!last || last.temperatureC !== 26.0) fail('malformed: valid frame after garbage not stored');
          console.log('PHASE 7 (malformed packets) OK — garbage ignored, valid frame accepted (T=' + last.temperatureC + ')');
          A.stopPolling();
          done();
        }, 300);
      }, 2000);
    }, 300);
  }, 200);
}

/* ================================================================
   PHASE 8 — duplicate startPolling must not create parallel timers
   ================================================================ */
function phaseDuplicateStart(done) {
  wsInstances = [];
  global.WebSocket = GoodWS;
  var m = freshLoad();
  var S = m.S, A = m.A;
  S.saveSettings({ mode: 'live', baseUrl: 'http://192.168.4.1', refreshIntervalSec: 2 });

  A.startPolling();
  A.startPolling();   // duplicate — must not create a second WS
  A.startPolling();   // triple — still must be only one

  setTimeout(function () {
    // startPolling calls stopPolling first, which closes any existing WS,
    // so we should see at most 1 active (non-closed) instance.
    var open = wsInstances.filter(function (w) { return w.readyState === 1; });
    if (open.length > 1) fail('duplicate start: ' + open.length + ' concurrent open WebSockets');
    if (wsInstances.length < 1) fail('duplicate start: no WS created at all');
    console.log('PHASE 8 (duplicate startPolling) OK — ' + wsInstances.length + ' WS created, ' + open.length + ' open (no parallel timers)');
    A.stopPolling();
    done();
  }, 200);
}

phaseWs(function () {
  phaseHttpFallback(function (A, S) {
    phaseDoctor(A, S, function () {
      phaseStateMachine(function () {
        phaseWsOnlyDoctor(function () {
          phaseEspBaseConsistency(function () {
            phaseMalformedPackets(function () {
              phaseDuplicateStart(function () {
                console.log('ALL TESTS PASSED (WS + HTTP fallback + doctor + states + WS-only + espBase + malformed + dup-start)');
                process.exit(0);
              });
            });
          });
        });
      });
    });
  });
});
