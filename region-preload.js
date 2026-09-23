const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('region', {
  done: (r) => ipcRenderer.send('region:done', r),
  cancel: () => ipcRenderer.send('region:cancel'),
});
