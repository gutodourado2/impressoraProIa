const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Config
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  printTest: () => ipcRenderer.invoke('print-test'),
  reprintOrder: (pedidoId, isSegundaVia) => ipcRenderer.invoke('reprint-order', pedidoId, isSegundaVia),
  getStatus: () => ipcRenderer.invoke('get-status'),

  // Atualizações e links
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (_, data) => callback(data)),

  // Window controls
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),

  // Events from backend
  onStatusChange: (callback) => ipcRenderer.on('status-change', (_, status) => callback(status)),
  onPedidoImpresso: (callback) => ipcRenderer.on('pedido-impresso', (_, id) => callback(id)),
  onPrintError: (callback) => ipcRenderer.on('print-error', (_, error) => callback(error)),
});
