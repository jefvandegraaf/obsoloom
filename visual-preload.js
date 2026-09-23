const { contextBridge, ipcRenderer } = require('electron');

// Same narrow contract as the other windows: named actions only.
contextBridge.exposeInMainWorld('visual', {
  ready: () => ipcRenderer.send('visual:ready'),
  send: (action, value) => ipcRenderer.send('visual:action', { action, value }),
  onCaps: (cb) => ipcRenderer.on('visual:caps', (_e, v) => cb(v)),
});
