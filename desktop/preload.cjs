const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel, callback) => {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('papertrailDesktop', {
  startDictation: () => ipcRenderer.invoke('papertrail:start-dictation'),
  openAISettings: () => ipcRenderer.invoke('papertrail:open-ai-settings'),
  getProjectLocation: () => ipcRenderer.invoke('papertrail:project-location'),
  chooseDirectory: (defaultPath) => ipcRenderer.invoke('papertrail:choose-directory', defaultPath),
  getAISettings: () => ipcRenderer.invoke('papertrail:get-ai-settings'),
  saveAISettings: (settings) => ipcRenderer.invoke('papertrail:save-ai-settings', settings),
  onAISettingsChanged: (callback) => listen('papertrail:ai-settings-changed', callback),
  onOpenStorage: (callback) => listen('papertrail:open-storage', callback),
  onPrepareClose: (callback) => listen('papertrail:prepare-close', callback),
  onCloseCancelled: (callback) => listen('papertrail:close-cancelled', callback),
  closePrepared: (id, error) => ipcRenderer.send('papertrail:close-prepared', id, error),
});
