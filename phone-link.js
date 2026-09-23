// The PC end of the Obsoloom Camera app (see android/).
//
// The phone serves its encoded camera on a Unix-domain socket that only
// accepts adb's shell user; adb forwards a local port to it over the USB
// cable, so the video never touches a network. The PC port is picked fresh
// by adb each time, so nothing can squat on a known one. This module sets up that forward, connects, and turns the byte
// stream back into packets.
//
// Packet layout (see StreamServer.java): type(1) flags(1) reserved(2)
// ptsUs(8, big-endian) length(4, big-endian) payload.

const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

const SOCKET = 'obsoloom-camera';
// The largest packet the phone could honestly send: a 1080p keyframe at 16
// Mbps is well under 1 MB. A bigger length means a corrupt or hostile stream.
const MAX_PACKET = 16 * 1024 * 1024;
const TYPE = { CONFIG: 1, FRAME: 2, INFO: 3 };

// adb ships with the Android SDK. Look where Android Studio puts it, then
// fall back to PATH.
function findAdb() {
  const candidates = [
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || 'adb';
}

function adb(args, cb) {
  execFile(findAdb(), args, { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
    cb(err ? new Error(String(stderr || err.message).trim()) : null, String(stdout || ''));
  });
}

// Phones attached and authorised for debugging.
function listDevices(cb) {
  adb(['devices', '-l'], (err, out) => {
    if (err) return cb(err, []);
    const devices = out
      .split(/\r?\n/)
      .slice(1)
      .map((l) => /^(\S+)\s+device\b.*?model:(\S+)/.exec(l))
      .filter(Boolean)
      .map((m) => ({ serial: m[1], model: m[2].replace(/_/g, ' ') }));
    cb(null, devices);
  });
}

// Bring the camera app to the front on the phone.
function launchApp(cb) {
  adb(['shell', 'am', 'start', '-n', 'com.obsoloom.camera/.MainActivity'], (err) => cb(err || null));
}

class PhoneLink extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
  }

  // Emits: 'info' (object), 'config' (Buffer), 'frame' ({data, ptsUs, key}),
  // 'close', 'error'.
  connect() {
    adb(['forward', 'tcp:0', `localabstract:${SOCKET}`], (err, out) => {
      if (err) return this.emit('error', err);
      const port = parseInt(out, 10);
      if (!(port > 0 && port < 65536)) return this.emit('error', new Error('adb gave no port'));
      this.port = port;

      const socket = net.connect({ host: '127.0.0.1', port });
      socket.setNoDelay(true);
      this.socket = socket;

      socket.on('data', (chunk) => this.onData(chunk));
      socket.on('error', (e) => this.emit('error', e));
      socket.on('close', () => {
        this.socket = null;
        this.emit('close');
      });
    });
  }

  onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 16) {
      const length = this.buffer.readUInt32BE(12);
      if (length > MAX_PACKET) {
        this.emit('error', new Error('bad packet length ' + length));
        return this.close();
      }
      if (this.buffer.length < 16 + length) break;

      const type = this.buffer.readUInt8(0);
      const flags = this.buffer.readUInt8(1);
      const ptsUs = Number(this.buffer.readBigInt64BE(4));
      const payload = this.buffer.subarray(16, 16 + length);
      this.buffer = this.buffer.subarray(16 + length);

      if (type === TYPE.FRAME) {
        this.emit('frame', { data: payload, ptsUs, key: (flags & 1) === 1 });
      } else if (type === TYPE.CONFIG) {
        this.emit('config', payload);
      } else if (type === TYPE.INFO) {
        try {
          this.emit('info', JSON.parse(payload.toString('utf8')));
        } catch {
          /* a malformed info packet is not worth dropping the stream for */
        }
      }
    }
  }

  // Camera controls, as one JSON object per line.
  send(control) {
    if (this.socket) this.socket.write(JSON.stringify(control) + '\n');
  }

  close() {
    if (this.socket) this.socket.destroy();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    // Leave no forward behind once the link is done with it.
    if (this.port) adb(['forward', '--remove', `tcp:${this.port}`], () => {});
    this.port = null;
  }
}

module.exports = { PhoneLink, listDevices, launchApp, findAdb };
