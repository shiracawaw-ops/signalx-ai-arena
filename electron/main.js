// ─── SignalX AI Arena — Electron Main Process ─────────────────────────────────
// Uses utilityProcess.fork() (Electron 22+) to embed the Express API server
// without needing a separate node.exe binary — works in packaged Windows EXE.

const { app, BrowserWindow, shell, dialog, utilityProcess } = require('electron');
const path = require('path');
const fs   = require('fs');
const http = require('http');

// ── Paths ──────────────────────────────────────────────────────────────────────
const IS_PACKAGED = app.isPackaged;

function resourcePath(...parts) {
  return IS_PACKAGED
    ? path.join(process.resourcesPath, ...parts)
    : path.join(__dirname, '..', ...parts);
}

// Packaged: resources/frontend/ — Unpackaged: the electron Vite build output
const FRONTEND_DIR = IS_PACKAGED
  ? resourcePath('frontend')
  : path.join(__dirname, '..', 'artifacts', 'signalx-arena', 'dist-electron');

// Packaged: resources/api-server/dist/index.mjs — Unpackaged: dev build
const API_ENTRY = IS_PACKAGED
  ? resourcePath('api-server', 'dist', 'index.mjs')
  : path.join(__dirname, '..', 'artifacts', 'api-server', 'dist', 'index.mjs');

const API_PORT = 18080;

// ── API server via utilityProcess ─────────────────────────────────────────────
// utilityProcess.fork() runs a Node.js script inside Electron's process model
// without requiring a separate node.exe binary — safe in packaged apps.
let apiProc = null;

function startApiServer() {
  if (!fs.existsSync(API_ENTRY)) {
    console.warn('[electron] API entry not found:', API_ENTRY);
    return;
  }

  apiProc = utilityProcess.fork(API_ENTRY, [], {
    env: {
      ...process.env,
      PORT:     String(API_PORT),
      NODE_ENV: 'production',
    },
    stdio: 'pipe',
  });

  apiProc.stdout?.on('data', d => process.stdout.write('[api] ' + d));
  apiProc.stderr?.on('data', d => process.stderr.write('[api] ' + d));

  apiProc.on('exit', code => {
    if (code && code !== 0) {
      console.error('[electron] API server exited with code', code);
    }
    apiProc = null;
  });
}

// ── Wait for API server to respond ────────────────────────────────────────────
function waitForApi(retries, callback) {
  http.get(`http://localhost:${API_PORT}/api/healthz`, () => {
    callback(null);
  }).on('error', () => {
    if (retries <= 0) {
      callback(new Error('API server did not start within timeout'));
      return;
    }
    setTimeout(() => waitForApi(retries - 1, callback), 400);
  });
}

// ── BrowserWindow ─────────────────────────────────────────────────────────────
let mainWindow = null;

function createWindow() {
  const iconPath = path.join(__dirname, 'icon.png');

  mainWindow = new BrowserWindow({
    width:           1440,
    height:          900,
    minWidth:        1024,
    minHeight:       640,
    backgroundColor: '#09090b',
    show:            false,
    title:           'SignalX AI Arena',
    icon:            fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload:             path.join(__dirname, 'preload.js'),
      nodeIntegration:     false,
      contextIsolation:    true,
      additionalArguments: [`--api-port=${API_PORT}`],
    },
  });

  const indexHtml = path.join(FRONTEND_DIR, 'index.html');
  if (fs.existsSync(indexHtml)) {
    mainWindow.loadFile(indexHtml);
  } else {
    // Fallback for unpackaged dev run without a prior build
    mainWindow.loadURL('http://localhost:24952');
    console.warn('[electron] index.html not found at', indexHtml, '— falling back to dev server');
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  startApiServer();

  waitForApi(50, err => {
    if (err) {
      dialog.showErrorBox(
        'SignalX — Startup Error',
        'The local API server failed to start.\n\nThe app will open in demo mode — real trading will be unavailable.',
      );
    }
    createWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  killApi();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', killApi);

function killApi() {
  if (apiProc) {
    try {
      apiProc.kill();
      console.log('[electron] API server process terminated');
    } catch (e) {
      console.warn('[electron] killApi error (non-fatal):', e?.message ?? e);
    }
    apiProc = null;
  }
}
