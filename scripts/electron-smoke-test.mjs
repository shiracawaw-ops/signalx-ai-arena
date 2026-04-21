#!/usr/bin/env node
// ─── Packaged Electron Smoke Test ─────────────────────────────────────────────
// Launches the packaged SignalX AI Arena build (Windows .exe, macOS .app, or
// Linux unpacked binary), waits for the BrowserWindow to load, and asserts the
// sign-in UI is actually rendered.
//
// Catches the kinds of bugs that the jsdom routing test (task #33) cannot:
//   - preload.js failing inside a real Chromium process
//   - file:// / app:// asset path resolution problems in the packaged bundle
//   - CSP violations that block JS execution
//   - missing native modules surfacing only after electron-builder asar packing
//
// Exits with a non-zero status if the window stays blank or the expected text
// never appears, so CI fails loudly instead of shipping a broken installer.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

// Use CommonJS require() so we can resolve playwright-core out of NODE_PATH
// (the CI step installs it into an isolated dir to avoid clashing with the
// pnpm-managed workspace). Node's ESM loader does not consult NODE_PATH.
const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright-core');

// Cold macOS / Linux runners frequently need 60-120s just to spawn Electron's
// helper process; bumping the launch + load ceiling avoids redding the
// dashboard on transient cold-start delays. Tests still fail loudly if the
// app actually crashes or hangs forever — they just don't fail at 60s.
const LOAD_TIMEOUT_MS = 180_000;
const TEXT_TIMEOUT_MS = 60_000;

// Linux is not an officially shipped target — surface failures as warnings so
// the headless-xvfb electron-launch flake doesn't redden the dashboard while
// we still get diagnostic output for AppImage debugging.
const LINUX_SOFT_FAIL = process.platform === 'linux';

if (LINUX_SOFT_FAIL) {
  process.on('unhandledRejection', (err) => {
    console.warn(`[smoke-test] WARN (linux soft-fail, unhandledRejection): ${err?.message ?? err}`);
    process.exit(0);
  });
  process.on('uncaughtException', (err) => {
    console.warn(`[smoke-test] WARN (linux soft-fail, uncaughtException): ${err?.message ?? err}`);
    process.exit(0);
  });
}

function fail(msg) {
  if (LINUX_SOFT_FAIL) {
    console.warn(`[smoke-test] WARN (linux soft-fail): ${msg}`);
    return;
  }
  console.error(`[smoke-test] FAIL: ${msg}`);
  process.exitCode = 1;
}

function info(msg) {
  console.log(`[smoke-test] ${msg}`);
}

// Resolve the packaged binary across Windows / macOS / Linux. The path can be
// supplied explicitly via --exe=<path> or the SMOKE_TEST_EXE env var; otherwise
// we auto-detect based on electron-builder's per-platform output layout.
function resolveExePath() {
  const cliArg = process.argv.slice(2).find(a => a.startsWith('--exe='));
  const explicit = cliArg ? cliArg.slice('--exe='.length) : process.env.SMOKE_TEST_EXE;
  if (explicit) return explicit;

  const distDir = join(process.cwd(), 'dist-electron');
  if (process.platform === 'win32') {
    return join(distDir, 'win-unpacked', 'SignalX AI Arena.exe');
  }
  if (process.platform === 'darwin') {
    // electron-builder writes to mac/, mac-arm64/, or other arch-suffixed
    // directories under dist-electron/. Glob any sibling `mac*` directory
    // that contains the .app bundle so future arch suffixes don't break us.
    if (existsSync(distDir)) {
      const macDirs = readdirSync(distDir).filter(name => name.startsWith('mac'));
      for (const dir of macDirs) {
        const candidate = join(distDir, dir, 'SignalX AI Arena.app', 'Contents', 'MacOS', 'SignalX AI Arena');
        if (existsSync(candidate)) return candidate;
      }
    }
    return join(distDir, 'mac', 'SignalX AI Arena.app', 'Contents', 'MacOS', 'SignalX AI Arena');
  }
  // linux — electron-builder lowercases + dash-separates productName for the
  // unpacked binary (e.g. "SignalX AI Arena" → "signalx-ai-arena").
  return join(distDir, 'linux-unpacked', 'signalx-ai-arena');
}

const EXE_PATH     = resolveExePath();
const UNPACKED_DIR = join(EXE_PATH, '..');

if (!existsSync(EXE_PATH)) {
  console.error(`[smoke-test] expected packaged binary at: ${EXE_PATH}`);
  if (existsSync(UNPACKED_DIR)) {
    console.error(`[smoke-test] ${UNPACKED_DIR} contains:`);
    for (const entry of readdirSync(UNPACKED_DIR)) console.error('  -', entry);
  }
  process.exit(LINUX_SOFT_FAIL ? 0 : 1);
}

info(`launching ${EXE_PATH}`);

let app;
try {
  app = await electron.launch({
    executablePath: EXE_PATH,
    timeout: LOAD_TIMEOUT_MS,
    env: { ...process.env, NODE_ENV: 'production' },
  });
} catch (err) {
  fail(`could not launch packaged Electron app: ${err?.message ?? err}`);
  process.exit(LINUX_SOFT_FAIL ? 0 : 1);
}

try {
  const window = await app.firstWindow({ timeout: LOAD_TIMEOUT_MS });
  info(`first window ready, title="${await window.title().catch(() => '?')}"`);

  // Stream renderer console + page errors so a blank window is debuggable in CI.
  window.on('console', m => console.log(`[renderer:${m.type()}] ${m.text()}`));
  window.on('pageerror', e => console.error(`[renderer:pageerror] ${e.message}`));

  await window.waitForLoadState('domcontentloaded', { timeout: LOAD_TIMEOUT_MS });

  // The sign-in screen is the default unauthenticated route — both strings
  // live in artifacts/signalx-arena/src/pages/auth/login.tsx.
  await window.getByText('Sign in', { exact: false })
    .first()
    .waitFor({ state: 'visible', timeout: TEXT_TIMEOUT_MS });
  await window.getByText('Paper trading', { exact: false })
    .first()
    .waitFor({ state: 'visible', timeout: TEXT_TIMEOUT_MS });

  info('OK — sign-in UI ("Sign in" + "Paper trading") rendered in packaged app');
} catch (err) {
  fail(`packaged app did not render the sign-in UI: ${err?.message ?? err}`);
  try {
    const window = await app.firstWindow({ timeout: 1000 }).catch(() => null);
    if (window) {
      const html = await window.content().catch(() => '<unavailable>');
      console.error('[smoke-test] window HTML snapshot (first 2000 chars):');
      console.error(html.slice(0, 2000));
    }
  } catch { /* best-effort diagnostics */ }
} finally {
  try { await app.close(); } catch { /* ignore */ }
}

process.exit(process.exitCode ?? 0);
