const { app, BrowserWindow, ipcMain, screen, shell, dialog, globalShortcut, Menu } = require('electron');

const recorder = require('./recorder');
const native = require('./native');
const phone = require('./phone-link');
const path = require('node:path');
const fs = require('node:fs');

const STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');

// Breakout: a true circle floating over the page being torn down.
const BREAKOUT_SIZES = { small: 200, mid: 320, big: 460 };
const BREAKOUT_SIZE = BREAKOUT_SIZES.mid;
// Side: a free-form rectangle you resize at will; this is only the first run.
const SIDE_DEFAULT = { width: 460, height: 720 };

let win = null;
let settingsWin = null;
// Set once the panel is dragged: after that it stays where it was put.
let settingsMoved = false;
let recWin = null;
let visualWin = null;
let frameWin = null;
let hudWin = null;
// Set while the countdown owns the screen: the controls window is hidden so
// it cannot intercept clicks meant for Cancel.
let hudSuppressed = false;
// Caches of what the camera window last reported. Declared here so the
// settings handlers cannot read them before initialisation.
let lastModes = null;
let lastCameraReport = null;

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(patch) {
  const next = { ...readState(), ...patch };
  try {
    fs.writeFileSync(STATE_FILE(), JSON.stringify(next, null, 2));
  } catch {
    // Persisting preferences is a convenience; never let it break the app.
  }
}

// Keep saved bounds usable if the monitor layout changed since last launch.
function visibleBounds(bounds) {
  if (!bounds) return null;
  const onScreen = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return (
      bounds.x < a.x + a.width &&
      bounds.x + bounds.width > a.x &&
      bounds.y < a.y + a.height &&
      bounds.y + bounds.height > a.y
    );
  });
  return onScreen ? bounds : null;
}

// Breakout is a square the user resizes freely; side is a docked column.
// Both are enforced by this process during the gesture itself (see the
// interaction section), so no native size or aspect locks are involved.
function applyMode(mode, { reposition = false } = {}) {
  if (!win || win.isDestroyed()) return;

  if (mode === 'breakout') {
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    const current = win.getBounds();
    const saved = readState();
    const wasBreakout = saved.mode === 'breakout';
    const circle = !saved.shape || saved.shape === 'circle';

    // Coming from side mode, fall back to the saved preset; already in
    // breakout, keep the exact current size so repeat calls change nothing.
    // Only the circle is forced square: a rectangle may have been snapped
    // into a layout cell and should stay that way.
    const preset = BREAKOUT_SIZES[saved.size] || BREAKOUT_SIZE;
    const size = wasBreakout ? Math.max(current.width, current.height) : preset;

    let bounds;
    if (reposition) {
      bounds = {
        width: size,
        height: size,
        x: area.x + area.width - size - 40,
        y: area.y + area.height - size - 40,
      };
    } else if (wasBreakout && !circle) {
      // Already breaking out as a rectangle: leave it alone, it may have
      // been snapped into a layout cell deliberately.
      bounds = current;
    } else {
      // Coming out of side mode it must stop looking like a column, whatever
      // the shape: square it up and bring it back inside the work area.
      const x = Math.max(area.x, Math.min(current.x, area.x + area.width - size));
      const y = Math.max(area.y, Math.min(current.y, area.y + area.height - size));
      bounds = { x, y, width: size, height: size };
    }
    // Lift side mode's full-height minimum BEFORE setting the new bounds:
    // leaving it in place pins the height to the work area, and the window
    // comes out of side mode still shaped like a column.
    win.setMinimumSize(160, 160);
    win.setMaximumSize(0, 0);
    // The mode must be saved before applyNativeLocks reads it, for the
    // same reason.
    writeState({ mode });
    win.setBounds(bounds);
    writeState({ bounds: win.getBounds() });
    applyNativeLocks();
    return;
  }

  // Side: full height of the recording display, pinned to an edge.
  const s = readState();
  const area = cameraDisplay().workArea;
  const frac = s.bounds ? s.bounds.width / area.width : 0.2;
  snapSide(frac >= 0.1 && frac <= 0.6 ? frac : 0.2, s.edge === 'left' ? 'left' : 'right');
}

function applyBreakoutSize(name) {
  if (!win || win.isDestroyed()) return;
  const size = BREAKOUT_SIZES[name] || BREAKOUT_SIZES.mid;
  const b = win.getBounds();
  const area = screen.getDisplayMatching(b).workArea;

  // Grow from the centre so the bubble does not crawl across the screen.
  let x = Math.round(b.x + (b.width - size) / 2);
  let y = Math.round(b.y + (b.height - size) / 2);
  x = Math.max(area.x, Math.min(x, area.x + area.width - size));
  y = Math.max(area.y, Math.min(y, area.y + area.height - size));

  win.setBounds({ x, y, width: size, height: size });
  writeState({ size: name, bounds: win.getBounds() });
}

function createWindow() {
  const state = readState();
  const mode = state.mode === 'side' ? 'side' : 'breakout';
  const saved = visibleBounds(state.bounds);
  const area = screen.getPrimaryDisplay().workArea;

  const fallback =
    mode === 'breakout'
      ? { width: BREAKOUT_SIZE, height: BREAKOUT_SIZE }
      : SIDE_DEFAULT;

  const size = saved
    ? { width: saved.width, height: saved.height }
    : fallback;
  // A circle is a square window, whatever got saved: anything else is drawn
  // as an oval.
  if (mode === 'breakout' && (!state.shape || state.shape === 'circle')) {
    size.width = size.height = Math.min(size.width, size.height);
  }

  const position = saved
    ? { x: saved.x, y: saved.y }
    : {
        x: area.x + area.width - size.width - 40,
        y: area.y + area.height - size.height - 40,
      };

  // A circle needs a transparent window, and Windows will not snap those.
  // The rectangular shapes are opaque instead, so they get real window
  // drags: Snap Layouts at the top edge, half-screen snaps at the sides.
  const shape = ['circle', 'rounded', 'sharp'].includes(state.shape) ? state.shape : 'circle';
  const transparent = shape === 'circle';

  win = new BrowserWindow({
    ...size,
    ...position,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    frame: false,
    transparent,
    backgroundColor: transparent ? '#00000000' : '#000000',
    roundedCorners: shape === 'rounded',
    alwaysOnTop: true,
    // Resizable keeps WS_THICKFRAME, which snapping requires. The edge
    // handles in the page do the actual resizing (see the interaction
    // section); the native border is locked to the same rules below.
    resizable: true,
    minWidth: 160,
    minHeight: 160,
    // No shadow: a transparent window's shadow draws a visible box in captures.
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.__transparent = transparent;

  // "screen-saver" keeps it above full-screen browser windows too.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenu(null);
  applyNativeLocks();

  win.loadFile('index.html');

  // The settings panel and the controls ride along during a drag.
  win.on('move', () => {
    repositionSettings();
    moveHud();
  });
  win.on('resize', () => moveHud());
  // Every path that brings the camera forward would otherwise bury them.
  win.on('focus', () => raiseHud());
  win.on('show', () => raiseHud());

  // The controls are their own window, so they do not follow the camera
  // into the taskbar by themselves: without this they hang about on screen
  // after the camera is minimized.
  win.on('minimize', () => syncSatellites());
  win.on('hide', () => syncSatellites());
  win.on('restore', () => syncSatellites());
  win.on('always-on-top-changed', () => raiseHud());

  // The camera page's warnings and errors, on this process's stderr: a
  // frameless window has no console to open when something goes wrong.
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.error(`[camera] ${message} (${path.basename(source || '')}:${line})`);
  });

  // A right-click menu on the camera itself: the way out if the controls are
  // ever not where they should be.
  win.webContents.on('context-menu', () => showCameraMenu());

  win.webContents.on('did-finish-load', () => {
    const s = readState();
    win.webContents.send('camera:edge', s.edge === 'left' ? 'left' : 'right');
    showHud();
    watchHudProximity();
  });

  // Debounced: a drag fires this at 60Hz and the state file does not need
  // rewriting on every tick.
  let persistTimer = null;
  const persist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      // endInteraction persists a gesture's own bounds; leaving this to fire
      // as well would write back the size getBounds jitters to on a scaled
      // display, which is what grew the circle into an oval.
      // Spotlight borrows the 16:9 capture frame; saving that as the
      // window's own size would bring the circle back as an oval.
      if (!interaction && !spotlightPrev) writeState({ bounds: win.getBounds() });
      repositionSettings();
    }, 150);
  };
  win.on('moved', persist);
  win.on('resized', () => {
    persist();
    adoptWindowsSnap();
  });

  win.on('closed', () => {
    win = null;
    closeSettings();
    closeRecorder();
    closeVisual();
    hideFrame();
    hideHud();
  });
}

// Transparency is fixed at creation, so switching between the circle and a
// rectangle rebuilds the window in place. The camera restarts in about a
// second; the panels stay where they are.
function recreateWindow() {
  if (!win || win.isDestroyed()) return createWindow();
  endInteraction();
  const old = win;
  writeState({ bounds: old.getBounds() });
  old.removeAllListeners('closed');
  win = null;
  old.close();
  createWindow();
  applyMode(readState().mode === 'side' ? 'side' : 'breakout');
  repositionSettings();
}

// What the native frame may do, per mode and shape: a circle stays square,
// a rectangle resizes freely, a docked column keeps the work area's height.
function applyNativeLocks() {
  if (!win || win.isDestroyed()) return;
  const s = readState();
  if (s.mode === 'side') {
    // A docked column runs edge to edge: Windows 11 would otherwise round
    // its corners, leaving gaps against the screen edge.
    native.setCorners(win, false);
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    win.setAspectRatio(0);
    win.setMinimumSize(160, area.height);
    win.setMaximumSize(area.width, area.height);
    return;
  }
  native.setCorners(win, s.shape === 'rounded');
  win.setMinimumSize(160, 160);
  win.setMaximumSize(0, 0);
  // No native aspect lock, ever. It constrains the outer frame, and on a
  // resizable window Windows re-applies it to every setPosition during a
  // polled drag -- each tick rounds the size up a little and the circle
  // slowly swells into an oval. stepInteraction keeps it square instead.
  win.setAspectRatio(0);
}

// ms-settings:camera lands on the camera *list*. The per-device page --
// the one with the Studio Effects toggles -- needs the camera symbolic
// link, which Windows derives from the device instance ID: backslashes
// become #, wrapped in \\?\ and the video-camera interface GUID.
const KSCATEGORY_VIDEO_CAMERA = '{e5323777-f976-4f5b-9b55-b94699c46e44}';

function cameraSettingsUri(instanceId) {
  if (!instanceId) return 'ms-settings:camera';
  const BS = String.fromCharCode(92);
  const symlink =
    BS + BS + '?' + BS +
    instanceId.split(BS).join('#') +
    '#' + KSCATEGORY_VIDEO_CAMERA;
  // Unencoded: encodeURIComponent turns the backslashes and braces into
  // escapes that some Settings builds fail to parse, landing on the camera
  // list instead of the device page.
  return 'ms-settings:camera?cameraId=' + symlink;
}

// Ask Windows for the instance ID of the camera currently in use, so the
// deep link follows whichever device the app actually selected.
function openStudioEffects() {
  // The Control Center flyout hosts the Studio Effects toggles directly.
  // Windows exposes no API to set them, so a one-click deep link is the
  // closest thing to embedding them.
  shell
    .openExternal('ms-controlcenter:studioeffects')
    .catch(() => openCameraSettings());
}

function openCameraSettings() {
  const { execFile } = require('node:child_process');
  const ps = [
    '-NoProfile',
    '-Command',
    "(Get-PnpDevice -Class Camera | Where-Object { $_.Status -eq 'OK' -and $_.FriendlyName -notmatch 'IR' } | Select-Object -First 1).InstanceId",
  ];
  execFile(POWERSHELL, ps, { timeout: 4000 }, (err, stdout) => {
    const id = !err && stdout ? stdout.trim() : null;
    shell.openExternal(cameraSettingsUri(id)).catch(() => {});
  });
}
const SETTINGS_SIZE = { width: 278, height: 536 };

function settingsPosition() {
  const camBounds = win.getBounds();
  const area = screen.getDisplayMatching(camBounds).workArea;
  const gap = 12;

  let x = camBounds.x + camBounds.width + gap;
  // Not enough room on the right? Put it on the left instead.
  if (x + SETTINGS_SIZE.width > area.x + area.width) {
    x = camBounds.x - SETTINGS_SIZE.width - gap;
  }
  // Still off-screen (tiny display)? Clamp inside the work area.
  x = Math.max(area.x, Math.min(x, area.x + area.width - SETTINGS_SIZE.width));

  let y = camBounds.y;
  y = Math.max(area.y, Math.min(y, area.y + area.height - SETTINGS_SIZE.height));

  return { x: Math.round(x), y: Math.round(y) };
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.setBounds({ ...SETTINGS_SIZE, ...settingsPosition() });
    settingsWin.show();
    settingsWin.focus();
    return;
  }

  settingsWin = new BrowserWindow({
    ...SETTINGS_SIZE,
    ...settingsPosition(),
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#17181c',
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWin.setAlwaysOnTop(true, 'screen-saver');
  settingsWin.setMenu(null);
  // WDA_EXCLUDEFROMCAPTURE: on screen, never in a recording.
  settingsWin.setContentProtection(true);
  settingsWin.loadFile('settings.html');

  settingsWin.on('moved', () => {
    settingsMoved = true;
  });

  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

function closeSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  settingsWin = null;
  settingsMoved = false;
}

function pushState() {
  if (!settingsWin || settingsWin.isDestroyed()) return;
  const s = readState();
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  settingsWin.webContents.send('settings:state', {
    mode: s.mode === 'side' ? 'side' : 'breakout',
    shape: ['circle', 'rounded', 'sharp'].includes(s.shape) ? s.shape : 'circle',
    quality: s.quality || '1920x1080',
    brightness: typeof s.brightness === 'number' ? s.brightness : 100,
    contrast: typeof s.contrast === 'number' ? s.contrast : 100,
    size: ['small', 'mid', 'big'].includes(s.size) ? s.size : 'mid',
    width: s.bounds ? s.bounds.width / area.width : 0.2,
    mirror: s.mirror ?? true,
    deviceId: s.deviceId ?? null,
    edge: s.edge === 'left' ? 'left' : 'right',
    preset: ['landscape', 'portrait', 'square'].includes(s.preset)
      ? s.preset
      : 'landscape',
    folder: s.folder || null,
    audioDevice: s.audioDevice || null,
    recording: recorder.isRecording(),
    quality: s.quality || '1920x1080',
    brightness: typeof s.brightness === 'number' ? s.brightness : 100,
    contrast: typeof s.contrast === 'number' ? s.contrast : 100,
  });
}

// Keep the panel glued to the camera window as it moves.
function repositionSettings() {
  if (!settingsWin || settingsWin.isDestroyed()) return;
  // Once moved by hand, the panel is where the user wants it.
  if (settingsMoved) return;
  settingsWin.setBounds({ ...SETTINGS_SIZE, ...settingsPosition() });
}

// Where recordings land. Asked once, then remembered.
function recordingFolder() {
  const saved = readState().folder;
  if (saved && fs.existsSync(saved)) return saved;
  return null;
}

async function chooseFolder(parent) {
  const opts = {
    title: 'Where should Obsoloom save recordings?',
    defaultPath: app.getPath('videos'),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Save here',
  };

  // Parenting makes it modal and keeps it in front of the always-on-top
  // recorder; without a parent it opens behind.
  const result = parent && !parent.isDestroyed()
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts);
  if (result.canceled || !result.filePaths[0]) return null;
  writeState({ folder: result.filePaths[0] });
  return result.filePaths[0];
}

function notifyRecording(payload) {
  for (const target of [win, settingsWin]) {
    if (target && !target.isDestroyed()) {
      target.webContents.send('record:state', payload);
    }
  }
}

const REC_SIZE = { width: 320, height: 572 };
const LIVE_SIZE = { width: 320, height: 268 };

function recPosition() {
  // Bottom-right of the display being recorded: the same corner it parks in
  // once capture starts, so it never jumps mid-take.
  const area = targetDisplay().workArea;
  return {
    x: Math.round(area.x + area.width - REC_SIZE.width - 16),
    y: Math.round(area.y + area.height - REC_SIZE.height - 16),
  };
}

function openRecorder() {
  // One panel at a time: the recording panel takes the settings' place.
  closeSettings();
  closeVisual();
  if (recWin && !recWin.isDestroyed()) {
    recWin.show();
    recWin.focus();
    return;
  }

  // Recording starts on the screen the camera is on. Picking another screen
  // in the panel then moves everything there.
  if (win && !win.isDestroyed()) writeState({ displayId: cameraDisplay().id });

  recWin = new BrowserWindow({
    ...REC_SIZE,
    ...recPosition(),
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#17181c',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'record-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  recWin.setAlwaysOnTop(true, 'screen-saver');
  recWin.setMenu(null);
  // WDA_EXCLUDEFROMCAPTURE: on screen, never in a recording.
  recWin.setContentProtection(true);
  recWin.loadFile('record.html');
  recWin.on('moved', () => {
    if (!parking) recWinMoved = true;
  });

  recWin.on('closed', () => {
    recWin = null;
    recWinMoved = false;
  });
}

function clearCountdown() {
  // Whatever ended the countdown, the controls come back.
  setHudVisible(true);
  if (!win || win.isDestroyed()) return;
  win.webContents.send('camera:countdown', null);
  // The countdown hides the ring and controls from its first tick. If it
  // never became a recording, put them back.
  if (!recorder.isRecording()) {
    win.webContents.send('record:state', { recording: false });
  }
}

function closeRecorder() {
  // Whatever closed the panel, the countdown must not outlive it.
  clearCountdown();
  hideFrame();
  if (recWin && !recWin.isDestroyed()) recWin.close();
  recWin = null;
}

// "No audio" is a poor default when a mic is plugged in: pick a real
// device the first time, preferring anything that is not the built-in array.
function preferredAudioDevice(devices) {
  const saved = readState().audioDevice;
  if (saved && devices.includes(saved)) return saved;
  if (!devices.length) return null;

  // A headset or external mic beats the laptop's array for a walkthrough.
  const external = devices.find((d) => !/Microphone Array|Internal/i.test(d));
  return external || devices[0];
}

// With three displays attached the app cannot guess which one to record.
// Model names from the monitor EDID, cached once at startup. Electron has
// no API for these, and "Screen 2" is useless when you own a ThinkVision and
// a Samsung.
let monitorNames = null;

function loadMonitorNames() {
  return new Promise((resolve) => {
    const { execFile } = require('node:child_process');
    const script = path.join(__dirname, 'tools', 'monitors.ps1');
    execFile(
      POWERSHELL,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      { timeout: 6000 },
      (err, stdout) => {
        const names = [];
        if (!err && stdout) {
          for (const line of stdout.trim().split(/\r?\n/)) {
            const [mfr, name, w, h] = line.split('|');
            if (!mfr) continue;
            names.push({
              mfr: mfr.trim(),
              name: (name || '').trim(),
              width: Number(w) || 0,
              height: Number(h) || 0,
            });
          }
        }
        monitorNames = names;
        resolve(names);
      }
    );
  });
}

// Turn "LEN" + "M15" into something a person recognises.
function friendlyName(entry, isPrimary, index) {
  if (!entry) return isPrimary ? 'Laptop' : 'Screen ' + (index + 1);

  const BRANDS = { LEN: 'Lenovo', SAM: 'Samsung', DEL: 'Dell', AUS: 'Asus' };
  const model = entry.name;

  if (!model) return isPrimary ? 'Laptop' : (BRANDS[entry.mfr] || 'Screen');
  // Brand only: the model number identifies nothing on a desk.
  if (entry.mfr === 'LEN') return 'ThinkVision';
  return BRANDS[entry.mfr] || entry.mfr;
}

function listDisplays() {
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay().id;

  // WMI lists monitors in its own order, so pair them up by index: the
  // internal panel is always the primary on a laptop.
  // Windows enumerates monitors in the same order in both APIs, so position
  // is the reliable key -- as long as the list is not filtered first.
  const pool = monitorNames || [];

  return all.map((d, i) => ({
    id: d.id,
    label: (() => {
      if (d.id === primary) return 'Laptop';
      return friendlyName(pool[i], false, i);
    })(),
    width: d.bounds.width,
    height: d.bounds.height,
    // Scaled displays report fewer CSS pixels than they physically have.
    native: Math.round(d.bounds.width * d.scaleFactor) +
      '×' + Math.round(d.bounds.height * d.scaleFactor),
    primary: d.id === primary,
  }));
}

// The chosen display, falling back to whichever one the camera sits on.
// The screen the camera window is sitting on right now. Layout follows this;
// only capture follows targetDisplay(), the screen picked for recording.
function cameraDisplay() {
  return screen.getDisplayMatching(win.getBounds());
}

function targetDisplay() {
  const saved = readState().displayId;
  if (saved) {
    const match = screen.getAllDisplays().find((d) => d.id === saved);
    if (match) return match;
  }
  return screen.getDisplayMatching(win.getBounds());
}

function pushRecState() {
  if (!recWin || recWin.isDestroyed()) return;
  const s = readState();
  const g = captureGeometry();
  const sf = g.display.scaleFactor || 1;
  const even = (n) => n - (n % 2);
  const customLabel = s.customRegion
    ? even(Math.round(s.customRegion.width * sf)) +
      '×' +
      even(Math.round(s.customRegion.height * sf))
    : null;

  recWin.webContents.send('rec:state', {
    preset: s.preset === 'custom' ? 'custom' : 'landscape',
    customRegion: s.customRegion || null,
    customLabel,
    captureLabel: g.label,
    displays: listDisplays(),
    displayId: g.display.id,
    folder: s.folder || null,
    audioDevice: resolveAudioDevice(),
    audioWarning,
  });
}

// Result of the last attempt to open the chosen mic; null when it opened.
let audioWarning = null;

// The saved mic, or the best stand-in while it is unplugged.
let lastAudioDevices = [];
function resolveAudioDevice() {
  const saved = readState().audioDevice;
  if (!saved) return null;
  if (!lastAudioDevices.length || lastAudioDevices.includes(saved)) return saved;
  return lastAudioDevices.find((d) => !/Microphone Array|Internal/i.test(d)) || lastAudioDevices[0] || null;
}

function probeChosenMic() {
  const device = resolveAudioDevice();
  recorder.probeAudioDevice(device, (ok, why) => {
    audioWarning = ok
      ? null
      : `This mic can't be opened right now — another app (OBS, Teams, a browser tab) may be using it.${why ? ' ' + why : ''}`;
    pushRecState();
  });
}

function notifyHudRecording() {
  if (hudWin && !hudWin.isDestroyed()) {
    hudWin.webContents.send('hud:recording', recorder.isRecording());
  }
}

function notifyRec(payload) {
  if (recWin && !recWin.isDestroyed()) {
    recWin.webContents.send('rec:recording', payload);
  }
  // The camera window mirrors the state on its own record button.
  if (win && !win.isDestroyed()) {
    win.webContents.send('record:state', payload);
  }
  if ('recording' in payload) notifyHudRecording();
}

// Actually begin capture, once the countdown has finished.
// The panel is an on-screen window, so it lands in the capture. Park it
// outside the recorded region for the duration.
let recWinHomeBounds = null;
let recWinMoved = false;
let parking = false;

function parkRecorder() {
  if (!recWin || recWin.isDestroyed()) return;
  parking = true;
  recWinHomeBounds = recWin.getBounds();
  // Shrink to the live controls before moving, so the parked window is as
  // small as possible.
  recWin.setBounds({ ...recWinHomeBounds, ...LIVE_SIZE });

  // Dragged somewhere (say, the screen that is not being recorded)? It stays
  // there, shrinking upward from its bottom edge. Otherwise it parks in the
  // corner of the recorded screen, which is where it opened.
  let x, y;
  if (recWinMoved) {
    x = recWinHomeBounds.x;
    y = recWinHomeBounds.y + recWinHomeBounds.height - LIVE_SIZE.height;
  } else {
    const area = targetDisplay().workArea;
    x = Math.round(area.x + area.width - LIVE_SIZE.width - 16);
    y = Math.round(area.y + area.height - LIVE_SIZE.height - 16);
  }
  recWin.setBounds({ ...LIVE_SIZE, x, y });
  parking = false;
}

function unparkRecorder() {
  if (!recWin || recWin.isDestroyed() || !recWinHomeBounds) return;
  parking = true;
  // Grow back upward from wherever the live panel ended up, inside the screen.
  const live = recWin.getBounds();
  const area = screen.getDisplayMatching(live).workArea;
  const y = Math.max(area.y, live.y + live.height - REC_SIZE.height);
  recWin.setBounds({ ...REC_SIZE, x: live.x, y });
  parking = false;
  recWinHomeBounds = null;
}

// Spotlight: fill the captured region with the camera mid-recording, then
// drop back to the previous shape. Doing it live removes the need to cut
// between a talking head and a screen share in an editor afterwards.
let spotlightPrev = null;

function toggleSpotlight() {
  if (!win || win.isDestroyed()) return false;

  if (spotlightPrev) {
    win.setBounds(spotlightPrev.bounds);
    win.webContents.send('camera:spotlight', false);
    writeState({ bounds: win.getBounds() });
    spotlightPrev = null;
    return false;
  }

  spotlightPrev = { bounds: win.getBounds() };
  win.setBounds(frameBounds());
  win.webContents.send('camera:spotlight', true);
  return true;
}

let regionWin = null;

// Full-screen overlay for choosing a capture area by dragging, the same
// gesture as the Snipping Tool.
function openRegionPicker() {
  if (regionWin && !regionWin.isDestroyed()) return;
  hideFrame();

  const display = targetDisplay();
  const b = display.bounds;

  regionWin = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    webPreferences: {
      preload: path.join(__dirname, 'region-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  regionWin.setAlwaysOnTop(true, 'screen-saver');
  regionWin.setMenu(null);
  // The picker measures in DIPs; the scale factor lets its size label show
  // the physical pixels that will actually be captured.
  regionWin.loadFile('region.html', {
    query: { sf: String(display.scaleFactor || 1) },
  });
  // Remember which display it covers: the drag is window-local, the capture
  // region has to be in desktop coordinates.
  regionWin.__origin = { x: b.x, y: b.y };
  regionWin.on('closed', () => {
    regionWin = null;
  });
}

function closeRegionPicker() {
  if (regionWin && !regionWin.isDestroyed()) regionWin.close();
  regionWin = null;
}

ipcMain.on('region:done', (_e, r) => {
  const origin = regionWin && regionWin.__origin ? regionWin.__origin : { x: 0, y: 0 };
  writeState({
    preset: 'custom',
    customRegion: {
      x: Math.round(origin.x + r.x),
      y: Math.round(origin.y + r.y),
      width: r.width,
      height: r.height,
    },
  });
  closeRegionPicker();
  refreshFrame();
  pushRecState();
});

ipcMain.on('region:cancel', () => {
  closeRegionPicker();
  refreshFrame();
});

// ---------------------------------------------------------------------------
// Capture geometry
//
// Electron works in DIPs; ddagrab captures the display in physical pixels.
// On the laptop (150%) and the ThinkVision (125%) the two differ, and the
// crop handed to ffmpeg has to be physical pixels relative to the display's
// own origin -- the full display, not the work area, since ddagrab does not
// know about the taskbar.
// ---------------------------------------------------------------------------
const CAPTURE = { width: 1920, height: 1080 };

function physicalOf(display) {
  const sf = display.scaleFactor || 1;
  return {
    sf,
    width: Math.round(display.bounds.width * sf),
    height: Math.round(display.bounds.height * sf),
  };
}

function captureGeometry() {
  const s = readState();
  const display = targetDisplay();
  const phys = physicalOf(display);
  const b = display.bounds;
  const even = (n) => n - (n % 2);

  if (s.preset === 'custom' && s.customRegion) {
    const r = s.customRegion;
    // Clamp to the display so a region picked on another screen cannot ask
    // for pixels that do not exist here.
    const x0 = Math.max(b.x, Math.min(r.x, b.x + b.width - 40));
    const y0 = Math.max(b.y, Math.min(r.y, b.y + b.height - 40));
    const w0 = Math.max(40, Math.min(r.width, b.x + b.width - x0));
    const h0 = Math.max(40, Math.min(r.height, b.y + b.height - y0));
    const crop = {
      x: Math.round((x0 - b.x) * phys.sf),
      y: Math.round((y0 - b.y) * phys.sf),
      w: even(Math.round(w0 * phys.sf)),
      h: even(Math.round(h0 * phys.sf)),
    };
    return {
      display,
      crop,
      dip: { x: x0, y: y0, width: w0, height: h0 },
      label: crop.w + '×' + crop.h,
    };
  }

  const w = even(Math.min(CAPTURE.width, phys.width));
  const h = even(Math.min(CAPTURE.height, phys.height));
  const crop = {
    x: Math.floor((phys.width - w) / 2),
    y: Math.floor((phys.height - h) / 2),
    w,
    h,
  };
  return {
    display,
    crop,
    dip: {
      x: b.x + crop.x / phys.sf,
      y: b.y + crop.y / phys.sf,
      width: w / phys.sf,
      height: h / phys.sf,
    },
    label: w + '×' + h,
  };
}

function frameBounds() {
  const d = captureGeometry().dip;
  return {
    x: Math.round(d.x),
    y: Math.round(d.y),
    width: Math.round(d.width),
    height: Math.round(d.height),
  };
}

// ---------------------------------------------------------------------------
// Capture frame overlay
//
// A click-through window outlining exactly what will be recorded. It is
// content-protected (WDA_EXCLUDEFROMCAPTURE), so it is visible on the
// monitor and absent from the file -- verified by sampling a ddagrab frame.
// ---------------------------------------------------------------------------
function showFrame() {
  if (!win || win.isDestroyed()) return;
  const bounds = frameBounds();

  if (frameWin && !frameWin.isDestroyed()) {
    frameWin.setBounds(bounds);
    frameWin.showInactive();
    sendFrameState();
    return;
  }

  frameWin = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'frame-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  frameWin.setAlwaysOnTop(true, 'screen-saver');
  frameWin.setIgnoreMouseEvents(true);
  frameWin.setContentProtection(true);
  frameWin.setMenu(null);
  frameWin.loadFile('frame.html');
  frameWin.webContents.on('did-finish-load', () => {
    if (!frameWin || frameWin.isDestroyed()) return;
    frameWin.showInactive();
    sendFrameState();
  });
  frameWin.on('closed', () => {
    frameWin = null;
  });
}

function sendFrameState() {
  if (!frameWin || frameWin.isDestroyed()) return;
  frameWin.webContents.send('frame:set', {
    label: captureGeometry().label,
    recording: recorder.isRecording(),
    paused: recorder.isPaused(),
  });
}

// Only meaningful while the recording panel is open.
function refreshFrame() {
  if (recWin && !recWin.isDestroyed()) showFrame();
}

function hideFrame() {
  if (frameWin && !frameWin.isDestroyed()) frameWin.close();
  frameWin = null;
}

// ---------------------------------------------------------------------------
// Moving the stack to the recording display
// ---------------------------------------------------------------------------
function moveStackToDisplay(display) {
  if (!win || win.isDestroyed()) return;
  const s = readState();
  const from = screen.getDisplayMatching(win.getBounds()).workArea;
  const to = display.workArea;

  if (s.mode === 'side') {
    const frac = s.bounds ? s.bounds.width / from.width : 0.2;
    snapSide(
      frac >= 0.1 && frac <= 0.6 ? frac : 0.2,
      s.edge === 'left' ? 'left' : 'right',
      display
    );
  } else {
    // Same relative spot on the new screen.
    const b = win.getBounds();
    const fx = (b.x - from.x) / Math.max(1, from.width - b.width);
    const fy = (b.y - from.y) / Math.max(1, from.height - b.height);
    const clamp = (v) => Math.min(1, Math.max(0, v));
    win.setBounds({
      ...b,
      x: Math.round(to.x + clamp(fx) * (to.width - b.width)),
      y: Math.round(to.y + clamp(fy) * (to.height - b.height)),
    });
    writeState({ bounds: win.getBounds() });
  }

  // A panel the user placed by hand stays put; only the default follows.
  if (recWin && !recWin.isDestroyed() && !recWinMoved) {
    parking = true;
    recWin.setBounds({ ...recWin.getBounds(), ...recPosition() });
    parking = false;
  }
  settingsMoved = false;
  repositionSettings();
}

// ---------------------------------------------------------------------------
// Move and resize
//
// -webkit-app-region: drag hands the area to Windows as a title bar: CSS
// cursors are ignored there, mousemove never reaches the page, and native
// resizing fights the square lock. So the page only reports gestures, and
// this process polls the real cursor and sets the bounds itself.
// ---------------------------------------------------------------------------
let interaction = null;

function beginInteraction(kind, dir) {
  endInteraction();
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const s = readState();

  // getBounds is unreliable on a fractionally scaled display: at 1.5x it
  // reports a size one pixel either way depending on where the window sits.
  // The circle is square by definition, so square up the snapshot rather
  // than carrying a stale +1 into the gesture -- feeding that back every
  // tick is what slowly swelled the circle into an oval.
  if (s.mode !== 'side' && (!s.shape || s.shape === 'circle')) {
    const size = Math.min(bounds.width, bounds.height);
    bounds.width = size;
    bounds.height = size;
  }

  const cursor = screen.getCursorScreenPoint();
  interaction = {
    kind,
    dir: dir || '',
    cursor,
    bounds,
    // Where in the column the grab happened, as a fraction of its width, so
    // it stays under the pointer even when the width changes with the screen.
    grabFraction: bounds.width ? (cursor.x - bounds.x) / bounds.width : 0.5,
    edge: s.edge === 'left' ? 'left' : 'right',
    timer: setInterval(stepInteraction, 16),
  };
}

function stepInteraction() {
  if (!interaction || !win || win.isDestroyed()) return endInteraction();

  const c = screen.getCursorScreenPoint();
  const dx = c.x - interaction.cursor.x;
  const dy = c.y - interaction.cursor.y;
  const b = interaction.bounds;

  if (interaction.kind === 'move') {
    if (readState().mode === 'side') {
      dragSideColumn(c);
      return;
    }
    // setBounds, not setPosition: passing the size back every tick means a
    // stray constraint or rounding cannot accumulate into a changed shape.
    win.setBounds({ x: Math.round(b.x + dx), y: Math.round(b.y + dy), width: b.width, height: b.height });
    repositionSettings();
    return;
  }

  const s = readState();
  const dir = interaction.dir;

  if (s.mode === 'side') {
    // Docked: only the inward edge moves. Height is the work area's.
    const area = cameraDisplay().workArea;
    const edge = s.edge === 'left' ? 'left' : 'right';
    let width = edge === 'right' ? b.width - dx : b.width + dx;
    width = Math.round(Math.max(160, Math.min(area.width, width)));
    win.setBounds({
      x: edge === 'right' ? area.x + area.width - width : area.x,
      y: area.y,
      width,
      height: area.height,
    });
    return;
  }

  const east = dir.includes('e');
  const west = dir.includes('w');
  const north = dir.includes('n');
  const south = dir.includes('s');

  if (s.shape && s.shape !== 'circle') {
    // Rectangle: each edge moves on its own, so it can match a layout cell.
    const area = screen.getDisplayMatching(b).workArea;
    let width = east ? b.width + dx : west ? b.width - dx : b.width;
    let height = south ? b.height + dy : north ? b.height - dy : b.height;
    width = Math.round(Math.max(160, Math.min(area.width, width)));
    height = Math.round(Math.max(160, Math.min(area.height, height)));
    win.setBounds({
      x: Math.round(west ? b.x + b.width - width : b.x),
      y: Math.round(north ? b.y + b.height - height : b.y),
      width,
      height,
    });
    // Dragged against the top or bottom of the screen while already tall, it
    // IS a side column: make it one rather than leaving a breakout window
    // that merely looks like it.
    if (touchesFullHeight(win.getBounds(), area)) becomeSideColumn(width, area);
    return;
  }

  // Circle: a square. Take the delta along the axis the handle moves; on a
  // corner, whichever axis the pointer has moved further along.
  const dxs = east ? dx : west ? -dx : null;
  const dys = south ? dy : north ? -dy : null;
  let delta = 0;
  if (dxs !== null && dys !== null) delta = Math.abs(dxs) > Math.abs(dys) ? dxs : dys;
  else delta = dxs !== null ? dxs : dys;

  const area = screen.getDisplayMatching(b).workArea;
  let size = Math.round(b.width + delta);
  size = Math.max(160, Math.min(size, Math.min(area.width, area.height)));

  win.setBounds({
    x: Math.round(west ? b.x + b.width - size : b.x),
    y: Math.round(north ? b.y + b.height - size : b.y),
    width: size,
    height: size,
  });
  if (touchesFullHeight(win.getBounds(), area)) becomeSideColumn(size, area);
}

// Windows' own snap, when a rectangle is dragged to a screen edge. Its
// half-screen tile is fine as a column, but its quarter tiles are not: side
// mode is always full height, so a quarter is promoted to the full edge
// rather than left as a stray box in a corner.
function adoptWindowsSnap() {
  if (!win || win.isDestroyed()) return;
  // Only Windows-driven drags: our own gestures manage their own geometry.
  if (interaction || win.__transparent) return;
  const b = win.getBounds();
  const area = screen.getDisplayMatching(b).workArea;

  const halfIsh = b.width <= area.width * 0.6;
  const touchesLeft = Math.abs(b.x - area.x) <= FULL_HEIGHT_SLOP;
  const touchesRight = Math.abs(b.x + b.width - (area.x + area.width)) <= FULL_HEIGHT_SLOP;
  if (!halfIsh || !(touchesLeft || touchesRight)) return;

  // A tile that does not already run the full height is a quarter: take it
  // to full height and treat the result as a docked column.
  const full = b.height >= area.height - FULL_HEIGHT_SLOP;
  if (full && readState().mode === 'side') return;

  if (readState().mode === 'side') {
    // Already docked: just restore the full height Windows took away.
    const edge = touchesLeft ? 'left' : 'right';
    snapSide(Math.min(0.6, Math.max(0.1, b.width / area.width)), edge);
    fillStage('side');
    return;
  }
  becomeSideColumn(b.width, area);
}

// Tall enough to be a column, and pinned against the top or bottom of the
// screen. Height alone is not enough: a window can be work-area tall while
// floating in the middle, which is still a breakout window.
function touchesFullHeight(b, area) {
  const tall = b.height >= area.height * 0.8;
  const atTop = Math.abs(b.y - area.y) <= FULL_HEIGHT_SLOP;
  const atBottom = Math.abs(b.y + b.height - (area.y + area.height)) <= FULL_HEIGHT_SLOP;
  return tall && (atTop || atBottom);
}

// Grown to the screen's full height, a breakout window has become a side
// column in all but name. Rather than leave the two looking identical but
// behaving differently, switch it over: the shape goes square-cornered, the
// column docks to the nearer edge, and the window beside it takes the rest.
const FULL_HEIGHT_SLOP = 12;

function becomeSideColumn(width, area) {
  if (readState().mode === 'side') return;
  endInteraction();
  const b = win.getBounds();
  const edge = b.x + b.width / 2 < area.x + area.width / 2 ? 'left' : 'right';
  writeState({ mode: 'side' });
  snapSide(Math.min(0.6, Math.max(0.1, width / area.width)), edge);
  win.webContents.send('camera:mode', 'side');
  fillStage('side');
  pushState();
  moveHud();
}

// Dragging a docked column: it keeps its width and the work area's full
// height, and follows the cursor from screen to screen. Within the magnet
// zone of an edge it sticks there; past that it tracks the cursor freely, so
// it can be carried across a monitor without fighting the snap.
const MAGNET = 45;

// Which screen a column being dragged belongs to: the one holding most of
// where it is heading. Ties go to the cursor's screen, so a deliberate push
// across the seam still commits immediately.
function displayForColumn(cursor) {
  const b = win.getBounds();
  const displays = screen.getAllDisplays();
  let best = null;
  let bestArea = 0;
  for (const d of displays) {
    const a = d.workArea;
    const overlap =
      Math.max(0, Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x)) *
      Math.max(0, Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y));
    if (overlap > bestArea) {
      bestArea = overlap;
      best = d;
    }
  }
  const under = screen.getDisplayNearestPoint(cursor);
  // The cursor's screen wins once the column is meaningfully onto it: that
  // is the gesture committing, and waiting for a majority feels sticky.
  const a = under.workArea;
  const onUnder =
    Math.max(0, Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x)) *
    Math.max(0, Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y));
  if (onUnder > 0 && onUnder >= bestArea * 0.34) return under;
  return best || under;
}

function dragSideColumn(cursor) {
  // Follow the screen the column is mostly over, not the one the cursor is
  // on. Work areas differ in height (the laptop's taskbar makes it 752 where
  // the ThinkVision is 864), so tracking the cursor draws the column at the
  // old screen's height for the whole crossing -- a gap at the bottom until
  // the cursor finally catches up.
  const display = displayForColumn(cursor);
  const area = display.workArea;

  // Screens differ in size and scale, so carry the column's proportion
  // across rather than its pixel width: a fifth of the laptop stays a fifth
  // of the ThinkVision instead of jumping to a different share of it.
  if (!interaction.widthFraction) {
    const from = screen.getDisplayMatching(interaction.bounds).workArea;
    interaction.widthFraction = interaction.bounds.width / from.width;
  }
  const width = Math.round(
    Math.max(160, Math.min(area.width, area.width * interaction.widthFraction))
  );

  // Where the column would sit if it just followed the cursor. The grab
  // point is kept as a fraction of the width, so a column that changes width
  // crossing to another screen stays under the pointer instead of jumping.
  const free = Math.round(cursor.x - width * interaction.grabFraction);
  const leftGap = Math.abs(free - area.x);
  const rightGap = Math.abs(area.x + area.width - (free + width));

  let x = free;
  let edge = null;
  if (leftGap <= MAGNET && leftGap <= rightGap) {
    x = area.x;
    edge = 'left';
  } else if (rightGap <= MAGNET) {
    x = area.x + area.width - width;
    edge = 'right';
  }
  // Never let it wander off the screen it is on.
  x = Math.max(area.x, Math.min(x, area.x + area.width - width));

  win.setBounds({ x, y: area.y, width, height: area.height });
  if (edge && edge !== interaction.edge) {
    interaction.edge = edge;
    win.webContents.send('camera:edge', edge);
  }
  repositionSettings();
  moveHud();
}

function endInteraction() {
  if (!interaction) return;
  const wasMove = interaction.kind === 'move';
  const started = interaction.bounds;

  // A docked column may have been carried to another screen or another edge.
  if (readState().mode === 'side' && win && !win.isDestroyed()) {
    clearInterval(interaction.timer);
    const edge = interaction.edge;
    interaction = null;
    writeState({ edge, bounds: win.getBounds() });
    applyNativeLocks();
    // The window beside it belongs on the same screen.
    if (stage) fillStage('side');
    repositionSettings();
    moveHud();
    return;
  }
  clearInterval(interaction.timer);
  interaction = null;
  if (win && !win.isDestroyed()) {
    // On a fractionally scaled display (the laptop is 1.5x) getBounds reports
    // a size one pixel off depending on where the window sits. A move must
    // never persist that: keep the size the gesture began with.
    const b = win.getBounds();
    // A move never changes the size, so persist the one the gesture began
    // with rather than the read-back, which jitters by a pixel on a scaled
    // display.
    writeState({
      bounds: wasMove
        ? { x: b.x, y: b.y, width: started.width, height: started.height }
        : b,
    });
    // Put the window back on the exact size too: otherwise the next gesture
    // starts from the jittered one again.
    if (wasMove && (b.width !== started.width || b.height !== started.height)) {
      win.setBounds({ x: b.x, y: b.y, width: started.width, height: started.height });
    }
    // Widening the docked column takes space from the window beside it.
    if (!wasMove && readState().mode === 'side' && stage) fillStage('side');
    repositionSettings();
  }
}

ipcMain.on('drag:start', () => {
  if (!win || win.isDestroyed()) return;
  const s = readState();
  // A docked column keeps its full height and its width, but it can be
  // carried to another screen; the move loop snaps it to whichever edge it
  // is nearest.
  if (s.mode === 'side') return beginInteraction('move');
  // Opaque rectangle: hand the drag to Windows so it can snap.
  if (!win.__transparent && native.beginMove(win)) return;
  beginInteraction('move');
});
ipcMain.on('resize:start', (_e, dir) => beginInteraction('resize', String(dir || 'se')));
ipcMain.on('drag:end', () => endInteraction());

// Actually begin capture, once the countdown has finished.
function beginCapture() {
  const s = readState();
  const folder = s.folder;
  if (!folder) return notifyRec({ recording: false, error: 'No folder chosen' });

  const g = captureGeometry();
  const displayIndex = Math.max(
    0,
    screen.getAllDisplays().findIndex((d) => d.id === g.display.id)
  );

  recorder.start(
    {
      folder,
      audioDevice: resolveAudioDevice(),
      displayIndex,
      crop: g.crop,
      label: g.label,
      fps: 30,
    },
    (err, info) => {
      if (err) {
        unparkRecorder();
        return notifyRec({ recording: false, error: err.message });
      }
      setHudVisible(true);
      notifyRec({ recording: true, ...info });
      sendFrameState();
    }
  );
}

function stopCapture({ discard = false, then = null } = {}) {
  if (spotlightPrev) toggleSpotlight();
  recorder.stop((_err, file) => {
    unparkRecorder();
    notifyRec({ recording: false, file });
    sendFrameState();
    if (file && discard) {
      // Restart means the take was bad: bin it rather than leaving clutter.
      for (const f of [file]) {
        try {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch {
          /* the file may still be locked; leaving it is harmless */
        }
      }
    } else if (file) {
      shell.showItemInFolder(file);
    }
    // Only once the recorder has fully let go: starting sooner fails with
    // "already recording" while the last segment is still being joined.
    if (then) then();
  });
}

// Pause and resume are real, and neither is instant: pausing finalises the
// current segment, resuming restarts the GPU encoder (about a second). The
// panel hears when each begins and when it has landed, so it can show
// "Pausing…" / "Resuming…" instead of pretending.
function togglePause() {
  if (!recorder.isRecording()) return;
  const pausing = !recorder.isPaused();
  const tell = (payload) => {
    if (recWin && !recWin.isDestroyed()) recWin.webContents.send('rec:paused', payload);
    sendFrameState();
  };
  tell({ paused: recorder.isPaused(), pending: pausing ? 'pausing' : 'resuming' });
  const landed = (err) => {
    tell({
      paused: recorder.isPaused(),
      pending: null,
      // A failed resume is worth saying out loud (the mic may have gone);
      // a pause that was refused because one is already under way is not.
      error: err && !pausing ? err.message : null,
    });
  };
  if (pausing) recorder.pause(landed);
  else recorder.resume(landed);
}

// Re-list the microphones and make sure the chosen one is actually there.
// A mic that was unplugged since the last take must not stay selected: the
// audio process would fail to open it and the take would be silent.
function refreshAudioDevices(cb) {
  recorder.listAudioDevices((devices) => {
    const saved = readState().audioDevice;
    // Only ever fill in a blank: a mic the user picked stays picked even
    // when it is unplugged (or missed by one device scan), and comes back
    // by itself when it reappears. It used to be overwritten with the
    // laptop's array, which then recorded the next take.
    if (!saved && devices.length) writeState({ audioDevice: preferredAudioDevice(devices) });
    lastAudioDevices = devices;
    pushRecState();
    if (recWin && !recWin.isDestroyed()) {
      recWin.webContents.send('rec:audio', devices);
    }
    probeChosenMic();
    if (cb) cb(devices);
  });
}

ipcMain.on('rec:ready', async () => {
  // Names may not have arrived yet when the panel opens.
  if (!monitorNames || !monitorNames.length) await loadMonitorNames();
  refreshAudioDevices(() => refreshFrame());
});

// The camera page hears plug/unplug events from the OS (they cover audio
// inputs too); the panel's list follows.
ipcMain.on('devices:changed', () => {
  if (recWin && !recWin.isDestroyed()) refreshAudioDevices();
});

ipcMain.on('rec:action', async (_e, { action, value }) => {
  switch (action) {
    case 'preset':
      writeState({ preset: value });
      refreshFrame();
      pushRecState();
      break;
    case 'pickRegion':
      openRegionPicker();
      break;
    case 'display': {
      writeState({ displayId: value });
      const target = screen.getAllDisplays().find((d) => d.id === value);
      // The camera and the panels belong on the screen being recorded.
      if (target) moveStackToDisplay(target);
      refreshFrame();
      pushRecState();
      break;
    }
    case 'audio':
      writeState({ audioDevice: value || null });
      probeChosenMic();
      break;
      break;
    case 'folder': {
      const f = await chooseFolder(recWin);
      if (f) pushRecState();
      break;
    }
    case 'cameraSettings':
      closeVisual();
      openSettings();
      break;
    case 'visualSettings':
      openVisual();
      break;
    case 'countdown':
      // A null tick is a cancelled countdown.
      if (value === null) {
        clearCountdown();
        break;
      }
      // The camera window draws it over the face; the panel only counts.
      if (win && !win.isDestroyed()) {
        win.webContents.send('camera:countdown', value);
      }
      // The controls window is always-on-top and sits exactly where the
      // countdown's Cancel button is, so it swallowed every click on it.
      // Cancel is the only thing worth clicking during a countdown.
      setHudVisible(false);
      // Resize on the first tick so the panel settles before capture, and
      // re-check the mic so capture starts with one that exists.
      if (value === 3) {
        parkRecorder();
        refreshAudioDevices();
      }
      break;
    case 'begin':
      if (win && !win.isDestroyed()) {
        win.webContents.send('camera:countdown', null);
      }
      beginCapture();
      break;
    case 'pause':
      togglePause();
      break;
    case 'spotlight':
      notifyRec({ spotlight: toggleSpotlight() });
      break;
    case 'restart':
      stopCapture({ discard: true, then: beginCapture });
      break;
    case 'stop':
      clearCountdown();
      stopCapture();
      break;
    case 'cancel':
      if (recorder.isRecording()) stopCapture();
      closeRecorder();
      break;
  }
});

// The record button opens the recording window. Capture itself starts after
// the countdown, so there is time to get ready and a visible way to stop.
function startRecording() {
  if (recorder.isRecording()) {
    stopCapture();
    return;
  }
  // Panel already open and primed: the red button is a second Start button.
  if (recWin && !recWin.isDestroyed()) {
    recWin.webContents.send('rec:go');
    return;
  }
  openRecorder();
}

ipcMain.on('record:start', startRecording);

// Cancel pressed on the camera window during the countdown.
ipcMain.on('countdown:cancel', () => {
  clearCountdown();
  if (recWin && !recWin.isDestroyed()) {
    recWin.webContents.send('rec:cancelCountdown');
  }
});
// The gear is a toggle: a second click closes the panel rather than
// re-opening and nudging it.
function toggleSettings() {
  if (settingsWin && !settingsWin.isDestroyed() && settingsWin.isVisible()) {
    closeSettings();
    return;
  }
  openSettings();
}

const VISUAL_SIZE = {
  width: 268,
  // The phone offers far more controls than a webcam's four sliders. (The
  // panel scrolls if a screen is too short for them.)
  get height() {
    if (readState().deviceId !== 'phone-usb') return 396;
    // As tall as the phone's controls want, but never taller than the screen
    // it opens on: the laptop's work area is only 752 high.
    const area = win && !win.isDestroyed() ? cameraDisplay().workArea : screen.getPrimaryDisplay().workArea;
    return Math.min(700, area.height - 32);
  },
};

function openVisual() {
  // Take over the settings window rather than stacking a second panel.
  if (settingsWin && !settingsWin.isDestroyed()) {
    const b = settingsWin.getBounds();
    closeSettings();
    openVisualAt(b);
    return;
  }
  openVisualAt(null);
}

function openVisualAt(bounds) {
  if (visualWin && !visualWin.isDestroyed()) {
    visualWin.show();
    visualWin.focus();
    return;
  }

  const b = win.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  let x = b.x + b.width + 12;
  if (x + VISUAL_SIZE.width > area.x + area.width) {
    x = b.x - VISUAL_SIZE.width - 12;
  }
  x = Math.max(area.x, Math.min(x, area.x + area.width - VISUAL_SIZE.width));
  const y = Math.max(
    area.y,
    Math.min(b.y, area.y + area.height - VISUAL_SIZE.height)
  );

  visualWin = new BrowserWindow({
    ...VISUAL_SIZE,
    x: bounds ? bounds.x : Math.round(x),
    y: bounds ? bounds.y : Math.round(y),
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#17181c',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'visual-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  visualWin.setAlwaysOnTop(true, 'screen-saver');
  visualWin.setMenu(null);
  visualWin.setContentProtection(true);
  visualWin.loadFile('visual.html');
  visualWin.on('closed', () => {
    visualWin = null;
  });
}

function closeVisual() {
  if (visualWin && !visualWin.isDestroyed()) visualWin.close();
  visualWin = null;
}

// The camera window owns the track, so capability probing happens there.
ipcMain.on('visual:ready', () => {
  // The phone's controls live on the phone, not in a Windows camera driver.
  if (phoneIsSource()) return sendPhoneControls();
  if (win && !win.isDestroyed()) win.webContents.send('camera:probeVisual');
});

ipcMain.on('visual:action', (_e, { action, value }) => {
  if (action === 'dismiss') return closeVisual();
  if (action === 'back') {
    const b = visualWin && !visualWin.isDestroyed() ? visualWin.getBounds() : null;
    closeVisual();
    openSettings();
    // Reopen where the visual panel was, so nothing jumps.
    if (b && settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.setBounds({ ...SETTINGS_SIZE, x: b.x, y: b.y });
      settingsMoved = true;
    }
    return;
  }
  if (action === 'record') {
    closeVisual();
    return openRecorder();
  }
  if (phoneIsSource()) {
    if (action === 'set') setPhoneControl(value.key, value.value);
    if (action === 'reset') resetPhoneControls();
    return;
  }
  if (!win || win.isDestroyed()) return;
  if (action === 'set') win.webContents.send('camera:setVisual', value);
  if (action === 'reset') win.webContents.send('camera:resetVisual');
});

// Results come back from the camera window and go straight to the panel.
ipcMain.on('camera:visualCaps', (_e, payload) => {
  if (visualWin && !visualWin.isDestroyed()) {
    visualWin.webContents.send('visual:caps', payload);
  }
});

ipcMain.on('visual:open', openVisual);
ipcMain.on('settings:open', toggleSettings);
ipcMain.on('settings:ready', () => {
  // Modes must land BEFORE state: renderQuality() bails out when the list is
  // empty, so a state push that arrives first is dropped and the select keeps
  // whatever its first option happens to be.
  if (lastModes && settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('settings:modes', lastModes);
  } else if (win && !win.isDestroyed()) {
    // Nothing cached yet: ask the camera window to report now.
    win.webContents.send('camera:requestModes');
  }
  pushState();
  recorder.listAudioDevices((devices) => {
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.webContents.send('settings:audio', devices);
    }
  });
  if (lastCameraReport && settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('settings:cameras', lastCameraReport);
  }
});

// The camera window owns the media stream, so anything touching the camera is
// forwarded to it; window geometry is handled here.
ipcMain.on('settings:action', (_e, { action, value }) => {
  switch (action) {
    case 'mode': {
      // Side is always a fifth on the left (the recording is the window
      // beside it); breakout hands that window the whole screen and floats
      // the camera on top. Same path as the keyboard shortcut.
      setMode(value === 'side' ? 'side' : 'breakout');
      break;
    }
    case 'shape':
      // Same path as the keyboard shortcut.
      setShape(value);
      break;
    case 'snap': {
      const s = readState();
      const edge = s.edge === 'left' ? 'left' : 'right';
      snapSide(value, edge);
      win?.webContents.send('camera:mode', 'side');
      repositionSettings();
      break;
    }
    case 'size':
      applyBreakoutSize(value);
      repositionSettings();
      break;
    case 'edge': {
      writeState({ edge: value });
      // Only meaningful in side mode; in breakout it would deform the square.
      const s = readState();
      if (s.mode === 'side') {
        const b = win.getBounds();
        const area = screen.getDisplayMatching(b).workArea;
        snapSide(b.width / area.width, value);
        repositionSettings();
      }
      break;
    }
    case 'record':
      closeSettings();
      startRecording();
      break;
    case 'preset':
      writeState({ preset: value });
      break;
    case 'quality':
      writeState({ quality: value });
      win?.webContents.send('camera:quality', value);
      break;
    case 'visual':
      openVisual();
      break;
    case 'audio':
      writeState({ audioDevice: value || null });
      break;
    case 'folder':
      chooseFolder(settingsWin).then((f) => {
        if (f) pushState();
      });
      break;
    case 'openFolder': {
      const f = recordingFolder();
      if (f) shell.openPath(f);
      break;
    }
    case 'device':
      win?.webContents.send('camera:device', value);
      break;
    case 'mirror':
      writeState({ mirror: value });
      win?.webContents.send('camera:mirror', value);
      break;
    case 'effects':
      openStudioEffects();
      break;
    case 'dismiss':
      closeSettings();
      break;
    case 'quit':
      closeSettings();
      win?.close();
      break;
  }
});


ipcMain.on('camera:modes', (_e, modes) => {
  lastModes = modes;
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('settings:modes', modes);
  }
});

ipcMain.on('camera:report', (_e, payload) => {
  lastCameraReport = payload;
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('settings:cameras', payload);
  }
});

ipcMain.handle('prefs:get', () => {
  const s = readState();
  return {
    mode: s.mode === 'side' ? 'side' : 'breakout',
    mirror: s.mirror ?? true,
    deviceId: s.deviceId ?? null,
    shape: ['circle', 'rounded', 'sharp'].includes(s.shape) ? s.shape : 'circle',
    edge: s.edge === 'left' ? 'left' : 'right',
    quality: s.quality || '1920x1080',
    brightness: typeof s.brightness === 'number' ? s.brightness : 100,
    contrast: typeof s.contrast === 'number' ? s.contrast : 100,
  };
});

ipcMain.on('mirror:set', (_e, mirror) => writeState({ mirror }));
ipcMain.on('device:set', (_e, deviceId) => writeState({ deviceId }));

// ---------------------------------------------------------------------------
// Phone camera over USB
//
// The Obsoloom Camera app (android/) streams the phone's camera as H.264
// through adb's port forwarding. This process owns the socket and relays
// packets to the camera window, which decodes them; the page cannot open a
// TCP connection itself. While the phone is the chosen source the link is
// kept up: if the cable is pulled or the app is closed, it is retried.
// ---------------------------------------------------------------------------
let phoneLink = null;
let phoneWanted = false;
let phoneRetry = null;
let lastPhoneInfo = null;

function phoneIsSource() {
  return readState().deviceId === 'phone-usb';
}

// Android's numbering for each setting, in words.
const PHONE_LABELS = {
  wb: { 1: 'Auto', 5: 'Daylight', 6: 'Cloudy', 8: 'Shade', 2: 'Incandescent (warm bulbs)', 3: 'Fluorescent', 4: 'Warm fluorescent', 7: 'Twilight' },
  antibanding: { 3: 'Auto', 1: '50 Hz mains', 2: '60 Hz mains', 0: 'Off' },
  edge: { 1: 'Normal', 0: 'Off (softest)', 2: 'High quality' },
  nr: { 1: 'Normal', 0: 'Off (most detail, most grain)', 3: 'Minimal', 2: 'High quality' },
};

function phoneOptions(kind, available) {
  const labels = PHONE_LABELS[kind];
  return Object.keys(labels)
    .map(Number)
    .filter((v) => (available || []).includes(v))
    .sort((a, b) => Object.keys(labels).indexOf(String(a)) - Object.keys(labels).indexOf(String(b)))
    .map((v) => ({ value: v, label: labels[v] }));
}

// The Visual settings panel draws itself from this list. It is built from
// what the phone says its current camera can do, so another phone (or the
// front camera) gets the controls it actually has.
function phoneControlList() {
  const info = lastPhoneInfo;
  if (!info || !info.caps) return null;
  const caps = info.caps;
  const now = { ...(info.controls || {}) };
  const list = [];

  if ((caps.cameras || []).length > 1) {
    list.push({
      key: 'camera',
      label: 'Camera',
      type: 'select',
      value: info.camera,
      options: caps.cameras.map((c) => ({ value: c.id, label: c.front ? 'Front (selfie)' : 'Rear (best quality)' })),
    });
  }
  if (caps.zoom) {
    list.push({
      key: 'zoom', label: 'Zoom', type: 'range', format: 'zoom',
      min: Math.round(caps.zoom[0] * 10) / 10, max: caps.zoom[1], step: 0.1,
      value: typeof now.zoom === 'number' ? now.zoom : 1,
    });
  }
  if (caps.exposure) {
    list.push({
      key: 'exposure', label: 'Exposure', type: 'range', format: 'ev',
      min: caps.exposure[0], max: caps.exposure[1], step: 1, scale: caps.exposureStep || 0.1,
      value: typeof now.exposure === 'number' ? now.exposure : 0,
    });
    list.push({ key: 'aeLock', label: 'Lock exposure (stop it drifting)', type: 'toggle', value: !!now.aeLock });
  }
  const banding = phoneOptions('antibanding', caps.antibanding);
  if (banding.length > 1) {
    list.push({ key: 'antibanding', label: 'Light flicker', type: 'select', options: banding, value: now.antibanding ?? 3 });
  }
  const wb = phoneOptions('wb', caps.wb);
  if (wb.length > 1) {
    list.push({ key: 'wb', label: 'White balance', type: 'select', options: wb, value: now.wb ?? 1 });
    list.push({ key: 'awbLock', label: 'Lock white balance', type: 'toggle', value: !!now.awbLock });
  }
  if (caps.minFocus) {
    list.push({
      key: 'focusMode', label: 'Focus', type: 'select', value: now.focusMode || 'auto',
      options: [{ value: 'auto', label: 'Automatic' }, { value: 'manual', label: 'Manual (fixed distance)' }],
    });
    list.push({
      key: 'focusDistance', label: 'Focus distance', type: 'range', format: 'focus',
      min: 0, max: caps.minFocus, step: 0.05,
      value: typeof now.focusDistance === 'number' ? now.focusDistance : 1.5,
      when: { key: 'focusMode', equals: 'manual' },
    });
  }
  const edge = phoneOptions('edge', caps.edge);
  if (edge.length > 1) list.push({ key: 'edge', label: 'Sharpening', type: 'select', options: edge, value: now.edge ?? 1 });
  const nr = phoneOptions('nr', caps.nr);
  if (nr.length > 1) list.push({ key: 'nr', label: 'Noise reduction', type: 'select', options: nr, value: now.nr ?? 1 });

  return list;
}

function sendPhoneControls() {
  if (!visualWin || visualWin.isDestroyed()) return;
  const controls = phoneControlList();
  visualWin.webContents.send('visual:caps', {
    controls: controls || [],
    note: controls ? '' : 'Waiting for the phone… plug it in over USB and unlock it once.',
  });
}

function setPhoneControl(key, value) {
  if (key === 'camera') {
    // Zoom and focus positions mean something else on another lens.
    const saved = { ...(readState().phoneControls || {}) };
    delete saved.zoom;
    delete saved.focusDistance;
    writeState({ phoneControls: saved, phoneCamera: String(value) });
  } else {
    writeState({ phoneControls: { ...(readState().phoneControls || {}), [key]: value } });
  }
  if (phoneLink) phoneLink.send({ set: { [key]: value } });
}

function resetPhoneControls() {
  writeState({ phoneControls: {} });
  if (phoneLink) phoneLink.send({ reset: true });
  // The panel redraws from the phone's reply, which lands a moment later.
  setTimeout(sendPhoneControls, 600);
}

function toCamera(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// When the phone's picture hitches, was it the phone/cable or this PC? Gaps
// between frames reaching the socket answer that, so the long ones are kept
// in a small log beside the settings file.
let lastPhoneArrival = 0;
function notePhoneArrival() {
  const now = Date.now();
  const gap = lastPhoneArrival ? now - lastPhoneArrival : 0;
  lastPhoneArrival = now;
  if (gap < 150 || gap > 10000) return;
  const file = path.join(app.getPath('userData'), 'phone-link.log');
  const line = `${new Date(now).toISOString()} no frames for ${gap}ms${recorder.isRecording() ? ' (recording)' : ''}
`;
  fs.stat(file, (_e, st) => {
    const write = st && st.size > 200000 ? fs.writeFile : fs.appendFile;
    write(file, line, () => {});
  });
}

function connectPhone() {
  if (!phoneWanted || phoneLink) return;
  const link = new phone.PhoneLink();
  phoneLink = link;

  let greeted = false;
  link.on('info', (info) => {
    const cameraChanged = !lastPhoneInfo || lastPhoneInfo.camera !== info.camera;
    lastPhoneInfo = info;
    toCamera('phone:info', info);

    // The phone app starts on automatic every time it is opened; put the
    // saved look back as soon as it says hello.
    if (!greeted) {
      greeted = true;
      const state = readState();
      const saved = state.phoneControls || {};
      // Camera first, as its own message: switching lens clears zoom and
      // focus on the phone, and the saved ones must land after that.
      if (state.phoneCamera && state.phoneCamera !== info.camera) {
        link.send({ set: { camera: state.phoneCamera } });
      }
      if (Object.keys(saved).length) link.send({ set: saved });
      return;
    }
    // Another camera has other ranges: redraw the panel for it.
    if (cameraChanged) sendPhoneControls();
  });
  link.on('config', (data) => toCamera('phone:config', data));
  link.on('frame', (frame) => {
    notePhoneArrival();
    toCamera('phone:frame', frame);
  });

  const lost = (why) => {
    if (phoneLink !== link) return;
    phoneLink = null;
    link.close();
    toCamera('phone:state', { connected: false, why });
    if (!phoneWanted) return;
    // adb forwards happily to an app that is not running, and the socket
    // then closes at once: bring the app up and try again.
    clearTimeout(phoneRetry);
    phoneRetry = setTimeout(() => {
      phone.launchApp(() => setTimeout(connectPhone, 1200));
    }, 1500);
  };
  link.on('close', () => lost('closed'));
  link.on('error', (err) => lost(err.message));
  link.connect();
}

function startPhone() {
  phoneWanted = true;
  if (phoneLink) {
    // The camera window was rebuilt (a shape change): give its new decoder
    // a fresh start rather than frames it cannot begin from.
    phoneLink.close();
    phoneLink = null;
  }
  phone.launchApp(() => setTimeout(connectPhone, 1200));
}

function stopPhone() {
  phoneWanted = false;
  clearTimeout(phoneRetry);
  if (phoneLink) phoneLink.close();
  phoneLink = null;
}

ipcMain.handle('phone:available', () =>
  new Promise((resolve) => phone.listDevices((err, devices) => resolve(!err && devices.length > 0)))
);
ipcMain.on('phone:start', () => startPhone());
// The camera page cannot decode a delta frame after it skipped or errored;
// asking the phone for a keyframe now beats waiting up to a second for the
// next scheduled one.
ipcMain.on('phone:keyframe', () => {
  if (phoneLink) phoneLink.send({ keyframe: true });
});
// Every few seconds while the phone is the source: how the decoder is doing.
// Kept only when something is off, so the log stays about problems.
ipcMain.on('phone:stats', (_e, s) => {
  if (!s || (!s.errors && !s.skips && s.maxQueue < 8 && s.in - s.out < 2)) return;
  const file = path.join(app.getPath('userData'), 'phone-link.log');
  const line = `${new Date().toISOString()} decoder in=${s.in} out=${s.out} errors=${s.errors} skips=${s.skips} maxQueue=${s.maxQueue} hw=${s.hw}${recorder.isRecording() ? ' (recording)' : ''}\n`;
  fs.appendFile(file, line, () => {});
});
ipcMain.on('phone:stop', () => stopPhone());
ipcMain.on('shape:set', (_e, shape) => writeState({ shape }));

ipcMain.on('mode:set', (_e, { mode, reposition }) =>
  applyMode(mode, { reposition })
);

// Dock side mode to an edge of the recording display: full work-area
// height, width from the fraction, no native locks -- the interaction code
// keeps it there during a resize.
function snapSide(fraction, edge, display) {
  if (!win || win.isDestroyed()) return;
  // Dock on the screen the camera is already on. It used to dock on the
  // screen saved from the last recording, so switching to side mode on the
  // laptop threw the camera across to another monitor.
  const area = (display || cameraDisplay()).workArea;
  const width = Math.round(Math.max(160, Math.min(area.width, area.width * fraction)));
  // Lift any lock from the previous display before setting the new bounds.
  win.setMaximumSize(0, 0);
  win.setMinimumSize(160, 160);
  win.setAspectRatio(0);
  win.setBounds({
    width,
    height: area.height,
    x: edge === 'right' ? area.x + area.width - width : area.x,
    y: area.y,
  });
  writeState({ mode: 'side', edge, bounds: win.getBounds() });
  applyNativeLocks();
  win.webContents.send('camera:edge', edge);
}

ipcMain.on('window:snap', (_e, { fraction, edge }) => snapSide(fraction, edge));

// ---------------------------------------------------------------------------
// The controls
//
// The camera window is what gets recorded, so anything drawn inside it lands
// in the file. The controls live in their own content-protected window
// instead (WDA_EXCLUDEFROMCAPTURE): visible and clickable on the monitor
// throughout a take, absent from the recording. That is what lets the size
// be changed and the take be stopped mid-recording from the camera itself.
// ---------------------------------------------------------------------------
// Tall enough for the buttons plus the in-page tooltip beneath them; the
// window is transparent, so the spare height shows nothing until a label
// appears in it.
const HUD_SIZE = { width: 180, height: 74 };

function hudBounds() {
  const b = win.getBounds();
  return {
    x: Math.round(b.x + (b.width - HUD_SIZE.width) / 2),
    // Centre the BUTTONS on the camera, not the window: the tooltip sits in
    // the space below them.
    y: Math.round(b.y + (b.height - 44) / 2),
    width: HUD_SIZE.width,
    height: HUD_SIZE.height,
  };
}

function showHud() {
  if (!win || win.isDestroyed()) return;
  if (hudWin && !hudWin.isDestroyed()) {
    hudWin.setBounds(hudBounds());
    return;
  }

  hudWin = new BrowserWindow({
    ...hudBounds(),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    // Focusable, unlike the frame overlay: Windows does not deliver clicks
    // to an unfocusable window, so the buttons here would do nothing. It is
    // shown with showInactive so it still never steals focus.
    focusable: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'hud-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  hudWin.setAlwaysOnTop(true, 'screen-saver');
  hudWin.setContentProtection(true);
  hudWin.setMenu(null);
  // The controls cover the middle of the camera, so a right-click there
  // must reach the same menu rather than doing nothing.
  hudWin.webContents.on('context-menu', () => showCameraMenu());
  hudWin.loadFile('hud.html');
  hudWin.webContents.on('did-finish-load', () => {
    if (!hudWin || hudWin.isDestroyed()) return;
    hudWin.showInactive();
    hudWin.webContents.send('hud:recording', recorder.isRecording());
  });
  hudWin.on('closed', () => {
    hudWin = null;
  });
}

function hideHud() {
  if (hudWin && !hudWin.isDestroyed()) hudWin.close();
  hudWin = null;
}

// Hidden rather than closed: the window is rebuilt often enough that
// closing it for a three second countdown would be wasteful, and a hidden
// window cannot intercept clicks.
function setHudVisible(visible) {
  hudSuppressed = !visible;
  syncSatellites();
}

// The controls and the settings panels are separate always-on-top windows,
// so nothing makes them follow the camera by themselves. Rather than chase
// every way a window can be hidden (taskbar click, Win+D, Win+M, a hide
// call), their visibility is derived from the camera's actual state: if the
// camera is not on screen, neither are they, and they come back with it.
let panelsHiddenWithCamera = [];

function syncSatellites() {
  if (!win || win.isDestroyed()) return;
  const cameraShown = win.isVisible() && !win.isMinimized();

  if (hudWin && !hudWin.isDestroyed()) {
    const want = cameraShown && !hudSuppressed;
    if (want && !hudWin.isVisible()) hudWin.showInactive();
    else if (!want && hudWin.isVisible()) hudWin.hide();
  }

  // The recording panel and capture frame are left alone: a take can be
  // running with the camera minimized, and Stop has to stay reachable.
  if (!cameraShown) {
    for (const p of [settingsWin, visualWin]) {
      if (p && !p.isDestroyed() && p.isVisible()) {
        p.hide();
        panelsHiddenWithCamera.push(p);
      }
    }
  } else if (panelsHiddenWithCamera.length) {
    for (const p of panelsHiddenWithCamera) {
      if (p && !p.isDestroyed()) p.showInactive();
    }
    panelsHiddenWithCamera = [];
  }
}

// Right-click anywhere on the camera. Deliberately plain: this exists so
// there is always a way to reach Settings and Close, whatever the controls
// are doing.
function showCameraMenu() {
  if (!win || win.isDestroyed()) return;
  Menu.buildFromTemplate([
    {
      label: recorder.isRecording() ? 'Stop recording' : 'Start recording',
      click: () => startRecording(),
    },
    { type: 'separator' },
    { label: 'Settings…', click: () => openSettings() },
    { type: 'separator' },
    { label: 'Close Obsoloom', click: () => win && !win.isDestroyed() && win.close() },
  ]).popup({ window: win });
}

function moveHud() {
  if (hudWin && !hudWin.isDestroyed() && win && !win.isDestroyed()) {
    hudWin.setBounds(hudBounds());
  }
}

// Both windows sit at the same always-on-top level, so anything that raises
// the camera (a click on it, opening a panel) buries the controls behind it
// and they stay there -- present, centred, and invisible. Lift them back
// whenever the camera comes forward.
function raiseHud() {
  if (!hudWin || hudWin.isDestroyed()) return;
  hudWin.setAlwaysOnTop(true, 'screen-saver');
  hudWin.moveTop();
}

// The controls fade with the pointer's distance from the camera's centre.
// Their own window is only as big as the buttons, so the pointer is tracked
// here rather than in the page.
let hudTimer = null;

function watchHudProximity() {
  if (hudTimer) return;
  let ticks = 0;
  hudTimer = setInterval(() => {
    if (!hudWin || hudWin.isDestroyed() || !win || win.isDestroyed()) return;
    const b = win.getBounds();
    const c = screen.getCursorScreenPoint();
    const dx = c.x - (b.x + b.width / 2);
    const dy = c.y - (b.y + b.height / 2);
    hudWin.webContents.send('hud:proximity', Math.hypot(dx, dy));

    // Anything that raises the camera or a panel buries the controls behind
    // it, where they stay for good. Re-asserting the top spot here covers
    // every such path, including ones Electron raises no event for; it is a
    // no-op when they are already on top.
    // Whatever hid or restored the camera, the satellites follow its real
    // state -- and hidden controls are never raised.
    syncSatellites();
    if (!hudWin.isVisible()) return;
    if (++ticks % 4 === 0) hudWin.moveTop();
  }, 80);
}

// ---------------------------------------------------------------------------
// The stage
//
// Side mode gives the camera a fifth of the screen and hands the rest to the
// window you were last using; breakout gives that window the whole screen and
// floats the camera on top. Whatever gets moved is recorded first and put
// back when the stage is released.
//
// Win32 works in physical pixels while Electron works in DIPs, so every
// rectangle crossing that boundary is scaled by the display's factor.
// ---------------------------------------------------------------------------
const SIDE_FRACTION = 1 / 5;

// The window we borrowed, and where it was before we touched it.
let stage = null;

function ownPids() {
  const pids = [process.pid];
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      const pid = w.webContents.getOSProcessId();
      if (pid) pids.push(pid);
    } catch {
      /* window already gone */
    }
  }
  return pids;
}

// Electron owns this conversion: doing the arithmetic by hand lands a window
// on the wrong monitor, because a display's physical origin is not its DIP
// origin times the scale factor.
function toPhysical(rect) {
  return screen.dipToScreenRect(null, {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
}

// Remember a window before moving it, so it can be put back exactly.
function claimStageWindow(id) {
  if (stage && stage.saved && stage.saved.id === String(id)) return true;
  releaseStage();
  const saved = native.getPlacement(id);
  if (!saved || !saved.rect) return false;
  stage = { saved };
  return true;
}

// Pick the window to use: the remembered one if it is still around, else
// whatever was in front when the app was last given focus.
function stageTarget() {
  const s = readState();
  if (s.stageWindow) {
    const still = native.getPlacement(s.stageWindow);
    if (still && still.title) return s.stageWindow;
  }
  const front = lastForeground || native.foregroundWindow(ownPids());
  return front ? front.id : null;
}

// Give the window the area the camera is not using.
function fillStage(mode) {
  if (!native.available()) return;
  const id = stageTarget();
  if (!id) return;
  if (!claimStageWindow(id)) return;

  const display = cameraDisplay();
  const area = display.workArea;
  const camera = win && !win.isDestroyed() ? win.getBounds() : null;

  let target;
  if (mode === 'side' && camera) {
    // Beside the docked column, never underneath it.
    const onLeft = (readState().edge || 'right') === 'left';
    const used = camera.width;
    target = {
      x: onLeft ? area.x + used : area.x,
      y: area.y,
      width: area.width - used,
      height: area.height,
    };
  } else {
    // Breakout: the whole work area, camera floating over it.
    target = { ...area };
  }

  writeState({ stageWindow: String(id) });
  native.placeWindow(id, toPhysical(target));
}

// Put the borrowed window back and forget it.
function releaseStage() {
  if (stage && stage.saved) native.restoreWindow(stage.saved);
  stage = null;
}

// The last window that was in front before Obsoloom took focus. Sampled
// continuously, because by the time a mode button is clicked the foreground
// window is one of ours.
let lastForeground = null;
let foregroundTimer = null;

function watchForeground() {
  if (foregroundTimer || !native.available()) return;
  const mine = ownPids();
  foregroundTimer = setInterval(() => {
    const front = native.foregroundWindow(mine);
    if (front) lastForeground = front;
  }, 700);
}

// Portrait/standard blur is a system-level camera effect applied by the
// NPU before any app sees a frame, so there is nothing to implement here --
// we just open the panel where Windows exposes the toggle.
ipcMain.on('effects:open', () => {
  openCameraSettings();
});

ipcMain.on('window:close', () => win?.close());

// Windows groups taskbar buttons by AppUserModelID. Without one, the app
// inherits Electron's identity and shows Electron's icon while running,
// however the launching shortcut is set up.
app.setAppUserModelId('com.obsoloom.app');

// Mid-take controls need to work without hunting for a button: reaching
// for the mouse mid-sentence is exactly what breaks the flow these shortcuts
// exist to protect.
function registerShortcuts() {
  // Ctrl+Alt+Shift: plain Ctrl+Shift+letter is taken system-wide by other
  // apps (Save As, DevTools, VS Code's palette), and a global shortcut steals
  // it from all of them while Obsoloom runs.
  // Spotlight: cut to fullscreen camera and back.
  globalShortcut.register('CommandOrControl+Alt+Shift+S', () => {
    if (recorder.isRecording()) {
      notifyRec({ spotlight: toggleSpotlight() });
    }
  });

  // Pause and resume without leaving the window you are demonstrating.
  globalShortcut.register('CommandOrControl+Alt+Shift+P', () => togglePause());

  // Stop and save.
  globalShortcut.register('CommandOrControl+Alt+Shift+X', () => {
    if (recorder.isRecording()) stopCapture();
  });

  // Shape and layout, without going through the settings panel: mid-take
  // these are the changes worth making, and reaching for a menu is what
  // breaks the flow.
  globalShortcut.register('CommandOrControl+Alt+Shift+C', () => setShape('circle'));
  globalShortcut.register('CommandOrControl+Alt+Shift+R', () => setShape('rounded'));
  // Ctrl+Alt+Shift+S is already spotlight, so square takes Q.
  globalShortcut.register('CommandOrControl+Alt+Shift+Q', () => setShape('sharp'));

  // Side <-> breakout, which also hands the screen to the window beside it.
  globalShortcut.register('CommandOrControl+Alt+Shift+F', () => {
    setMode(readState().mode === 'side' ? 'breakout' : 'side');
  });
}

// The settings panel changes shape over IPC; these do the same work so the
// panel, the window and the saved state cannot drift apart.
function setShape(shape) {
  if (!win || win.isDestroyed()) return;
  const prev = readState().shape || 'circle';
  if (prev === shape) return;
  writeState({ shape });

  if ((prev === 'circle') !== (shape === 'circle')) {
    // Circle <-> rectangle changes the window's transparency, which is fixed
    // at creation.
    recreateWindow();
    if (shape === 'circle' && readState().mode !== 'side') applyBreakoutSize('mid');
  } else {
    native.setCorners(win, shape === 'rounded');
    applyNativeLocks();
    win.webContents.send('camera:shape', shape);
  }
  pushState();
}

function setMode(mode) {
  if (!win || win.isDestroyed()) return;
  if (mode === 'side') {
    snapSide(SIDE_FRACTION, 'left');
    fillStage('side');
  } else {
    applyMode('breakout', { reposition: false });
    if ((readState().shape || 'circle') === 'circle') applyBreakoutSize('mid');
    fillStage('breakout');
  }
  win.webContents.send('camera:mode', mode);
  pushState();
  repositionSettings();
  moveHud();
}

// Every window here shows one of the app's own local pages and nothing
// else. By default Electron would navigate a window to any file dropped on
// it (with that window's preload still attached), open pop-ups, and grant
// any permission a page asks for. None of that is wanted.
function isOwnPage(url) {
  return typeof url === 'string' && url.startsWith('file://');
}
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.on('will-redirect', (e) => e.preventDefault());
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

// PowerShell by full path: a bare name is looked up in the current folder
// before PATH, and the current folder is not ours to trust.
const POWERSHELL = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
);

app.whenReady().then(async () => {
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((wc, _permission, cb) => cb(isOwnPage(wc.getURL())));
  session.defaultSession.setPermissionCheckHandler((wc) => !!wc && isOwnPage(wc.getURL()));

  await loadMonitorNames();
  createWindow();
  registerShortcuts();
  watchForeground();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (foregroundTimer) clearInterval(foregroundTimer);
  // Never leave someone's window resized to a fifth of the screen.
  releaseStage();
});
app.on('before-quit', (e) => {
  if (recorder.isRecording()) {
    e.preventDefault();
    recorder.stop(() => app.exit(0));
  }
});

app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
