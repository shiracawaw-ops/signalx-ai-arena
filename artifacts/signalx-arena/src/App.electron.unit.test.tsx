// @vitest-environment jsdom
// @vitest-environment-options { "url": "file:///__signalx_test__/dist-electron/index.html" }

// Smoke test for the Electron build. Has two layers:
//
//   (a) Build-output assertions on the actual artifact in dist-electron/.
//       These catch regressions where the build emits wrong asset paths
//       (e.g. absolute `/assets/...` instead of `./assets/...`) or sneaks
//       a service-worker registration back in — both of which produce a
//       blank window under file:// even though the React code is fine.
//
//   (b) A routing assertion that mounts <App /> under a file:// document
//       URL and checks that the SignalX login UI ("Sign in" / "Paper
//       trading") actually renders. This locks in the IS_ELECTRON branch
//       added in task #31.
//
// Together these cover the same blank-window class of bug at the artifact
// level (a) and the React/router level (b).

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';

const __filename = fileURLToPath(import.meta.url);
const __dirnameLocal = dirname(__filename);
const distElectron = resolve(__dirnameLocal, '..', 'dist-electron');
const indexHtmlPath = resolve(distElectron, 'index.html');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => { root!.unmount(); });
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
});

describe('Electron build — artifact assertions (dist-electron/)', () => {
  it('produced an index.html (run `pnpm run build:electron` first if this fails)', () => {
    expect(existsSync(indexHtmlPath)).toBe(true);
  });

  it('uses relative ./ asset paths so file:// loading works (no absolute /assets/ refs)', () => {
    const html = readFileSync(indexHtmlPath, 'utf-8');

    // Mounts a real <div id="root"> the renderer can attach to
    expect(html).toMatch(/<div id="root">/);

    // Has a module entry script
    const scriptMatches = [...html.matchAll(
      /<script[^>]*type="module"[^>]*src="([^"]+)"/g,
    )];
    expect(scriptMatches.length).toBeGreaterThan(0);

    for (const m of scriptMatches) {
      const src = m[1];
      // Under file:// an absolute path like /assets/index-X.js resolves to
      // the filesystem root and 404s — must be relative.
      expect(src.startsWith('./'), `script src must be relative for file://: ${src}`).toBe(true);
      expect(existsSync(resolve(distElectron, src))).toBe(true);
    }

    // CSS and modulepreload links must also be relative
    const linkMatches = [...html.matchAll(
      /<link[^>]*(?:href|src)="([^"]+)"/g,
    )];
    for (const m of linkMatches) {
      const href = m[1];
      if (href.startsWith('http')) continue;       // CDN fonts etc are fine
      if (href.startsWith('./')) continue;          // good
      // Anything else (e.g. "/assets/..") would break under file://
      expect(
        href.startsWith('./'),
        `link href must be relative for file://: ${href}`,
      ).toBe(true);
    }
  });

  it('does not register a service worker (would crash under file://)', () => {
    const html = readFileSync(indexHtmlPath, 'utf-8');
    expect(html).not.toMatch(/serviceWorker\.register|\/sw\.js|registerSW\.js/);
  });
});

describe('Electron build — routing smoke test (file:// document URL)', () => {
  it('renders the SignalX login UI under file:// (hash routing)', async () => {
    expect(window.location.protocol).toBe('file:');

    container = document.createElement('div');
    document.body.appendChild(container);

    await act(async () => {
      root = createRoot(container!);
      root.render(<App />);
    });

    const text = container.textContent ?? '';
    expect(text).toMatch(/Sign in/);
    expect(text).toMatch(/Paper trading/);
    expect(text).not.toMatch(/No route matched/i);
    expect(container.querySelector('input[type="email"]')).not.toBeNull();

    // The unauthenticated catch-all redirects to /login via the hash.
    // Under file:// it must use a hash route — never push a real path that
    // would be unreachable next time the file:// document loads.
    expect(window.location.hash).toBe('#/login');
  });
});
