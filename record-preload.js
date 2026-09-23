const { contextBridge, ipcRenderer } = require('electron');

// Same narrow contract as the other windows: named actions only.
contextBridge.exposeInMainWorld('rec', {
  ready: () => ipcRenderer.send('rec:ready'),

  send: (action, value) => ipcRenderer.send('rec:action', { action, value }),

  onState: (cb) => ipcRenderer.on('rec:state', (_e, v) => cb(v)),
  onAudio: (cb) => ipcRenderer.on('rec:audio', (_e, v) => cb(v)),
  onRecording: (cb) => ipcRenderer.on('rec:recording', (_e, v) => cb(v)),
  onPaused: (cb) => ipcRenderer.on('rec:paused', (_e, v) => cb(v)),
  // The camera window's red button and its countdown Cancel land here.
  onGo: (cb) => ipcRenderer.on('rec:go', () => cb()),
  onCancelCountdown: (cb) => ipcRenderer.on('rec:cancelCountdown', () => cb()),
});
