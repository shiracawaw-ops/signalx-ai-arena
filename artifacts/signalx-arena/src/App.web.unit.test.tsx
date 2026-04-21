// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://localhost/signalx-arena/login" }

// Smoke test for the web (path-based routing) build. Locks in that:
//   - The router resolves /signalx-arena/login → the login page
//   - Wouter <Link> components emit hrefs that include the /signalx-arena/
//     base prefix (a base-path regression would silently emit `/login`
//     and break the multi-app proxy routing)
//   - Mounting does not silently strip the base and redirect to bare /login

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const BASE = '/signalx-arena/';

beforeAll(() => {
  vi.stubEnv('BASE_URL', BASE);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

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

describe('Web build — routing smoke test (path-based, BASE_URL=/signalx-arena/)', () => {
  it('renders the SignalX login UI under /signalx-arena/login', { timeout: 15_000 }, async () => {
    expect(window.location.protocol).toBe('http:');
    expect(window.location.pathname).toBe('/signalx-arena/login');

    // Dynamic import so module-level reads of import.meta.env.BASE_URL
    // happen after vi.stubEnv() has run.
    const { default: App } = await import('./App');

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
    expect(text).not.toMatch(/404/);
    expect(container.querySelector('input[type="email"]')).not.toBeNull();

    // Base-path validation: routing must not have collapsed the URL to
    // a bare /login (which is the failure mode the reviewer flagged).
    expect(window.location.pathname.startsWith(BASE)).toBe(true);

    // Wouter <Link> hrefs (e.g. "Forgot password?", "Create one free")
    // should be prefixed with the base path. If BASE_URL handling regresses
    // they would render as `/forgot-password` / `/signup` and break routing
    // behind the workspace proxy.
    const anchors = Array.from(container.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    const internalHrefs = anchors
      .map(a => a.getAttribute('href') ?? '')
      .filter(href => href.startsWith('/'));

    expect(internalHrefs.length).toBeGreaterThan(0);
    for (const href of internalHrefs) {
      expect(
        href.startsWith(BASE),
        `internal link must include base path "${BASE}": ${href}`,
      ).toBe(true);
    }
  });
});
