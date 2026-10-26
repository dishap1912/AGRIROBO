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
  this.url = url; this.readyState = 0;
  var self = this;
  wsInstances.push(self);
  setTimeout(function () { self.readyState = 1; self.onopen && self.onopen(); }, 5);
}
GoodWS.prototype.send = function () {};
GoodWS.prototype.close = function () { this.readyState = 3; this.onclose && this.onclose(); };

function FailingWS(url) {
  this.url = url; this.readyState = 0;
  var self = this;
  wsInstances.push(self);
  setTimeout(function () { self.onclose && self.onclose(); }, 5);   // never opens
}
FailingWS.prototype.send = function () {};
FailingWS.prototype.close = function () { this.readyState = 3; this.onclose && this.onclose(); };

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

phaseWs(function () {
  phaseHttpFallback(function (A, S) {
    phaseDoctor(A, S, function () { process.exit(0); });
  });
});
