const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('notificationSound', {
  onPlay: callback => ipcRenderer.on('notification:sound', (_event, value) => { if (value === 'attention' || value === 'complete') callback(value); })
});
