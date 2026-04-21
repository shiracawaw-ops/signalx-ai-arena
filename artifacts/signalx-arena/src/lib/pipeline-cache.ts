// ─── Pipeline Cache (System #8) ───────────────────────────────────────────────
// Lightweight in-memory + localStorage TTL cache shared by every pre-trade
// system (symbol rules, exchange compliance, prices, diagnostics).

interface Entry<T> { value: T; expiresAt: number }

const MEM = new Map<string, Entry<unknown>>();
const STORAGE_PREFIX = 'sx_pcache_';

export interface CacheStats {
  hits:    number;
  misses:  number;
  sets:    number;
  entries: number;
}

const STATS: CacheStats = { hits: 0, misses: 0, sets: 0, entries: 0 };

function loadFromDisk<T>(key: string): Entry<T> | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return undefined;
    const e = JSON.parse(raw) as Entry<T>;
    if (e.expiresAt < Date.now()) {
      localStorage.removeItem(STORAGE_PREFIX + key);
      return undefined;
    }
    return e;
  } catch { return undefined; }
}

function persist<T>(key: string, e: Entry<T>) {
  try { localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(e)); } catch { /* quota */ }
}

export const pipelineCache = {
  get<T>(key: string): T | undefined {
    const m = MEM.get(key) as Entry<T> | undefined;
    if (m && m.expiresAt > Date.now()) { STATS.hits++; return m.value; }
    if (m) MEM.delete(key);
    const d = loadFromDisk<T>(key);
    if (d) { MEM.set(key, d); STATS.hits++; return d.value; }
    STATS.misses++;
    return undefined;
  },

  set<T>(key: string, value: T, ttlMs: number, persistDisk = true): void {
    const e: Entry<T> = { value, expiresAt: Date.now() + ttlMs };
    MEM.set(key, e);
    if (persistDisk) persist(key, e);
    STATS.sets++;
    STATS.entries = MEM.size;
  },

  delete(key: string): void {
    MEM.delete(key);
    try { localStorage.removeItem(STORAGE_PREFIX + key); } catch { /* ignore */ }
    STATS.entries = MEM.size;
  },

  clearAll(): void {
    MEM.clear();
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(STORAGE_PREFIX)) keys.push(k);
      }
      keys.forEach(k => localStorage.removeItem(k));
    } catch { /* ignore */ }
    STATS.entries = 0;
  },

  stats(): CacheStats { return { ...STATS, entries: MEM.size }; },

  async memoize<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;
    const v = await fn();
    this.set(key, v, ttlMs);
    return v;
  },
};

// Standard TTLs
export const TTL = {
  SYMBOL_RULES:  10 * 60_000,  // 10 min — exchange filters rarely change
  PRICE:              5_000,    // 5 sec — public ticker
  COMPLIANCE:    24 * 3600_000, // 24 h — asset listings change daily at most
  DIAGNOSTIC:    2  * 60_000,   // 2 min — keep recent diag readable
  STUDY:         60 * 1000,     // 60 sec — bot study refresh
} as const;
