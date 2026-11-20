/**
 * GAN Cube Raw BLE Logger
 *
 * Standalone, dependency-free (besides vendored aes-js) Web Bluetooth client
 * built to answer one question: do BLE notifications from a GAN smart cube
 * actually arrive in this browser, on this device, when the cube connects
 * and when faces are turned?
 *
 * It deliberately does NOT reuse gan-web-bluetooth, so it can act as an
 * independent cross-check. It only *listens* — it never writes commands to
 * the cube, to keep the surface area for bugs as small as possible.
 *
 * Protocol constants below (service/characteristic UUIDs, encryption keys,
 * MAC extraction from manufacturer data, salting scheme) are public
 * knowledge of the GAN BLE protocol, reproduced from the upstream
 * afedotov/gan-web-bluetooth project (MIT) purely for interoperability with
 * your own hardware.
 */

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
    { service: GEN2_SERVICE, command: GEN2_COMMAND_CHAR, state: GEN2_STATE_CHAR, name: 'Gen2' },
    { service: GEN3_SERVICE, command: GEN3_COMMAND_CHAR, state: GEN3_STATE_CHAR, name: 'Gen3' },
    { service: GEN4_SERVICE, command: GEN4_COMMAND_CHAR, state: GEN4_STATE_CHAR, name: 'Gen4' }
  ];

  // All known Company Identifier Codes GAN cubes may use in manufacturer data
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

  var allLines = []; // full history, independent of DOM render cap
  var RENDER_CAP = 3000;

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
    for (var i = 0; i < bytes.length; i++) {
      out.push(bytes[i].toString(16).toUpperCase().padStart(2, '0'));
    }
    return out.join(' ');
  }

  function dataViewToBytes(dv) {
    return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  }

  // ---------------------------------------------------------------------
  // Environment diagnostics (printed once on load — this is exactly the
  // kind of info normally only visible in a desktop devtools console)
  // ---------------------------------------------------------------------

  function printEnvInfo() {
    var lines = [];
    lines.push('User-Agent: ' + navigator.userAgent);
    lines.push('Platform: ' + (navigator.platform || 'n/a'));
    lines.push('Page origin: ' + location.origin + ' (protocol: ' + location.protocol + ')');
    lines.push('navigator.bluetooth available: ' + (!!navigator.bluetooth));
    lines.push('watchAdvertisements supported: ' + (typeof BluetoothDevice !== 'undefined' && !!BluetoothDevice.prototype && typeof BluetoothDevice.prototype.watchAdvertisements === 'function'));
    envInfoEl.innerHTML = lines.map(function (l) { return escapeHtml(l); }).join('<br>');

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
      }).catch(function (e) {
        log('getAvailability() failed: ' + e, 'warn');
      });
    }
  }

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  // ---------------------------------------------------------------------
  // Manufacturer data / MAC extraction (mirrors gan-web-bluetooth's logic)
  // ---------------------------------------------------------------------

  function getManufacturerDataBytes(manufacturerData) {
    if (manufacturerData instanceof DataView) {
      // Some browsers (e.g. Bluefy) hand back a raw DataView directly
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
    for (var i = 1; i <= 6; i++) {
      mac.push(dv.getUint8(dv.byteLength - i).toString(16).toUpperCase().padStart(2, '0'));
    }
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
  // AES decryption (uses vendored aes-js, same scheme as gan-web-bluetooth:
  // AES-128-CBC, key/iv salted with reversed MAC bytes, only the first and
  // last 16-byte chunk of the payload are encrypted)
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
      var tail = cipher1.decrypt(res.subarray(res.length - 16, res.length));
      res.set(tail, res.length - 16);
    }
    var cipher2 = new window.aesjs.ModeOfOperation.cbc(keyIv.key, keyIv.iv);
    var head = cipher2.decrypt(res.subarray(0, 16));
    res.set(head, 0);
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
    mac: null,
    keyIv: null,
    advAbort: null,
    notifyCount: 0
  };

  function resetUi() {
    setStatus('Disconnected', 'disconnected');
    deviceInfoEl.textContent = '';
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
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

  async function connect() {
    try {
      connectBtn.disabled = true;
      setStatus('Connecting…', 'connecting');
      log('Requesting device (filters: namePrefix GAN / MG / AiCube)…');

      var device = await navigator.bluetooth.requestDevice({
        filters: [
          { namePrefix: 'GAN' },
          { namePrefix: 'MG' },
          { namePrefix: 'AiCube' }
        ],
        optionalServices: [GEN2_SERVICE, GEN3_SERVICE, GEN4_SERVICE],
        optionalManufacturerData: CIC_LIST
      });

      state.device = device;
      log('Device selected: name="' + device.name + '" id=' + device.id, 'ok');
      deviceInfoEl.textContent = device.name + ' (' + device.id + ')';

      device.addEventListener('gattserverdisconnected', function () {
        log('gattserverdisconnected event fired (cube/phone dropped the connection)', 'warn');
        setStatus('Disconnected', 'disconnected');
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
      });

      log('Attempting automatic MAC retrieval via watchAdvertisements() (up to 10s)…');
      var mac = await tryAutoRetrieveMac(device, 10000);
      if (!mac) {
        var manual = manualMacInput.value.trim();
        if (manual) {
          mac = manual;
          log('Using manually entered MAC: ' + mac);
        } else {
          log('No MAC available — decryption will be skipped, raw notification bytes will still be logged.', 'warn');
        }
      }
      state.mac = mac;

      log('Connecting GATT…');
      var gatt = await device.gatt.connect();
      state.gatt = gatt;
      log('GATT connected.', 'ok');

      var services = await gatt.getPrimaryServices();
      log('Primary services found (' + services.length + '): ' + services.map(function (s) { return s.uuid; }).join(', '));

      var match = null;
      for (var i = 0; i < services.length; i++) {
        var uuid = services[i].uuid.toLowerCase();
        for (var j = 0; j < GEN_SERVICES.length; j++) {
          if (uuid === GEN_SERVICES[j].service) {
            match = { service: services[i], def: GEN_SERVICES[j] };
            break;
          }
        }
        if (match) break;
      }

      if (!match) {
        throw new Error('None of the known GAN service UUIDs (Gen2/Gen3/Gen4) were found among the primary services. This cube/firmware may use an unrecognized protocol variant.');
      }

      log('Matched protocol: ' + match.def.name + ' (service ' + match.def.service + ')', 'ok');

      var stateChar = await match.service.getCharacteristic(match.def.state);
      var commandChar = null;
      try {
        commandChar = await match.service.getCharacteristic(match.def.command);
      } catch (e) {
        log('Could not get command characteristic (not needed for listening): ' + e, 'warn');
      }

      state.stateChar = stateChar;
      state.commandChar = commandChar;
      state.gen = match.def.name;

      log('State characteristic properties: ' + JSON.stringify(stateChar.properties));
      if (commandChar) log('Command characteristic properties: ' + JSON.stringify(commandChar.properties));

      if (mac) {
        var salt = macToSalt(mac);
        if (salt) {
          var keyDef = (device.name && device.name.indexOf('AiCube') === 0) ? ENCRYPTION_KEYS[1] : ENCRYPTION_KEYS[0];
          state.keyIv = buildEncrypter(keyDef, salt);
          log('Encryption key/iv derived from MAC salt. Decryption ' + (decryptToggle.checked ? 'enabled' : 'disabled (checkbox off)') + '.');
        } else {
          log('MAC "' + mac + '" is not a valid 6-byte MAC address, ignoring it.', 'warn');
        }
      }

      state.notifyCount = 0;
      stateChar.addEventListener('characteristicvaluechanged', onNotification);
      await stateChar.startNotifications();
      log('startNotifications() succeeded on state characteristic. Now turn a face on the cube — every notification received will be logged below.', 'ok');

      setStatus('Connected (' + match.def.name + ')', 'connected');
      disconnectBtn.disabled = false;
    } catch (err) {
      log('ERROR during connect: ' + (err && err.message ? err.message : err), 'error');
      if (err && err.stack) log('stack: ' + err.stack, 'error');
      setStatus('Error', 'error');
      connectBtn.disabled = false;
    }
  }

  function onNotification(evt) {
    state.notifyCount++;
    var bytes = dataViewToBytes(evt.target.value);
    log('notification #' + state.notifyCount + ' (' + bytes.length + ' bytes) raw: ' + bytesToHex(bytes), 'evt');

    if (decryptToggle.checked && state.keyIv) {
      try {
        var decrypted = decryptPayload(bytes, state.keyIv);
        log('  decrypted: ' + bytesToHex(decrypted));
      } catch (e) {
        log('  decryption failed: ' + e, 'warn');
      }
    }
  }

  async function disconnect() {
    try {
      if (state.advAbort) {
        try { state.advAbort.abort(); } catch (e) {}
      }
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
      state.keyIv = null;
      resetUi();
    }
  }

  // ---------------------------------------------------------------------
  // UI wiring
  // ---------------------------------------------------------------------

  connectBtn.addEventListener('click', connect);
  disconnectBtn.addEventListener('click', disconnect);

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

  printEnvInfo();
  resetUi();
  log('Ready. Tap "Connect to cube" and select your GAN cube from the browser\'s device picker.');
})();
