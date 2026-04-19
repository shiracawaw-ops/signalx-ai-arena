// ─── SignalX AI Arena — Electron Main Process ─────────────────────────────────
// Spawns the bundled Express API server, then opens a BrowserWindow
// loading the Vite-built frontend. Works on Windows 10/11 (x64 / arm64).

const { app, BrowserWindow, shell, dialog } = require('electron');
const path  = require('path');
const fs    = require('fs');
const http  = require('http');
const { spawn } = require('child_process');

// ── Paths ──────────────────────────────────────────────────────────────────────
const IS_PACKAGED = app.isPackaged;

function resourcePath(...parts) {
  return IS_PACKAGED
    ? path.join(process.resourcesPath, ...parts)
    : path.join(__dirname, '..', ...parts);
}

const FRONTEND_DIR   = IS_PACKAGED
  ? resourcePath('frontend')
  : path.join(__dirname, '..', 'artifacts', 'signalx-arena', 'dist');

const API_ENTRY      = IS_PACKAGED
  ? resourcePath('api-server', 'dist', 'index.mjs')
  : path.join(__dirname, '..', 'artifacts', 'api-server', 'dist', 'index.mjs');

const API_PORT       = 18080;   // dedicated port to avoid collision with dev workflow

// ── API-server child process ────────────────────────────────────────────────────
let apiProc = null;

function startApiServer() {
  if (!fs.existsSync(API_ENTRY)) {
    console.warn('[electron] API server bundle not found at', API_ENTRY);
    return;
  }

  const nodeExe = process.execPath.replace(/electron(\.exe)?$/i, 'node$1');
  const nodeCmd  = fs.existsSync(nodeExe) ? nodeExe : 'node';

  apiProc = spawn(nodeCmd, ['--enable-source-maps', API_ENTRY], {
    env: {
      ...process.env,
      PORT:     String(API_PORT),
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  apiProc.stdout.on('data', d => process.stdout.write('[api] ' + d));
  apiProc.stderr.on('data', d => process.stderr.write('[api] ' + d));

  apiProc.on('exit', code => {
    if (code && code !== 0) {
      console.error('[electron] API server exited with code', code);
    }
  });
}

// ── Wait for API server to be ready ────────────────────────────────────────────
function waitForApi(retries, callback) {
  http.get(`http://localhost:${API_PORT}/api/healthz`, res => {
    callback(null);
  }).on('error', () => {
    if (retries <= 0) { callback(new Error('API server did not start')); return; }
    setTimeout(() => waitForApi(retries - 1, callback), 400);
  });
}

// ── BrowserWindow ───────────────────────────────────────────────────────────────
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width:          1440,
    height:         900,
    minWidth:       1024,
    minHeight:      640,
    backgroundColor: '#09090b',
    show:           false,
    title:          'SignalX AI Arena',
    icon:           path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      nodeIntegration:  false,
      contextIsolation: true,
      // Inject the API port so the frontend knows where to connect
      additionalArguments: [`--api-port=${API_PORT}`],
    },
  });

  const indexHtml = path.join(FRONTEND_DIR, 'index.html');
  if (fs.existsSync(indexHtml)) {
    mainWindow.loadFile(indexHtml);
  } else {
    // Fallback to dev server (unpackaged dev run)
    mainWindow.loadURL('http://localhost:24952');
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Open external links in the OS browser, not inside Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── App lifecycle ───────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  startApiServer();

  waitForApi(40, err => {
    if (err) {
      dialog.showErrorBox(
        'SignalX — Startup Error',
        'The local API server failed to start.\n\nThe app will run in demo mode only.',
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
  if (apiProc && !apiProc.killed) {
    apiProc.kill('SIGTERM');
    apiProc = null;
  }
}
