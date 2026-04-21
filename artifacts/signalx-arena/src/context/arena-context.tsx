
import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { Bot, Trade, loadBots, saveBots, loadTrades, saveTrades, BOT_COLORS } from '@/lib/storage';
import { perfMonitor } from '@/lib/perf-monitor';
import { MarketData, initMarket, tickMarket, executeBotTick } from '@/lib/engine';
import { generateBots, makeFreshStandbyBot } from '@/lib/seed';
import { exchangeMode } from '@/lib/exchange-mode';
import { bridgeBotTradeToExchange } from '@/lib/live-execution-bridge';

// ── Real-trade bridge ─────────────────────────────────────────────────────────
// When a bot produces a synthetic Trade in REAL or TESTNET mode we forward it
// to the unified Execution Engine via `bridgeBotTradeToExchange` (see
// live-execution-bridge.ts for the routing rules, including the explicit
// "asset class not supported" rejection for non-crypto symbols on a
// crypto-only exchange — surfaced via the Execution Log so the user
// understands why an on-screen "BUY AAPL" or "SELL EURUSD" didn't become a
// real order, rather than AutoPilot silently behaving like demo).
// We keep the dispatch fire-and-forget here so the tick loop never blocks on
// a network round-trip, and we log rejections/successes for the Execution Log.
function dispatchBotTradeFireAndForget(trade: Trade): void {
  const promise = bridgeBotTradeToExchange(trade);
  if (!promise) return;
  const mode = exchangeMode.get().mode;
  promise.then(res => {
    if (!res.ok) {
      console.warn(
        `[arena→engine][${mode}] ${trade.type} ${trade.symbol} blocked: `
        + `${res.rejectReason ?? 'unknown'}${res.detail ? ' — ' + res.detail : ''}`,
      );
    } else if (!res.demo) {
      console.log(
        `[arena→engine][${mode}] ${trade.type} ${trade.symbol} → orderId=${res.orderId}`,
      );
    }
  }).catch((err: unknown) => {
    console.error(`[arena→engine] dispatch error:`, err);
  });
}

// ── Storage keys ─────────────────────────────────────────────────────────────
const BOT_COUNT_KEY    = 'signalx_bot_count';
const DEMO_BALANCE_KEY = 'signalx_demo_balance';
const SPEND_PCT_KEY    = 'signalx_spend_pct';
const SEED_VER_KEY     = 'signalx_seed_ver';
const HEAL_LOG_KEY     = 'signalx_heal_log';

// ── Defaults ─────────────────────────────────────────────────────────────────
const DEFAULT_BOT_COUNT    = 30;
const DEFAULT_DEMO_BALANCE = 1000;
const DEFAULT_SPEND_PCT    = 0.3;
const SEED_VER_PREFIX      = 'v19'; // v19: TP=4%, SL=1.5% — large asymmetric profit per trade

// ── Self-healing config ───────────────────────────────────────────────────────
// Replacement is IMMEDIATE — checked every tick for running bots
const CRITICAL_PNL_PCT       = -25;  // bot lost >25% → immediately replaced
const CRITICAL_CONSEC_LOSSES = 7;    // 7+ consecutive sell losses → replaced
const HEAL_START_TICK        = 15;   // don't heal until tick 15 (let engine settle)
const SAVE_EVERY_N_TICKS     = 5;    // throttle localStorage writes
const WATCHDOG_INTERVAL_MS   = 5000; // watchdog checks every 5s
const MIN_STANDBY_POOL       = 3;    // auto-refill standby when pool < this

function loadBotCount():    number { return parseInt(localStorage.getItem(BOT_COUNT_KEY) ?? String(DEFAULT_BOT_COUNT), 10) || DEFAULT_BOT_COUNT; }
function loadDemoBalance(): number { return parseFloat(localStorage.getItem(DEMO_BALANCE_KEY) ?? String(DEFAULT_DEMO_BALANCE)) || DEFAULT_DEMO_BALANCE; }
function loadSpendPct():    number { return parseFloat(localStorage.getItem(SPEND_PCT_KEY) ?? String(DEFAULT_SPEND_PCT)) || DEFAULT_SPEND_PCT; }

function makeSeedVer(count: number, balance: number) { return `${SEED_VER_PREFIX}-${count}-${balance}`; }

// ── Heal event log ────────────────────────────────────────────────────────────
export interface HealEvent {
  id:        string;
  timestamp: number;
  type:      'replace_weak' | 'activate_standby' | 'load_shed' | 'watchdog_restart' | 'refill_standby' | 'pause_critical';
  botId:     string;
  botName:   string;
  reason:    string;
}

function loadHealLog(): HealEvent[] {
  try { return JSON.parse(localStorage.getItem(HEAL_LOG_KEY) ?? '[]'); }
  catch { return []; }
}
function saveHealLog(log: HealEvent[]) {
  try { localStorage.setItem(HEAL_LOG_KEY, JSON.stringify(log.slice(-100))); } catch { /* ignore */ }
}

function makeHealId() { return `heal_${Date.now()}_${Math.random().toString(36).slice(2,7)}`; }

// ── Bootstrap (runs once outside React) ──────────────────────────────────────
function bootstrap() {
  const botCount    = loadBotCount();
  const demoBalance = loadDemoBalance();
  const version     = makeSeedVer(botCount, demoBalance);
  const storedVer   = localStorage.getItem(SEED_VER_KEY);

  let bots: Bot[], trades: Trade[], market: MarketData;

  if (storedVer !== version) {
    const fresh = generateBots(botCount, demoBalance);
    bots   = fresh.bots;
    trades = fresh.trades;
    market = fresh.market;
    saveBots(bots);
    saveTrades(trades);
    localStorage.setItem(SEED_VER_KEY, version);
  } else {
    bots   = loadBots();
    trades = loadTrades();
    market = initMarket();
  }

  return { bots, trades, market, botCount, demoBalance };
}

const init = bootstrap();

// ── Context type ──────────────────────────────────────────────────────────────
export interface ArenaContextType {
  bots:            Bot[];
  trades:          Trade[];
  market:          MarketData;
  isGlobalRunning: boolean;
  tickCount:       number;
  spendPct:        number;
  botCount:        number;
  demoBalance:     number;
  searchQuery:     string;
  healLog:         HealEvent[];
  // actions
  setBotCount:     (n: number) => void;
  setDemoBalance:  (n: number) => void;
  setSpendPct:     (n: number) => void;
  setSearchQuery:  (q: string) => void;
  start:           () => void;
  stop:            () => void;
  addBot:          (name: string, symbol: string, strategy: string) => void;
  removeBot:       (id: string) => void;
  toggleBot:       (id: string) => void;
  resetBot:        (id: string) => void;
  resetAll:        () => void;
  getCurrentPrice: (symbol: string) => number;
  activateStandby: (id: string) => void;
  cloneStrategy:   (sourceId: string, targetId: string) => boolean;
}

export const ArenaContext = createContext<ArenaContextType | null>(null);

export function useArena(): ArenaContextType {
  const ctx = useContext(ArenaContext);
  if (!ctx) throw new Error('useArena must be used inside ArenaProvider');
  return ctx;
}

// ── Quick weakness check (O(n) per bot for sell streak — runs every tick) ────
// engineStartedAt: only count live-engine trades, not warm-up trades
function isBotWeak(bot: Bot, botTrades: Trade[], engineStartedAt: number): boolean {
  // Use TOTAL portfolio value (balance + position at entry price) — NOT just cash balance.
  // Without this, any bot that has an open position appears to have lost money (balance dipped),
  // triggering a false-positive heal and causing every bot to be replaced on every tick.
  const positionValue = bot.position * (bot.avgEntryPrice || 0);
  const totalValue = bot.balance + positionValue;
  const pnlPct = ((totalValue - bot.startingBalance) / bot.startingBalance) * 100;
  // Just-reset bots or flat bots are not weak
  if (Math.abs(pnlPct) < 0.5) return false;
  if (pnlPct < CRITICAL_PNL_PCT) return true;
  // Streak check: only count trades that happened AFTER engine started (live trades only)
  const liveSells = botTrades.filter(t => t.botId === bot.id && t.type === 'SELL' && t.timestamp >= engineStartedAt);
  let streak = 0;
  for (let i = liveSells.length - 1; i >= 0; i--) {
    if (liveSells[i].pnl <= 0) streak++;
    else break;
  }
  return streak >= CRITICAL_CONSEC_LOSSES;
}

// ── Provider ──────────────────────────────────────────────────────────────────
export function ArenaProvider({ children }: { children: React.ReactNode }) {
  const [bots,            setBots]            = useState<Bot[]>(init.bots);
  const [trades,          setTrades]          = useState<Trade[]>(init.trades);
  const [market,          setMarket]          = useState<MarketData>(init.market);
  const [isGlobalRunning, setIsGlobalRunning] = useState(false);
  const [tickCount,       setTickCount]       = useState(0);
  const [spendPct,        setSpendPctState]   = useState(loadSpendPct());
  const [botCount,        setBotCountState]   = useState(init.botCount);
  const [demoBalance,     setDemoBalanceState]= useState(init.demoBalance);
  const [searchQuery,     setSearchQuery]     = useState('');
  const [healLog,         setHealLog]         = useState<HealEvent[]>(loadHealLog());

  const intervalRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchdogRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const qualityRef         = useRef<string>('high');
  const runningRef         = useRef(false);
  // eslint-disable-next-line react-hooks/purity
  const lastTickAtRef      = useRef<number>(Date.now());
  const tickCountRef       = useRef(0);
  const saveThrottleRef    = useRef(0);
  // eslint-disable-next-line react-hooks/purity
  const engineStartedAtRef = useRef<number>(Date.now());
  // Always reflects the latest user-configured active bot count
  const botCountRef        = useRef<number>(init.botCount);

  const stateRef = useRef({ bots, market, trades, spendPct });
  // Intentional: sync ref during render so callbacks always read latest values.
  // eslint-disable-next-line react-hooks/refs
  stateRef.current = { bots, market, trades, spendPct };

  // ── Emit heal events ──────────────────────────────────────────────────────
  const emitHealEvents = useCallback((events: Omit<HealEvent, 'id' | 'timestamp'>[]) => {
    if (events.length === 0) return;
    const entries: HealEvent[] = events.map(e => ({ ...e, id: makeHealId(), timestamp: Date.now() }));
    setHealLog(prev => { const next = [...prev, ...entries].slice(-100); saveHealLog(next); return next; });
  }, []);

  // ── Immediate self-healing: runs EVERY tick ───────────────────────────────
  // Returns updated bots array + any heal events generated this tick.
  const healPass = useCallback((
    bots: Bot[],
    trades: Trade[],
    balance: number,
    tc: number,
    engineStartedAt: number,
    targetCount: number,         // the user-configured active bot count — must always be maintained
  ): { bots: Bot[]; events: Omit<HealEvent, 'id' | 'timestamp'>[] } => {
    // Give the engine a grace period before starting replacements
    if (tc < HEAL_START_TICK) return { bots, events: [] };

    const events: Omit<HealEvent, 'id' | 'timestamp'>[] = [];
    let updated = bots;

    // Find all weak active bots (using live-only trades to ignore warm-up history)
    const weakBots = updated.filter(b => b.isRunning && isBotWeak(b, trades, engineStartedAt));

    for (const bad of weakBots) {
      const posVal = bad.position * (bad.avgEntryPrice || 0);
      const pnlPct = ((bad.balance + posVal - bad.startingBalance) / bad.startingBalance) * 100;
      const reason = pnlPct < CRITICAL_PNL_PCT
        ? `Lost ${Math.abs(pnlPct).toFixed(1)}% of capital`
        : `Consecutive losing streak`;

      // 1. Park the weak bot as a standby — reset its balance so it's healthy for future use
      updated = updated.map(b =>
        b.id === bad.id
          ? { ...b, isRunning: false, balance: bad.startingBalance, position: 0, avgEntryPrice: 0 }
          : b,
      );
      events.push({ type: 'replace_weak', botId: bad.id, botName: bad.name, reason });

      // 2. Activate the healthiest standby (exclude the bot we just parked)
      const standbyPool = updated.filter(b => !b.isRunning && b.id !== bad.id);
      if (standbyPool.length > 0) {
        const best = standbyPool.reduce((a, b) => a.balance >= b.balance ? a : b);
        updated = updated.map(b => b.id === best.id ? { ...b, isRunning: true } : b);
        events.push({ type: 'activate_standby', botId: best.id, botName: best.name, reason: `Replaced ${bad.name}` });
      } else {
        // No standbys — create a fresh one and activate it directly
        const fresh = makeFreshStandbyBot(balance, updated.length);
        fresh.isRunning = true;
        updated = [...updated, fresh];
        events.push({ type: 'activate_standby', botId: fresh.id, botName: fresh.name, reason: `Fresh bot — standby pool was empty` });
      }
    }

    // ── INVARIANT: active count must always equal targetCount ────────────────
    // This is the guarantee: no matter what happened above, correct the count.
    const activeNow = updated.filter(b => b.isRunning).length;
    const deficit   = targetCount - activeNow;

    if (deficit > 0) {
      // Too few active — pull from standby (or create fresh bots)
      for (let i = 0; i < deficit; i++) {
        const standby = updated.filter(b => !b.isRunning);
        if (standby.length > 0) {
          const best = standby.reduce((a, b) => a.balance >= b.balance ? a : b);
          updated = updated.map(b => b.id === best.id ? { ...b, isRunning: true } : b);
          events.push({ type: 'activate_standby', botId: best.id, botName: best.name, reason: `Count correction (+${deficit})` });
        } else {
          const fresh = makeFreshStandbyBot(balance, updated.length + i);
          fresh.isRunning = true;
          updated = [...updated, fresh];
          events.push({ type: 'activate_standby', botId: fresh.id, botName: fresh.name, reason: `Fresh bot — count correction` });
        }
      }
    }

    // ── Refill standby pool to maintain minimum reserve ─────────────────────
    const standbyLeft = updated.filter(b => !b.isRunning).length;
    if (standbyLeft < MIN_STANDBY_POOL) {
      const toAdd = MIN_STANDBY_POOL - standbyLeft;
      for (let i = 0; i < toAdd; i++) {
        const fresh = makeFreshStandbyBot(balance, updated.length + i);
        updated = [...updated, fresh];
        events.push({ type: 'refill_standby', botId: fresh.id, botName: fresh.name, reason: `Pool refill` });
      }
    }

    return { bots: updated, events };
  }, []);

  // ── Tick ───────────────────────────────────────────────────────────────────
  const tick = useCallback(() => {
    const { bots: cur, market: mkt, trades: trds, spendPct: pct } = stateRef.current;
    const balance = parseFloat(localStorage.getItem(DEMO_BALANCE_KEY) ?? String(DEFAULT_DEMO_BALANCE)) || DEFAULT_DEMO_BALANCE;

    lastTickAtRef.current = Date.now();
    tickCountRef.current += 1;
    const tc = tickCountRef.current;

    const newMarket = tickMarket(mkt);

    const newTrades: Trade[] = [];
    let updatedBots = cur.map(bot => {
      if (!bot.isRunning) return bot;
      const candles = newMarket[bot.symbol] || [];
      const { bot: updatedBot, trade } = executeBotTick(bot, candles, trds, pct);
      if (trade) {
        newTrades.push(trade);
        // Mirror to the live Execution Engine in REAL / TESTNET mode.
        // No-op for DEMO and PAPER. Fire-and-forget; safety gates live
        // inside executeSignal.
        dispatchBotTradeFireAndForget(trade);
      }
      return updatedBot;
    });

    const combined  = [...trds, ...newTrades];
    const allTrades = combined.length > 3000 ? combined.slice(-3000) : combined;

    // ── Immediate self-healing (every tick, after grace period) ───────────
    const { bots: healedBots, events } = healPass(updatedBots, allTrades, balance, tc, engineStartedAtRef.current, botCountRef.current);
    updatedBots = healedBots;
    if (events.length > 0) emitHealEvents(events);

    setMarket(newMarket);
    setBots(updatedBots);
    setTrades(allTrades);
    setTickCount(tc);

    // ── Throttled localStorage saves ───────────────────────────────────────
    saveThrottleRef.current += 1;
    if (saveThrottleRef.current >= SAVE_EVERY_N_TICKS) {
      saveThrottleRef.current = 0;
      saveBots(updatedBots);
    }
    if (newTrades.length > 0) saveTrades(allTrades);
  }, [healPass, emitHealEvents]);

  // ── Engine helpers ────────────────────────────────────────────────────────
  const getTickMs = useCallback(() =>
    perfMonitor.snapshot(stateRef.current.bots.filter(b => b.isRunning).length).tickMs,
  []);

  const startEngine = useCallback((ms?: number) => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    runningRef.current = true;
    // Do NOT reset tickCountRef here — only setBotCount/resetAll should reset the grace period.
    // Resetting here would restart the HEAL_START_TICK window on every quality-change restart.
    intervalRef.current = setInterval(tick, ms ?? getTickMs());
  }, [tick, getTickMs]);

  const start = useCallback(() => {
    if (runningRef.current && intervalRef.current) return;
    startEngine();
    setIsGlobalRunning(true);
  }, [startEngine]);

  const stop = useCallback(() => {
    runningRef.current = false;
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    setIsGlobalRunning(false);
  }, []);

  // ── AI adaptive: adjust tick speed based on FPS quality ──────────────────
  // Load shedding removed — user controls bot count; engine adapts speed instead.
  useEffect(() => {
    perfMonitor.start();
    const unsub = perfMonitor.subscribe(snap => {
      if (snap.quality === qualityRef.current) return;
      qualityRef.current = snap.quality;
      // Only adjust tick interval; never pause user-configured bots
      if (runningRef.current) {
        const activeCount = stateRef.current.bots.filter(b => b.isRunning).length;
        startEngine(perfMonitor.snapshot(activeCount).tickMs);
      }
    });
    return unsub;
  }, [startEngine]);

  // ── Watchdog: detect stuck engine ────────────────────────────────────────
  useEffect(() => {
    watchdogRef.current = setInterval(() => {
      if (!runningRef.current) return;
      const age = Date.now() - lastTickAtRef.current;
      if (age > WATCHDOG_INTERVAL_MS * 1.5) {
        console.warn('[SignalX] Watchdog: tick engine stuck, restarting…');
        startEngine();
        emitHealEvents([{ type: 'watchdog_restart', botId: 'engine', botName: 'Engine', reason: `No tick for ${Math.round(age / 1000)}s` }]);
      }
    }, WATCHDOG_INTERVAL_MS);
    return () => { if (watchdogRef.current) clearInterval(watchdogRef.current); };
  }, [startEngine, emitHealEvents]);

  // ── Auto-start ────────────────────────────────────────────────────────────
  useEffect(() => {
    start();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsGlobalRunning(true);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (watchdogRef.current) clearInterval(watchdogRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Bot count (re-seeds all bots) ─────────────────────────────────────────
  const setBotCount = useCallback((n: number) => {
    const count   = Math.max(1, Math.min(500, n));
    const balance = parseFloat(localStorage.getItem(DEMO_BALANCE_KEY) ?? String(DEFAULT_DEMO_BALANCE)) || DEFAULT_DEMO_BALANCE;
    const fresh   = generateBots(count, balance);
    localStorage.setItem(BOT_COUNT_KEY, String(count));
    localStorage.setItem(SEED_VER_KEY, makeSeedVer(count, balance));
    saveBots(fresh.bots);
    saveTrades(fresh.trades);
    botCountRef.current = count;  // keep ref in sync immediately
    setBotCountState(count);
    setBots(fresh.bots);
    setTrades(fresh.trades);
    setMarket(fresh.market);
    setTickCount(0);
    tickCountRef.current = 0;
    saveThrottleRef.current = 0;
    engineStartedAtRef.current = Date.now(); // reset grace period on full re-seed
    startEngine(perfMonitor.snapshot(count).tickMs);
    setIsGlobalRunning(true);
  }, [startEngine]);

  // ── Demo balance ──────────────────────────────────────────────────────────
  const setDemoBalance = useCallback((n: number) => {
    const balance = Math.max(1, Math.min(1_000_000, n));
    localStorage.setItem(DEMO_BALANCE_KEY, String(balance));
    setDemoBalanceState(balance);
  }, []);

  // ── Spend % ───────────────────────────────────────────────────────────────
  const setSpendPct = useCallback((pct: number) => {
    setSpendPctState(pct);
    localStorage.setItem(SPEND_PCT_KEY, String(pct));
  }, []);

  // ── Reset All — wipes everything and re-seeds ─────────────────────────────
  const resetAll = useCallback(() => {
    const count   = parseInt(localStorage.getItem(BOT_COUNT_KEY) ?? String(DEFAULT_BOT_COUNT), 10) || DEFAULT_BOT_COUNT;
    const balance = parseFloat(localStorage.getItem(DEMO_BALANCE_KEY) ?? String(DEFAULT_DEMO_BALANCE)) || DEFAULT_DEMO_BALANCE;

    [
      'signalx_bots', 'signalx_trades', SEED_VER_KEY, HEAL_LOG_KEY,
      'signalx_risk_config', 'signalx_wallet_transactions', 'signalx_wallet_balance',
    ].forEach(k => localStorage.removeItem(k));

    const fresh = generateBots(count, balance);
    localStorage.setItem(SEED_VER_KEY, makeSeedVer(count, balance));
    saveBots(fresh.bots);
    saveTrades(fresh.trades);

    setBots(fresh.bots);
    setTrades(fresh.trades);
    setMarket(fresh.market);
    setTickCount(0);
    tickCountRef.current = 0;
    saveThrottleRef.current = 0;
    botCountRef.current = count;  // keep ref in sync
    setBotCountState(count);
    setDemoBalanceState(balance);
    setHealLog([]);
    setSearchQuery('');
    engineStartedAtRef.current = Date.now(); // reset grace period on full reset

    startEngine(perfMonitor.snapshot(count).tickMs);
    setIsGlobalRunning(true);
  }, [startEngine]);

  // ── Single bot actions ────────────────────────────────────────────────────
  const addBot = useCallback((name: string, symbol: string, strategy: string) => {
    const balance = parseFloat(localStorage.getItem(DEMO_BALANCE_KEY) ?? String(DEFAULT_DEMO_BALANCE)) || DEFAULT_DEMO_BALANCE;
    const newBot: Bot = {
      id: `bot_${Date.now()}`,
      name, symbol, strategy,
      balance, startingBalance: balance,
      position: 0, avgEntryPrice: 0, trades: [],
      isRunning: true,
      createdAt: Date.now(),
      color: BOT_COLORS[Math.floor(Math.random() * BOT_COLORS.length)],
    };
    setBots(prev => { const u = [...prev, newBot]; saveBots(u); return u; });
  }, []);

  const removeBot = useCallback((id: string) => {
    setBots(prev => { const u = prev.filter(b => b.id !== id); saveBots(u); return u; });
  }, []);

  const toggleBot = useCallback((id: string) => {
    setBots(prev => { const u = prev.map(b => b.id === id ? { ...b, isRunning: !b.isRunning } : b); saveBots(u); return u; });
  }, []);

  const resetBot = useCallback((id: string) => {
    const balance = parseFloat(localStorage.getItem(DEMO_BALANCE_KEY) ?? String(DEFAULT_DEMO_BALANCE)) || DEFAULT_DEMO_BALANCE;
    setBots(prev => { const u = prev.map(b => b.id === id ? { ...b, balance, startingBalance: balance, position: 0, avgEntryPrice: 0 } : b); saveBots(u); return u; });
    setTrades(prev => { const u = prev.filter(t => t.botId !== id); saveTrades(u); return u; });
  }, []);

  // Clone champion's strategy onto target — strategy field only, balance/position untouched.
  const cloneStrategy = useCallback((sourceId: string, targetId: string): boolean => {
    if (sourceId === targetId) return false;
    let ok = false;
    setBots(prev => {
      const src = prev.find(b => b.id === sourceId);
      const tgt = prev.find(b => b.id === targetId);
      if (!src || !tgt) return prev;
      ok = true;
      const u = prev.map(b => b.id === targetId ? { ...b, strategy: src.strategy } : b);
      saveBots(u);
      return u;
    });
    return ok;
  }, []);

  // Manually activate a specific standby bot
  const activateStandby = useCallback((id: string) => {
    setBots(prev => { const u = prev.map(b => b.id === id ? { ...b, isRunning: true } : b); saveBots(u); return u; });
  }, []);

  const getCurrentPrice = useCallback((symbol: string): number => {
    const candles = stateRef.current.market[symbol];
    if (!candles || candles.length === 0) return 0;
    return candles[candles.length - 1].close;
  }, []);

  return (
    <ArenaContext.Provider value={{
      bots, trades, market, isGlobalRunning, tickCount, spendPct, botCount, demoBalance,
      searchQuery, setSearchQuery, healLog,
      setBotCount, setDemoBalance, setSpendPct, start, stop,
      addBot, removeBot, toggleBot, resetBot, resetAll, getCurrentPrice, activateStandby, cloneStrategy,
    }}>
      {children}
    </ArenaContext.Provider>
  );
}
