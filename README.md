# AgriRobo — Smart Farming Assistant

A mobile-first, installable **Progressive Web App (PWA)** for the AgriRobo college engineering project. It connects to the solar smart-farming robot (**ESP32 + MDDS10 + DHT11 + soil-moisture sensor**) over a **WebSocket link** and displays live soil moisture, temperature and humidity, plus robot driving, seed dispensing and speed controls.

> **Hardware scope (strict):** soil moisture sensor + DHT11 (temperature & humidity) + MDDS10 motor driver + seed servo. There is **no NPK sensor** in this project and **no NPK / fertilizer features** anywhere in the app or firmware.

---

## 1. What's included

| Item | Description |
|---|---|
| `index.html` + `css/` + `js/` | Complete runnable app (no build step) |
| `js/chart.umd.min.js` | Chart.js bundled locally so charts work offline / from the robot |
| `manifest.json`, `sw.js`, `icons/` | PWA install support + offline app shell |
| `firmware/AgriRobo_MDDS10_dht11.ino` | The robot firmware (AP + WebSocket + sensors + LittleFS app server) |
| `test/ws-client.test.js` | Headless test of the app↔firmware protocol (`node test/ws-client.test.js`) |
| This README | Setup, protocol spec, calibration, testing |

### Screens
1. **Home (Dashboard)** — soil moisture (% + status), temperature (°C), humidity (%), connection status, irrigation assistant, alerts, manual refresh
2. **Sensor History** — local charts with Last hour / 24 h / 7 days filters (real recorded data only — never fake)
3. **Robot Controls** — **virtual joystick**, direction buttons, **Drive Speed (Slow/Normal/Fast)**, emergency stop, seed dispensing, feature list
4. **Settings** — connection, soil calibration, thresholds, theme, troubleshooting

---

## 2. How the app and robot talk (architecture)

```
Phone ──Wi-Fi──▶ ESP32 "AgriRobo" network  (192.168.4.1)
   │                     │
   │  HTTP  GET /        │  serves the app itself from LittleFS
   │  WS    :81          │  control + sensor stream (WebSocket)
   └─────────────────────┘
```

- The ESP32 creates a Wi-Fi **access point**: SSID `AgriRobo`, password `agrirobo123`, IP `192.168.4.1`.
- The app is **served by the robot** from flash (LittleFS) → open `http://192.168.4.1` and everything works with **no internet**.
- A **WebSocket on port 81** carries:
  - **App → robot**, 20× per second: `x,y,speedMode,stop,dispense` (e.g. `0,100,1,0,0` = forward at Slow)
  - **Robot → app**, every ~2 s: `S,<tempC>,<hum%>,<soilRaw>` (e.g. `S,28.5,61,2310`)

### Safety design (in firmware)
- If the stream stops for **800 ms** (link lost, tab hidden, app closed) → **all motors stop** automatically.
- After connecting or stopping, the robot stays **disarmed until the stick returns to centre** — it never lurches.
- The app also halts driving when the tab is hidden/closed.

> **Important:** the hosted GitHub Pages copy runs on **HTTPS**, and browsers block insecure `ws://` from HTTPS pages. So **live robot control works from the robot-served app (`http://192.168.4.1`)**. The hosted copy is for demo mode and reviewing the UI anywhere. The app detects this and shows a clear message.

---

## 3. Getting the robot online (step by step)

### 3.1 Flash the firmware
1. Install **Arduino IDE** + the **ESP32 board package**, and the libraries:
   - `DHT sensor library` (Adafruit) + `Adafruit Unified Sensor`
   - `WebSockets` by Markus Sattler
2. Open `firmware/AgriRobo_MDDS10_dht11.ino` (IDE will copy it into a matching folder).
3. Check pins against your wiring (defaults in the file header):

   | Peripheral | GPIO |
   |---|---|
   | MDDS10 AN1 / DIG1 (left) | 26 / 14 |
   | MDDS10 AN2 / DIG2 (right) | 25 / 27 |
   | DHT11 DATA | 4 |
   | Soil moisture AOUT | 34 (ADC1 — required while Wi-Fi is on) |
   | Seed servo signal | 13 |

4. Select **ESP32 Dev Module** + port → **Upload**.

### 3.2 Upload the app to LittleFS (so the robot serves it)
1. Install a LittleFS upload tool for your IDE (e.g. **ESP32 LittleFS Uploader** / `arduino-littlefs-upload`, or PlatformIO's `Upload Filesystem Image`).
2. Create a folder named `data` next to the `.ino` sketch and copy the app into it **keeping the structure**:
   ```
   data/
     index.html
     manifest.json
     sw.js
     css/styles.css
     js/{store,api,charts,app,chart.umd.min}.js
     icons/*
   ```
3. Run **Upload Filesystem Image**.
4. The robot now serves the full app at `http://192.168.4.1` (the old built-in page stays at `/legacy`).

### 3.3 Connect the phone
1. Phone Wi-Fi → join **`AgriRobo`** (password `agrirobo123`).
2. Open a browser → **`http://192.168.4.1`** → the AgriRobo dashboard loads.
3. Go to **Controls** → the joystick, direction buttons, speed selector and seed dispenser are live; **Home** shows temperature, humidity and soil moisture within a couple of seconds.
4. Settings → **Test connection** confirms the link and shows a live reading.

No configuration is needed when the app is served by the robot — it auto-detects its own host.

---

## 4. Protocol specification (app ↔ firmware)

### App → robot (WebSocket text frame, every 50 ms)
```
x,y,speedMode,stop,dispense
```
| Field | Range | Meaning |
|---|---|---|
| `x` | −100..+100 | steering (+ = right) |
| `y` | −100..+100 | throttle (+ = forward) |
| `speedMode` | 0 / 1 / 2 | Normal / Slow / Fast (default **Slow**) |
| `stop` | 0/1 | 1 = emergency stop + disarm (sent a few frames) |
| `dispense` | 0/1 | 1 = open seed gate |

Examples: `0,100,1,0,0` forward-slow · `-100,0,1,0,0` spin left · `0,0,1,1,0` stop.

### Robot → app (WebSocket text frame, every ~2 s)
```
S,<tempC>,<hum%>,<soilRaw>
```
- `err` in place of a value = sensor read failed (app shows "No data", never a fake number).
- `soilRaw` is the raw ADC (0–4095). The **app converts it to %** using the calibration in Settings (defaults: dry 3200, wet 1200).

### Legacy built-in page
`http://192.168.4.1/legacy` — the firmware's original joystick page (always available, works even if LittleFS isn't uploaded).

---

## 5. Sensor calibration & thresholds

### Soil moisture
Capacitive sensor → raw ADC, **higher = drier**. Calibrate in **Settings → Soil Moisture Calibration**:
1. Probe in dry air → read the raw value on the dashboard source line / serial → enter as **Dry**.
2. Probe in wet soil → enter as **Wet**.
3. `percent = (dry − raw) × 100 / (dry − wet)`, clamped 0–100.

### DHT11
Temperature 0–50 °C, humidity 0–100 % RH; the app range-checks and rejects impossible values (shows "No data").

### Thresholds (Settings, all configurable)
| Setting | Default | Effect |
|---|---|---|
| Soil moisture warning threshold | 40 % | "Watering may be required" recommendation |
| Low moisture alert | 25 % | Dry status + red alert |
| High temperature alert | 38 °C | Warm status + alert |
| Low temperature alert | 10 °C | Cool status + alert |
| High humidity alert | 85 % | Humidity alert |
| Refresh interval | 5 s | How often readings are recorded to history |

---

## 6. Running it on phones

### On the robot's Wi-Fi (live data — the presentation setup)
Join `AgriRobo` → open `http://192.168.4.1` → **Add to Home Screen** (Chrome: ⋮ → Install; Safari: Share → Add to Home Screen).

### Anywhere else (demo / review)
Open the GitHub Pages link (`https://dishap1912.github.io/AGRIROBO/`) → **Settings → Connection mode → Demo → Save**. Readings are simulated and permanently labelled **Demo Mode**.

---

## 7. Testing with real hardware

1. **Serial:** open Serial Monitor (115200) — you should see `[SENS] S,28.5,61,2310` lines and the AP IP.
2. **Protocol:** `node test/ws-client.test.js` verifies the app's parsing/streaming against a mock robot.
3. **App connection:** Settings → **Test connection** → returns temp/humidity/soil-raw.
4. **Soil sensor:** move the probe between dry and wet — the % and chart must move (recalibrate if the direction/range is off).
5. **DHT11:** breathe on the sensor — humidity rises within ~2 s (watch Serial if not).
6. **Drive:** joystick push → robot moves while held; **release → stops**. Kill the phone Wi-Fi mid-drive → motors stop within 800 ms (failsafe).
7. **Seed:** Controls → Dispense Seeds → servo opens, holds, closes (gate timing tunable in firmware).
8. **History:** leave it running 10+ minutes → History shows real recorded trends.

---

## 8. Feature status matrix

| Feature | Status | Notes |
|---|---|---|
| Soil moisture monitoring | ✅ Implemented | Raw ADC → calibrated % in app |
| Temperature & humidity (DHT11) | ✅ Implemented | Range-validated, `err` handled |
| Live connection status + auto-reconnect | ✅ Implemented | WebSocket, 2 s retry |
| Local history + charts (offline Chart.js) | ✅ Implemented | localStorage, 3 ranges |
| Threshold alerts (soil/temp/humidity) | ✅ Implemented | Configurable |
| Irrigation recommendations | ✅ Implemented | Threshold-based guidance |
| Virtual joystick + direction buttons | ✅ Implemented | 50 ms stream, failsafe stop |
| Drive speed Slow/Normal/Fast | ✅ Implemented | Starts on Slow (safety) |
| Emergency stop | ✅ Implemented | Stop flag + disarm |
| Seed dispensing | ✅ Implemented | Servo on GPIO13 |
| Water pump | ⛔ Not in this build | App supports it; firmware has no pump |
| Ploughing | ⛔ Not implemented | Needs hardware + firmware |
| Water-tank level alert | ⛔ Not included | Needs a level sensor |
| Battery / solar telemetry | ⛔ Not displayed | Add to firmware message if measured |
| NPK / fertilizer | ❌ Out of scope | No NPK sensor in this project |
| Remote monitoring over internet | ⛔ Not applicable | Robot creates its own AP; hosted copy runs demo mode |
| Push notifications | 🔧 Not enabled | Would need web-push + permission |

---

## 9. Design notes

- Dark green / light green / white with earthy accents; **light and dark themes**.
- Large touch targets (≥ 48 px), bottom navigation, confirmation dialogs for emergency/seed actions.
- The Wi-Fi password lives only in the firmware; no credentials are embedded in the app code.
- Demo data is **always labelled** — never present simulated values as measurements.

---

## 10. Presentation tips

- Start in **Demo Mode** (hosted link) to walk through every screen reliably.
- Then join `AgriRobo` and open `http://192.168.4.1` for the **live demo**: sensors, joystick driving, speed change, seed dispensing, and the **Wi-Fi-kill failsafe** (motors stop by themselves).
- Be explicit: *"Our sensors are soil moisture and DHT11 only — there is no NPK sensor. The robot creates its own Wi-Fi network; the app is served by the robot itself, so it works without internet."*
