const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('openClaudeDesktop', {
  getMeta: () => ipcRenderer.invoke('desktop:get-meta'),
  selectWorkspace: () => ipcRenderer.invoke('desktop:select-workspace'),
  openExternal: url => ipcRenderer.invoke('desktop:open-external', url),
})
