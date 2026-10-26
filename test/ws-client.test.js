/* Headless test: WebSocket client vs mock ESP32 firmware behaviour
   Run:  node test/ws-client.test.js */
global.window = global;
global.localStorage = { _d: {}, getItem(k){return this._d[k]||null;}, setItem(k,v){this._d[k]=v;}, removeItem(k){delete this._d[k];} };
global.location = { hostname: 'localhost', protocol: 'http:' };
global.document = { addEventListener(){}, hidden: false };
global.addEventListener = function(){};

var sentLines = [];
var instances = [];
function MockWS(url) {
  this.url = url; this.readyState = 0;
  var self = this;
  instances.push(this);
  setTimeout(function () { self.readyState = 1; self.onopen && self.onopen(); }, 5);
}
MockWS.prototype.send = function (l) { sentLines.push(l); };
MockWS.prototype.close = function () { this.readyState = 3; this.onclose && this.onclose(); };
global.WebSocket = MockWS;

require('../js/store.js');
require('../js/api.js');
var S = window.AgrStore, A = window.AgrApi;

S.saveSettings({ mode: 'live', baseUrl: 'http://192.168.4.1' });

var readings = [];
A.on('reading', function (r) { readings.push(r); });

var fail = function (msg) { console.error('FAIL: ' + msg); process.exit(1); };

A.startPolling();

setTimeout(function () {
  if (instances.length !== 1) fail('no WS connection attempted');
  if (instances[0].url !== 'ws://192.168.4.1:81/') fail('wrong ws url: ' + instances[0].url);

  // Robot broadcasts sensor data like the firmware does
  instances[0].onmessage({ data: 'S,28.5,61,2310' });

  setTimeout(function () {
    if (readings.length < 1) fail('no reading stored from S message');
    var r = readings[0];
    if (r.temperatureC !== 28.5) fail('temp wrong: ' + r.temperatureC);
    if (r.humidityPercent !== 61) fail('hum wrong: ' + r.humidityPercent);
    if (r.soilMoistureRaw !== 2310) fail('soil raw wrong: ' + r.soilMoistureRaw);
    // default cal 3200/1200 -> (3200-2310)/2000 -> 45 %
    if (r.soilMoisturePercent !== 45) fail('soil % wrong: ' + r.soilMoisturePercent);
    if (!r.features.movement || !r.features.seed || r.features.pump) fail('features wrong');
    console.log('sensor parse OK: T=' + r.temperatureC + ' H=' + r.humidityPercent +
      ' soil=' + r.soilMoisturePercent + '% (raw ' + r.soilMoistureRaw + ')');

    // Movement commands stream to the firmware
    A.sendMove('forward').then(function () {
      return A.sendSeed();
    }).then(function () {
      setTimeout(function () {
        if (!sentLines.some(function (l) { return l.indexOf('0,100,') === 0; })) fail('forward x,y not streamed: ' + JSON.stringify(sentLines));
        if (!sentLines.some(function (l) { return l.split(',')[4] === '1'; })) fail('dispense flag not sent');
        if (!sentLines.some(function (l) { return l.indexOf('0,0,') === 0; })) fail('stream lacks centred/idle frames');
        console.log('command stream OK: ' + sentLines.length + ' frames, e.g. "' + sentLines[sentLines.length - 1] + '"');

        // every AgrApi function that app.js uses must exist
        var used = ['fetchOnce','getSpeed','isPumping','on','sendEmergency','sendMove','sendPlough','sendSeed','sendWater','setSpeed','startPolling','stopPolling','testConnection'];
        var missing = used.filter(function (n) { return typeof A[n] !== 'function'; });
        if (missing.length) fail('AgrApi missing: ' + missing.join(', '));
        console.log('AgrApi exports OK: ' + used.length + ' functions');

        A.sendMove('stop').then(function () {
          console.log('ALL WEBSOCKET TESTS PASSED');
          process.exit(0);
        });
      }, 180);
    }).catch(function (e) { fail(e.message); });
  }, 400);
}, 200);
