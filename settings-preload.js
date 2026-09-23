const { contextBridge, ipcRenderer } = require('electron');

// Same narrow contract as the camera window's preload: a fixed set of named
// actions, no node, no fs, no arbitrary channels.
contextBridge.exposeInMainWorld('settings', {
  ready: () => ipcRenderer.send('settings:ready'),

  send: (action, value) => ipcRenderer.send('settings:action', { action, value }),

  onState: (cb) =>
    ipcRenderer.on('settings:state', (_e, state) => cb(state)),

  onModes: (cb) => ipcRenderer.on('settings:modes', (_e, list) => cb(list)),

  onAudio: (cb) => ipcRenderer.on('settings:audio', (_e, list) => cb(list)),

  onCameras: (cb) =>
    ipcRenderer.on('settings:cameras', (_e, payload) => cb(payload)),
});
