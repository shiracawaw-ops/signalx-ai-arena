// ─── SignalX AI Arena — Electron Main Process ─────────────────────────────────
// Uses utilityProcess.fork() (Electron 22+) to embed the Express API server
// without needing a separate node.exe binary — works in packaged Windows EXE.

const { app, BrowserWindow, shell, dialog, utilityProcess, ipcMain, clipboard } = require('electron');
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

// ── Error fallback ────────────────────────────────────────────────────────────
// Loaded when the renderer fails to load (did-fail-load) or the renderer
// process crashes (render-process-gone). Replaces the otherwise-blank window
// with a static page that surfaces the error and lets the user retry.
const ERROR_HTML     = path.join(__dirname, 'error.html');
const ERROR_PRELOAD  = path.join(__dirname, 'error-preload.js');

let showingError      = false;
let errorIpcRegistered = false;

function registerErrorIpc() {
  if (errorIpcRegistered) return;
  errorIpcRegistered = true;

  ipcMain.on('signalx-error:reopen', () => {
    if (mainWindow) {
      mainWindow.close();
      mainWindow = null;
    }
    showingError = false;
    createWindow(null);
  });
  ipcMain.on('signalx-error:quit', () => app.quit());
  ipcMain.on('signalx-error:copy', (_evt, text) => {
    if (typeof text === 'string') clipboard.writeText(text);
  });
}

function showErrorPage(reason) {
  if (showingError || !mainWindow || mainWindow.isDestroyed()) return;
  showingError = true;

  const info = {
    message:  String(reason || 'Unknown error'),
    version:  app.getVersion(),
    platform: `${process.platform} ${process.arch}`,
    electron: process.versions.electron,
  };

  console.error('[electron] showing error fallback:', info.message);

  // Re-create window with the error preload so the page can use IPC + diagnostics.
  try { mainWindow.removeAllListeners('closed'); } catch { /* ignore */ }
  try { mainWindow.destroy(); } catch { /* ignore */ }

  mainWindow = new BrowserWindow({
    width:           720,
    height:          560,
    minWidth:        480,
    minHeight:       360,
    backgroundColor: '#09090b',
    show:            true,
    title:           'SignalX AI Arena — Failed to load',
    webPreferences: {
      preload:             ERROR_PRELOAD,
      nodeIntegration:     false,
      contextIsolation:    true,
      additionalArguments: [
        '--signalx-error=' + encodeURIComponent(JSON.stringify(info)),
      ],
    },
  });

  mainWindow.on('closed', () => { mainWindow = null; showingError = false; });

  mainWindow.loadFile(ERROR_HTML).catch((e) => {
    // Last-ditch: native dialog if even the bundled error page can't load.
    dialog.showErrorBox(
      'SignalX — Failed to load',
      `${info.message}\n\n(The bundled error screen also failed to load: ${e?.message || e})`,
    );
  });
}

// ── BrowserWindow ─────────────────────────────────────────────────────────────
let mainWindow = null;

// Per-session renderer crash counter. The first render-process-gone triggers a
// silent reload; the second (or later) shows the error fallback. Reset to 0
// whenever the bundle finishes loading successfully.
let rendererCrashCount = 0;

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

  // Reset the per-session crash counter once the bundle loads successfully so a
  // future crash also gets one silent retry.
  mainWindow.webContents.on('did-finish-load', () => {
    rendererCrashCount = 0;
  });

  // ── Renderer load failures → show the error fallback page ──────────────────
  // did-fail-load (the bundle itself failed) always goes straight to the error
  // screen — retrying a broken bundle would just loop.
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;          // ignore subframe/asset failures
    if (errorCode === -3) return;      // ERR_ABORTED — usually a user/nav cancel
    showErrorPage(
      `Failed to load application window.\n\n` +
      `URL:   ${validatedURL}\n` +
      `Code:  ${errorCode}\n` +
      `Cause: ${errorDescription || 'unknown'}`,
    );
  });

  // First render-process-gone of the session → silently re-create the window.
  // Second (or later) → fall through to the error screen.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    rendererCrashCount += 1;

    if (rendererCrashCount === 1) {
      console.warn(
        '[electron] renderer crashed (reason=' + (details?.reason || 'unknown') +
        ', exitCode=' + (details?.exitCode ?? 'n/a') + ') — silently reloading once',
      );
      try { mainWindow.removeAllListeners('closed'); } catch { /* ignore */ }
      try { mainWindow.destroy(); } catch { /* ignore */ }
      mainWindow = null;
      createWindow(null);
      return;
    }

    showErrorPage(
      `The application window crashed.\n\n` +
      `Reason:    ${details?.reason || 'unknown'}\n` +
      `Exit code: ${details?.exitCode ?? 'n/a'}`,
    );
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  registerErrorIpc();
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
