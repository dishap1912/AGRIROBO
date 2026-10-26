/*
 * Web-controlled 4-wheel agricultural robot  (WebSocket version, MDDS10)
 * Board : ESP32-WROOM-32 (ESP32 Dev Module, Espressif "esp32" core 2.x or 3.x)
 * Libs  : "WebSockets" by Markus Sattler (arduinoWebSockets, Links2004)
 * Driver: Cytron MDDS10 in PWM + DIR (sign-magnitude) mode
 *
 * WIRING
 *   MDDS10 AN1  (PWM, left)  -> GPIO26
 *   MDDS10 DIG1 (DIR, left)  -> GPIO14
 *   MDDS10 AN2  (PWM, right) -> GPIO25
 *   MDDS10 DIG2 (DIR, right) -> GPIO27
 *   MDDS10 GND <-> ESP32 GND (common ground is a must)
 *   DHT11 DATA -> GPIO4, VCC -> 3.3V, GND -> GND
 *   Soil moisture AOUT -> GPIO34 (3.3V, GND)
 *   Seed servo signal -> GPIO13 (servo power from its own 5-6V supply, GND common)
 *   Left channel : front-left + rear-left motors
 *   Right channel: front-right + rear-right motors
 *
 * HOW IT WORKS
 *   ESP32 creates its own WiFi network (AP_SSID below).
 *   Connect phone/laptop to it and open  http://192.168.4.1
 *   The page has a touch joystick (phone) and W/A/S/D / arrow keys (laptop).
 *   It streams values 20 times per second. If the stream stops for
 *   PACKET_TIMEOUT_MS, or the socket closes, all motors stop (failsafe).
 *
 *   The AgriRobo mobile app (same files in LittleFS) talks to the robot over
 *   the WebSocket on :81 (primary).  A JSON HTTP API on :80 is also provided
 *   as a fallback so the app can still monitor sensors and send movement if
 *   the WebSocket path fails:
 *     GET  /api/status   GET /api/sensors
 *     POST /api/control/move | /api/control/emergency | /api/control/seed
 *   Firmware version: 1.1.0
 *
 * After connect and after STOP the robot is "disarmed" until the stick/keys
 * return to centre, so it never lurches.
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <WebSocketsServer.h>
#include <LittleFS.h>   // serves the AgriRobo app (index.html, js/, css/) from flash
#include <DHT.h>        // "DHT sensor library" by Adafruit (+ Adafruit Unified Sensor)

struct Motor;   // forward declaration so Arduino's auto-generated prototypes compile

// ============================================================================
// 0. WIFI
// ============================================================================
const char* AP_SSID = "AgriRobo";
const char* AP_PASS = "agrirobo123";    // minimum 8 characters
constexpr int AP_CHANNEL = 1;           // try 6 or 11 if the link is flaky

// ============================================================================
// 1. GPIO ASSIGNMENTS (MDDS10, PWM + DIR mode)
// ============================================================================
constexpr uint8_t M1_PWM = 26;   // AN1
constexpr uint8_t M1_DIR = 14;   // DIG1
constexpr uint8_t M2_PWM = 25;   // AN2
constexpr uint8_t M2_DIR = 27;   // DIG2

// Seed-dispenser servo (signal wire)
constexpr uint8_t SERVO_PIN = 13;

// DHT11 temperature / humidity sensor (DATA pin)
constexpr uint8_t  DHT_PIN       = 4;
constexpr uint32_t DHT_PERIOD_MS = 2000;   // DHT11 can be read at most once per second

// Soil moisture sensor (analog out). Use an ADC1 pin (32-39) - ADC2 does not work while WiFi is on.
constexpr bool    USE_SOIL = true;         // set false if no soil sensor is connected
constexpr uint8_t SOIL_PIN = 34;           // AOUT -> GPIO34, VCC -> 3.3V, GND -> GND

// ============================================================================
// 2. TUNING
// ============================================================================
constexpr bool SWAP_SIDES = false;  // true if left stick turns the robot the wrong way
constexpr bool INVERT_L   = false;  // true if left side goes backward when pushing forward
constexpr bool INVERT_R   = false;  // true if right side goes backward when pushing forward

constexpr uint32_t PWM_FREQ_HZ  = 15000;   // above hearing range, MDDS10 accepts up to 20 kHz
constexpr uint8_t  PWM_RES_BITS = 8;
constexpr int      PWM_DUTY_MAX = 255;
constexpr int      PWM_MIN      = 30;      // lowest duty at which the motors actually turn
constexpr int      PWM_MAX_SLOW   = 110;
constexpr int      PWM_MAX_NORMAL = 180;
constexpr int      PWM_MAX_FAST   = 255;

constexpr float STICK_DEADZONE    = 0.10f;
constexpr float STEER_SENSITIVITY = 0.80f;  // 0.1 (gentle) .. 1.5 (aggressive)

constexpr int ACCEL_STEP = 10;   // PWM counts per 10 ms tick
constexpr int DECEL_STEP = 20;

constexpr uint32_t CONTROL_PERIOD_MS = 10;
constexpr uint32_t PACKET_TIMEOUT_MS = 800;   // page sends every 50 ms
constexpr bool     DEBUG_SERIAL      = true;
constexpr uint32_t DEBUG_PERIOD_MS   = 500;

// Seed dispenser servo
constexpr int SERVO_MIN_US       = 500;    // pulse for 0 deg   (tune for your servo)
constexpr int SERVO_MAX_US       = 2500;   // pulse for 180 deg
constexpr int SERVO_CLOSED_ANGLE = 0;
constexpr int SERVO_OPEN_ANGLE   = 90;
constexpr uint32_t SERVO_HOLD_MS = 600;    // how long the gate stays open (seed falls)
constexpr uint32_t SERVO_MOVE_MS = 500;    // time allowed for it to return

// ============================================================================
// 3. PWM WRAPPERS (work on core 2.x and 3.x)
// ============================================================================
#if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
  static bool pwmAttach(uint8_t pin, uint8_t /*ch*/) { return ledcAttach(pin, PWM_FREQ_HZ, PWM_RES_BITS); }
  static void pwmWrite(uint8_t pin, uint8_t /*ch*/, int duty) { ledcWrite(pin, duty); }
#else
  static bool pwmAttach(uint8_t pin, uint8_t ch) {
    ledcSetup(ch, PWM_FREQ_HZ, PWM_RES_BITS);
    ledcAttachPin(pin, ch);
    return true;
  }
  static void pwmWrite(uint8_t /*pin*/, uint8_t ch, int duty) { ledcWrite(ch, duty); }
#endif

// ---- Servo: 50 Hz, 16-bit LEDC ----
constexpr uint8_t SERVO_CH = 2;   // LEDC channel (core 2.x only)

static void servoAttach() {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
  ledcAttach(SERVO_PIN, 50, 16);
#else
  ledcSetup(SERVO_CH, 50, 16);
  ledcAttachPin(SERVO_PIN, SERVO_CH);
#endif
}

static void servoWriteUs(int us) {
  const uint32_t duty = (uint32_t)(((uint64_t)us * 65535ULL) / 20000ULL);
#if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
  ledcWrite(SERVO_PIN, duty);
#else
  ledcWrite(SERVO_CH, duty);
#endif
}

static void servoWriteAngle(int angle) {
  angle = constrain(angle, 0, 180);
  servoWriteUs(SERVO_MIN_US + (long)(SERVO_MAX_US - SERVO_MIN_US) * angle / 180);
}

// Non-blocking dispense: open -> hold -> close
static uint8_t  svState = 0;   // 0 idle, 1 open, 2 closing
static uint32_t svT = 0;

static void servoStartDispense() {
  if (svState != 0) return;    // ignore presses while already dispensing
  servoWriteAngle(SERVO_OPEN_ANGLE);
  svState = 1;
  svT = millis();
  Serial.println("[SERVO] Dispense");
}

static void servoUpdate(uint32_t now) {
  if (svState == 1 && (now - svT) >= SERVO_HOLD_MS) {
    servoWriteAngle(SERVO_CLOSED_ANGLE);
    svState = 2;
    svT = now;
  } else if (svState == 2 && (now - svT) >= SERVO_MOVE_MS) {
    svState = 0;
  }
}

// ============================================================================
// 4. MOTOR TABLE (one entry per MDDS10 channel = one side of the robot)
// ============================================================================
struct Motor {
  const char* name;
  uint8_t pwmPin, dirPin;
  bool invert;
  uint8_t ch;    // LEDC channel (core 2.x only)
  int current;   // PWM actually applied (signed: + = forward)
  int target;    // PWM requested (signed)
};

enum MotorId { M_L = 0, M_R, M_COUNT };

Motor motors[M_COUNT] = {
  { "L", SWAP_SIDES ? M2_PWM : M1_PWM, SWAP_SIDES ? M2_DIR : M1_DIR, INVERT_L, 0, 0, 0 },
  { "R", SWAP_SIDES ? M1_PWM : M2_PWM, SWAP_SIDES ? M1_DIR : M2_DIR, INVERT_R, 1, 0, 0 },
};

// ============================================================================
// 5. STATE
// ============================================================================
enum SpeedMode { MODE_NORMAL = 0, MODE_SLOW = 1, MODE_FAST = 2 };
const int   MODE_MAX_PWM[] = { PWM_MAX_NORMAL, PWM_MAX_SLOW, PWM_MAX_FAST };
const char* MODE_NAME[]    = { "NORMAL", "SLOW", "FAST" };

SpeedMode mode = MODE_NORMAL;
bool armed    = false;   // false -> motors forced to 0 until stick centred
bool wasAlive = false;   // was the link alive on the previous pass

// Latest command from the web page
int      g_x = 0;        // steering  -100..+100 (right = +)
int      g_y = 0;        // throttle  -100..+100 (forward = +)
uint32_t g_lastPacketMs = 0;
bool     g_haveCmd = false;

WebServer         server(80);
WebSocketsServer  ws(81);

// ============================================================================
// 6. WEB PAGE (stored in flash)
// ============================================================================
const char PAGE[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>AgriRobo Control</title>
<style>
  body{font-family:system-ui,Arial,sans-serif;background:#10161a;color:#e8f0e8;margin:0;
       display:flex;flex-direction:column;align-items:center;user-select:none;touch-action:none}
  h1{font-size:20px;margin:14px 0 4px}
  #st{padding:4px 12px;border-radius:12px;font-size:13px;background:#a33}
  #st.ok{background:#2a7a3a}
  #pad{width:260px;height:260px;border-radius:50%;background:#1d2a30;border:2px solid #3a5560;
       position:relative;margin:18px 0;touch-action:none}
  #knob{width:90px;height:90px;border-radius:50%;background:#4caf70;position:absolute;
        left:85px;top:85px;box-shadow:0 0 12px #0008}
  .row{display:flex;gap:10px;margin:6px}
  button{font-size:16px;padding:12px 18px;border:0;border-radius:8px;background:#2c3d45;color:#fff}
  button.sel{background:#4caf70;color:#000;font-weight:700}
  #stop{background:#c62828;font-weight:700;padding:14px 40px}
  #disp{background:#e0a21b;color:#000;font-weight:700;padding:14px 24px}
  #val{font-family:monospace;font-size:13px;color:#9fb5a8;margin-top:6px}
  #sens{font-size:18px;margin:10px;padding:8px 16px;border-radius:10px;background:#1d2a30}
  small{color:#789;margin:8px 16px;text-align:center}
</style>
</head>
<body>
<h1>AgriRobo Control</h1>
<div id="st">CONNECTING...</div>
<div id="pad"><div id="knob"></div></div>
<div class="row">
  <button id="m1" onclick="setMode(1)">SLOW</button>
  <button id="m0" onclick="setMode(0)">NORMAL</button>
  <button id="m2" onclick="setMode(2)">FAST</button>
</div>
<div class="row"><button id="disp" onclick="doDispense()">DISPENSE SEED</button><button id="stop" onclick="doStop()">STOP</button></div>
<div id="sens">Temp: -- &deg;C &nbsp; Humidity: -- %</div>
<div id="val">x=0 y=0</div>
<small>Drag the joystick, or use W/A/S/D or arrow keys. Space = STOP.</small>
<script>
let jx=0, jy=0;          // joystick  -1..1  (y up = +)
let kx=0, ky=0;          // keyboard
let mode=1, stopCnt=0, dispCnt=0;   // starts in SLOW for safety
const pad=document.getElementById('pad'), knob=document.getElementById('knob');
const stEl=document.getElementById('st');
const R=130, KR=45;      // pad radius, knob radius

function moveKnob(cx,cy){
  const r=pad.getBoundingClientRect();
  let dx=cx-(r.left+R), dy=cy-(r.top+R);
  const max=R-KR, d=Math.hypot(dx,dy);
  if(d>max){dx*=max/d; dy*=max/d;}
  knob.style.left=(R-KR+dx)+'px'; knob.style.top=(R-KR+dy)+'px';
  jx=dx/max; jy=-dy/max;
}
function resetKnob(){ knob.style.left=(R-KR)+'px'; knob.style.top=(R-KR)+'px'; jx=0; jy=0; }
pad.addEventListener('pointerdown',e=>{pad.setPointerCapture(e.pointerId);moveKnob(e.clientX,e.clientY);});
pad.addEventListener('pointermove',e=>{if(e.buttons||e.pressure>0)moveKnob(e.clientX,e.clientY);});
pad.addEventListener('pointerup',resetKnob);
pad.addEventListener('pointercancel',resetKnob);

const keys={};
function updKeys(){
  kx=((keys.d||keys.arrowright)?1:0)-((keys.a||keys.arrowleft)?1:0);
  ky=((keys.w||keys.arrowup)?1:0)-((keys.s||keys.arrowdown)?1:0);
}
addEventListener('keydown',e=>{
  const k=e.key.toLowerCase();
  if(k===' '){doStop();e.preventDefault();return;}
  if('wasd'.includes(k)||k.startsWith('arrow')){keys[k]=true;updKeys();e.preventDefault();}
});
addEventListener('keyup',e=>{keys[e.key.toLowerCase()]=false;updKeys();});
addEventListener('blur',()=>{for(const k in keys)keys[k]=false;updKeys();resetKnob();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){resetKnob();}});

function setMode(m){
  mode=m;
  for(let i=0;i<3;i++)document.getElementById('m'+i).className=(i===m?'sel':'');
}
setMode(1);
function doDispense(){ dispCnt=1; }
function doStop(){ stopCnt=5; resetKnob(); for(const k in keys)keys[k]=false; updKeys(); }

// ---- WebSocket: one persistent connection, auto-reconnect ----------------
let ws=null, reconnectTimer=null;
function connect(){
  clearTimeout(reconnectTimer);
  try{ ws=new WebSocket('ws://'+location.hostname+':81/'); }
  catch(e){ reconnectTimer=setTimeout(connect,500); return; }
  ws.onopen =()=>{ stEl.textContent='CONNECTED'; stEl.className='ok'; };
  ws.onclose=()=>{ stEl.textContent='RECONNECTING...'; stEl.className='';
                   reconnectTimer=setTimeout(connect,500); };
  ws.onerror=()=>{ try{ws.close();}catch(e){} };
  ws.onmessage=e=>{
    const p=String(e.data).split(',');
    if(p[0]==='S'){
      document.getElementById('sens').textContent =
        (p[1]==='err') ? 'Sensor error' : 'Temp: '+p[1]+' \u00B0C   Humidity: '+p[2]+' %';
    }
  };
}
connect();

// ---- continuous signal: 20 messages / second ------------------------------
function tick(){
  const x=Math.max(-1,Math.min(1,jx+kx)), y=Math.max(-1,Math.min(1,jy+ky));
  const xi=Math.round(x*100), yi=Math.round(y*100);
  document.getElementById('val').textContent='x='+xi+' y='+yi;
  if(ws && ws.readyState===1){
    ws.send(xi+','+yi+','+mode+','+(stopCnt>0?1:0)+','+dispCnt);
    if(stopCnt>0) stopCnt--;
    dispCnt=0;
  }
}
// A Web Worker timer is throttled much less than a normal timer when the
// tab is in the background. Fall back to setInterval if Workers are blocked.
try{
  const tw=new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),50)'])));
  tw.onmessage=tick;
}catch(e){
  setInterval(tick,50);
}
</script>
</body>
</html>
)rawliteral";

// ============================================================================
// 6b. DHT11 SENSOR (read every 2 s, pushed to the web page over the WebSocket
//     AND cached for the HTTP fallback API  GET /api/sensors)
// ============================================================================
DHT dht(DHT_PIN, DHT11);
char g_sensorMsg[40] = "";    // latest message, e.g. "S,28.5,61,2310"
float g_temp    = NAN;        // last good temperature (°C)
float g_hum     = NAN;        // last good humidity (%)
int   g_soilRaw = -1;         // last soil ADC reading (-1 = none)
bool  g_dhtOk   = false;      // false = last DHT read failed

static void dhtUpdate(uint32_t now) {
  static uint32_t last = 0;
  if (now - last < DHT_PERIOD_MS) return;
  last = now;

  const float t = dht.readTemperature();   // deg C
  const float h = dht.readHumidity();      // %
  const int soil = USE_SOIL ? analogRead(SOIL_PIN) : -1;   // raw 0..4095, app calibrates it

  g_dhtOk = !isnan(t) && !isnan(h);
  if (g_dhtOk) { g_temp = t; g_hum = h; }
  g_soilRaw = soil;

  // Message format: S,<tempC>,<hum%>,<soilRaw>   (err / -1 = not available)
  char tb[12], hb[12], sb[12];
  if (!g_dhtOk) { strcpy(tb, "err"); strcpy(hb, "err"); Serial.println("[DHT] read failed - check wiring"); }
  else { snprintf(tb, sizeof(tb), "%.1f", t); snprintf(hb, sizeof(hb), "%.0f", h); }
  if (soil < 0) strcpy(sb, "err"); else snprintf(sb, sizeof(sb), "%d", soil);
  snprintf(g_sensorMsg, sizeof(g_sensorMsg), "S,%s,%s,%s", tb, hb, sb);
  Serial.printf("[SENS] %s\n", g_sensorMsg);
  ws.broadcastTXT(g_sensorMsg);
}

// ============================================================================
// 7. LOW-LEVEL MOTOR CONTROL (MDDS10: PWM pin = speed, DIR pin = direction)
// ============================================================================
static void driveMotor(const Motor& m, int pwm) {
  pwm = constrain(pwm, -PWM_DUTY_MAX, PWM_DUTY_MAX);
  if (pwm == 0) {
    pwmWrite(m.pwmPin, m.ch, 0);
    return;
  }
  const bool forward = (pwm > 0) != m.invert;
  digitalWrite(m.dirPin, forward ? HIGH : LOW);
  pwmWrite(m.pwmPin, m.ch, abs(pwm));
}

static void stopAllMotors() {
  for (int i = 0; i < M_COUNT; i++) {
    motors[i].current = 0;
    motors[i].target  = 0;
    driveMotor(motors[i], 0);
  }
}

static int slew(int cur, int tgt) {
  if (cur == tgt) return cur;
  if (cur == 0) cur = (tgt > 0) ? PWM_MIN : -PWM_MIN;
  const bool towardZero = (tgt == 0) || (((tgt > 0) == (cur > 0)) && (abs(tgt) < abs(cur)));
  const int step = towardZero ? DECEL_STEP : ACCEL_STEP;
  if (tgt > cur) cur = min(cur + step, tgt);
  else           cur = max(cur - step, tgt);
  if (abs(cur) < PWM_MIN && tgt == 0) cur = 0;
  return cur;
}

// ============================================================================
// 8. INPUT SHAPING
// ============================================================================
static float applyDeadzone(float v) {
  float a = fabsf(v);
  if (a < STICK_DEADZONE) return 0.0f;
  a = (a - STICK_DEADZONE) / (1.0f - STICK_DEADZONE);
  return (v < 0.0f) ? -a : a;
}

static int sideToPwm(float v, int maxPwm) {
  const float a = fabsf(v);
  if (a < 0.02f) return 0;
  int p = PWM_MIN + (int)(a * (maxPwm - PWM_MIN));
  p = constrain(p, PWM_MIN, maxPwm);
  return (v < 0.0f) ? -p : p;
}

// ============================================================================
// 9. WEB / WEBSOCKET HANDLERS
// ============================================================================
// "/"        -> the AgriRobo app from LittleFS (falls back to the built-in page if not uploaded)
// "/legacy"  -> the original built-in joystick page (always available)
static void handleLegacy() {
  server.send_P(200, "text/html", PAGE);
}

static String mimeOf(const String& p) {
  if (p.endsWith(".html")) return "text/html";
  if (p.endsWith(".js"))   return "application/javascript";
  if (p.endsWith(".css"))  return "text/css";
  if (p.endsWith(".json")) return "application/json";
  if (p.endsWith(".png"))  return "image/png";
  if (p.endsWith(".svg"))  return "image/svg+xml";
  return "text/plain";
}

static void handleRoot() {
  File f = LittleFS.open("/index.html", "r");
  if (!f) { handleLegacy(); return; }
  server.streamFile(f, "text/html");
  f.close();
}

static void handleNotFound() {
  const String p = server.uri();
  if (LittleFS.exists(p)) {
    File f = LittleFS.open(p, "r");
    server.streamFile(f, mimeOf(p));
    f.close();
    return;
  }
  server.send(404, "text/plain", "not found");
}

static void onWsEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.printf("[WS] Client %u connected\n", num);
      if (g_sensorMsg[0]) ws.sendTXT(num, g_sensorMsg);
      break;

    case WStype_DISCONNECTED:
      Serial.printf("[WS] Client %u disconnected -> failsafe\n", num);
      stopAllMotors();
      armed = false;
      g_haveCmd = false;
      break;

    case WStype_TEXT: {
      char buf[40];
      size_t n = (length < sizeof(buf) - 1) ? length : sizeof(buf) - 1;
      memcpy(buf, payload, n);
      buf[n] = 0;
      int x = 0, y = 0, m = 0, s = 0, d = 0;
      if (sscanf(buf, "%d,%d,%d,%d,%d", &x, &y, &m, &s, &d) >= 3) {
        g_x = constrain(x, -100, 100);
        g_y = constrain(y, -100, 100);
        mode = (SpeedMode)constrain(m, 0, 2);
        if (s == 1) {                    // STOP pressed
          stopAllMotors();
          armed = false;
        }
        if (d == 1) servoStartDispense();   // DISPENSE pressed
        g_lastPacketMs = millis();
        g_haveCmd = true;
      }
      break;
    }

    default:
      break;
  }
}

// ============================================================================
// 9b. HTTP FALLBACK API (used by the app when the WebSocket cannot connect)
//     GET  /api/status     - device info (lets the app verify HTTP works)
//     GET  /api/sensors    - latest DHT11 + soil readings as JSON
//     POST /api/control/move       {"direction":"forward","speed":1}
//     POST /api/control/emergency  {"action":"stop_all"}
//     POST /api/control/seed       {"action":"dispense"}
//     POST /api/control/plough / /api/water -> 501 (not in this build)
// ============================================================================
static void sendJson(const String& body, int code) {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.send(code, "application/json", body);
}

static void handleOptions() { sendJson("", 204); }

static void handleApiStatus() {
  sendJson("{\"device\":\"AgriRobo\",\"firmware\":\"1.1.0\",\"ws_port\":81,"
           "\"http_api\":true,\"sensors\":{\"dht11\":true,\"soil\":true},"
           "\"features\":{\"pump\":false,\"movement\":true,\"seed\":true,\"plough\":false}}", 200);
}

static void handleApiSensors() {
  char t[12] = "null", h[12] = "null", s[12] = "null";
  if (g_dhtOk) { snprintf(t, sizeof(t), "%.1f", g_temp); snprintf(h, sizeof(h), "%.0f", g_hum); }
  if (g_soilRaw >= 0) snprintf(s, sizeof(s), "%d", g_soilRaw);

  String out;
  out.reserve(340);
  out += "{\"soil_moisture_raw\":";
  out += s;
  out += ",\"soil_moisture_percent\":null,";      // null -> the app converts using its calibration
  out += "\"temperature_c\":";
  out += t;
  out += ",\"humidity_percent\":";
  out += h;
  out += ",\"device_status\":\"connected\",\"firmware\":\"1.1.0\"";
  if (!g_dhtOk) out += ",\"last_error\":\"DHT11 read failed - check wiring\"";
  out += ",\"features\":{\"pump\":false,\"movement\":true,\"seed\":true,\"plough\":false}";
  out += ",\"pump\":{\"supported\":false,\"status\":\"off\"}}";
  sendJson(out, 200);
}

static void handleApiMove() {
  String b = server.arg("plain");
  String dir = "stop";
  if      (b.indexOf("\"forward\"")  >= 0) dir = "forward";
  else if (b.indexOf("\"backward\"") >= 0) dir = "backward";
  else if (b.indexOf("\"left\"")     >= 0) dir = "left";
  else if (b.indexOf("\"right\"")    >= 0) dir = "right";

  // optional speed selection: {"speed":0|1|2}
  int sp = -1;
  if (b.indexOf("\"speed\":0") >= 0 || b.indexOf("\"speed\": 0") >= 0) sp = 0;
  if (b.indexOf("\"speed\":1") >= 0 || b.indexOf("\"speed\": 1") >= 0) sp = 1;
  if (b.indexOf("\"speed\":2") >= 0 || b.indexOf("\"speed\": 2") >= 0) sp = 2;
  if (sp >= 0) mode = (SpeedMode)sp;

  if      (dir == "forward")  { g_x = 0;   g_y = 100; }
  else if (dir == "backward") { g_x = 0;   g_y = -100; }
  else if (dir == "left")     { g_x = -100; g_y = 0; }
  else if (dir == "right")    { g_x = 100;  g_y = 0; }
  else                        { g_x = 0;   g_y = 0; }

  if (dir == "stop") { stopAllMotors(); armed = false; }   // same semantics as the WS stop flag
  g_lastPacketMs = millis();   // refresh the 800 ms failsafe (app re- sends while holding)
  g_haveCmd = true;

  sendJson("{\"ok\":true,\"direction\":\"" + dir + "\"}", 200);
}

static void handleApiEmergency() {
  stopAllMotors();
  armed = false;
  g_haveCmd = false;
  g_x = 0; g_y = 0;
  sendJson("{\"ok\":true,\"status\":\"all_stopped\"}", 200);
}

static void handleApiSeed() {
  servoStartDispense();
  sendJson("{\"ok\":true,\"gate\":\"dispensing\",\"note\":\"gate opens then closes automatically\"}", 200);
}

static void handleApiPlough() { sendJson("{\"ok\":false,\"error\":\"plough_not_implemented\"}", 501); }
static void handleApiWater()  { sendJson("{\"ok\":false,\"error\":\"pump_not_in_this_build\"}", 501); }

// ============================================================================
// 10. SETUP
// ============================================================================
void setup() {
  // Motors safe FIRST
  for (int i = 0; i < M_COUNT; i++) {
    pinMode(motors[i].dirPin, OUTPUT); digitalWrite(motors[i].dirPin, LOW);
    pinMode(motors[i].pwmPin, OUTPUT); digitalWrite(motors[i].pwmPin, LOW);
  }

  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("=== Web-controlled Agricultural Robot (WebSocket, MDDS10) ===");

  for (int i = 0; i < M_COUNT; i++) {
    if (!pwmAttach(motors[i].pwmPin, motors[i].ch)) {
      Serial.printf("[ERROR] PWM attach failed on GPIO%u (%s)\n", motors[i].pwmPin, motors[i].name);
    }
    pwmWrite(motors[i].pwmPin, motors[i].ch, 0);
  }
  stopAllMotors();
  Serial.println("[MOTOR] Outputs initialised, all motors stopped");

  servoAttach();
  servoWriteAngle(SERVO_CLOSED_ANGLE);
  Serial.println("[SERVO] Ready on GPIO13");

  if (USE_SOIL) { pinMode(SOIL_PIN, INPUT); }
  if (!LittleFS.begin(true)) Serial.println("[FS] LittleFS mount failed");
  else Serial.println("[FS] LittleFS ready");

  dht.begin();
  Serial.println("[DHT] DHT11 started on GPIO4");

  // WiFi access point
  WiFi.mode(WIFI_AP);
  WiFi.setSleep(false);                       // lower latency, steadier link
  const bool ok = WiFi.softAP(AP_SSID, AP_PASS, AP_CHANNEL, 0, 2);
  Serial.printf("[WIFI] AP %s: SSID=%s  PASS=%s  CH=%d\n", ok ? "started" : "FAILED", AP_SSID, AP_PASS, AP_CHANNEL);
  Serial.print("[WIFI] Open in browser: http://");
  Serial.println(WiFi.softAPIP());

  server.on("/", handleRoot);
  server.on("/legacy", handleLegacy);

  // HTTP fallback API (app uses this if the WebSocket on :81 cannot connect)
  server.on("/api/status", HTTP_GET, handleApiStatus);
  server.on("/api/sensors", HTTP_GET, handleApiSensors);
  server.on("/api/control/move", HTTP_POST, handleApiMove);
  server.on("/api/control/emergency", HTTP_POST, handleApiEmergency);
  server.on("/api/control/seed", HTTP_POST, handleApiSeed);
  server.on("/api/control/plough", HTTP_POST, handleApiPlough);
  server.on("/api/water", HTTP_POST, handleApiWater);
  // CORS preflight for every API path
  server.on("/api/status", HTTP_OPTIONS, handleOptions);
  server.on("/api/sensors", HTTP_OPTIONS, handleOptions);
  server.on("/api/control/move", HTTP_OPTIONS, handleOptions);
  server.on("/api/control/emergency", HTTP_OPTIONS, handleOptions);
  server.on("/api/control/seed", HTTP_OPTIONS, handleOptions);
  server.on("/api/control/plough", HTTP_OPTIONS, handleOptions);
  server.on("/api/water", HTTP_OPTIONS, handleOptions);

  server.onNotFound(handleNotFound);
  server.begin();

  ws.begin();
  ws.onEvent(onWsEvent);
  Serial.println("[WEB] HTTP :80 (app + /api/* fallback) and WebSocket :81 started");
  Serial.println("[WEB] API: GET /api/sensors  /api/status   POST /api/control/move|emergency|seed");
}

// ============================================================================
// 11. MAIN LOOP
// ============================================================================
void loop() {
  static uint32_t lastTick  = 0;
  static uint32_t lastDebug = 0;

  server.handleClient();
  ws.loop();
  const uint32_t now = millis();
  servoUpdate(now);
  dhtUpdate(now);

  // ---- Failsafe: no command recently -> everything off ----------------------
  const bool alive = g_haveCmd && ((now - g_lastPacketMs) <= PACKET_TIMEOUT_MS);
  if (!alive) {
    stopAllMotors();
    if (wasAlive) {
      wasAlive = false;
      Serial.println("[FAILSAFE] Command stream lost - motors stopped");
    }
    armed = false;
    delay(1);
    return;
  }

  if (!wasAlive) {
    wasAlive = true;
    armed = false;
    Serial.println("[WEB] Link active. Centre the joystick to arm the drive.");
  }

  // ---- Fixed-rate control tick ----------------------------------------------
  if (now - lastTick < CONTROL_PERIOD_MS) return;
  lastTick = now;

  const float throttle = applyDeadzone(g_y / 100.0f);
  const float steerIn  = applyDeadzone(g_x / 100.0f);

  if (!armed && throttle == 0.0f && steerIn == 0.0f) {
    armed = true;
    Serial.println("[WEB] Armed");
  }

  // Differential (tank-style) mix: + steer = turn right
  const float steer = steerIn * STEER_SENSITIVITY;
  float left  = throttle + steer;
  float right = throttle - steer;
  const float peak = max(fabsf(left), fabsf(right));
  if (peak > 1.0f) { left /= peak; right /= peak; }

  const int maxPwm   = MODE_MAX_PWM[mode];
  const int leftPwm  = armed ? sideToPwm(left,  maxPwm) : 0;
  const int rightPwm = armed ? sideToPwm(right, maxPwm) : 0;

  motors[M_L].target = leftPwm;
  motors[M_R].target = rightPwm;

  for (int i = 0; i < M_COUNT; i++) {
    motors[i].current = slew(motors[i].current, motors[i].target);
    driveMotor(motors[i], motors[i].current);
  }

  if (DEBUG_SERIAL && (now - lastDebug) >= DEBUG_PERIOD_MS) {
    lastDebug = now;
    Serial.printf("[DBG] x=%4d y=%4d | mode=%s armed=%d | L=%4d R=%4d\n",
                  g_x, g_y, MODE_NAME[mode], armed ? 1 : 0,
                  motors[M_L].current, motors[M_R].current);
  }
}
