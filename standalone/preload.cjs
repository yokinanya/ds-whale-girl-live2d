const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('whale', {
  getState: () => ipcRenderer.invoke('state'),
  saveConfig: config => ipcRenderer.invoke('save-config', config),
  connect: authCode => ipcRenderer.invoke('connect', authCode),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  perform: payload => ipcRenderer.invoke('perform', payload),
  copyOverlayUrl: () => ipcRenderer.invoke('copy-overlay-url'),
  onState: callback => { ipcRenderer.on('state-changed', (_event, state) => callback(state)) },
})
