const video = document.getElementById('video');
const statusBox = document.getElementById('status');
const resBadge = document.getElementById('res');
const shellEl = document.getElementById('shell');
const cancelBtn = document.getElementById('cancelCount');

let mode = 'breakout';
let mirrored = true;
let edge = 'right';
let deviceId = null;
let shape = 'circle';
let quality = '1920x1080';
let picture = { brightness: 100, contrast: 100 };
let stream = null;
let recording = false;
let counting = false;

function fail(message) {
  document.body.classList.add('errored');
  statusBox.textContent = message;
}

function clearError() {
  document.body.classList.remove('errored');
  statusBox.textContent = '';
}

// This machine exposes "Integrated Camera" and "Integrated IR Camera" as two
// functions of the same USB module. They enumerate adjacently and the IR one
// can win the default pick, which returns a near-black frame in normal light.
// Always de-rank IR.
const isInfrared = (label) => /\bir\b|infra-?red/i.test(label || '');

// Virtual cameras are never an automatic choice. Windows lists the phone's
// "Connected Camera" FIRST, so asking for "the default camera" opens it --
// which wakes Microsoft's camera screen on the phone, and that takes the
// camera away from the Obsoloom Camera app. They can still be chosen by hand.
const isVirtual = (label) => /virtual camera/i.test(label || '');

// The laptop's own camera: a real one, and not the infrared sensor.
function laptopCamera(cameras) {
  return cameras.find((c) => !isInfrared(c.label) && !isVirtual(c.label)) || null;
}

function stopStream() {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
  stream = null;
}

// ---------- phone camera over USB ----------

// The Obsoloom Camera app streams H.264 down the USB cable; the main process
// relays the packets here and WebCodecs decodes them on the GPU. The decoded
// frames feed a MediaStreamTrack, so from the <video> element onwards the
// phone is handled exactly like a webcam.
const PHONE_ID = 'phone-usb';
let phone = null;
let phoneAvailable = false;

function stopPhone() {
  if (!phone) return;
  window.cam.phoneStop();
  try {
    if (phone.decoder && phone.decoder.state !== 'closed') phone.decoder.close();
  } catch {
    /* already closed */
  }
  try {
    phone.generator.stop();
  } catch {
    /* already stopped */
  }
  phone = null;
  applyVideoTransform();
}

async function startPhone() {
  stopStream();
  stopPhone();

  deviceId = PHONE_ID;
  window.cam.setDevice(deviceId);

  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  phone = {
    generator,
    writer: generator.writable.getWriter(),
    decoder: null,
    config: null,
    needKey: true,
    info: null,
    shown: false,
  };
  stream = new MediaStream([generator]);
  video.srcObject = stream;

  fail('Connecting to the phone over USB…');
  window.cam.phoneStart();
  reportToSettings(await listCameras());
  window.cam.reportModes(['1920x1080']);
}

// "avc1.PPCCLL" from the SPS: profile, constraint flags, level.
function codecFromConfig(config) {
  for (let i = 0; i + 4 < config.length; i++) {
    const startCode =
      config[i] === 0 && config[i + 1] === 0 &&
      (config[i + 2] === 1 || (config[i + 2] === 0 && config[i + 3] === 1));
    if (!startCode) continue;
    const nal = i + (config[i + 2] === 1 ? 3 : 4);
    if ((config[nal] & 0x1f) === 7) {
      const hex = (n) => n.toString(16).padStart(2, '0');
      return 'avc1.' + hex(config[nal + 1]) + hex(config[nal + 2]) + hex(config[nal + 3]);
    }
  }
  return 'avc1.640028';
}

function configurePhoneDecoder(config) {
  if (!phone) return;
  const session = phone;
  session.config = new Uint8Array(config);
  try {
    if (session.decoder && session.decoder.state !== 'closed') session.decoder.close();
  } catch {
    /* already closed */
  }

  session.decoder = new VideoDecoder({
    output: (frame) => {
      phoneStats.out++;
      if (phone !== session) return frame.close();
      if (!session.shown) {
        session.shown = true;
        clearError();
        showResolution();
        reportToSettings();
      }
      session.writer.write(frame).catch(() => frame.close());
    },
    error: () => {
      // A corrupt frame poisons everything up to the next keyframe; start
      // clean from there, and ask the phone for that keyframe now. Repeated
      // errors point at the GPU's decoder choking on this stream: hand the
      // rest of the session to the software decoder, which does not.
      phoneStats.errors++;
      if (phone !== session || !session.config) return;
      if (phoneStats.errors >= 3 && phoneDecodeHw) phoneDecodeHw = false;
      configurePhoneDecoder(session.config);
      window.cam.phoneKeyframe();
    },
  });
  // No description: the stream is Annex B, with SPS/PPS carried in-band.
  session.decoder.configure({
    codec: codecFromConfig(session.config),
    optimizeForLatency: true,
    hardwareAcceleration: phoneDecodeHw ? 'prefer-hardware' : 'prefer-software',
  });
  session.needKey = true;
}

// Which decoder the phone stream gets, and how it is doing. The counters go
// to the main process every few seconds; it keeps the bad ones.
let phoneDecodeHw = true;
const phoneStats = { in: 0, out: 0, errors: 0, skips: 0, maxQueue: 0 };
setInterval(() => {
  if (!phone) return;
  window.cam.phoneStats({ ...phoneStats, hw: phoneDecodeHw });
  phoneStats.in = phoneStats.out = phoneStats.errors = phoneStats.skips = phoneStats.maxQueue = 0;
}, 5000);

function decodePhoneFrame({ data, ptsUs, key }) {
  if (!phone || !phone.decoder || phone.decoder.state !== 'configured') return;
  phoneStats.in++;
  phoneStats.maxQueue = Math.max(phoneStats.maxQueue, phone.decoder.decodeQueueSize);
  if (phone.needKey && !key) return;

  // If decoding falls a full second behind, showing stale frames in order
  // would turn into permanent delay: skip ahead to the next keyframe. The bar
  // is high on purpose. USB delivers frames in bursts after any hiccup, the
  // decoder clears a burst in a few milliseconds, and skipping on one (the
  // old limit was 6) froze the picture for up to a second each time.
  if (!key && phone.decoder.decodeQueueSize > 30) {
    phone.needKey = true;
    phoneStats.skips++;
    window.cam.phoneKeyframe();
    return;
  }

  let bytes = new Uint8Array(data);
  if (key) {
    // The phone sends SPS/PPS once, separately; Annex-B decoding wants them
    // in front of every keyframe.
    const joined = new Uint8Array(phone.config.length + bytes.length);
    joined.set(phone.config, 0);
    joined.set(bytes, phone.config.length);
    bytes = joined;
  }
  phone.needKey = false;
  try {
    phone.decoder.decode(
      new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ptsUs, data: bytes })
    );
  } catch {
    phone.needKey = true;
    window.cam.phoneKeyframe();
  }
}

// The phone sends frames as its sensor produces them and says how far they
// need turning to be upright. Turning (and mirroring) is done here in CSS,
// which costs nothing and loses nothing.
function applyVideoTransform() {
  const rotation = phone && phone.info ? Number(phone.info.rotation) || 0 : 0;
  const s = video.style;
  if (!rotation) {
    s.position = s.width = s.height = s.left = s.top = s.transform = '';
    return;
  }
  const quarter = rotation === 90 || rotation === 270;
  // A quarter turn swaps the box: size the element to the window's height by
  // its width, so that once turned it covers the window exactly.
  s.position = 'absolute';
  s.left = '50%';
  s.top = '50%';
  s.width = (quarter ? shellEl.clientHeight : shellEl.clientWidth) + 'px';
  s.height = (quarter ? shellEl.clientWidth : shellEl.clientHeight) + 'px';
  s.transform =
    'translate(-50%, -50%) ' + (mirrored ? 'scaleX(-1) ' : '') + 'rotate(' + rotation + 'deg)';
}

async function listCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  } catch {
    return [];
  }
}

// adb sees a phone: offer it as a source.
async function refreshPhoneAvailability() {
  const before = phoneAvailable;
  try {
    phoneAvailable = await window.cam.phoneAvailable();
  } catch {
    phoneAvailable = false;
  }
  if (before !== phoneAvailable) reportToSettings(await listCameras());
}

async function startCamera(requestedId, exactSize = true, fellBack = false) {
  if (requestedId === PHONE_ID) return startPhone();
  stopPhone();
  stopStream();

  // Never open "the default camera": Windows hands back the phone's virtual
  // camera. With nothing specific asked for, find the laptop's own camera by
  // name first (names are readable without opening anything).
  if (!requestedId) {
    const laptop = laptopCamera(await listCameras());
    if (!laptop) {
      reportToSettings(await listCameras());
      return fail('No laptop camera found. Choose a camera under Settings › Source.');
    }
    requestedId = laptop.deviceId;
  }

  try {
    // Video only: the recorder takes the mic itself.
    // 'exact', not 'ideal': ideal is only a preference and Chromium hands
    // back the camera's best mode regardless, so the picker looked inert.
    const [wantW, wantH] = quality.split('x').map(Number);
    const videoConstraints = {
      width: exactSize ? { exact: wantW } : { ideal: wantW || 1920 },
      height: exactSize ? { exact: wantH } : { ideal: wantH || 1080 },
      frameRate: { ideal: 30 },
    };
    videoConstraints.deviceId = { exact: requestedId };

    stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false,
    });

    const cameras = await listCameras();
    deviceId = requestedId;
    window.cam.setDevice(deviceId);

    video.srcObject = stream;
    reportToSettings(cameras);
    reportModes();
    clearError();
  } catch (err) {
    const name = err && err.name;
    if (name === 'NotAllowedError') {
      fail('Camera blocked. Windows Settings › Privacy & security › Camera.');
    } else if (name === 'NotReadableError') {
      fail('Camera is in use by another app. Close it, then press Retry.');
    } else if (name === 'OverconstrainedError' && exactSize) {
      // The camera cannot do the requested mode exactly: let it pick nearest.
      return startCamera(requestedId, false, fellBack);
    } else if (name === 'OverconstrainedError' && !fellBack) {
      // That camera is gone: fall back to the laptop's own, once.
      deviceId = null;
      return startCamera(null, true, true);
    } else {
      fail(`Could not start the camera: ${err && err.message ? err.message : err}`);
    }
  }
}

// Reports what the camera actually delivered, which is not always what we
// asked for.
function showResolution() {
  if (phone) {
    const i = phone.info;
    const text = i && i.width ? `${i.width}x${i.height} @ ${i.fps}fps · USB` : '';
    if (resBadge) resBadge.textContent = text;
    return text;
  }
  const track = stream && stream.getVideoTracks()[0];
  if (!track) return '';
  const s = track.getSettings();
  const fps = s.frameRate ? Math.round(s.frameRate) : null;
  const text = s.width && s.height
    ? `${s.width}x${s.height}${fps ? ' @ ' + fps + 'fps' : ''}`
    : '';
  if (resBadge) resBadge.textContent = text;
  return text;
}

// getCapabilities() on a live track reports the CURRENT stream's size, not
// the camera's maximum, so the list is probed once per device and cached.
let cachedModes = null;
let cachedForDevice = null;

async function reportModes() {
  const candidates = [
    [1920, 1080],
    [1280, 720],
    [960, 540],
    [848, 480],
    [640, 480],
    [640, 360],
  ];

  // The phone app streams one fixed mode.
  if (phone) return window.cam.reportModes(['1920x1080']);

  if (cachedModes && cachedForDevice === deviceId) {
    window.cam.reportModes(cachedModes);
    return;
  }

  const track = stream && stream.getVideoTracks()[0];
  if (!track) return;

  let maxW = 1920;
  let maxH = 1080;
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const isKnown = all.some(
      (d) => d.kind === 'videoinput' && d.deviceId === deviceId
    );
    if (!isKnown) {
      const caps = track.getCapabilities ? track.getCapabilities() : null;
      if (caps && caps.width) maxW = caps.width.max;
      if (caps && caps.height) maxH = caps.height.max;
    }
  } catch {
    /* fall through to the full candidate list */
  }

  cachedModes = candidates
    .filter(([w, h]) => w <= maxW && h <= maxH)
    .map(([w, h]) => w + 'x' + h);
  cachedForDevice = deviceId;

  window.cam.reportModes(cachedModes);
}

let lastCameras = [];

function reportToSettings(cameras) {
  if (cameras) lastCameras = cameras;
  const list = lastCameras.map((c) => ({
    deviceId: c.deviceId,
    label: c.label || 'Camera',
  }));
  // The phone over USB is not a Windows camera, so it is listed by hand
  // whenever adb can see one (or it is the source already in use).
  if (phoneAvailable || phone) list.push({ deviceId: PHONE_ID, label: 'Phone USB' });
  window.cam.report({ cameras: list, deviceId, resolution: showResolution() });
}

// ---------- shape / mode / edge ----------

const SHAPES = ['circle', 'rounded', 'sharp'];

function applyShape(next) {
  shape = SHAPES.includes(next) ? next : 'circle';
  for (const s of SHAPES) document.body.classList.toggle(s, shape === s);
  // The rectangular shapes live in an opaque window. While that window
  // grows (spotlight, resize), Chromium fills the not-yet-painted area with
  // the document's background -- white unless the page says otherwise.
  document.documentElement.style.background = shape === 'circle' ? 'transparent' : '#000';
  window.cam.setShape(shape);
}

function applyMode(next, reposition) {
  mode = next;
  document.body.classList.toggle('breakout', mode === 'breakout');
  document.body.classList.toggle('side', mode === 'side');
  window.cam.setMode(mode, reposition);
}

// Which edge the docked column sits on decides which resize handle exists.
function applyEdge(next) {
  edge = next === 'left' ? 'left' : 'right';
  document.body.classList.toggle('edge-left', edge === 'left');
  document.body.classList.toggle('edge-right', edge === 'right');
}

// ---------- camera-level picture controls ----------

// Real camera controls via applyConstraints, not CSS filters: these change
// what the sensor emits, so they are present in a screen recording.
const VISUAL_KEYS = ['brightness', 'contrast', 'sharpness', 'saturation'];
let visualDefaults = null;

function probeVisual() {
  const track = stream && stream.getVideoTracks()[0];
  if (!track || !track.getCapabilities) return;

  const caps = track.getCapabilities();
  const settings = track.getSettings ? track.getSettings() : {};

  const ranges = {};
  const values = {};
  for (const k of VISUAL_KEYS) {
    if (caps[k] && typeof caps[k].min === 'number') {
      ranges[k] = { min: caps[k].min, max: caps[k].max, step: caps[k].step || 1 };
      values[k] = typeof settings[k] === 'number' ? settings[k] : caps[k].min;
    }
  }

  if (!visualDefaults) visualDefaults = { ...values };
  window.cam.reportVisualCaps({ ranges, values });
}

async function setVisual({ key, value }) {
  const track = stream && stream.getVideoTracks()[0];
  if (!track || !track.applyConstraints) return;
  try {
    await track.applyConstraints({ advanced: [{ [key]: value }] });
  } catch {
    // Some cameras reject a value mid-range; ignore rather than break the UI.
  }
}

async function resetVisual() {
  if (!visualDefaults) return;
  const track = stream && stream.getVideoTracks()[0];
  if (!track || !track.applyConstraints) return;
  try {
    await track.applyConstraints({
      advanced: VISUAL_KEYS.filter((k) => k in visualDefaults).map((k) => ({
        [k]: visualDefaults[k],
      })),
    });
  } catch {
    /* best effort */
  }
  probeVisual();
}

function applyPicture(next) {
  picture = { ...picture, ...next };
  const parts = [];
  if (picture.brightness !== 100) {
    parts.push('brightness(' + picture.brightness / 100 + ')');
  }
  if (picture.contrast !== 100) {
    parts.push('contrast(' + picture.contrast / 100 + ')');
  }
  video.style.filter = parts.join(' ');
}

function applyMirror(next) {
  mirrored = next;
  video.classList.toggle('mirrored', mirrored);
  // A turned phone picture carries its mirror inside the same transform.
  applyVideoTransform();
  window.cam.setMirror(mirrored);
}

// ---------- buttons ----------

cancelBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  window.cam.cancelCountdown();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && counting) window.cam.cancelCountdown();
});

// ---------- move / resize ----------

// The page only reports the gesture. The main process polls the real cursor
// position and sets the window bounds, so the cursor shown here and the
// behaviour that follows always agree.
let interacting = false;

shellEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('button')) return;
  const handle = e.target.closest('[data-dir]');
  interacting = true;
  if (handle) window.cam.resizeStart(handle.dataset.dir);
  else window.cam.dragStart();
  e.preventDefault();
});

function endInteraction() {
  if (!interacting) return;
  interacting = false;
  window.cam.dragEnd();
}

window.addEventListener('mouseup', endInteraction);
window.addEventListener('blur', endInteraction);

// The ring holds while the window is changing size.
let resizeHold = null;
window.addEventListener('resize', () => {
  // A quarter-turned picture is sized from the window's own dimensions.
  applyVideoTransform();
  document.body.classList.add('resizing');
  if (resizeHold) clearTimeout(resizeHold);
  resizeHold = setTimeout(() => {
    document.body.classList.remove('resizing');
  }, 500);
});

// The controls, and their opacity ramp, live in hud.html now: a window of
// their own that content protection keeps out of the recording.

// ---------- from the main process ----------

window.cam.onMode((next) => applyMode(next, false));
window.cam.onEdge((next) => applyEdge(next));
window.cam.onShape((next) => applyShape(next));
window.cam.onMirror((next) => applyMirror(next));
window.cam.onDevice((id) => startCamera(id));
window.cam.onQuality((q) => {
  quality = q;
  startCamera(deviceId);
});
window.cam.onPicture((p) => applyPicture(p));
window.cam.onRequestModes(() => reportModes());

window.cam.onSpotlight((on) => {
  document.body.classList.toggle('spotlight', !!on);
});

let countdownExpiry = null;

window.cam.onCountdown((n) => {
  const box = document.getElementById('countdown');
  const num = document.getElementById('count');
  if (!box || !num) return;
  if (countdownExpiry) clearTimeout(countdownExpiry);

  if (n === null) {
    counting = false;
    box.hidden = true;
    // The main process follows a cancelled countdown with an explicit
    // recording:false, which is what restores the ring and controls.
    return;
  }

  // From the first tick the window must already look like a recording: the
  // ring and controls are captured, so they cannot be disappearing on frame
  // one.
  counting = true;
  document.body.classList.add('recording');

  box.hidden = false;
  num.textContent = String(n);
  num.style.animation = 'none';
  void num.offsetWidth;
  num.style.animation = '';

  // A tick is only ever a second long. If the next never arrives the panel
  // has gone away; do not sit there showing a stale number.
  countdownExpiry = setTimeout(() => {
    box.hidden = true;
  }, 1600);
});

// Plug/unplug of any capture device, microphones included. The main process
// re-lists the mics for the recording panel.
navigator.mediaDevices.addEventListener('devicechange', () => {
  window.cam.devicesChanged();
  refreshPhoneAvailability();
});

// Plugging a phone in raises no camera event, so look for one now and then.
setInterval(refreshPhoneAvailability, 8000);

window.cam.onPhoneInfo((info) => {
  if (!phone) return;
  phone.info = info;
  applyVideoTransform();
  showResolution();
});
window.cam.onPhoneConfig((config) => configurePhoneDecoder(config));
window.cam.onPhoneFrame((frame) => decodePhoneFrame(frame));
window.cam.onPhoneState((state) => {
  if (!phone || state.connected) return;
  phone.needKey = true;
  phone.shown = false;
  fail('Phone not connected. Plug it in over USB and unlock it once — retrying…');
});

window.cam.onProbeVisual(() => probeVisual());
window.cam.onSetVisual((v) => setVisual(v));
window.cam.onResetVisual(() => resetVisual());

// Spotlight notifications share this channel without a recording key. They
// used to be read as recording:false, which un-hid the ring mid-take -- the
// red frame that kept appearing in captures.
window.cam.onRecordState((payload) => {
  if (payload.error) fail(payload.error);
  if (!('recording' in payload)) return;

  recording = !!payload.recording;
  if (!recording) counting = false;
  // Only the ring and badge respond here; the controls are their own window.
  document.body.classList.toggle('recording', recording);
});

(async function init() {
  // Opened as a plain file in a browser instead of through Electron, the
  // preload bridge is absent: say so rather than half-rendering.
  if (!window.cam) {
    document.body.classList.add('breakout');
    fail('Run this with "npm start" — the app window, not a browser tab.');
    return;
  }

  const prefs = await window.cam.getPrefs();
  mirrored = prefs.mirror;
  quality = prefs.quality || '1920x1080';

  applyPicture({
    brightness: prefs.brightness ?? 100,
    contrast: prefs.contrast ?? 100,
  });
  applyShape(prefs.shape);
  applyEdge(prefs.edge);
  applyMode(prefs.mode, false);
  applyMirror(mirrored);

  await refreshPhoneAvailability();
  // Always start on the laptop's own camera, whatever was used last. The
  // phone sources stay in Settings › Source for when they are wanted; opening
  // one automatically is how Microsoft's camera screen kept taking over the
  // phone.
  await startCamera(null);
})();
