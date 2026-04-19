// ─── Icon Generator for Electron Build ────────────────────────────────────────
// Copies pwa-512.png → electron/icon.png (already done).
// On Windows CI, electron-builder auto-converts PNG → ICO.
// This script just verifies the icon exists and logs its size.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

const SRC  = path.join(ROOT, 'artifacts', 'signalx-arena', 'public', 'pwa-512.png');
const DEST = path.join(ROOT, 'electron', 'icon.png');

if (!fs.existsSync(DEST)) {
  if (fs.existsSync(SRC)) {
    fs.copyFileSync(SRC, DEST);
    console.log('✅ Icon copied:', DEST);
  } else {
    console.warn('⚠️  Source icon not found at', SRC, '— using fallback');
  }
} else {
  const stat = fs.statSync(DEST);
  console.log(`✅ Icon ready: ${DEST} (${(stat.size / 1024).toFixed(1)} KB)`);
}
