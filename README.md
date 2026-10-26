# AgriRobo — Smart Farming Assistant

A mobile-first, installable **Progressive Web App (PWA)** for the AgriRobo college engineering project. It connects to an ESP32-based solar smart farming robot over local Wi-Fi and displays **live soil moisture, temperature and humidity** readings from the project's actual sensors.

> **Hardware scope (strict):** soil moisture sensor + DHT11 (temperature & humidity). There is **no NPK sensor** in this project and **no NPK / fertilizer features** exist anywhere in the app or firmware.

---

## 1. What's included

| Item | Description |
|---|---|
| `index.html` + `css/` + `js/` | Complete runnable PWA (no build step needed) |
| `manifest.json`, `sw.js`, `icons/` | PWA install support (Android, iPhone, desktop) |
| `firmware/agrirobo_firmware.ino` | Reference ESP32 firmware exposing the HTTP JSON API |
| This README | Setup, API spec, calibration, testing instructions |

### Screens
1. **Home (Dashboard)** — soil moisture, temperature (°C), humidity (%), robot connection status, irrigation assistant, alerts, manual refresh
2. **Sensor History** — local charts for soil / temperature / humidity with Last hour / 24 h / 7 days filters (only real recorded data, never fake)
3. **Robot Controls** — movement D-pad, emergency stop, water pump, seed/plough placeholders, feature-availability list
4. **Settings & Setup** — connection config, calibration, thresholds, theme, troubleshooting

---

## 2. Quick start (5 minutes, no robot needed)

The app ships with a clearly labelled **Demo Mode** so you can practice the presentation without hardware. A permanent banner shows "Demo Mode — readings are simulated".

```bash
cd agrirobo
# any static server works; Python is the simplest:
python -m http.server 8080
```

Open `http://localhost:8080` on your phone or PC. In **Settings → ESP32 Connection**, choose **Demo** and tap **Save settings**. The dashboard, charts, alerts and pump timer all work in demo mode.

> Demo data is *always* labelled as simulated. Never present demo readings as real measurements.

---

## 3. Running with the real robot

### 3.1 Flash the ESP32 firmware
1. Install **Arduino IDE** (or PlatformIO) + the **ESP32 board package**.
2. Install libraries: `DHT sensor library` (Adafruit), `Adafruit Unified Sensor`, `ArduinoJson`.
3. Open `firmware/agrirobo_firmware.ino`, set `WIFI_SSID`, `WIFI_PASS`, pin assignments and soil calibration values.
4. Select your ESP32 board + port, compile and upload.
5. Open the Serial Monitor (115200 baud). The firmware prints either:
   - `AgriRobo ready at http://192.168.x.x` (joined your Wi-Fi), or
   - fallback AP mode: `AP IP: 192.168.4.1` (phone connects to Wi-Fi network `AgriRobo-AP`).

### 3.2 Connect the app
1. Put your phone on the **same Wi-Fi network** as the ESP32 (or join the `AgriRobo-AP` hotspot).
2. In the app: **Settings → ESP32 Connection**
   - Mode: `Live`
   - ESP32 base URL: `http://192.168.x.x` (the IP from Serial Monitor)
   - Optional API token, if you enabled one in firmware
3. Tap **Test connection**, then **Save settings**.
4. The dashboard now shows live readings with a "Connected" badge and last-update time.

### 3.3 Important networking note
A phone on the **same local Wi-Fi** can reach the ESP32 directly. **Local Wi-Fi is not worldwide access.** To monitor from outside the network you must add one of:
- an IoT cloud backend (e.g. Blynk, ThingSpeak, MQTT + broker, Firebase) that the ESP32 publishes to and the app reads from,
- or a VPN/tunnel (e.g. WireGuard, ngrok) to reach the LAN remotely.

The app polls `GET /api/sensors`; swapping in a cloud URL only requires changing the base URL or the fetch layer in `js/api.js`.

---

## 4. ESP32 HTTP API specification

All responses are JSON. CORS headers are enabled so the PWA (even from a different origin/port) can call the ESP32. If `API_TOKEN` is set in firmware, every request must include `Authorization: Bearer <token>`.

### `GET /api/sensors`
```json
{
  "soil_moisture_raw": 1850,
  "soil_moisture_percent": 42,
  "temperature_c": 28.5,
  "humidity_percent": 65,
  "timestamp": "2026-10-26T09:30:00",
  "device_status": "connected",
  "features": { "pump": true, "movement": false, "seed": false, "plough": false },
  "pump": { "supported": true, "status": "off" }
}
```
- `soil_moisture_percent` may be `null` — the app then converts `soil_moisture_raw` using its own calibration (Settings), or shows the raw ADC value if calibration is missing.
- `temperature_c` / `humidity_percent` are DHT11 readings; `null` on sensor fault.
- Missing/invalid values are handled gracefully — the app shows "No data" chips instead of fake numbers.

### `POST /api/water`
Body: `{ "action": "on" }` or `{ "action": "off" }`  
Response: `{ "ok": true, "pump_status": "on" }`  
Firmware failsafe turns the pump off after `PUMP_MAX_MS`; the app also enforces a configurable auto-off timer.

### `POST /api/control/move`
Body: `{ "direction": "forward" | "backward" | "left" | "right" | "stop" }`  
Returns `501 movement_not_supported` if motor hardware is disabled in firmware — the app keeps these buttons disabled based on `features.movement`.

### `POST /api/control/emergency`
Body: `{ "action": "stop_all" }` — stops pump + motors immediately.

### `POST /api/control/seed`, `POST /api/control/plough`
Placeholder endpoints; return `501` until implemented. The app shows these as "Not implemented".

---

## 5. Sensor calibration & data model

### Soil moisture
Capacitive sensors output a raw ADC value (0–4095 on ESP32) where **higher = drier** for most modules. Calibrate:
1. Hold the probe in dry air → note the raw value → enter as **Dry** in Settings.
2. Insert into wet soil → note the raw value → enter as **Wet**.
3. The app converts: `percent = (dry - raw) * 100 / (dry - wet)`, clamped 0–100.

If your firmware already publishes a calibrated `soil_moisture_percent`, enable **"ESP32 already sends calibrated percent"** in Settings and the app skips local conversion.

### DHT11
- Temperature: 0–50 °C (app sanity-checks the range and rejects impossible values).
- Humidity: 0–100 % RH.
- Both read every 5 s by default; app refresh interval is configurable (2–300 s).

### Thresholds (all configurable in Settings)
| Setting | Default | Effect |
|---|---|---|
| Soil moisture warning threshold | 40 % | "Watering may be required" recommendation |
| Low moisture alert | 25 % | Red "Dry" status + alert entry |
| High temperature alert | 38 °C | Warm status + alert |
| Low temperature alert | 10 °C | Cool status + alert |
| High humidity alert | 85 % | High humidity alert |
| Max manual watering | 30 s | App sends automatic Water OFF |

---

## 6. Installing on phones

### Android (Chrome)
1. Host the app (GitHub Pages, Netlify, or any static host) **or** serve it locally.
2. Open in Chrome → menu → **Add to Home screen** / **Install app**.
3. Launches fullscreen like a native app; works offline for the shell (live data needs network).

### iPhone / iPad (Safari)
1. Open in Safari → Share → **Add to Home Screen**.
2. Launches in standalone mode.

### PC / demo on laptop
Just open the served URL. Use browser DevTools device emulation for a phone-sized preview.

---

## 7. Testing with real hardware

1. **API sanity:** with the robot powered, open `http://<esp32-ip>/api/sensors` in the phone browser. You should see the JSON above.
2. **App connection:** enter the IP in Settings → Test connection → Save. The badge turns green "Connected".
3. **Soil sensor test:** touch the probe / move it between dry and wet soil; the dashboard % and chart should change within one refresh interval. Verify calibration by comparing app % with manual observation.
4. **DHT11 test:** breathe on the sensor — humidity should rise, temperature reading should react. Check the Serial Monitor values match the app.
5. **Disconnect test:** power off the robot → within ~3 intervals the app shows "Disconnected" + "Waiting for sensor data" and never displays stale values as live.
6. **Pump test (if wired):** press Water ON → confirm the relay energises, the countdown appears, and the pump stops at the max duration. Test the firmware failsafe separately by blocking the app.
7. **History:** leave the app running 10+ minutes, then check History → Last hour charts show the recorded trend (only real readings are stored locally in `localStorage`).

---

## 8. Feature status matrix

| Feature | Status | Notes |
|---|---|---|
| Soil moisture monitoring | ✅ Implemented | Raw ADC + calibration → % |
| Temperature & humidity (DHT11) | ✅ Implemented | Range-validated |
| Connection status / auto-retry | ✅ Implemented | Polling + watchdog |
| Local history + charts | ✅ Implemented | localStorage, 3 time ranges |
| Threshold alerts (soil/temp/humidity) | ✅ Implemented | Configurable |
| Irrigation recommendations | ✅ Implemented | Threshold-based, no automation |
| Manual water pump + auto-off | ✅ Implemented (app) | Needs pump relay in firmware |
| Robot movement D-pad | ✅ Implemented (app) | Needs motor driver + `USE_MOTORS=true` |
| Emergency stop | ✅ Implemented (app) | Needs firmware endpoint |
| Seed dispensing | ⛔ Placeholder | Requires dispenser hardware + firmware |
| Ploughing | ⛔ Placeholder | Requires plough hardware + firmware |
| Water-tank level alert | ⛔ Not included | Requires a water-level sensor (not in current build) |
| Battery / solar telemetry | ⛔ Not displayed | Only shown if firmware sends `battery_percent` |
| NPK / fertilizer | ❌ Out of scope | No NPK sensor exists in this project |
| Cloud remote monitoring | 🔧 Architecture-ready | Point the app at a cloud URL; needs IoT backend |
| Push notifications | 🔧 Not enabled | Would need service-worker push + permission |

---

## 9. Design notes

- Colours: dark green / light green / white with earthy accents; light **and** dark themes (follows system by default).
- Large touch targets (≥ 48 px), bottom navigation (Home / History / Controls / Settings), confirmation dialogs for pump, movement-critical and emergency actions.
- All credentials (Wi-Fi password, API token) stay on the device — **never hardcode them in client-side JS**; the firmware token is optional and entered only in Settings.

---

## 10. Presenting at your project review

- Show **Demo Mode** first to walk through every screen reliably.
- Then switch to **Live Mode** with the real robot for the soil-moisture and DHT11 demonstration.
- Be explicit: *"Demo readings are simulated and labelled. Live readings come from our ESP32's soil and DHT11 sensors over local Wi-Fi. Seed dispensing, ploughing and NPK are not part of our current hardware."*
