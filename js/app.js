/* ============================================================
   AgriRobo — App logic
   Navigation, dashboard rendering, alerts, settings, controls
   ============================================================ */
(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  /* ================= Theme ================= */
  function applyTheme() {
    var pref = AgrStore.settings.theme;
    var dark = pref === 'dark' ||
      (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var btn = $('#theme-toggle');
    if (btn) btn.textContent = dark ? '☀️' : '🌙';
  }

  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme') === 'dark';
    AgrStore.saveSettings({ theme: cur ? 'light' : 'dark' });
    applyTheme();
    AgrCharts.renderAll();
  }

  /* ================= Toast & confirm ================= */
  var toastTimer = null;
  function toast(msg, isErr) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 3200);
  }

  function confirmAction(title, msg) {
    return new Promise(function (resolve) {
      var overlay = $('#confirm-overlay');
      $('#confirm-title').textContent = title;
      $('#confirm-msg').textContent = msg;
      overlay.classList.remove('hidden');

      function close(result) {
        overlay.classList.add('hidden');
        $('#confirm-ok').onclick = null;
        $('#confirm-cancel').onclick = null;
        resolve(result);
      }
      $('#confirm-ok').onclick = function () { close(true); };
      $('#confirm-cancel').onclick = function () { close(false); };
    });
  }

  /* ================= Navigation ================= */
  function showScreen(name) {
    $$('.screen').forEach(function (s) { s.classList.remove('active'); });
    var el = document.getElementById('screen-' + name);
    if (el) el.classList.add('active');
    $$('.nav-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-screen') === name);
    });
    window.scrollTo(0, 0);
    if (name === 'history') setTimeout(function () { AgrCharts.renderAll(); }, 30);
  }

  /* ================= Status helpers ================= */
  function statusLabelSoil(pct, s) {
    if (pct === null || pct === undefined) return { text: '—', cls: 'chip-neutral' };
    if (pct < s.soilAlert) return { text: 'Dry', cls: 'chip-danger' };
    if (pct < s.soilThreshold) return { text: 'Moderate', cls: 'chip-warn' };
    return { text: 'Moist', cls: 'chip-ok' };
  }

  function statusLabelTemp(t) {
    if (t === null) return { text: '—', cls: 'chip-neutral' };
    var s = AgrStore.settings;
    if (t <= s.tempLow) return { text: 'Cool', cls: 'chip-info' };
    if (t >= s.tempHigh) return { text: 'Warm', cls: 'chip-danger' };
    return { text: 'Normal', cls: 'chip-ok' };
  }

  function statusLabelHum(h) {
    if (h === null) return { text: '—', cls: 'chip-neutral' };
    if (h >= AgrStore.settings.humHigh) return { text: 'High', cls: 'chip-danger' };
    if (h >= 60) return { text: 'Comfortable', cls: 'chip-ok' };
    return { text: 'Low', cls: 'chip-warn' };
  }

  function fmtTime(ts) {
    if (!ts) return 'No data';
    var d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function setChip(id, info) {
    var el = $(id);
    if (!el) return;
    el.textContent = info.text;
    el.className = 'chip ' + info.cls;
  }

  /* ================= Dashboard render ================= */
  function renderConnection(connected, mode) {
    var badge = $('#conn-badge');
    var label = badge.querySelector('.conn-label');
    var ctrlBadge = $('#ctrl-conn');
    var ctrlLabel = ctrlBadge.querySelector('.conn-label');
    var demoBanner = $('#demo-banner');
    var isDemo = mode === 'demo';

    badge.classList.toggle('connected', connected && !isDemo);
    badge.classList.toggle('demo', isDemo);
    ctrlBadge.classList.toggle('connected', connected && !isDemo);
    ctrlBadge.classList.toggle('demo', isDemo);

    var text = isDemo ? 'Demo Mode' : (connected ? 'Connected' : 'Disconnected');
    label.textContent = text;
    ctrlLabel.textContent = text;

    demoBanner.classList.toggle('hidden', !isDemo);
    $('#device-mode').textContent = isDemo ? 'Demo (simulated)' : 'Live';
    var ctrlMode = $('#ctrl-mode');
    ctrlMode.textContent = isDemo ? 'Demo mode' : 'Live mode';
    ctrlMode.className = 'chip ' + (isDemo ? 'chip-warn' : 'chip-ok');

    var controlsEnabled = connected; // demo mode counts as connected for UI but shows labels
    enableControls(controlsEnabled);
  }

  function enableControls(enabled) {
    $$('#dpad .dpad-btn').forEach(function (b) { b.disabled = !enabled; });
    $('#btn-emergency').disabled = !enabled;
    var joy = $('#joystick');
    if (joy) {
      joy.classList.toggle('disabled', !enabled);
      joy.setAttribute('aria-disabled', String(!enabled));
      if (!enabled) resetKnob('Idle');
    }
    var s = AgrStore.settings;
    // Only enable feature buttons that the firmware reported as available (or demo simulates pump)
    var last = AgrStore.lastReading;
    var feats = (last && last.features) || {};
    var demo = s.mode === 'demo';
    $('#btn-water-on').disabled = !(enabled && (feats.pump || demo));
    $('#btn-water-off').disabled = !(enabled && (feats.pump || demo));
    $('#btn-water-on-ctrl').disabled = !(enabled && (feats.pump || demo));
    $('#btn-water-off-ctrl').disabled = !(enabled && (feats.pump || demo));
    $('#btn-seed').disabled = !(enabled && feats.seed === true);
    $('#btn-plough').disabled = !(enabled && feats.plough === true);
    $('#pump-unavailable').classList.toggle('hidden', !!(feats.pump || demo));
    $('#controls-disabled-note').classList.toggle('hidden', enabled);
  }

  function renderReading(rec) {
    var s = AgrStore.settings;
    if (!rec) return;

    // --- Soil ---
    if (rec.soilMoisturePercent !== null && rec.soilMoisturePercent !== undefined) {
      $('#soil-value').textContent = rec.soilMoisturePercent;
      $('#soil-gauge-fill').style.width = rec.soilMoisturePercent + '%';
      setChip('#soil-status', statusLabelSoil(rec.soilMoisturePercent, s));
      var soilMsg = $('#soil-msg');
      if (rec.soilMoisturePercent < s.soilAlert) {
        soilMsg.textContent = 'Soil is very dry — watering may be required.';
        soilMsg.className = 'card-msg danger';
      } else if (rec.soilMoisturePercent < s.soilThreshold) {
        soilMsg.textContent = 'Soil moisture below your threshold (' + s.soilThreshold + '%). Consider watering.';
        soilMsg.className = 'card-msg';
      } else {
        soilMsg.textContent = 'Soil moisture is healthy.';
        soilMsg.className = 'card-msg ok';
      }
      soilMsg.classList.remove('hidden');
      $('#soil-source').textContent = rec.soilMoistureRaw !== null
        ? 'From raw ADC ' + rec.soilMoistureRaw + (s.autoPercent ? '' : ' → calibrated %')
        : 'Soil moisture sensor';
    } else if (rec.soilMoistureRaw !== null && rec.soilMoistureRaw !== undefined) {
      $('#soil-value').textContent = rec.soilMoistureRaw;
      $('#soil-unit').textContent = 'raw';
      $('#soil-status').textContent = 'Raw ADC — calibrate in Settings';
      $('#soil-status').className = 'chip chip-warn';
    } else {
      $('#soil-value').textContent = '--';
      $('#soil-status').textContent = 'No data';
      $('#soil-status').className = 'chip chip-neutral';
    }
    $('#soil-time').textContent = fmtTime(rec.timestamp);

    // --- Temperature ---
    $('#temp-value').textContent = rec.temperatureC !== null && rec.temperatureC !== undefined ? rec.temperatureC : '--';
    setChip('#temp-status', statusLabelTemp(rec.temperatureC));
    $('#temp-time').textContent = fmtTime(rec.timestamp);
    var tMsg = $('#temp-msg');
    if (rec.temperatureC !== null && rec.temperatureC >= s.tempHigh) {
      tMsg.textContent = 'High temperature — protect crops and the robot from heat.';
      tMsg.className = 'card-msg danger';
      tMsg.classList.remove('hidden');
    } else if (rec.temperatureC !== null && rec.temperatureC <= s.tempLow) {
      tMsg.textContent = 'Low temperature alert threshold reached.';
      tMsg.className = 'card-msg';
      tMsg.classList.remove('hidden');
    } else tMsg.classList.add('hidden');

    // --- Humidity ---
    $('#hum-value').textContent = rec.humidityPercent !== null && rec.humidityPercent !== undefined ? rec.humidityPercent : '--';
    $('#hum-gauge-fill').style.width = (rec.humidityPercent || 0) + '%';
    setChip('#hum-status', statusLabelHum(rec.humidityPercent));
    $('#hum-time').textContent = fmtTime(rec.timestamp);

    // --- Device ---
    $('#device-status').textContent = rec.mode === 'demo' ? 'Demo (simulated)' : (rec.deviceStatus === 'connected' ? 'Connected' : rec.deviceStatus);
    $('#device-last').textContent = fmtTime(rec.timestamp);
    $('#pump-status').textContent = rec.pumpStatus ? rec.pumpStatus.toUpperCase() : (AgrApi.isPumping() ? 'ON' : 'Unknown');
    if (rec.battery !== null && rec.battery !== undefined) {
      $('#kv-battery-row').classList.remove('hidden');
      $('#battery-value').textContent = rec.battery > 20 ? rec.battery + (rec.battery <= 100 ? '%' : ' V') : rec.battery + (rec.battery <= 100 ? '% — low' : ' V');
    } else {
      $('#kv-battery-row').classList.add('hidden');
    }

    // --- Irrigation assistant ---
    $('#irr-threshold').textContent = s.soilThreshold + '%';
    $('#irr-current').textContent = rec.soilMoisturePercent !== null && rec.soilMoisturePercent !== undefined ? rec.soilMoisturePercent + '%' : '—';
    var rec2 = $('#irr-recommendation');
    if (rec.soilMoisturePercent === null || rec.soilMoisturePercent === undefined) {
      rec2.textContent = 'No soil moisture value available — cannot evaluate irrigation need.';
      rec2.className = 'card-msg';
    } else if (rec.soilMoisturePercent < s.soilThreshold) {
      rec2.textContent = '⚠ Watering recommended — moisture is below your ' + s.soilThreshold + '% threshold.';
      rec2.className = 'card-msg';
    } else {
      rec2.textContent = '✓ Soil moisture is above threshold. No watering needed right now.';
      rec2.className = 'card-msg ok';
    }

    // --- Unavailable state ---
    $('#data-unavailable').classList.add('hidden');
    $('#dashboard-grid').classList.remove('hidden');
    $('#update-bar').classList.remove('hidden');
    $('#last-update-label').textContent = fmtTime(rec.timestamp) + (rec.mode === 'demo' ? ' (demo)' : '');
  }

  function showUnavailable(msg) {
    $('#data-unavailable').classList.remove('hidden');
    $('#dashboard-grid').classList.add('hidden');
    $('#update-bar').classList.add('hidden');
    if (msg) $('#data-unavailable-msg').textContent = msg;
    // still fill last-known values if any
    if (AgrStore.lastReading) {
      $('#device-status').textContent = 'Disconnected';
      $('#device-last').textContent = fmtTime(AgrStore.lastSuccessAt);
    }
    renderConnection(false, AgrStore.settings.mode);
  }

  /* ================= Alerts ================= */
  var lastAlertKey = '';

  function computeAlerts(rec) {
    var s = AgrStore.settings;
    var out = [];
    if (!rec) return out;

    if (rec.soilMoisturePercent !== null && rec.soilMoisturePercent !== undefined) {
      if (rec.soilMoisturePercent < s.soilAlert) {
        out.push({ sev: 'danger', text: 'Soil moisture critically low (' + rec.soilMoisturePercent + '%). Watering required.' });
      } else if (rec.soilMoisturePercent < s.soilThreshold) {
        out.push({ sev: 'warn', text: 'Soil moisture below threshold (' + rec.soilMoisturePercent + '% < ' + s.soilThreshold + '%).' });
      }
    }
    if (rec.temperatureC !== null && rec.temperatureC !== undefined && rec.temperatureC >= s.tempHigh) {
      out.push({ sev: 'warn', text: 'High temperature: ' + rec.temperatureC + ' °C (alert ≥ ' + s.tempHigh + ' °C).' });
    }
    if (rec.temperatureC !== null && rec.temperatureC !== undefined && rec.temperatureC <= s.tempLow) {
      out.push({ sev: 'info', text: 'Low temperature: ' + rec.temperatureC + ' °C (alert ≤ ' + s.tempLow + ' °C).' });
    }
    if (rec.humidityPercent !== null && rec.humidityPercent !== undefined && rec.humidityPercent >= s.humHigh) {
      out.push({ sev: 'warn', text: 'High humidity: ' + rec.humidityPercent + '% (alert ≥ ' + s.humHigh + '%).' });
    }
    return out;
  }

  function renderAlerts(disconnectedMsg) {
    var list = $('#alerts-list');
    var alerts = computeAlerts(AgrStore.lastReading);
    if (disconnectedMsg) alerts.unshift({ sev: 'danger', text: disconnectedMsg });

    if (!alerts.length) {
      list.innerHTML = '<li class="alerts-empty">No active alerts. Everything looks good.</li>';
      return;
    }
    list.innerHTML = alerts.map(function (a) {
      return '<li class="sev-' + a.sev + '"><span>⚠️</span><div>' + a.text +
        '<span class="alert-time">' + fmtTime(Date.now()) + '</span></div></li>';
    }).join('');
  }

  /* ================= Settings forms ================= */
  function fillSettingsForms() {
    var s = AgrStore.settings;
    $('#set-mode').value = s.mode;
    $('#set-url').value = s.baseUrl;
    $('#set-token').value = s.apiToken;
    $('#set-interval').value = s.refreshIntervalSec;
    $('#set-device-name').value = s.deviceName;
    $('#set-cal-dry').value = s.calDry;
    $('#set-cal-wet').value = s.calWet;
    $('#set-auto-percent').checked = !!s.autoPercent;
    $('#set-soil-threshold').value = s.soilThreshold;
    $('#set-soil-alert').value = s.soilAlert;
    $('#set-temp-high').value = s.tempHigh;
    $('#set-temp-low').value = s.tempLow;
    $('#set-hum-high').value = s.humHigh;
    $('#set-pump-max').value = s.pumpMaxSec;
    $('#set-theme').value = s.theme;
    $('#device-name-label').textContent = s.deviceName;
    $('#irr-threshold').textContent = s.soilThreshold + '%';
  }

  function saveConnection() {
    var mode = $('#set-mode').value;
    var url = $('#set-url').value.trim().replace(/\/+$/, '');
    var token = $('#set-token').value.trim();
    var interval = Math.max(2, Math.min(300, Number($('#set-interval').value) || 5));
    var name = $('#set-device-name').value.trim() || 'AgriRobo-01';

    if (mode === 'live') {
      if (!/^https?:\/\/.+/i.test(url)) {
        toast('Enter a full URL like http://192.168.4.1', true);
        return;
      }
    }
    AgrStore.saveSettings({ mode: mode, baseUrl: url, apiToken: token, refreshIntervalSec: interval, deviceName: name });
    $('#device-name-label').textContent = name;
    toast('Connection settings saved.');
    restartPolling();
  }

  function saveThresholds() {
    var patch = {
      soilThreshold: Math.max(0, Math.min(100, Number($('#set-soil-threshold').value) || 40)),
      soilAlert: Math.max(0, Math.min(100, Number($('#set-soil-alert').value) || 25)),
      tempHigh: Number($('#set-temp-high').value) || 38,
      tempLow: Number($('#set-temp-low').value) || 10,
      humHigh: Math.max(0, Math.min(100, Number($('#set-hum-high').value) || 85)),
      pumpMaxSec: Math.max(5, Math.min(600, Number($('#set-pump-max').value) || 30)),
      calDry: Number($('#set-cal-dry').value) || 3200,
      calWet: Number($('#set-cal-wet').value) || 1200,
      autoPercent: $('#set-auto-percent').checked
    };
    AgrStore.saveSettings(patch);
    $('#irr-threshold').textContent = patch.soilThreshold + '%';
    toast('Thresholds saved.');
    if (AgrStore.lastReading) renderReading(AgrStore.lastReading);
    renderAlerts();
  }

  function saveDisplay() {
    AgrStore.saveSettings({ theme: $('#set-theme').value });
    applyTheme();
    AgrCharts.renderAll();
    toast('Display preference saved.');
  }

  /* ================= Polling control ================= */
  function restartPolling() {
    AgrApi.stopPolling();
    if (AgrStore.settings.mode === 'demo') {
      renderConnection(true, 'demo');
      AgrApi.startPolling();
    } else {
      renderConnection(false, 'live');
      AgrApi.startPolling();
    }
  }

  /* ================= Virtual joystick ================= */
  var joyLastDir = 'stop';

  function resetKnob(label) {
    var knob = $('#joy-knob');
    var base = $('#joystick');
    if (knob) knob.style.transform = 'translate(-50%, -50%)';
    if (base) base.classList.remove('dragging');
    var out = $('#joy-readout');
    if (out && label !== undefined) out.textContent = label;
    joyLastDir = 'stop';
  }

  function initJoystick() {
    var base = $('#joystick');
    var knob = $('#joy-knob');
    var readout = $('#joy-readout');
    if (!base || !knob) return;

    var DIR_LABELS = {
      stop: '● Idle / Stopped',
      forward: '▲ Forward',
      backward: '▼ Backward',
      left: '◀ Left',
      right: '▶ Right'
    };
    var active = false;
    var currentDir = 'stop';

    function sendDir(dir) {
      if (dir === joyLastDir) return;
      joyLastDir = dir;
      readout.textContent = DIR_LABELS[dir];
      AgrApi.sendMove(dir).catch(function (err) {
        toast('Joystick command failed: ' + (err.message || 'error'), true);
      });
    }

    function handle(clientX, clientY) {
      var rect = base.getBoundingClientRect();
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      var dx = clientX - cx;
      var dy = clientY - cy;
      var maxR = rect.width / 2 - knob.offsetWidth / 2 - 4;
      var dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > maxR) { dx = dx / dist * maxR; dy = dy / dist * maxR; }
      knob.style.transform = 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px))';

      var deadzone = 14;
      if (dist < deadzone) { currentDir = 'stop'; return; }
      if (Math.abs(dy) >= Math.abs(dx)) currentDir = dy < 0 ? 'forward' : 'backward';
      else currentDir = dx < 0 ? 'left' : 'right';
      sendDir(currentDir);
    }

    function onDown(e) {
      if (base.classList.contains('disabled')) return;
      active = true;
      base.classList.add('dragging');
      if (base.setPointerCapture && e.pointerId !== undefined) {
        try { base.setPointerCapture(e.pointerId); } catch (err) {}
      }
      e.preventDefault();
      handle(e.clientX, e.clientY);
    }
    function onMove(e) {
      if (!active) return;
      e.preventDefault();
      handle(e.clientX, e.clientY);
    }
    function onUp() {
      if (!active) return;
      active = false;
      var wasMoving = joyLastDir !== 'stop';
      resetKnob(DIR_LABELS.stop);
      if (wasMoving) AgrApi.sendMove('stop').catch(function () {});
    }

    base.addEventListener('pointerdown', onDown);
    base.addEventListener('pointermove', onMove);
    base.addEventListener('pointerup', onUp);
    base.addEventListener('pointercancel', onUp);
    base.addEventListener('lostpointercapture', onUp);
    // Keyboard accessibility: arrows on focused joystick
    base.setAttribute('tabindex', '0');
    base.addEventListener('keydown', function (e) {
      if (base.classList.contains('disabled')) return;
      var map = { ArrowUp: 'forward', ArrowDown: 'backward', ArrowLeft: 'left', ArrowRight: 'right', ' ': 'stop', Enter: 'stop' };
      var dir = map[e.key];
      if (!dir) return;
      e.preventDefault();
      if (dir === 'stop') { resetKnob(DIR_LABELS.stop); AgrApi.sendMove('stop').catch(function () {}); }
      else sendDir(dir);
    });
    base.addEventListener('keyup', function () {
      if (base.classList.contains('disabled')) return;
      var wasMoving = joyLastDir !== 'stop';
      resetKnob(DIR_LABELS.stop);
      if (wasMoving) AgrApi.sendMove('stop').catch(function () {});
    });
  }

  /* ================= Pump countdown UI ================= */
  function renderPumpTimer(left) {
    var el = $('#pump-timer');
    if (left === null || left === undefined) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    $('#pump-countdown').textContent = left;
  }

  /* ================= Wire up events ================= */
  function init() {
    applyTheme();
    fillSettingsForms();
    renderAlerts();
    showScreen('home');

    // Nav
    $$('.nav-btn').forEach(function (b) {
      b.addEventListener('click', function () { showScreen(b.getAttribute('data-screen')); });
    });

    // Theme
    $('#theme-toggle').addEventListener('click', toggleTheme);

    // Refresh
    function doRefresh() {
      toast('Refreshing…');
      AgrApi.fetchOnce().catch(function (err) {
        toast('Refresh failed: ' + (err.message || 'network error'), true);
      });
    }
    $('#btn-refresh').addEventListener('click', doRefresh);
    $('#btn-refresh-state').addEventListener('click', doRefresh);
    $('#btn-open-setup').addEventListener('click', function () { showScreen('settings'); });
    $('#btn-goto-setup-ctrl').addEventListener('click', function () { showScreen('settings'); });

    // History filters
    $$('.chip-btn[data-range]').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('.chip-btn[data-range]').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        AgrCharts.setRange(b.getAttribute('data-range'));
      });
    });

    // Settings buttons
    $('#btn-save-conn').addEventListener('click', saveConnection);
    $('#btn-save-thresholds').addEventListener('click', saveThresholds);
    $('#btn-save-display').addEventListener('click', saveDisplay);
    $('#btn-test-conn').addEventListener('click', function () {
      var resEl = $('#conn-test-result');
      resEl.textContent = 'Testing…';
      // Apply form values temporarily for the test
      var mode = $('#set-mode').value;
      var url = $('#set-url').value.trim().replace(/\/+$/, '');
      AgrStore.saveSettings({ mode: mode, baseUrl: url, apiToken: $('#set-token').value.trim() });
      AgrApi.testConnection().then(function (r) {
        resEl.textContent = '✓ ' + r.message;
      }).catch(function (err) {
        resEl.textContent = '✗ Failed: ' + (err.message || 'network error') +
          '. Check Wi-Fi, URL and that the phone is on the same network.';
      });
    });
    $('#btn-clear-history').addEventListener('click', function () {
      confirmAction('Clear history?', 'This deletes all locally stored sensor readings. This cannot be undone.')
        .then(function (ok) {
          if (ok) {
            AgrStore.clearHistory();
            AgrCharts.renderAll();
            $('#history-count').textContent = '0 readings stored locally.';
            toast('History cleared.');
          }
        });
    });

    // Demo banner exit
    $('#demo-exit').addEventListener('click', function () {
      $('#set-mode').value = 'live';
      saveConnection();
    });

    // Water controls
    function water(action) {
      AgrApi.sendWater(action).then(function () {
        toast(action === 'on' ? 'Water pump ON' : 'Water pump OFF');
      }).catch(function (err) {
        toast('Pump command failed: ' + (err.message || 'error'), true);
      });
    }
    ['#btn-water-on', '#btn-water-on-ctrl'].forEach(function (id) {
      $(id).addEventListener('click', function () {
        confirmAction('Start watering?', 'The pump will run for at most ' + AgrStore.settings.pumpMaxSec +
          ' seconds, then stop automatically. You can also press Water OFF anytime.')
          .then(function (ok) { if (ok) water('on'); });
      });
    });
    ['#btn-water-off', '#btn-water-off-ctrl'].forEach(function (id) {
      $(id).addEventListener('click', function () { water('off'); });
    });

    // Movement
    initJoystick();
    $$('#dpad .dpad-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        var dir = b.getAttribute('data-dir');
        AgrApi.sendMove(dir).catch(function (err) {
          toast('Move command failed: ' + (err.message || 'error'), true);
        });
      });
    });

    // Drive speed (Slow / Normal / Fast)
    function showSpeed() {
      $$('#speed-row [data-speed]').forEach(function (b) {
        b.classList.toggle('active', Number(b.getAttribute('data-speed')) === AgrApi.getSpeed());
      });
    }
    $$('#speed-row [data-speed]').forEach(function (b) {
      b.addEventListener('click', function () {
        AgrApi.setSpeed(Number(b.getAttribute('data-speed')));
        showSpeed();
      });
    });
    showSpeed();

    // Emergency
    $('#btn-emergency').addEventListener('click', function () {
      confirmAction('EMERGENCY STOP', 'This immediately stops all robot activity including the water pump. Continue?')
        .then(function (ok) {
          if (!ok) return;
          AgrApi.sendEmergency().then(function () {
            $('#emergency-result').textContent = 'Emergency stop command sent at ' + fmtTime(Date.now()) + '.';
            toast('Emergency stop sent.');
          }).catch(function (err) {
            $('#emergency-result').textContent = 'Failed: ' + (err.message || 'error');
            toast('Emergency stop failed!', true);
          });
        });
    });

    // Seed & plough (only enabled if firmware reports support)
    $('#btn-seed').addEventListener('click', function () {
      confirmAction('Dispense seeds?', 'Run the seed dispenser now?').then(function (ok) {
        if (!ok) return;
        AgrApi.sendSeed().then(function (r) {
          $('#seed-result').textContent = r.note || 'Seed dispensing command sent.';
          toast('Seed command sent.');
        }).catch(function (err) {
          $('#seed-result').textContent = 'Failed: ' + (err.message || 'error');
        });
      });
    });
    $('#btn-plough').addEventListener('click', function () {
      confirmAction('Toggle ploughing?', 'Start or stop the ploughing mechanism?').then(function (ok) {
        if (!ok) return;
        AgrApi.sendPlough().then(function (r) {
          $('#plough-result').textContent = r.note || 'Ploughing command sent.';
          toast('Plough command sent.');
        }).catch(function (err) {
          $('#plough-result').textContent = 'Failed: ' + (err.message || 'error');
        });
      });
    });

    /* ---------- API events ---------- */
    AgrApi.on('reading', function (rec) {
      renderConnection(true, rec.mode);
      renderReading(rec);
      renderAlerts();
      $('#history-count').textContent = AgrStore.historyLength + ' readings stored locally.';
      if (rec.mode !== 'demo') { /* live mode refreshes charts less often to stay smooth */ }
      AgrCharts.renderAll();
    });

    AgrApi.on('disconnected', function (info) {
      renderConnection(false, 'live');
      showUnavailable('Could not reach the robot: ' + (info && info.error || 'network error') +
        '. Make sure your phone is on the same Wi-Fi network as the ESP32, then tap Refresh.');
      renderAlerts('Robot disconnected — cannot fetch sensor data.');
    });

    AgrApi.on('pump-timer', renderPumpTimer);

    AgrApi.on('pump', function (r) {
      if (AgrStore.lastReading) {
        $('#pump-status').textContent = r.action === 'on' ? 'ON' : 'OFF';
      }
      $('#pump-ctrl-status').textContent = 'Last pump command: ' + r.action.toUpperCase() + ' at ' + fmtTime(Date.now()) +
        (r.response && r.response.demo ? ' (simulated — demo mode)' : '') + '.';
    });

    AgrApi.on('pump-error', function (err) {
      $('#pump-ctrl-status').textContent = 'Pump command failed: ' + (err.message || 'error');
    });

    // Watchdog: if no reading for 3× interval, mark stale/disconnected (live mode only)
    setInterval(function () {
      var s = AgrStore.settings;
      if (s.mode === 'demo') return;
      var last = AgrStore.lastSuccessAt;
      if (!last) return;
      var limit = (Number(s.refreshIntervalSec) || 5) * 3000 + 5000;
      if (Date.now() - last > limit) {
        renderConnection(false, 'live');
        showUnavailable('No data received from the robot for a while. Check power and Wi-Fi.');
      }
    }, 5000);

    // System theme change
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
        if (AgrStore.settings.theme === 'system') { applyTheme(); AgrCharts.renderAll(); }
      });
    }

    // Register service worker (PWA)
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }

    // Initial state
    if (AgrStore.lastReading) {
      renderReading(AgrStore.lastReading);
      renderAlerts();
    } else {
      showUnavailable('No readings yet. Connect the robot in Settings, or switch to Demo mode to explore the app.');
    }
    $('#history-count').textContent = AgrStore.historyLength + ' readings stored locally.';
    restartPolling();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
