const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lhc', {
  send: (ch, data) => ipcRenderer.send(ch, data),
  invoke: (ch, data) => ipcRenderer.invoke(ch, data),
  on: (ch, cb) => ipcRenderer.on(ch, (_e, data) => cb(data)),
});
