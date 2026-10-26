/* ============================================================
 * AgriRobo Smart Farming Assistant — ESP32 Firmware
 * ------------------------------------------------------------
 * Sensors:  Soil moisture (analog capacitive sensor) + DHT11
 * Purpose:  Serve a local HTTP JSON API for the AgriRobo mobile
 *           app (PWA). Optional pump / motor control endpoints.
 *
 * Libraries (install via Arduino Library Manager):
 *   - DHT sensor library by Adafruit
 *   - Adafruit Unified Sensor
 *   - ESP32 board package (Arduino-ESP32)
 *
 * Wiring (defaults — change pins below to match your robot):
 *   Soil moisture AO -> GPIO 34 (input-only pin)
 *   DHT11 DATA       -> GPIO 15 (with 10k pull-up)
 *   Water pump relay -> GPIO 26 (active HIGH via transistor/relay)
 *   Motor driver EN  -> GPIO 25, IN1 -> 27, IN2 -> 33 (L298N/TB6612)
 *   (Motor pins optional — comment out if not used)
 *
 * IMPORTANT: This firmware has NO NPK sensor. Do not add NPK code.
 * ============================================================ */

#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include <DHT.h>

// ---------- User configuration ----------
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";
// Optional simple bearer token. Leave "" to disable auth.
// If set, the app must send: Authorization: Bearer <token>
const char* API_TOKEN = "";

#define SOIL_PIN        34
#define DHT_PIN         15
#define DHT_TYPE        DHT11
#define PUMP_PIN        26
#define MOTOR_EN        25
#define MOTOR_IN1       27
#define MOTOR_IN2       33
#define USE_MOTORS      false   // set true only if drive hardware is wired
#define USE_PUMP        true    // set true only if pump relay is wired

// Soil calibration — measure in dry air and wet soil, then update.
// Most capacitive sensors: higher ADC = drier.
int SOIL_CAL_DRY = 3200;   // raw ADC in dry air  -> 0%
int SOIL_CAL_WET = 1200;   // raw ADC in wet soil -> 100%

const unsigned long SENSOR_INTERVAL_MS = 5000;  // sample every 5 s
unsigned long lastSample = 0;
bool pumpOn = false;
unsigned long pumpStartedAt = 0;
const unsigned long PUMP_MAX_MS = 60UL * 1000UL; // firmware-level failsafe

WebServer server(80);
DHT dht(DHT_PIN, DHT_TYPE);

// ---------- Cached sensor state ----------
int   soilRaw    = -1;
float soilPct    = NAN;
float temperature = NAN;
float humidity    = NAN;
String lastError  = "";

// ---------- Helpers ----------
bool authOk() {
  if (strlen(API_TOKEN) == 0) return true;
  String h = server.header("Authorization");
  String expected = String("Bearer ") + API_TOKEN;
  return h == expected;
}

void handleAuthFail() {
  server.send(401, "application/json",
    "{\"error\":\"unauthorized\",\"message\":\"Missing or invalid bearer token\"}");
}

void readSensors() {
  // Soil moisture (12-bit ADC on ESP32: 0..4095)
  int raw = analogRead(SOIL_PIN);
  if (raw >= 0 && raw <= 4095) {
    soilRaw = raw;
    float pct = (float)(SOIL_CAL_DRY - raw) * 100.0 / (float)(SOIL_CAL_DRY - SOIL_CAL_WET);
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    soilPct = pct;
  }

  // DHT11
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (!isnan(t)) temperature = t; else lastError = "DHT11 temperature read failed";
  if (!isnan(h)) humidity = h;    else lastError = "DHT11 humidity read failed";

  // Pump failsafe
  if (pumpOn && (millis() - pumpStartedAt) > PUMP_MAX_MS) {
    pumpOn = false;
    if (USE_PUMP) digitalWrite(PUMP_PIN, LOW);
  }
}

String buildJson() {
  StaticJsonDocument<384> doc;
  if (soilRaw >= 0) doc["soil_moisture_raw"] = soilRaw;
  else doc["soil_moisture_raw"] = nullptr;
  if (!isnan(soilPct)) doc["soil_moisture_percent"] = (int)round(soilPct);
  else doc["soil_moisture_percent"] = nullptr;
  if (!isnan(temperature)) doc["temperature_c"] = round(temperature * 10) / 10.0;
  else doc["temperature_c"] = nullptr;
  if (!isnan(humidity)) doc["humidity_percent"] = round(humidity);
  else doc["humidity_percent"] = nullptr;

  // ISO-8601-ish timestamp (device clock; sync via NTP if needed)
  time_t now = time(nullptr);
  struct tm* t2 = localtime(&now);
  char ts[25];
  strftime(ts, sizeof(ts), "%Y-%m-%dT%H:%M:%S", t2);
  doc["timestamp"] = ts;

  doc["device_status"] = "connected";
  if (lastError.length()) doc["last_error"] = lastError;

  JsonObject pump = doc.createNestedObject("pump");
  pump["supported"] = USE_PUMP;
  pump["status"] = pumpOn ? "on" : "off";

  // Feature flags so the app can enable/disable controls automatically
  JsonObject feat = doc.createNestedObject("features");
  feat["pump"] = USE_PUMP;
  feat["movement"] = USE_MOTORS;
  feat["seed"] = false;    // set true when dispenser hardware exists
  feat["plough"] = false;  // set true when plough hardware exists

  String out;
  serializeJson(doc, out);
  return out;
}

void sendJson(const String& body, int code = 200) {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.send(code, "application/json", body);
}

// ---------- HTTP handlers ----------
void handleOptions() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.send(204);
}

void handleSensors() {
  if (!authOk()) { handleAuthFail(); return; }
  sendJson(buildJson());
}

void handleWater() {
  if (!authOk()) { handleAuthFail(); return; }
  if (!USE_PUMP) {
    sendJson("{\"ok\":false,\"error\":\"pump_not_supported\"}", 501);
    return;
  }
  StaticJsonDocument<128> doc;
  deserializeJson(doc, server.arg("plain"));
  String action = doc["action"] | "off";
  if (action == "on") {
    pumpOn = true;
    pumpStartedAt = millis();
    digitalWrite(PUMP_PIN, HIGH);
  } else {
    pumpOn = false;
    digitalWrite(PUMP_PIN, LOW);
  }
  StaticJsonDocument<96> res;
  res["ok"] = true;
  res["pump_status"] = pumpOn ? "on" : "off";
  String out;
  serializeJson(res, out);
  sendJson(out);
}

void handleMove() {
  if (!authOk()) { handleAuthFail(); return; }
  if (!USE_MOTORS) {
    sendJson("{\"ok\":false,\"error\":\"movement_not_supported\"}", 501);
    return;
  }
  StaticJsonDocument<128> doc;
  deserializeJson(doc, server.arg("plain"));
  String dir = doc["direction"] | "stop";
  // Simple single-motor polarity drive (adapt for 2-wheel differential drive as needed)
  if (dir == "forward")       { digitalWrite(MOTOR_IN1, HIGH); digitalWrite(MOTOR_IN2, LOW); analogWrite(MOTOR_EN, 200); }
  else if (dir == "backward") { digitalWrite(MOTOR_IN1, LOW);  digitalWrite(MOTOR_IN2, HIGH); analogWrite(MOTOR_EN, 200); }
  else if (dir == "left")     { digitalWrite(MOTOR_IN1, HIGH); digitalWrite(MOTOR_IN2, LOW); analogWrite(MOTOR_EN, 120); }
  else if (dir == "right")    { digitalWrite(MOTOR_IN1, LOW);  digitalWrite(MOTOR_IN2, HIGH); analogWrite(MOTOR_EN, 120); }
  else                        { digitalWrite(MOTOR_IN1, LOW);  digitalWrite(MOTOR_IN2, LOW);  analogWrite(MOTOR_EN, 0); }
  sendJson("{\"ok\":true,\"direction\":\"" + dir + "\"}");
}

void handleEmergency() {
  if (!authOk()) { handleAuthFail(); return; }
  pumpOn = false;
  if (USE_PUMP) digitalWrite(PUMP_PIN, LOW);
  if (USE_MOTORS) {
    digitalWrite(MOTOR_IN1, LOW);
    digitalWrite(MOTOR_IN2, LOW);
    analogWrite(MOTOR_EN, 0);
  }
  sendJson("{\"ok\":true,\"status\":\"all_stopped\"}");
}

void handleSeed() {
  if (!authOk()) { handleAuthFail(); return; }
  sendJson("{\"ok\":false,\"error\":\"seed_dispenser_not_implemented\"}", 501);
}

void handlePlough() {
  if (!authOk()) { handleAuthFail(); return; }
  sendJson("{\"ok\":false,\"error\":\"plough_not_implemented\"}", 501);
}

void handleRoot() {
  sendJson("{\"device\":\"AgriRobo\",\"api\":\"/api/sensors\",\"firmware\":\"1.0.0\"}");
}

void handleNotFound() {
  sendJson("{\"error\":\"not_found\"}", 404);
}

// ---------- Setup / loop ----------
void setup() {
  Serial.begin(115200);
  pinMode(SOIL_PIN, INPUT);
  if (USE_PUMP) { pinMode(PUMP_PIN, OUTPUT); digitalWrite(PUMP_PIN, LOW); }
  if (USE_MOTORS) {
    pinMode(MOTOR_EN, OUTPUT);
    pinMode(MOTOR_IN1, OUTPUT);
    pinMode(MOTOR_IN2, OUTPUT);
    analogWrite(MOTOR_EN, 0);
  }

  dht.begin();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting to Wi-Fi");
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 40) {
    delay(250);
    Serial.print(".");
    tries++;
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("AgriRobo ready at http://");
    Serial.println(WiFi.localIP());
  } else {
    // Fallback: start Access Point so the phone can always connect
    Serial.println("Wi-Fi failed — starting AP AgriRobo-AP (no password)");
    WiFi.mode(WIFI_AP);
    WiFi.softAP("AgriRobo-AP");
    Serial.print("AP IP: ");
    Serial.println(WiFi.softAPIP());
  }

  server.on("/", HTTP_GET, handleRoot);
  server.on("/api/sensors", HTTP_GET, handleSensors);
  server.on("/api/water", HTTP_POST, handleWater);
  server.on("/api/control/move", HTTP_POST, handleMove);
  server.on("/api/control/emergency", HTTP_POST, handleEmergency);
  server.on("/api/control/seed", HTTP_POST, handleSeed);
  server.on("/api/control/plough", HTTP_POST, handlePlough);
  // CORS preflight
  server.on("/api/sensors", HTTP_OPTIONS, handleOptions);
  server.on("/api/water", HTTP_OPTIONS, handleOptions);
  server.on("/api/control/move", HTTP_OPTIONS, handleOptions);
  server.on("/api/control/emergency", HTTP_OPTIONS, handleOptions);
  server.onNotFound(handleNotFound);
  server.begin();

  // Read sensors once at boot
  readSensors();
}

void loop() {
  server.handleClient();
  unsigned long now = millis();
  if (now - lastSample >= SENSOR_INTERVAL_MS) {
    lastSample = now;
    readSensors();
  }
}
