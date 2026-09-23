const { contextBridge, ipcRenderer } = require('electron');

// Deliberately narrow: the renderer gets window controls and persisted
// preferences, nothing else. No node, no fs, no arbitrary IPC.
contextBridge.exposeInMainWorld('cam', {
  getPrefs: () => ipcRenderer.invoke('prefs:get'),

  setMirror: (mirror) => ipcRenderer.send('mirror:set', mirror),
  setDevice: (deviceId) => ipcRenderer.send('device:set', deviceId),
  setShape: (shape) => ipcRenderer.send('shape:set', shape),

  setMode: (mode, reposition = false) =>
    ipcRenderer.send('mode:set', { mode, reposition }),

  snap: (fraction, edge) => ipcRenderer.send('window:snap', { fraction, edge }),

  openSettings: () => ipcRenderer.send('settings:open'),
  startRecording: () => ipcRenderer.send('record:start'),
  cancelCountdown: () => ipcRenderer.send('countdown:cancel'),
  openEffects: () => ipcRenderer.send('effects:open'),

  // Window geometry is driven from the main process, which polls the real
  // cursor position; the page only says when a gesture starts and stops.
  dragStart: () => ipcRenderer.send('drag:start'),
  resizeStart: (dir) => ipcRenderer.send('resize:start', dir),
  dragEnd: () => ipcRenderer.send('drag:end'),

  // Device list and live resolution for the separate settings window, which
  // has no camera access of its own.
  report: (payload) => ipcRenderer.send('camera:report', payload),

  // Changes made in the settings window arrive here.
  onMode: (cb) => ipcRenderer.on('camera:mode', (_e, v) => cb(v)),
  onEdge: (cb) => ipcRenderer.on('camera:edge', (_e, v) => cb(v)),
  onShape: (cb) => ipcRenderer.on('camera:shape', (_e, v) => cb(v)),
  onMirror: (cb) => ipcRenderer.on('camera:mirror', (_e, v) => cb(v)),
  onDevice: (cb) => ipcRenderer.on('camera:device', (_e, v) => cb(v)),
  onRecordState: (cb) => ipcRenderer.on('record:state', (_e, v) => cb(v)),
  onRequestModes: (cb) => ipcRenderer.on('camera:requestModes', () => cb()),

  openVisual: () => ipcRenderer.send('visual:open'),
  reportVisualCaps: (payload) => ipcRenderer.send('camera:visualCaps', payload),
  devicesChanged: () => ipcRenderer.send('devices:changed'),

  // The phone camera over USB. The main process owns the socket (a page
  // cannot open one) and relays the encoded packets here for decoding.
  phoneAvailable: () => ipcRenderer.invoke('phone:available'),
  phoneStart: () => ipcRenderer.send('phone:start'),
  phoneStop: () => ipcRenderer.send('phone:stop'),
  phoneKeyframe: () => ipcRenderer.send('phone:keyframe'),
  phoneStats: (s) => ipcRenderer.send('phone:stats', s),
  onPhoneInfo: (cb) => ipcRenderer.on('phone:info', (_e, v) => cb(v)),
  onPhoneConfig: (cb) => ipcRenderer.on('phone:config', (_e, v) => cb(v)),
  onPhoneFrame: (cb) => ipcRenderer.on('phone:frame', (_e, v) => cb(v)),
  onPhoneState: (cb) => ipcRenderer.on('phone:state', (_e, v) => cb(v)),
  onCountdown: (cb) => ipcRenderer.on('camera:countdown', (_e, n) => cb(n)),
  onSpotlight: (cb) => ipcRenderer.on('camera:spotlight', (_e, v) => cb(v)),
  onProbeVisual: (cb) => ipcRenderer.on('camera:probeVisual', () => cb()),
  onSetVisual: (cb) => ipcRenderer.on('camera:setVisual', (_e, v) => cb(v)),
  onResetVisual: (cb) => ipcRenderer.on('camera:resetVisual', () => cb()),
  onQuality: (cb) => ipcRenderer.on('camera:quality', (_e, v) => cb(v)),
  onPicture: (cb) => ipcRenderer.on('camera:picture', (_e, v) => cb(v)),
  reportModes: (modes) => ipcRenderer.send('camera:modes', modes),

  close: () => ipcRenderer.send('window:close'),
});
