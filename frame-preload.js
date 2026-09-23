const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('frame', {
  onSet: (cb) => ipcRenderer.on('frame:set', (_e, v) => cb(v)),
});
