const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, fn) => ipcRenderer.on(channel, () => fn()),
  pathFor: file => webUtils.getPathForFile(file), // real path of a file dropped from Explorer
});
