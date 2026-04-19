// ─── Error Page Preload — Context Bridge ──────────────────────────────────────
// Exposes diagnostics + reopen/quit/copy IPC to the bundled error.html.

const { contextBridge, ipcRenderer } = require('electron');

function parseInfo() {
  const arg = process.argv.find(a => a.startsWith('--signalx-error='));
  if (!arg) return null;
  try {
    return JSON.parse(decodeURIComponent(arg.slice('--signalx-error='.length)));
  } catch {
    return null;
  }
}

contextBridge.exposeInMainWorld('signalxErrorPage', {
  info: parseInfo() || {
    message: 'Unknown error',
    version: '?',
    platform: process.platform,
    electron: process.versions.electron,
  },
  reopen:          () => ipcRenderer.send('signalx-error:reopen'),
  quit:            () => ipcRenderer.send('signalx-error:quit'),
  copyDiagnostics: (text) => ipcRenderer.send('signalx-error:copy', text),
});
