/**
 * GAN Smart Cube protocol decoder — vanilla JS port of the public GAN BLE
 * protocol, reproduced from the upstream MIT-licensed afedotov/gan-web-bluetooth
 * project for interoperability with GAN-branded hardware.
 *
 * Exposes window.GanProtocol: cubie-level move application (standard
 * Kociemba cubie numbering/move tables), Kociemba facelets conversion,
 * and the three GAN protocol generation drivers (Gen2/Gen3/Gen4) that turn
 * a decrypted BLE notification payload into structured cube events
 * (MOVE / FACELETS / GYRO / HARDWARE / BATTERY / DISCONNECT).
 */
(function (global) {
  'use strict';

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? Math.floor(performance.now()) : Date.now();
  }

  function sum(arr) {
    return arr.reduce(function (a, v) { return a + v; }, 0);
  }

  // -----------------------------------------------------------------------
  // Kociemba facelets conversion (corner/edge permutation+orientation -> 54
  // character facelet string). Corner/edge cubie numbering below matches
  // the standard Kociemba two-phase solver convention:
  //   corners 0-7: URF UFL ULB UBR DFR DLF DBL DRB
  //   edges   0-11: UR UF UL UB DR DF DL DB FR FL BL BR
  // -----------------------------------------------------------------------

  var CORNER_FACELET_MAP = [
    [8, 9, 20],   // URF
    [6, 18, 38],  // UFL
    [0, 36, 47],  // ULB
    [2, 45, 11],  // UBR
    [29, 26, 15], // DFR
    [27, 44, 24], // DLF
    [33, 53, 42], // DBL
    [35, 17, 51]  // DRB
  ];

  var EDGE_FACELET_MAP = [
    [5, 10],  // UR
    [7, 19],  // UF
    [3, 37],  // UL
    [1, 46],  // UB
    [32, 16], // DR
    [28, 25], // DF
    [30, 43], // DL
    [34, 52], // DB
    [23, 12], // FR
    [21, 41], // FL
    [50, 39], // BL
    [48, 14]  // BR
  ];

  function toKociembaFacelets(cp, co, ep, eo) {
    var faces = 'URFDLB';
    var facelets = [];
    for (var i = 0; i < 54; i++) {
      facelets[i] = faces[Math.floor(i / 9)];
    }
    for (var c = 0; c < 8; c++) {
      for (var p = 0; p < 3; p++) {
        facelets[CORNER_FACELET_MAP[c][(p + co[c]) % 3]] = faces[Math.floor(CORNER_FACELET_MAP[cp[c]][p] / 9)];
      }
    }
    for (var e = 0; e < 12; e++) {
      for (var q = 0; q < 2; q++) {
        facelets[EDGE_FACELET_MAP[e][(q + eo[e]) % 2]] = faces[Math.floor(EDGE_FACELET_MAP[ep[e]][q] / 9)];
      }
    }
    return facelets.join('');
  }

  // -----------------------------------------------------------------------
  // Cubie-level move tables for a single CW quarter turn, face order
  // 0..5 = U R F D L B (matches the GAN protocol's own face numbering).
  // Values reproduced from the standard Kociemba two-phase solver cubie
  // move tables (same cubie numbering as above), public domain algorithm.
  // -----------------------------------------------------------------------

  var MOVE_CP = [
    [3, 0, 1, 2, 4, 5, 6, 7], // U
    [4, 1, 2, 0, 7, 5, 6, 3], // R
    [1, 5, 2, 3, 0, 4, 6, 7], // F
    [0, 1, 2, 3, 5, 6, 7, 4], // D
    [0, 2, 6, 3, 4, 1, 5, 7], // L
    [0, 1, 3, 7, 4, 5, 2, 6]  // B
  ];
  var MOVE_CO = [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [2, 0, 0, 1, 1, 0, 0, 2],
    [1, 2, 0, 0, 2, 1, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 1, 2, 0, 0, 2, 1, 0],
    [0, 0, 1, 2, 0, 0, 2, 1]
  ];
  var MOVE_EP = [
    [3, 0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11],
    [8, 1, 2, 3, 11, 5, 6, 7, 4, 9, 10, 0],
    [0, 9, 2, 3, 4, 8, 6, 7, 1, 5, 10, 11],
    [0, 1, 2, 3, 5, 6, 7, 4, 8, 9, 10, 11],
    [0, 1, 10, 3, 4, 5, 9, 7, 8, 2, 6, 11],
    [0, 1, 2, 11, 4, 5, 6, 10, 8, 9, 3, 7]
  ];
  var MOVE_EO = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1]
  ];

  function solvedState() {
    return {
      cp: [0, 1, 2, 3, 4, 5, 6, 7],
      co: [0, 0, 0, 0, 0, 0, 0, 0],
      ep: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      eo: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    };
  }

  function cloneState(s) {
    return { cp: s.cp.slice(), co: s.co.slice(), ep: s.ep.slice(), eo: s.eo.slice() };
  }

  function applyMoveOnceInPlace(state, face) {
    var mcp = MOVE_CP[face], mco = MOVE_CO[face], mep = MOVE_EP[face], meo = MOVE_EO[face];
    var newCp = new Array(8), newCo = new Array(8), newEp = new Array(12), newEo = new Array(12);
    for (var i = 0; i < 8; i++) {
      newCp[i] = state.cp[mcp[i]];
      newCo[i] = (state.co[mcp[i]] + mco[i]) % 3;
    }
    for (var j = 0; j < 12; j++) {
      newEp[j] = state.ep[mep[j]];
      newEo[j] = (state.eo[mep[j]] + meo[j]) % 2;
    }
    state.cp = newCp; state.co = newCo; state.ep = newEp; state.eo = newEo;
  }

  /** direction: 0 = CW (one quarter turn), 1 = CCW (applied as three CW turns) */
  function applyMove(state, face, direction) {
    var times = direction === 0 ? 1 : 3;
    for (var i = 0; i < times; i++) applyMoveOnceInPlace(state, face);
  }

  // -----------------------------------------------------------------------
  // Bit-level message view
  // -----------------------------------------------------------------------

  function GanProtocolMessageView(message) {
    var bits = '';
    for (var i = 0; i < message.length; i++) {
      bits += (message[i] + 0x100).toString(2).slice(1);
    }
    this.bits = bits;
  }

  GanProtocolMessageView.prototype.getBitWord = function (startBit, bitLength, littleEndian) {
    if (bitLength <= 8) {
      return parseInt(this.bits.slice(startBit, startBit + bitLength), 2);
    } else if (bitLength === 16 || bitLength === 32) {
      var buf = new Uint8Array(bitLength / 8);
      for (var i = 0; i < buf.length; i++) {
        buf[i] = parseInt(this.bits.slice(8 * i + startBit, 8 * i + startBit + 8), 2);
      }
      var dv = new DataView(buf.buffer);
      return bitLength === 16 ? dv.getUint16(0, !!littleEndian) : dv.getUint32(0, !!littleEndian);
    }
    throw new Error('Unsupported bit word length');
  };

  // -----------------------------------------------------------------------
  // Gen2 protocol driver (GAN12 ui, GAN12 ui FreePlay, GAN Mini ui FreePlay,
  // GAN356 i Carry / Carry S / i 3, Monster Go 3Ai)
  // -----------------------------------------------------------------------

  function GanGen2ProtocolDriver() {
    this.lastSerial = -1;
    this.lastMoveTimestamp = 0;
    this.cubeTimestamp = 0;
  }

  GanGen2ProtocolDriver.prototype.createCommandMessage = function (commandType) {
    var msg = new Uint8Array(20).fill(0);
    switch (commandType) {
      case 'REQUEST_FACELETS': msg[0] = 0x04; break;
      case 'REQUEST_HARDWARE': msg[0] = 0x05; break;
      case 'REQUEST_BATTERY': msg[0] = 0x09; break;
      case 'REQUEST_RESET':
        msg.set([0x0A, 0x05, 0x39, 0x77, 0x00, 0x00, 0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
        break;
      default: return undefined;
    }
    return msg;
  };

  GanGen2ProtocolDriver.prototype.handleStateEvent = async function (conn, eventMessage) {
    var timestamp = now();
    var cubeEvents = [];
    var msg = new GanProtocolMessageView(eventMessage);
    var eventType = msg.getBitWord(0, 4);

    if (eventType === 0x01) { // GYRO
      var qw = msg.getBitWord(4, 16), qx = msg.getBitWord(20, 16), qy = msg.getBitWord(36, 16), qz = msg.getBitWord(52, 16);
      var vx = msg.getBitWord(68, 4), vy = msg.getBitWord(72, 4), vz = msg.getBitWord(76, 4);
      cubeEvents.push({
        type: 'GYRO', timestamp: timestamp,
        quaternion: {
          x: (1 - (qx >> 15) * 2) * (qx & 0x7FFF) / 0x7FFF,
          y: (1 - (qy >> 15) * 2) * (qy & 0x7FFF) / 0x7FFF,
          z: (1 - (qz >> 15) * 2) * (qz & 0x7FFF) / 0x7FFF,
          w: (1 - (qw >> 15) * 2) * (qw & 0x7FFF) / 0x7FFF
        },
        velocity: {
          x: (1 - (vx >> 3) * 2) * (vx & 0x7),
          y: (1 - (vy >> 3) * 2) * (vy & 0x7),
          z: (1 - (vz >> 3) * 2) * (vz & 0x7)
        }
      });
    } else if (eventType === 0x02) { // MOVE
      if (this.lastSerial !== -1) {
        var serial = msg.getBitWord(4, 8);
        var diff = Math.min((serial - this.lastSerial) & 0xFF, 7);
        this.lastSerial = serial;
        if (diff > 0) {
          for (var i = diff - 1; i >= 0; i--) {
            var face = msg.getBitWord(12 + 5 * i, 4);
            var direction = msg.getBitWord(16 + 5 * i, 1);
            var move = ('URFDLB'.charAt(face) + " '".charAt(direction)).trim();
            var elapsed = msg.getBitWord(47 + 16 * i, 16);
            if (elapsed === 0) elapsed = timestamp - this.lastMoveTimestamp;
            this.cubeTimestamp += elapsed;
            cubeEvents.push({
              type: 'MOVE', serial: (serial - i) & 0xFF, timestamp: timestamp,
              localTimestamp: i === 0 ? timestamp : null,
              cubeTimestamp: this.cubeTimestamp,
              face: face, direction: direction, move: move
            });
          }
          this.lastMoveTimestamp = timestamp;
        }
      }
    } else if (eventType === 0x04) { // FACELETS
      var fserial = msg.getBitWord(4, 8);
      if (this.lastSerial === -1) this.lastSerial = fserial;
      var cp = [], co = [], ep = [], eo = [];
      for (var ci = 0; ci < 7; ci++) { cp.push(msg.getBitWord(12 + ci * 3, 3)); co.push(msg.getBitWord(33 + ci * 2, 2)); }
      cp.push(28 - sum(cp)); co.push((3 - (sum(co) % 3)) % 3);
      for (var ei = 0; ei < 11; ei++) { ep.push(msg.getBitWord(47 + ei * 4, 4)); eo.push(msg.getBitWord(91 + ei, 1)); }
      ep.push(66 - sum(ep)); eo.push((2 - (sum(eo) % 2)) % 2);
      cubeEvents.push({ type: 'FACELETS', serial: fserial, timestamp: timestamp, facelets: toKociembaFacelets(cp, co, ep, eo), state: { CP: cp, CO: co, EP: ep, EO: eo } });
    } else if (eventType === 0x05) { // HARDWARE
      var hwMajor = msg.getBitWord(8, 8), hwMinor = msg.getBitWord(16, 8), swMajor = msg.getBitWord(24, 8), swMinor = msg.getBitWord(32, 8);
      var gyroSupported = msg.getBitWord(104, 1);
      var hardwareName = '';
      for (var hi = 0; hi < 8; hi++) hardwareName += String.fromCharCode(msg.getBitWord(hi * 8 + 40, 8));
      cubeEvents.push({ type: 'HARDWARE', timestamp: timestamp, hardwareName: hardwareName, hardwareVersion: hwMajor + '.' + hwMinor, softwareVersion: swMajor + '.' + swMinor, gyroSupported: !!gyroSupported });
    } else if (eventType === 0x09) { // BATTERY
      cubeEvents.push({ type: 'BATTERY', timestamp: timestamp, batteryLevel: Math.min(msg.getBitWord(8, 8), 100) });
    } else if (eventType === 0x0D) { // DISCONNECT
      conn.disconnect();
    }
    return cubeEvents;
  };

  // -----------------------------------------------------------------------
  // Shared move-buffer/history-recovery logic used by Gen3 and Gen4 drivers
  // -----------------------------------------------------------------------

  function makeMoveBufferMixin(proto, historyMsgPrefixBytes, msgSize) {
    proto.requestMoveHistory = async function (conn, serial, count) {
      var msg = new Uint8Array(msgSize).fill(0);
      if (serial % 2 === 0) serial = (serial - 1) & 0xFF;
      if (count % 2 === 1) count++;
      count = Math.min(count, serial + 1);
      msg.set(historyMsgPrefixBytes.concat([serial, 0, count, 0]));
      return conn.sendCommandMessage(msg).catch(function () {});
    };

    proto.evictMoveBuffer = async function (conn) {
      var evicted = [];
      while (this.moveBuffer.length > 0) {
        var bufferHead = this.moveBuffer[0];
        var diff = this.lastSerial === -1 ? 1 : (bufferHead.serial - this.lastSerial) & 0xFF;
        if (diff > 1) {
          if (conn) await this.requestMoveHistory(conn, bufferHead.serial, diff);
          break;
        } else {
          evicted.push(this.moveBuffer.shift());
          this.lastSerial = bufferHead.serial;
        }
      }
      if (conn && this.moveBuffer.length > 16) conn.disconnect();
      return evicted;
    };

    proto.isSerialInRange = function (start, end, serial, closedStart, closedEnd) {
      return ((end - start) & 0xFF) >= ((serial - start) & 0xFF)
        && (closedStart || ((start - serial) & 0xFF) > 0)
        && (closedEnd || ((end - serial) & 0xFF) > 0);
    };

    proto.injectMissedMoveToBuffer = function (move) {
      if (move.type !== 'MOVE') return;
      if (this.moveBuffer.length > 0) {
        var bufferHead = this.moveBuffer[0];
        if (this.moveBuffer.some(function (e) { return e.type === 'MOVE' && e.serial === move.serial; })) return;
        if (!this.isSerialInRange(this.lastSerial, bufferHead.serial, move.serial)) return;
        if (move.serial === ((bufferHead.serial - 1) & 0xFF)) this.moveBuffer.unshift(move);
      } else {
        if (this.isSerialInRange(this.lastSerial, this.serial, move.serial, false, true)) this.moveBuffer.unshift(move);
      }
    };

    proto.checkIfMoveMissed = async function (conn) {
      var diff = (this.serial - this.lastSerial) & 0xFF;
      if (diff > 0 && this.serial !== 0) {
        var bufferHead = this.moveBuffer[0];
        var startSerial = bufferHead ? bufferHead.serial : (this.serial + 1) & 0xFF;
        await this.requestMoveHistory(conn, startSerial, diff + 1);
      }
    };
  }

  // -----------------------------------------------------------------------
  // Gen3 protocol driver (GAN356 i Carry 2)
  // -----------------------------------------------------------------------

  function GanGen3ProtocolDriver() {
    this.serial = -1;
    this.lastSerial = -1;
    this.lastLocalTimestamp = null;
    this.moveBuffer = [];
  }
  makeMoveBufferMixin(GanGen3ProtocolDriver.prototype, [0x68, 0x03], 16);

  GanGen3ProtocolDriver.prototype.createCommandMessage = function (commandType) {
    var msg = new Uint8Array(16).fill(0);
    switch (commandType) {
      case 'REQUEST_FACELETS': msg.set([0x68, 0x01]); break;
      case 'REQUEST_HARDWARE': msg.set([0x68, 0x04]); break;
      case 'REQUEST_BATTERY': msg.set([0x68, 0x07]); break;
      case 'REQUEST_RESET': msg.set([0x68, 0x05, 0x05, 0x39, 0x77, 0x00, 0x00, 0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0x00, 0x00, 0x00]); break;
      default: return undefined;
    }
    return msg;
  };

  GanGen3ProtocolDriver.prototype.handleStateEvent = async function (conn, eventMessage) {
    var timestamp = now();
    var cubeEvents = [];
    var msg = new GanProtocolMessageView(eventMessage);
    var magic = msg.getBitWord(0, 8);
    var eventType = msg.getBitWord(8, 8);
    var dataLength = msg.getBitWord(16, 8);

    if (magic === 0x55 && dataLength > 0) {
      if (eventType === 0x01) { // MOVE
        if (this.lastSerial !== -1) {
          this.lastLocalTimestamp = timestamp;
          var cubeTimestamp = msg.getBitWord(24, 32, true);
          var serial = this.serial = msg.getBitWord(56, 16, true);
          var direction = msg.getBitWord(72, 2);
          var face = [2, 32, 8, 1, 16, 4].indexOf(msg.getBitWord(74, 6));
          var move = ('URFDLB'.charAt(face) + " '".charAt(direction)).trim();
          if (face >= 0) {
            this.moveBuffer.push({ type: 'MOVE', serial: serial, timestamp: timestamp, localTimestamp: timestamp, cubeTimestamp: cubeTimestamp, face: face, direction: direction, move: move });
          }
          cubeEvents = await this.evictMoveBuffer(conn);
        }
      } else if (eventType === 0x06) { // MOVE_HISTORY
        var startSerial = msg.getBitWord(24, 8);
        var count = (dataLength - 1) * 2;
        for (var i = 0; i < count; i++) {
          var hface = [1, 5, 3, 0, 4, 2].indexOf(msg.getBitWord(32 + 4 * i, 3));
          var hdirection = msg.getBitWord(35 + 4 * i, 1);
          if (hface >= 0) {
            var hmove = ('URFDLB'.charAt(hface) + " '".charAt(hdirection)).trim();
            this.injectMissedMoveToBuffer({ type: 'MOVE', serial: (startSerial - i) & 0xFF, timestamp: timestamp, localTimestamp: null, cubeTimestamp: null, face: hface, direction: hdirection, move: hmove });
          }
        }
        cubeEvents = await this.evictMoveBuffer();
      } else if (eventType === 0x02) { // FACELETS
        var fserial = this.serial = msg.getBitWord(24, 16, true);
        if (this.lastSerial !== -1) {
          if (this.lastLocalTimestamp != null && (timestamp - this.lastLocalTimestamp) > 500) await this.checkIfMoveMissed(conn);
        }
        if (this.lastSerial === -1) this.lastSerial = fserial;
        var cp = [], co = [], ep = [], eo = [];
        for (var ci = 0; ci < 7; ci++) { cp.push(msg.getBitWord(40 + ci * 3, 3)); co.push(msg.getBitWord(61 + ci * 2, 2)); }
        cp.push(28 - sum(cp)); co.push((3 - (sum(co) % 3)) % 3);
        for (var ei = 0; ei < 11; ei++) { ep.push(msg.getBitWord(77 + ei * 4, 4)); eo.push(msg.getBitWord(121 + ei, 1)); }
        ep.push(66 - sum(ep)); eo.push((2 - (sum(eo) % 2)) % 2);
        cubeEvents.push({ type: 'FACELETS', serial: fserial, timestamp: timestamp, facelets: toKociembaFacelets(cp, co, ep, eo), state: { CP: cp, CO: co, EP: ep, EO: eo } });
      } else if (eventType === 0x07) { // HARDWARE
        var swMajor = msg.getBitWord(72, 4), swMinor = msg.getBitWord(76, 4), hwMajor = msg.getBitWord(80, 4), hwMinor = msg.getBitWord(84, 4);
        var hardwareName = '';
        for (var hi = 0; hi < 5; hi++) hardwareName += String.fromCharCode(msg.getBitWord(hi * 8 + 32, 8));
        cubeEvents.push({ type: 'HARDWARE', timestamp: timestamp, hardwareName: hardwareName, hardwareVersion: hwMajor + '.' + hwMinor, softwareVersion: swMajor + '.' + swMinor, gyroSupported: false });
      } else if (eventType === 0x10) { // BATTERY
        cubeEvents.push({ type: 'BATTERY', timestamp: timestamp, batteryLevel: Math.min(msg.getBitWord(24, 8), 100) });
      } else if (eventType === 0x11) { // DISCONNECT
        conn.disconnect();
      }
    }
    return cubeEvents;
  };

  // -----------------------------------------------------------------------
  // Gen4 protocol driver (GAN12 ui Maglev, GAN14 ui FreePlay)
  // -----------------------------------------------------------------------

  function GanGen4ProtocolDriver() {
    this.serial = -1;
    this.lastSerial = -1;
    this.lastLocalTimestamp = null;
    this.moveBuffer = [];
    this.hwInfo = {};
  }
  makeMoveBufferMixin(GanGen4ProtocolDriver.prototype, [0xD1, 0x04], 20);

  GanGen4ProtocolDriver.prototype.createCommandMessage = function (commandType) {
    var msg = new Uint8Array(20).fill(0);
    switch (commandType) {
      case 'REQUEST_FACELETS': msg.set([0xDD, 0x04, 0x00, 0xED, 0x00, 0x00]); break;
      case 'REQUEST_HARDWARE': this.hwInfo = {}; msg.set([0xDF, 0x03, 0x00, 0x00, 0x00]); break;
      case 'REQUEST_BATTERY': msg.set([0xDD, 0x04, 0x00, 0xEF, 0x00, 0x00]); break;
      case 'REQUEST_RESET': msg.set([0xD2, 0x0D, 0x05, 0x39, 0x77, 0x00, 0x00, 0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0x00, 0x00, 0x00]); break;
      default: return undefined;
    }
    return msg;
  };

  GanGen4ProtocolDriver.prototype.handleStateEvent = async function (conn, eventMessage) {
    var timestamp = now();
    var cubeEvents = [];
    var msg = new GanProtocolMessageView(eventMessage);
    var eventType = msg.getBitWord(0, 8);
    var dataLength = msg.getBitWord(8, 8);

    if (eventType === 0x01) { // MOVE
      if (this.lastSerial !== -1) {
        this.lastLocalTimestamp = timestamp;
        var cubeTimestamp = msg.getBitWord(16, 32, true);
        var serial = this.serial = msg.getBitWord(48, 16, true);
        var direction = msg.getBitWord(64, 2);
        var face = [2, 32, 8, 1, 16, 4].indexOf(msg.getBitWord(66, 6));
        var move = ('URFDLB'.charAt(face) + " '".charAt(direction)).trim();
        if (face >= 0) {
          this.moveBuffer.push({ type: 'MOVE', serial: serial, timestamp: timestamp, localTimestamp: timestamp, cubeTimestamp: cubeTimestamp, face: face, direction: direction, move: move });
        }
        cubeEvents = await this.evictMoveBuffer(conn);
      }
    } else if (eventType === 0xD1) { // MOVE_HISTORY
      var startSerial = msg.getBitWord(16, 8);
      var count = (dataLength - 1) * 2;
      for (var i = 0; i < count; i++) {
        var hface = [1, 5, 3, 0, 4, 2].indexOf(msg.getBitWord(24 + 4 * i, 3));
        var hdirection = msg.getBitWord(27 + 4 * i, 1);
        if (hface >= 0) {
          var hmove = ('URFDLB'.charAt(hface) + " '".charAt(hdirection)).trim();
          this.injectMissedMoveToBuffer({ type: 'MOVE', serial: (startSerial - i) & 0xFF, timestamp: timestamp, localTimestamp: null, cubeTimestamp: null, face: hface, direction: hdirection, move: hmove });
        }
      }
      cubeEvents = await this.evictMoveBuffer();
    } else if (eventType === 0xED) { // FACELETS
      var fserial = this.serial = msg.getBitWord(16, 16, true);
      if (this.lastSerial !== -1) {
        if (this.lastLocalTimestamp != null && (timestamp - this.lastLocalTimestamp) > 500) await this.checkIfMoveMissed(conn);
      }
      if (this.lastSerial === -1) this.lastSerial = fserial;
      var cp = [], co = [], ep = [], eo = [];
      for (var ci = 0; ci < 7; ci++) { cp.push(msg.getBitWord(32 + ci * 3, 3)); co.push(msg.getBitWord(53 + ci * 2, 2)); }
      cp.push(28 - sum(cp)); co.push((3 - (sum(co) % 3)) % 3);
      for (var ei = 0; ei < 11; ei++) { ep.push(msg.getBitWord(69 + ei * 4, 4)); eo.push(msg.getBitWord(113 + ei, 1)); }
      ep.push(66 - sum(ep)); eo.push((2 - (sum(eo) % 2)) % 2);
      cubeEvents.push({ type: 'FACELETS', serial: fserial, timestamp: timestamp, facelets: toKociembaFacelets(cp, co, ep, eo), state: { CP: cp, CO: co, EP: ep, EO: eo } });
    } else if (eventType >= 0xFA && eventType <= 0xFE) { // HARDWARE
      if (eventType === 0xFA) {
        var year = msg.getBitWord(24, 16, true), month = msg.getBitWord(40, 8), day = msg.getBitWord(48, 8);
        this.hwInfo[eventType] = String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
      } else if (eventType === 0xFC) {
        this.hwInfo[eventType] = '';
        for (var hi = 0; hi < dataLength - 1; hi++) this.hwInfo[eventType] += String.fromCharCode(msg.getBitWord(hi * 8 + 24, 8));
      } else if (eventType === 0xFD) {
        this.hwInfo[eventType] = msg.getBitWord(24, 4) + '.' + msg.getBitWord(28, 4);
      } else if (eventType === 0xFE) {
        this.hwInfo[eventType] = msg.getBitWord(24, 4) + '.' + msg.getBitWord(28, 4);
      }
      if (Object.keys(this.hwInfo).length === 4) {
        cubeEvents.push({
          type: 'HARDWARE', timestamp: timestamp,
          hardwareName: this.hwInfo[0xFC], hardwareVersion: this.hwInfo[0xFE], softwareVersion: this.hwInfo[0xFD], productDate: this.hwInfo[0xFA],
          gyroSupported: ['GAN12uiM'].indexOf(this.hwInfo[0xFC]) !== -1
        });
      }
    } else if (eventType === 0xEC) { // GYRO
      var qw = msg.getBitWord(16, 16), qx = msg.getBitWord(32, 16), qy = msg.getBitWord(48, 16), qz = msg.getBitWord(64, 16);
      var vx = msg.getBitWord(80, 4), vy = msg.getBitWord(84, 4), vz = msg.getBitWord(88, 4);
      cubeEvents.push({
        type: 'GYRO', timestamp: timestamp,
        quaternion: {
          x: (1 - (qx >> 15) * 2) * (qx & 0x7FFF) / 0x7FFF,
          y: (1 - (qy >> 15) * 2) * (qy & 0x7FFF) / 0x7FFF,
          z: (1 - (qz >> 15) * 2) * (qz & 0x7FFF) / 0x7FFF,
          w: (1 - (qw >> 15) * 2) * (qw & 0x7FFF) / 0x7FFF
        },
        velocity: {
          x: (1 - (vx >> 3) * 2) * (vx & 0x7),
          y: (1 - (vy >> 3) * 2) * (vy & 0x7),
          z: (1 - (vz >> 3) * 2) * (vz & 0x7)
        }
      });
    } else if (eventType === 0xEF) { // BATTERY
      cubeEvents.push({ type: 'BATTERY', timestamp: timestamp, batteryLevel: Math.min(msg.getBitWord(8 + dataLength * 8, 8), 100) });
    } else if (eventType === 0xEA) { // DISCONNECT
      conn.disconnect();
    }
    return cubeEvents;
  };

  global.GanProtocol = {
    now: now,
    toKociembaFacelets: toKociembaFacelets,
    solvedState: solvedState,
    cloneState: cloneState,
    applyMove: applyMove,
    GanProtocolMessageView: GanProtocolMessageView,
    GanGen2ProtocolDriver: GanGen2ProtocolDriver,
    GanGen3ProtocolDriver: GanGen3ProtocolDriver,
    GanGen4ProtocolDriver: GanGen4ProtocolDriver
  };
})(window);
