// ─── Outbound IP detector ─────────────────────────────────────────────────────
// Reports the PUBLIC IPv4 the api-server reaches the outside world from.
// Used by the diagnostics panel so users can compare it against the IP
// whitelist on their exchange API key (the #1 cause of "trading permission
// missing" false positives).
//
// Cached for 5 minutes — the public IP of an Electron host or Replit VM
// rarely changes within a session and we do not want to thrash external
// services on every diagnostic click.

import { logger } from './logger.js';

const CACHE_TTL_MS = 5 * 60 * 1000;

let cached: { ip: string; ts: number } | null = null;

const PROBES: ReadonlyArray<{ url: string; pluck: (j: unknown) => string | undefined }> = [
  { url: 'https://api.ipify.org?format=json',      pluck: j => (j as { ip?: string })?.ip },
  { url: 'https://api64.ipify.org?format=json',    pluck: j => (j as { ip?: string })?.ip },
  { url: 'https://ifconfig.co/json',               pluck: j => (j as { ip?: string })?.ip },
];

export async function getOutboundIp(): Promise<string | undefined> {
  const now = Date.now();
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.ip;

  for (const probe of PROBES) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4_000);
      const r = await fetch(probe.url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) continue;
      const j = await r.json();
      const ip = probe.pluck(j);
      if (ip && /^[0-9a-f.:]+$/i.test(ip)) {
        cached = { ip, ts: now };
        return ip;
      }
    } catch (e) {
      logger.debug({ probe: probe.url, err: (e as Error).message }, '[outbound-ip] probe failed');
    }
  }
  return undefined;
}
