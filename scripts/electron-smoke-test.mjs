#!/usr/bin/env node
// ─── Packaged Electron Smoke Test ─────────────────────────────────────────────
// Launches the packaged Windows build of SignalX AI Arena, waits for the
// BrowserWindow to load, and asserts the sign-in UI is actually rendered.
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

const UNPACKED_DIR = join(process.cwd(), 'dist-electron', 'win-unpacked');
const EXE_NAME     = 'SignalX AI Arena.exe';
const EXE_PATH     = join(UNPACKED_DIR, EXE_NAME);

const LOAD_TIMEOUT_MS = 60_000;
const TEXT_TIMEOUT_MS = 30_000;

function fail(msg) {
  console.error(`[smoke-test] FAIL: ${msg}`);
  process.exitCode = 1;
}

function info(msg) {
  console.log(`[smoke-test] ${msg}`);
}

if (!existsSync(EXE_PATH)) {
  console.error(`[smoke-test] expected packaged exe at: ${EXE_PATH}`);
  if (existsSync(UNPACKED_DIR)) {
    console.error('[smoke-test] win-unpacked contains:');
    for (const entry of readdirSync(UNPACKED_DIR)) console.error('  -', entry);
  }
  process.exit(1);
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
  process.exit(1);
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
