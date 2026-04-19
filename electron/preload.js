// ─── Electron Preload — Context Bridge ────────────────────────────────────────
// Exposes a minimal, safe API to the renderer process.
// No Node.js APIs are directly exposed to the web content.

const { contextBridge, ipcRenderer } = require('electron');

// Read the --api-port flag injected by main.js
const apiPortArg = process.argv.find(a => a.startsWith('--api-port='));
const apiPort    = apiPortArg ? Number(apiPortArg.split('=')[1]) : 18080;

contextBridge.exposeInMainWorld('signalxElectron', {
  // The renderer uses this to build the correct backend URL
  apiPort,
  platform: process.platform,
  version:  process.env.npm_package_version || '1.0.0',
});
