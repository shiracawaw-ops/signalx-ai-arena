export interface DustFocusRequest {
  exchange: string;
  asset:    string;
}

let pending: DustFocusRequest | null = null;
const listeners = new Set<(req: DustFocusRequest) => void>();

export function requestDustFocus(req: DustFocusRequest): void {
  const normalized: DustFocusRequest = {
    exchange: req.exchange,
    asset:    req.asset.toUpperCase(),
  };
  pending = normalized;
  for (const cb of listeners) {
    try { cb(normalized); } catch { /* listener errors must not block others */ }
  }
}

export function consumeDustFocus(): DustFocusRequest | null {
  const p = pending;
  pending = null;
  return p;
}

export function peekDustFocus(): DustFocusRequest | null {
  return pending;
}

export function subscribeDustFocus(cb: (req: DustFocusRequest) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function __resetDustFocusForTests(): void {
  pending = null;
  listeners.clear();
}
