// Vitest global setup for SignalX Arena tests.
//
// 1. Tells React 19 we are inside a test renderer so act(...) doesn't warn.
// 2. Polyfills window.localStorage / sessionStorage on opaque origins
//    (jsdom returns null storage when the document URL is `file://`,
//    which breaks any module that touches localStorage at import time).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem:    (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem:    (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear:      () => { store.clear(); },
    key:        (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  } satisfies Storage;
}

if (typeof window !== 'undefined') {
  // jsdom forbids history.pushState/replaceState on opaque origins (file://).
  // Wouter's hash-location hook uses pushState to update the hash, so when
  // tests run with a file:// document URL we route hash-only updates through
  // window.location.hash directly and dispatch the hashchange event manually.
  if (window.location.protocol === 'file:') {
    const fallback = (url: string | URL | null | undefined) => {
      const s = url == null ? '' : String(url);
      const hashIdx = s.indexOf('#');
      if (hashIdx === -1) return; // non-hash navigations are ignored on file://
      const oldHash = window.location.hash;
      const newHash = s.slice(hashIdx);
      if (newHash === oldHash) return;
      const oldURL = window.location.href;
      window.location.hash = newHash;
      window.dispatchEvent(
        new HashChangeEvent('hashchange', {
          oldURL,
          newURL: window.location.href,
        }),
      );
    };
    history.pushState    = (_data, _title, url) => fallback(url);
    history.replaceState = (_data, _title, url) => fallback(url);
  }

  if (!window.localStorage) {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: makeMemoryStorage(),
    });
  }
  if (!window.sessionStorage) {
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: makeMemoryStorage(),
    });
  }
}
