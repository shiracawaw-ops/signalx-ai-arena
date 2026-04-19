// ─── SignalX AI Arena — Electron Main Process ─────────────────────────────────
// Uses utilityProcess.fork() (Electron 22+) to embed the Express API server
// without needing a separate node.exe binary — works in packaged Windows EXE.

const { app, BrowserWindow, shell, dialog, utilityProcess } = require('electron');
const path = require('path');
const fs   = require('fs');
const http = require('http');

// ── Paths ──────────────────────────────────────────────────────────────────────
const IS_PACKAGED = app.isPackaged;
const DEBUG_MODE  =
  process.env.SIGNALX_DEBUG === '1' ||
  process.argv.includes('--debug');

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
let apiProc       = null;
let apiStartError = null;

function startApiServer() {
  if (!fs.existsSync(API_ENTRY)) {
    const msg = `API server bundle missing at: ${API_ENTRY}`;
    console.error('[electron]', msg);
    apiStartError = msg;
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

function createWindow(startupError) {
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

  // Surface any startup error inside the window itself (not just in DevTools).
  if (startupError) {
    mainWindow.webContents.once('did-finish-load', () => {
      const safe = String(startupError).replace(/`/g, "\\`").replace(/\$/g, '\\$');
      mainWindow.webContents.executeJavaScript(`
        (function() {
          var box = document.createElement('div');
          box.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;'
            + 'background:#7f1d1d;color:#fee2e2;padding:10px 16px;'
            + 'font:13px ui-monospace,Menlo,monospace;border-bottom:1px solid #ef4444;';
          box.textContent = 'SignalX startup warning: ' + \`${safe}\`;
          document.body.appendChild(box);
        })();
      `).catch(() => { /* swallow — best-effort overlay */ });
    });
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
    if (DEBUG_MODE) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
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

  // If the API bundle is missing, don't waste 20 seconds polling — open the
  // window immediately with an in-window warning banner.
  if (apiStartError) {
    dialog.showErrorBox(
      'SignalX — Startup Warning',
      `The local API server bundle is missing.\n\n${apiStartError}\n\n` +
      'The app will open in demo mode — real trading will be unavailable.',
    );
    createWindow(apiStartError);
    return;
  }

  waitForApi(50, err => {
    if (err) {
      const msg = 'The local API server failed to start within the expected time. ' +
                  'The app will open in demo mode — real trading will be unavailable.';
      dialog.showErrorBox('SignalX — Startup Error', msg);
      createWindow(msg);
      return;
    }
    createWindow(null);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(null);
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
