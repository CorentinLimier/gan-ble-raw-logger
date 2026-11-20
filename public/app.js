/**
 * GAN Cube BLE Logger
 *
 * Standalone Web Bluetooth client built to answer two questions:
 *  1. Do BLE notifications from a GAN smart cube actually arrive in this
 *     browser, on this device, when it connects and when faces are turned?
 *  2. Once decoded (moves + facelet state + gyro), does the resulting cube
 *     state/orientation match what's physically happening to the cube?
 *
 * It deliberately does NOT reuse gan-web-bluetooth — protocol.js is an
 * independent vanilla-JS port of the public GAN BLE protocol (service/
 * characteristic UUIDs, encryption, bit-level event decoding), so this page
 * can act as a cross-check against a connectivity issue that reproduces on
 * phone but not on desktop. It never writes moves/alg data to the cube,
 * only the commands needed to read state (hardware/facelets/battery) and
 * the explicit "reset to solved" command behind the Reset Cube button.
 */

import { CubeRenderer } from './cube3d.js';

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Protocol constants
  // ---------------------------------------------------------------------

  var GEN2_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dc4179';
  var GEN2_COMMAND_CHAR = '28be4a4a-cd67-11e9-a32f-2a2ae2dbcce4';
  var GEN2_STATE_CHAR = '28be4cb6-cd67-11e9-a32f-2a2ae2dbcce4';

  var GEN3_SERVICE = '8653000a-43e6-47b7-9cb0-5fc21d4ae340';
  var GEN3_COMMAND_CHAR = '8653000c-43e6-47b7-9cb0-5fc21d4ae340';
  var GEN3_STATE_CHAR = '8653000b-43e6-47b7-9cb0-5fc21d4ae340';

  var GEN4_SERVICE = '00000010-0000-fff7-fff6-fff5fff4fff0';
  var GEN4_COMMAND_CHAR = '0000fff5-0000-1000-8000-00805f9b34fb';
  var GEN4_STATE_CHAR = '0000fff6-0000-1000-8000-00805f9b34fb';

  var GEN_SERVICES = [
    { service: GEN2_SERVICE, command: GEN2_COMMAND_CHAR, state: GEN2_STATE_CHAR, name: 'Gen2', Driver: window.GanProtocol.GanGen2ProtocolDriver },
    { service: GEN3_SERVICE, command: GEN3_COMMAND_CHAR, state: GEN3_STATE_CHAR, name: 'Gen3', Driver: window.GanProtocol.GanGen3ProtocolDriver },
    { service: GEN4_SERVICE, command: GEN4_COMMAND_CHAR, state: GEN4_STATE_CHAR, name: 'Gen4', Driver: window.GanProtocol.GanGen4ProtocolDriver }
  ];

  var CIC_LIST = [];
  for (var i = 0; i < 256; i++) CIC_LIST.push((i << 8) | 0x01);

  var ENCRYPTION_KEYS = [
    { // Gen2 / Gen3 / Gen4 default key
      key: [0x01, 0x02, 0x42, 0x28, 0x31, 0x91, 0x16, 0x07, 0x20, 0x05, 0x18, 0x54, 0x42, 0x11, 0x12, 0x53],
      iv: [0x11, 0x03, 0x32, 0x28, 0x21, 0x01, 0x76, 0x27, 0x20, 0x95, 0x78, 0x14, 0x32, 0x12, 0x02, 0x43]
    },
    { // MoYu AI 2023 key (AiCube-prefixed devices)
      key: [0x05, 0x12, 0x02, 0x45, 0x02, 0x01, 0x29, 0x56, 0x12, 0x78, 0x12, 0x76, 0x81, 0x01, 0x08, 0x03],
      iv: [0x01, 0x44, 0x28, 0x06, 0x86, 0x21, 0x22, 0x28, 0x51, 0x05, 0x08, 0x31, 0x82, 0x02, 0x21, 0x06]
    }
  ];

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------

  var $ = function (id) { return document.getElementById(id); };
  var logEl = $('log');
  var logCountEl = $('log-count');
  var statusBadge = $('status-badge');
  var deviceInfoEl = $('device-info');
  var envInfoEl = $('env-info');
  var connectBtn = $('connect-btn');
  var disconnectBtn = $('disconnect-btn');
  var copyBtn = $('copy-btn');
  var downloadBtn = $('download-btn');
  var clearBtn = $('clear-btn');
  var decryptToggle = $('decrypt-toggle');
  var autoscrollToggle = $('autoscroll-toggle');
  var manualMacInput = $('manual-mac');
  var resetGyroBtn = $('reset-gyro-btn');
  var resetCubeBtn = $('reset-cube-btn');

  var infoHardware = $('info-hardware');
  var infoHwVersion = $('info-hw-version');
  var infoSwVersion = $('info-sw-version');
  var infoProdDate = $('info-prod-date');
  var infoGyroSupported = $('info-gyro-supported');
  var infoBattery = $('info-battery');
  var infoMoveCount = $('info-move-count');
  var infoQuaternion = $('info-quaternion');

  var allLines = [];
  var RENDER_CAP = 3000;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /**
   * Many Android BLE stacks silently stall (never resolve, never reject) if
   * GATT operations are issued back-to-back with no breathing room. Wrap
   * such calls so a stall becomes a visible, labeled timeout instead of
   * dead silence.
   */
  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error('Timed out after ' + ms + 'ms waiting for: ' + label + ' (the native BLE stack likely stalled)'));
      }, ms);
      promise.then(
        function (v) { clearTimeout(timer); resolve(v); },
        function (e) { clearTimeout(timer); reject(e); }
      );
    });
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function pad3(n) { return n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n; }

  function nowStamp() {
    var d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + '.' + pad3(d.getMilliseconds());
  }

  function log(msg, level) {
    var line = '[' + nowStamp() + '] ' + msg;
    allLines.push(line);
    var span = document.createElement('div');
    if (level) span.className = 'log-line-' + level;
    span.textContent = line;
    logEl.appendChild(span);
    while (logEl.childNodes.length > RENDER_CAP) {
      logEl.removeChild(logEl.firstChild);
    }
    logCountEl.textContent = '(' + allLines.length + ' lines)';
    if (autoscrollToggle.checked) {
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  function setStatus(text, cls) {
    statusBadge.textContent = text;
    statusBadge.className = 'badge badge-' + cls;
  }

  function bytesToHex(bytes) {
    var out = [];
    for (var i = 0; i < bytes.length; i++) out.push(bytes[i].toString(16).toUpperCase().padStart(2, '0'));
    return out.join(' ');
  }

  function dataViewToBytes(dv) {
    return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  }

  /** BluetoothCharacteristicProperties fields are prototype getters, so JSON.stringify(properties) always prints "{}" — read them explicitly instead. */
  function describeCharProperties(props) {
    if (!props) return '(none)';
    var names = ['broadcast', 'read', 'writeWithoutResponse', 'write', 'notify', 'indicate', 'authenticatedSignedWrites', 'reliableWrite', 'writableAuxiliaries'];
    return names.filter(function (n) { return props[n]; }).join(', ') || '(no properties set)';
  }

  // ---------------------------------------------------------------------
  // Environment diagnostics
  // ---------------------------------------------------------------------

  function printEnvInfo() {
    var lines = [];
    lines.push('User-Agent: ' + navigator.userAgent);
    lines.push('Platform: ' + (navigator.platform || 'n/a'));
    lines.push('Page origin: ' + location.origin + ' (protocol: ' + location.protocol + ')');
    lines.push('navigator.bluetooth available: ' + (!!navigator.bluetooth));
    lines.push('watchAdvertisements supported: ' + (typeof BluetoothDevice !== 'undefined' && !!BluetoothDevice.prototype && typeof BluetoothDevice.prototype.watchAdvertisements === 'function'));
    envInfoEl.innerHTML = lines.map(escapeHtml).join('<br>');
    log('Environment: ' + lines.join(' | '));

    if (!navigator.bluetooth) {
      log('navigator.bluetooth is undefined — Web Bluetooth is not available in this browser/OS (e.g. iOS Safari/Chrome never supports it; desktop/Android Chrome needs HTTPS). This page cannot work here.', 'error');
      setStatus('Unsupported', 'error');
      connectBtn.disabled = true;
      return;
    }

    if (navigator.bluetooth.getAvailability) {
      navigator.bluetooth.getAvailability().then(function (avail) {
        log('navigator.bluetooth.getAvailability() = ' + avail + (avail ? '' : '  <-- Bluetooth adapter looks unavailable/off on this device'), avail ? undefined : 'warn');
      }).catch(function (e) { log('getAvailability() failed: ' + e, 'warn'); });
    }
  }

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  // ---------------------------------------------------------------------
  // Manufacturer data / MAC extraction
  // ---------------------------------------------------------------------

  function getManufacturerDataBytes(manufacturerData) {
    if (manufacturerData instanceof DataView) {
      return new DataView(manufacturerData.buffer.slice(2, 11));
    }
    for (var idx = 0; idx < CIC_LIST.length; idx++) {
      var id = CIC_LIST[idx];
      if (manufacturerData.has(id)) {
        var dv = manufacturerData.get(id);
        return new DataView(dv.buffer.slice(0, 9));
      }
    }
    return null;
  }

  function extractMAC(manufacturerData) {
    var dv = getManufacturerDataBytes(manufacturerData);
    if (!dv || dv.byteLength < 6) return null;
    var mac = [];
    for (var i = 1; i <= 6; i++) mac.push(dv.getUint8(dv.byteLength - i).toString(16).toUpperCase().padStart(2, '0'));
    return mac.join(':');
  }

  function logManufacturerData(manufacturerData) {
    try {
      if (manufacturerData instanceof DataView) {
        log('  advertisement manufacturerData (raw DataView): ' + bytesToHex(dataViewToBytes(manufacturerData)), 'evt');
        return;
      }
      if (manufacturerData && manufacturerData.forEach) {
        var any = false;
        manufacturerData.forEach(function (dv, cic) {
          any = true;
          log('  advertisement manufacturerData CIC=0x' + cic.toString(16) + ': ' + bytesToHex(dataViewToBytes(dv)), 'evt');
        });
        if (!any) log('  advertisement manufacturerData: (empty map)', 'evt');
      } else {
        log('  advertisement manufacturerData: (none present)', 'evt');
      }
    } catch (e) {
      log('  failed to read manufacturerData: ' + e, 'warn');
    }
  }

  // ---------------------------------------------------------------------
  // AES encryption/decryption (matches gan-web-bluetooth's scheme: AES-128
  // CBC, key/iv salted with reversed MAC bytes, only the first and last
  // 16-byte chunk of the payload are (en/de)crypted, each as an
  // independent CBC block using a fresh cipher keyed only by key/iv)
  // ---------------------------------------------------------------------

  function buildEncrypter(keyDef, salt) {
    var key = new Uint8Array(keyDef.key);
    var iv = new Uint8Array(keyDef.iv);
    for (var i = 0; i < 6; i++) {
      key[i] = (key[i] + salt[i]) % 0xFF;
      iv[i] = (iv[i] + salt[i]) % 0xFF;
    }
    return { key: key, iv: iv };
  }

  function decryptPayload(bytes, keyIv) {
    if (bytes.length < 16) throw new Error('payload shorter than 16 bytes, cannot decrypt');
    var res = new Uint8Array(bytes);
    if (res.length > 16) {
      var cipher1 = new window.aesjs.ModeOfOperation.cbc(keyIv.key, keyIv.iv);
      res.set(cipher1.decrypt(res.subarray(res.length - 16, res.length)), res.length - 16);
    }
    var cipher2 = new window.aesjs.ModeOfOperation.cbc(keyIv.key, keyIv.iv);
    res.set(cipher2.decrypt(res.subarray(0, 16)), 0);
    return res;
  }

  function encryptPayload(bytes, keyIv) {
    if (bytes.length < 16) throw new Error('payload shorter than 16 bytes, cannot encrypt');
    var res = new Uint8Array(bytes);
    var cipher1 = new window.aesjs.ModeOfOperation.cbc(keyIv.key, keyIv.iv);
    res.set(cipher1.encrypt(res.subarray(0, 16)), 0);
    if (res.length > 16) {
      var cipher2 = new window.aesjs.ModeOfOperation.cbc(keyIv.key, keyIv.iv);
      res.set(cipher2.encrypt(res.subarray(res.length - 16, res.length)), res.length - 16);
    }
    return res;
  }

  function macToSalt(mac) {
    var parts = mac.split(/[:\-\s]+/).map(function (c) { return parseInt(c, 16); });
    if (parts.length !== 6 || parts.some(isNaN)) return null;
    return new Uint8Array(parts.reverse());
  }

  // ---------------------------------------------------------------------
  // Connection state
  // ---------------------------------------------------------------------

  var state = {
    device: null,
    gatt: null,
    stateChar: null,
    commandChar: null,
    gen: null,
    driver: null,
    mac: null,
    keyIv: null,
    advAbort: null,
    notifyCount: 0,
    moveCount: 0,
    cubeState: window.GanProtocol.solvedState(),
    cubeStateSynced: false,
    intentionalDisconnect: false
  };

  function resetUi() {
    setStatus('Disconnected', 'disconnected');
    deviceInfoEl.textContent = '';
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    resetCubeBtn.disabled = true;
  }

  async function tryAutoRetrieveMac(device, timeoutMs) {
    if (typeof device.watchAdvertisements !== 'function') {
      log('device.watchAdvertisements() is not supported by this browser — cannot auto-retrieve MAC. On Android Chrome this often requires enabling "Experimental Web Platform features" in chrome://flags. Use the manual MAC field if you have it (e.g. via a BLE scanner app).', 'warn');
      return null;
    }
    return new Promise(function (resolve) {
      var abortController = new AbortController();
      state.advAbort = abortController;
      var resolved = false;
      var finish = function (mac) {
        if (resolved) return;
        resolved = true;
        try { abortController.abort(); } catch (e) {}
        resolve(mac);
      };
      device.addEventListener('advertisementreceived', function onAdv(evt) {
        log('advertisementreceived: rssi=' + evt.rssi + ' txPower=' + evt.txPower + ' name=' + evt.name, 'evt');
        logManufacturerData(evt.manufacturerData);
        var mac = extractMAC(evt.manufacturerData);
        if (mac && !resolved) {
          log('Extracted MAC from advertisement: ' + mac, 'ok');
          finish(mac);
        }
      });
      device.watchAdvertisements({ signal: abortController.signal }).catch(function (e) {
        log('watchAdvertisements() failed: ' + e, 'warn');
        finish(null);
      });
      setTimeout(function () { finish(null); }, timeoutMs || 10000);
    });
  }

  // ---------------------------------------------------------------------
  // Raw connection adapter handed to the protocol driver (used for move
  // history recovery requests and cube-initiated disconnect commands)
  // ---------------------------------------------------------------------

  var rawConn = {
    sendCommandMessage: async function (msg) {
      if (!state.commandChar || !state.keyIv) return;
      var encrypted = encryptPayload(msg, state.keyIv);
      return withTimeout(state.commandChar.writeValue(encrypted), 8000, 'commandChar.writeValue()');
    },
    disconnect: async function () {
      return disconnect();
    }
  };

  async function sendCubeCommand(type) {
    if (!state.driver) { log('Cannot send ' + type + ': not connected.', 'warn'); return; }
    if (!state.keyIv) { log('Cannot send ' + type + ': no encryption key (MAC unavailable).', 'warn'); return; }
    if (!state.commandChar) { log('Cannot send ' + type + ': command characteristic unavailable.', 'warn'); return; }
    var msg = state.driver.createCommandMessage(type);
    if (!msg) { log('Driver for ' + state.gen + ' does not support ' + type, 'warn'); return; }
    try {
      await rawConn.sendCommandMessage(msg);
      log('Sent command ' + type, 'ok');
    } catch (e) {
      log('Failed to send command ' + type + ': ' + e, 'error');
    }
  }

  // ---------------------------------------------------------------------
  // Decoded cube event handling
  // ---------------------------------------------------------------------

  function redrawCube() {
    var facelets = window.GanProtocol.toKociembaFacelets(state.cubeState.cp, state.cubeState.co, state.cubeState.ep, state.cubeState.eo);
    CubeRenderer.setFacelets(facelets);
    return facelets;
  }

  function onCubeEvent(event) {
    if (event.type === 'MOVE') {
      state.moveCount++;
      infoMoveCount.textContent = String(state.moveCount);
      if (state.cubeStateSynced) {
        window.GanProtocol.applyMove(state.cubeState, event.face, event.direction);
        var facelets = redrawCube();
        log('MOVE #' + state.moveCount + ' serial=' + event.serial + ' move=' + event.move + ' cubeTs=' + event.cubeTimestamp + ' -> ' + facelets, 'move');
      } else {
        log('MOVE move=' + event.move + ' serial=' + event.serial + ' (waiting for first FACELETS sync before applying to local state)', 'move');
      }
    } else if (event.type === 'FACELETS') {
      state.cubeState = { cp: event.state.CP.slice(), co: event.state.CO.slice(), ep: event.state.EP.slice(), eo: event.state.EO.slice() };
      state.cubeStateSynced = true;
      var facelets = redrawCube();
      log('FACELETS sync serial=' + event.serial + ': ' + facelets, 'facelets');
    } else if (event.type === 'GYRO') {
      CubeRenderer.handleGyroEvent(event.quaternion);
      infoQuaternion.textContent = 'x:' + event.quaternion.x.toFixed(2) + ' y:' + event.quaternion.y.toFixed(2) + ' z:' + event.quaternion.z.toFixed(2) + ' w:' + event.quaternion.w.toFixed(2);
    } else if (event.type === 'HARDWARE') {
      infoHardware.textContent = event.hardwareName || '-';
      infoHwVersion.textContent = event.hardwareVersion || '-';
      infoSwVersion.textContent = event.softwareVersion || '-';
      infoProdDate.textContent = event.productDate || '-';
      infoGyroSupported.textContent = event.gyroSupported ? 'yes' : 'no';
      log('HARDWARE: name=' + event.hardwareName + ' hw=' + event.hardwareVersion + ' sw=' + event.softwareVersion + ' date=' + event.productDate + ' gyro=' + event.gyroSupported, 'ok');
    } else if (event.type === 'BATTERY') {
      infoBattery.textContent = event.batteryLevel + '%';
      log('BATTERY: ' + event.batteryLevel + '%', 'ok');
    }
  }

  // ---------------------------------------------------------------------
  // Connect / disconnect
  // ---------------------------------------------------------------------

  async function connect() {
    try {
      connectBtn.disabled = true;
      setStatus('Connecting…', 'connecting');
      log('Requesting device (filters: namePrefix GAN / MG / AiCube)…');

      var device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'GAN' }, { namePrefix: 'MG' }, { namePrefix: 'AiCube' }],
        optionalServices: [GEN2_SERVICE, GEN3_SERVICE, GEN4_SERVICE],
        optionalManufacturerData: CIC_LIST
      });

      state.device = device;
      log('Device selected: name="' + device.name + '" id=' + device.id, 'ok');
      deviceInfoEl.textContent = device.name + ' (' + device.id + ')';

      device.addEventListener('gattserverdisconnected', function () {
        if (state.intentionalDisconnect) return; // our own retry/disconnect logic already handles its own state
        log('gattserverdisconnected event fired (cube/phone dropped the connection)', 'warn');
        resetUi();
      });

      var mac;
      var prefilledManualMac = manualMacInput.value.trim();
      if (prefilledManualMac) {
        mac = prefilledManualMac;
        log('Manual MAC field was pre-filled (' + mac + ') — skipping watchAdvertisements()/scanning entirely and connecting immediately. (Used to test whether the scan step itself interferes with the GATT session on some Android BLE stacks.)');
      } else {
        log('Attempting automatic MAC retrieval via watchAdvertisements() (up to 10s)…');
        mac = await tryAutoRetrieveMac(device, 10000);
      }
      if (!mac) {
        var manual = manualMacInput.value.trim();
        if (manual) {
          mac = manual;
          log('Using manually entered MAC: ' + mac);
        } else {
          log('No MAC available — decryption/decoding/3D view will be skipped, raw notification bytes will still be logged.', 'warn');
        }
      }
      state.mac = mac;

      var MAX_ATTEMPTS = 3;
      var result = null;
      var lastError = null;
      for (var attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (attempt > 1) {
          log('Attempt ' + attempt + '/' + MAX_ATTEMPTS + ': fully tearing down and re-establishing the GATT connection before retrying (a stuck native BLE operation usually needs a fresh connection, not just a retried call)…', 'warn');
          state.intentionalDisconnect = true;
          try { if (device.gatt && device.gatt.connected) device.gatt.disconnect(); } catch (e) {}
          await sleep(1500);
          state.intentionalDisconnect = false;
        }
        try {
          result = await establishGattSession(device, attempt);
          break;
        } catch (e) {
          lastError = e;
          log('Attempt ' + attempt + '/' + MAX_ATTEMPTS + ' failed: ' + (e && e.message ? e.message : e), 'error');
        }
      }
      if (!result) {
        throw lastError || new Error('Failed to establish GATT session after ' + MAX_ATTEMPTS + ' attempts.');
      }

      var match = result.match, stateChar = result.stateChar, commandChar = result.commandChar;
      state.gatt = device.gatt;
      state.stateChar = stateChar;
      state.commandChar = commandChar;
      state.gen = match.def.name;
      state.driver = new match.def.Driver();
      state.moveCount = 0;
      state.cubeState = window.GanProtocol.solvedState();
      state.cubeStateSynced = false;
      infoMoveCount.textContent = '0';
      CubeRenderer.setFacelets(null);

      if (mac) {
        var salt = macToSalt(mac);
        if (salt) {
          var keyDef = (device.name && device.name.indexOf('AiCube') === 0) ? ENCRYPTION_KEYS[1] : ENCRYPTION_KEYS[0];
          state.keyIv = buildEncrypter(keyDef, salt);
          log('Encryption key/iv derived from MAC salt. Decoding ' + (decryptToggle.checked ? 'enabled' : 'disabled (checkbox off)') + '.');
          resetCubeBtn.disabled = false;
        } else {
          log('MAC "' + mac + '" is not a valid 6-byte MAC address, ignoring it.', 'warn');
        }
      }

      setStatus('Connected (' + match.def.name + ')', 'connected');
      disconnectBtn.disabled = false;

      if (state.keyIv && commandChar) {
        await sleep(300);
        await sendCubeCommand('REQUEST_HARDWARE');
        await sleep(300);
        await sendCubeCommand('REQUEST_FACELETS');
        await sleep(300);
        await sendCubeCommand('REQUEST_BATTERY');
      }
    } catch (err) {
      log('ERROR during connect: ' + (err && err.message ? err.message : err), 'error');
      if (err && err.stack) log('stack: ' + err.stack, 'error');
      setStatus('Error', 'error');
      connectBtn.disabled = false;
    }
  }

  /**
   * One full attempt at: GATT connect -> discover service/characteristics ->
   * enable notifications. Pulled out of connect() so a stalled native BLE
   * operation can be retried from a clean, fully reconnected GATT session
   * rather than just re-issuing the same stuck call on the same connection.
   */
  async function establishGattSession(device, attemptLabel) {
    log('[attempt ' + attemptLabel + '] Connecting GATT…');
    var gatt = await withTimeout(device.gatt.connect(), 15000, 'device.gatt.connect()');
    log('[attempt ' + attemptLabel + '] GATT connected.', 'ok');
    await sleep(500); // give the native BLE stack a moment before the next GATT op (Android stability)

    var services = await withTimeout(gatt.getPrimaryServices(), 15000, 'gatt.getPrimaryServices()');
    log('[attempt ' + attemptLabel + '] Primary services found (' + services.length + '): ' + services.map(function (s) { return s.uuid; }).join(', '));
    await sleep(500);

    var match = null;
    for (var i = 0; i < services.length; i++) {
      var uuid = services[i].uuid.toLowerCase();
      for (var j = 0; j < GEN_SERVICES.length; j++) {
        if (uuid === GEN_SERVICES[j].service) { match = { service: services[i], def: GEN_SERVICES[j] }; break; }
      }
      if (match) break;
    }
    if (!match) throw new Error('None of the known GAN service UUIDs (Gen2/Gen3/Gen4) were found among the primary services. This cube/firmware may use an unrecognized protocol variant.');

    log('[attempt ' + attemptLabel + '] Matched protocol: ' + match.def.name + ' (service ' + match.def.service + ')', 'ok');

    var stateChar = await withTimeout(match.service.getCharacteristic(match.def.state), 15000, 'getCharacteristic(state)');
    await sleep(500);
    var commandChar = null;
    try { commandChar = await withTimeout(match.service.getCharacteristic(match.def.command), 15000, 'getCharacteristic(command)'); }
    catch (e) { log('Could not get command characteristic (move-history recovery / commands will be unavailable): ' + e, 'warn'); }
    await sleep(500);

    log('State characteristic properties: ' + describeCharProperties(stateChar.properties));
    if (commandChar) log('Command characteristic properties: ' + describeCharProperties(commandChar.properties));

    state.notifyCount = 0;
    stateChar.addEventListener('characteristicvaluechanged', onNotification);
    log('[attempt ' + attemptLabel + '] Enabling notifications on state characteristic…');
    try {
      await withTimeout(stateChar.startNotifications(), 8000, 'stateChar.startNotifications()');
    } catch (e) {
      stateChar.removeEventListener('characteristicvaluechanged', onNotification);
      throw e;
    }
    log('[attempt ' + attemptLabel + '] startNotifications() succeeded on state characteristic. Now turn a face on the cube — every notification received will be logged below.', 'ok');

    return { match: match, stateChar: stateChar, commandChar: commandChar };
  }

  async function onNotification(evt) {
    state.notifyCount++;
    var bytes = dataViewToBytes(evt.target.value);
    log('notification #' + state.notifyCount + ' (' + bytes.length + ' bytes) raw: ' + bytesToHex(bytes), 'evt');

    if (!decryptToggle.checked || !state.keyIv) return;

    var decrypted;
    try {
      decrypted = decryptPayload(bytes, state.keyIv);
      log('  decrypted: ' + bytesToHex(decrypted));
    } catch (e) {
      log('  decryption failed: ' + e, 'warn');
      return;
    }

    try {
      var events = await state.driver.handleStateEvent(rawConn, decrypted);
      events.forEach(onCubeEvent);
    } catch (e) {
      log('  protocol decode failed: ' + (e && e.message ? e.message : e), 'warn');
    }
  }

  async function disconnect() {
    try {
      state.intentionalDisconnect = true;
      if (state.advAbort) { try { state.advAbort.abort(); } catch (e) {} }
      if (state.stateChar) {
        try { await state.stateChar.stopNotifications(); } catch (e) {}
        state.stateChar.removeEventListener('characteristicvaluechanged', onNotification);
      }
      if (state.gatt && state.gatt.connected) {
        state.gatt.disconnect();
        log('Disconnected GATT.', 'ok');
      }
    } catch (e) {
      log('Error during disconnect: ' + e, 'warn');
    } finally {
      state.device = null;
      state.gatt = null;
      state.stateChar = null;
      state.commandChar = null;
      state.driver = null;
      state.keyIv = null;
      state.intentionalDisconnect = false;
      resetUi();
    }
  }

  // ---------------------------------------------------------------------
  // UI wiring
  // ---------------------------------------------------------------------

  connectBtn.addEventListener('click', connect);
  disconnectBtn.addEventListener('click', disconnect);

  resetGyroBtn.addEventListener('click', function () {
    CubeRenderer.resetGyro();
    log('Gyro orientation reference reset (client-side only, no command sent to cube).', 'ok');
  });

  resetCubeBtn.addEventListener('click', async function () {
    await sendCubeCommand('REQUEST_RESET');
    state.cubeState = window.GanProtocol.solvedState();
    state.cubeStateSynced = true;
    redrawCube();
    log('Local display reset to solved. Cube hardware was told to treat its CURRENT physical position as solved — only press this when the cube is actually solved in your hands.', 'ok');
  });

  clearBtn.addEventListener('click', function () {
    allLines = [];
    logEl.innerHTML = '';
    logCountEl.textContent = '';
  });

  copyBtn.addEventListener('click', async function () {
    var text = allLines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      log('Log copied to clipboard (' + allLines.length + ' lines).', 'ok');
    } catch (e) {
      log('Clipboard copy failed (' + e + '). Try the Download button instead.', 'warn');
    }
  });

  downloadBtn.addEventListener('click', function () {
    var text = allLines.join('\n');
    var blob = new Blob([text], { type: 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'gan-cube-ble-log-' + Date.now() + '.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  CubeRenderer.init($('cube3d-container'));
  printEnvInfo();
  resetUi();
  log('Ready. Tap "Connect to cube" and select your GAN cube from the browser\'s device picker.');
})();
