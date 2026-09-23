const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hud', {
  record: () => ipcRenderer.send('record:start'),
  settings: () => ipcRenderer.send('settings:open'),
  close: () => ipcRenderer.send('window:close'),

  onProximity: (cb) => ipcRenderer.on('hud:proximity', (_e, v) => cb(v)),
  onRecording: (cb) => ipcRenderer.on('hud:recording', (_e, v) => cb(v)),
});
