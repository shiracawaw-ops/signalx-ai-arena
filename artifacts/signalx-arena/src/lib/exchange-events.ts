// ─── Exchange Event Log ───────────────────────────────────────────────────────
// Structured, in-memory ring buffer of every exchange-related transition.
// Used by both the "Diagnostics" tab on the Exchange page and console logging
// so the user can copy a full trail without opening DevTools.
//
// API keys are always masked before storage.

import { maskKey } from './credential-store.js';

export type ExchangeStage =
  | 'save-keys'
  | 'validate'
  | 'connect'
  | 'fetch-balance'
  | 'order-poll'
  | 'parse-response'
  | 'switch-mode'
  | 'disconnect'
  | 'fallback'
  | 'state-change'
  | 'error';

export interface ExchangeEvent {
  id:        string;
  ts:        number;
  stage:     ExchangeStage;
  exchange:  string;
  message:   string;
  level:     'info' | 'warn' | 'error';
  data?:     Record<string, unknown>;
}

type Listener = (events: ExchangeEvent[]) => void;

const MAX_EVENTS = 200;

class ExchangeEventBus {
  private events: ExchangeEvent[] = [];
  private listeners: Set<Listener> = new Set();
  private seq = 0;

  log(stage: ExchangeStage, exchange: string, message: string, opts: {
    level?: 'info' | 'warn' | 'error';
    apiKey?: string;
    data?: Record<string, unknown>;
  } = {}): ExchangeEvent {
    const ev: ExchangeEvent = {
      id:       `e${++this.seq}_${Date.now().toString(36)}`,
      ts:       Date.now(),
      stage,
      exchange,
      level:    opts.level ?? 'info',
      message,
      data: {
        ...(opts.apiKey ? { key: maskKey(opts.apiKey) } : {}),
        ...(opts.data ?? {}),
      },
    };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.shift();

    const tag = `[exchange][${stage}][${exchange}]`;
    const payload = ev.data && Object.keys(ev.data).length > 0 ? ev.data : '';
    if      (ev.level === 'error') console.error(tag, message, payload);
    else if (ev.level === 'warn')  console.warn (tag, message, payload);
    else                           console.log  (tag, message, payload);

    this.notify();
    return ev;
  }

  all(): ExchangeEvent[] { return [...this.events]; }

  clear(): void { this.events = []; this.notify(); }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    const snap = this.all();
    this.listeners.forEach(fn => { try { fn(snap); } catch { /* ignore */ } });
  }

  toText(): string {
    return this.events.map(ev => {
      const t = new Date(ev.ts).toISOString();
      const d = ev.data && Object.keys(ev.data).length > 0 ? ' ' + JSON.stringify(ev.data) : '';
      return `${t} [${ev.level}] [${ev.stage}/${ev.exchange}] ${ev.message}${d}`;
    }).join('\n');
  }
}

export const exchangeEvents = new ExchangeEventBus();
