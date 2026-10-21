const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('connectTogetherDesktop', {
  getServer: () => ipcRenderer.invoke('desktop:get-server'),
  connect: (url) => ipcRenderer.invoke('desktop:connect', url),
});
