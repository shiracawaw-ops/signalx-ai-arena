
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useArena } from '@/hooks/use-arena';
import { useUser } from '@/context/user-context';
import {
  computeAutoPilotDecision, makeLogEntry,
  type AutoPilotDecision, type DecisionLogEntry, type BotEvaluation,
} from '@/lib/autopilot';
import { getBotTotalValue } from '@/lib/engine';
import { calcFeeAdjusted, PLATFORM_FEE_RATE } from '@/lib/platform';
import { ShieldAlert } from 'lucide-react';
import { exchangeMode, type ExchangeModeState } from '@/lib/exchange-mode';
import { dispatchAutoPilotLiveSignal, type AutoPilotDispatchKey } from '@/lib/live-execution-bridge';
import { ASSET_MAP } from '@/lib/storage';
import { EXCHANGE_MAP } from '@/lib/exchange';
import { BotFleetPanel } from '@/components/bot-fleet-panel';
import { loadWallet } from '@/lib/wallet';

// ── Sim-only detection ─────────────────────────────────────────────────────
// A bot is "simulator-only" when the user is in a live/testnet mode but the
// currently selected exchange can't actually route the bot's symbol to a
// real order. Today every KNOWN_EXCHANGES entry is crypto/derivatives only,
// so any Stocks/Metals/Forex symbol is sim-only in real or testnet. The
// helper inspects `markets` so that adding a multi-asset broker later
// automatically clears the badge for the asset classes it supports. In
// demo/paper mode every asset class is simulated, so the badge never shows.
function isSimOnlyForLive(symbol: string, exState: ExchangeModeState): boolean {
  if (exState.mode !== 'real' && exState.mode !== 'testnet') return false;
  const cat = ASSET_MAP[symbol]?.category;
  if (!cat || cat === 'Crypto') return false;
  const ex = EXCHANGE_MAP[exState.exchange];
  if (!ex) return true;
  const supports = ex.markets.some(m => m.toLowerCase() === cat.toLowerCase());
  return !supports;
}

function SimOnlyBadge({ exchangeName, category, compact }: { exchangeName: string; category: string; compact?: boolean }) {
  const cls = compact
    ? 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-bold tracking-wider uppercase border border-amber-600/40 bg-amber-900/15 text-amber-400'
    : 'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wider uppercase border border-amber-600/40 bg-amber-900/15 text-amber-400';
  return (
    <span
      className={cls}
      title={`${category} isn't tradable live on ${exchangeName}. This bot will only run in the simulator until you switch to a broker that supports ${category.toLowerCase()}, or to demo/paper mode.`}
    >
      Sim-only
    </span>
  );
}

// ── Formatters ─────────────────────────────────────────────────────────────
function fmt(n: number, d = 2) { return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function fmtPct(n: number) { return `${n >= 0 ? '+' : ''}${fmt(n)}%`; }
function fmtPnL(n: number) { return `${n >= 0 ? '+' : '-'}$${fmt(Math.abs(n))}`; }
function fmtTime(ts: number) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

const DECISION_INTERVAL = 5000;
const MAX_LOG = 20;

// ── Risk badge ─────────────────────────────────────────────────────────────
function RiskBadge({ level }: { level: string }) {
  const cfg = {
    SAFE:     { bg: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400',  dot: 'bg-emerald-400' },
    MODERATE: { bg: 'bg-amber-500/15 border-amber-500/40 text-amber-400',        dot: 'bg-amber-400' },
    HIGH:     { bg: 'bg-orange-500/15 border-orange-500/40 text-orange-400',     dot: 'bg-orange-400' },
    DANGER:   { bg: 'bg-red-600/15 border-red-600/50 text-red-400',              dot: 'bg-red-400 animate-pulse' },
  }[level] ?? { bg: 'bg-zinc-700/30 border-zinc-600 text-zinc-400', dot: 'bg-zinc-400' };

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-bold tracking-widest ${cfg.bg}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {level}
    </span>
  );
}

// ── Action signal block ────────────────────────────────────────────────────
function ActionSignal({ action, confidence }: { action: string; confidence: number }) {
  const cfg = {
    BUY:  { glow: 'shadow-[0_0_40px_#10b98140]', border: 'border-emerald-500/50', text: 'text-emerald-400', bg: 'bg-emerald-500/10', label: 'BUY' },
    SELL: { glow: 'shadow-[0_0_40px_#ef444440]', border: 'border-red-500/50',     text: 'text-red-400',     bg: 'bg-red-500/10',     label: 'SELL' },
    HOLD: { glow: 'shadow-[0_0_20px_#71717a20]', border: 'border-zinc-600/60',    text: 'text-zinc-300',    bg: 'bg-zinc-800/40',    label: 'HOLD' },
  }[action] ?? { glow: '', border: 'border-zinc-700', text: 'text-zinc-300', bg: 'bg-zinc-800/40', label: action };

  return (
    <div className={`relative flex flex-col items-center justify-center rounded-2xl border ${cfg.border} ${cfg.bg} ${cfg.glow} px-10 py-8 transition-all duration-500`}>
      <div className="text-[10px] uppercase tracking-[0.25em] text-zinc-500 mb-3 font-semibold">AutoPilot Signal</div>
      <div className={`text-6xl font-black tracking-tight ${cfg.text} mb-4 leading-none`}>{cfg.label}</div>
      <div className="w-full max-w-[200px]">
        <div className="flex justify-between text-[10px] text-zinc-500 mb-1">
          <span>Confidence</span>
          <span className={cfg.text}>{confidence.toFixed(0)}%</span>
        </div>
        <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-700 ${
              action === 'BUY' ? 'bg-emerald-500' : action === 'SELL' ? 'bg-red-500' : 'bg-zinc-500'
            }`}
            style={{ width: `${confidence}%` }}
          />
        </div>
      </div>
    </div>
  );
}

// ── Stat card ──────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, green }: { label: string; value: string; sub?: string; green?: boolean }) {
  const color = green === true ? 'text-emerald-400' : green === false ? 'text-red-400' : 'text-zinc-100';
  return (
    <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl px-4 py-3 flex flex-col gap-0.5">
      <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-medium">{label}</div>
      <div className={`font-mono font-bold text-xl ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-zinc-500">{sub}</div>}
    </div>
  );
}

// ── Top bot row ────────────────────────────────────────────────────────────
function TopBotRow({ eval: ev, rank, simOnly, exchangeName }: { eval: BotEvaluation; rank: number; simOnly: boolean; exchangeName: string }) {
  const medals = ['', '🥇', '🥈', '🥉'];
  const actionColor = ev.action === 'BUY' ? 'text-emerald-400' : ev.action === 'SELL' ? 'text-red-400' : 'text-zinc-400';
  const scoreColor  = ev.score >= 70 ? 'text-emerald-400' : ev.score >= 45 ? 'text-amber-400' : 'text-red-400';
  const category    = ASSET_MAP[ev.bot.symbol]?.category ?? 'Asset';

  return (
    <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors ${
      rank === 1
        ? 'border-emerald-500/20 bg-emerald-500/5'
        : 'border-zinc-800/50 bg-zinc-900/30 hover:bg-zinc-900/60'
    } ${simOnly ? 'opacity-60' : ''}`}>
      <span className="text-base w-6 text-center flex-shrink-0">{medals[rank] || rank}</span>
      <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: ev.bot.color }} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <div className="font-semibold text-sm text-zinc-100 truncate">{ev.bot.name}</div>
          {simOnly && <SimOnlyBadge exchangeName={exchangeName} category={category} compact />}
        </div>
        <div className="text-[10px] text-zinc-500">{ev.bot.symbol} · {ev.bot.strategy}</div>
      </div>
      <div className="text-right flex-shrink-0">
        <div className={`font-mono text-sm font-bold ${ev.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          {fmtPnL(ev.pnl)}
        </div>
        <div className={`text-[10px] font-mono ${ev.pnlPct >= 0 ? 'text-emerald-400/70' : 'text-red-400/70'}`}>
          {fmtPct(ev.pnlPct)}
        </div>
      </div>
      <div className={`text-[11px] font-bold w-8 text-right flex-shrink-0 ${actionColor}`}>{ev.action}</div>
      <div className="w-24 flex-shrink-0 hidden sm:block">
        <div className="flex justify-between text-[9px] text-zinc-600 mb-0.5">
          <span>Score</span>
          <span className={scoreColor}>{ev.score.toFixed(0)}</span>
        </div>
        <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full ${ev.score >= 70 ? 'bg-emerald-500' : ev.score >= 45 ? 'bg-amber-500' : 'bg-red-500'}`}
            style={{ width: `${ev.score}%` }}
          />
        </div>
      </div>
    </div>
  );
}

// ── Log entry row ──────────────────────────────────────────────────────────
function LogRow({ entry }: { entry: DecisionLogEntry }) {
  const dot = {
    info:    'bg-blue-400',
    warn:    'bg-amber-400',
    danger:  'bg-red-400 animate-pulse',
    success: 'bg-emerald-400',
  }[entry.level];
  const text = {
    info:    'text-zinc-300',
    warn:    'text-amber-300',
    danger:  'text-red-300',
    success: 'text-emerald-300',
  }[entry.level];

  return (
    <div className="flex items-start gap-2.5 py-1.5 border-b border-zinc-800/40 last:border-0">
      <span className="text-[10px] text-zinc-600 font-mono flex-shrink-0 mt-0.5 w-16">{fmtTime(entry.timestamp)}</span>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5 ${dot}`} />
      <span className={`text-[11px] leading-relaxed ${text}`}>{entry.message}</span>
    </div>
  );
}

// ── Risk meter ─────────────────────────────────────────────────────────────
function RiskMeter({ pnlPct, riskLevel }: { pnlPct: number; riskLevel: string }) {
  const zones = [
    { label: 'DANGER',   pct: 0,  width: 15, color: 'bg-red-600' },
    { label: 'HIGH',     pct: 15, width: 20, color: 'bg-orange-500' },
    { label: 'MODERATE', pct: 35, width: 25, color: 'bg-amber-400' },
    { label: 'SAFE',     pct: 60, width: 40, color: 'bg-emerald-500' },
  ];
  const needle = Math.min(95, Math.max(5, 60 + pnlPct * 8));
  const needleColor = riskLevel === 'SAFE' ? '#10b981' : riskLevel === 'MODERATE' ? '#f59e0b' : riskLevel === 'HIGH' ? '#f97316' : '#ef4444';

  return (
    <div className="space-y-2">
      <div className="relative h-3 rounded-full overflow-hidden flex">
        {zones.map(z => (
          <div key={z.label} className={`h-full ${z.color} opacity-25`} style={{ width: `${z.width}%` }} />
        ))}
        <div
          className="absolute top-0 bottom-0 w-0.5 rounded-full transition-all duration-1000"
          style={{ left: `${needle}%`, background: needleColor, boxShadow: `0 0 8px ${needleColor}` }}
        />
      </div>
      <div className="flex justify-between text-[9px] text-zinc-600 uppercase tracking-wider font-mono">
        <span>−3%</span><span>−1.5%</span><span>−0.5%</span><span>0</span><span>+</span>
      </div>
    </div>
  );
}

// ── Section header ─────────────────────────────────────────────────────────
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <div className="h-px flex-1 bg-zinc-800/60" />
      <span className="text-[10px] font-bold tracking-[0.2em] uppercase text-zinc-500">{children}</span>
      <div className="h-px flex-1 bg-zinc-800/60" />
    </div>
  );
}

// ── AutoPilot Page ─────────────────────────────────────────────────────────
export default function AutoPilotPage() {
  const { bots, trades, getCurrentPrice, isGlobalRunning, stop, start } = useArena();
  const { user } = useUser();

  const [decision, setDecision]   = useState<AutoPilotDecision | null>(null);
  const [log, setLog]             = useState<DecisionLogEntry[]>([]);
  const [exState, setExState]     = useState<ExchangeModeState>(() => exchangeMode.get());

  // Re-render badges immediately on mode/exchange changes (not just every 5s tick).
  useEffect(() => exchangeMode.subscribe(setExState), []);

  const exchangeName = EXCHANGE_MAP[exState.exchange]?.shortName ?? exState.exchange;
  const simOnlyForSymbol = useCallback(
    (symbol: string) => isSimOnlyForLive(symbol, exState),
    [exState],
  );

  // Refs for always-fresh values inside interval callbacks (avoids stale closures)
  // Intentional: sync refs during render so interval callbacks always read latest values.
  const botsRef          = useRef(bots);
  const tradesRef        = useRef(trades);
  const gcRef            = useRef(getCurrentPrice);
  const isRunningRef     = useRef(isGlobalRunning);
  const stopRef          = useRef(stop);
  const lastBotIdRef     = useRef<string | null>(null);
  const lastRiskRef      = useRef<string | null>(null);
  // Dedupe live dispatches: only latch when an order was ACCEPTED by the
  // engine. If the engine rejected (e.g. not armed yet, validation pending,
  // transient network), we leave the latch clear so the next decision tick
  // retries — otherwise readiness coming online later would never fire.
  // The latch is also explicitly cleared on any false→true transition of
  // exchangeMode.isExecutionReady().
  const lastDispatchRef  = useRef<AutoPilotDispatchKey | null>(null);
  const lastReadyRef     = useRef<boolean>(exchangeMode.isExecutionReady());
  // eslint-disable-next-line react-hooks/refs
  botsRef.current        = bots;
  // eslint-disable-next-line react-hooks/refs
  tradesRef.current      = trades;
  // eslint-disable-next-line react-hooks/refs
  gcRef.current          = getCurrentPrice;
  // eslint-disable-next-line react-hooks/refs
  isRunningRef.current   = isGlobalRunning;
  // eslint-disable-next-line react-hooks/refs
  stopRef.current        = stop;

  const runDecision = useCallback(() => {
    const d = computeAutoPilotDecision(botsRef.current, tradesRef.current, gcRef.current);
    setDecision(d);

    // Log new bot selection — ref-based, no stale closure
    if (d.selectedBot && d.selectedBot.bot.id !== lastBotIdRef.current) {
      setLog(prev => [makeLogEntry(
        'select',
        `${d.selectedBot!.bot.name} selected — score ${d.selectedBot!.score.toFixed(0)}/100 · ${d.selectedBot!.bot.symbol} · ${d.selectedBot!.bot.strategy}`,
        'success',
      ), ...prev].slice(0, MAX_LOG));
      lastBotIdRef.current = d.selectedBot.bot.id;
    }

    // Log risk changes
    if (d.riskLevel !== lastRiskRef.current) {
      const level: DecisionLogEntry['level'] =
        d.riskLevel === 'SAFE'     ? 'success'
        : d.riskLevel === 'DANGER' ? 'danger'
        : d.riskLevel === 'HIGH'   ? 'warn' : 'info';
      setLog(prev => [makeLogEntry('risk', `Risk ${d.riskLevel}: ${d.riskReason}`, level), ...prev].slice(0, MAX_LOG));
      lastRiskRef.current = d.riskLevel;

      // Auto-pause everything in DANGER mode — uses ref so always fresh
      if (d.riskLevel === 'DANGER' && isRunningRef.current) {
        stopRef.current();
        setLog(prev => [makeLogEntry('hold', 'Emergency HOLD — all bots paused by risk engine', 'danger'), ...prev].slice(0, MAX_LOG));
      }
    }

    // Log HOLD override
    if (d.selectedBot && d.masterAction !== d.selectedBot.action && d.masterAction === 'HOLD') {
      setLog(prev => [makeLogEntry('hold', `Signal overridden to HOLD — risk level ${d.riskLevel}`, 'warn'), ...prev].slice(0, MAX_LOG));
    }

    // ── Live execution bridge ─────────────────────────────────────────────
    // In REAL / TESTNET mode, forward the master decision to the unified
    // Execution Engine via the shared `dispatchAutoPilotLiveSignal` helper.
    // Demo / Paper modes never enter the live branch — those continue to be
    // handled by the bot tick simulator. The helper enforces the dedupe
    // latch (one dispatch per BUY/SELL transition) and the crypto/live
    // gating; here we only handle the readiness-flip latch reset and the
    // UI log row for the result.
    const readyNow = exchangeMode.isExecutionReady();
    if (readyNow && !lastReadyRef.current) {
      lastDispatchRef.current = null;
    }
    lastReadyRef.current = readyNow;

    void dispatchAutoPilotLiveSignal({
      decision:        d,
      lastDispatch:    lastDispatchRef.current,
      getCurrentPrice: gcRef.current,
    }).then(out => {
      if (out.reset) lastDispatchRef.current = null;
      // Adopt the helper's new latch in all cases (including the
      // unsupported-asset rejection, which latches without dispatching
      // so we don't spam the Execution Log every 5s cycle).
      if (out.newLast) lastDispatchRef.current = out.newLast;
      if (!out.dispatched) return;
      const res = out.result!;
      const action = out.signal!.side === 'buy' ? 'BUY' : 'SELL';
      const sym    = out.signal!.symbol;
      const msg = res.ok
        ? `AutoPilot ${action} ${sym} → live order ${res.orderId ?? ''}`
        : `AutoPilot ${action} ${sym} blocked — ${res.rejectReason ?? 'unknown'}${res.detail ? ': ' + res.detail : ''}`;
      setLog(prev => [makeLogEntry('select', msg, res.ok ? 'success' : 'warn'), ...prev].slice(0, MAX_LOG));
    }).catch((err: unknown) => {
      console.error('[autopilot→engine] dispatch error:', err);
    });
  }, []);

  // Run immediately + every 5s — stable interval, fresh data via refs
  useEffect(() => {
    runDecision();
    const id = setInterval(runDecision, DECISION_INTERVAL);
    return () => clearInterval(id);
  }, [runDecision]);

  // Fee-adjusted portfolio net P&L
  const netFeeMetrics = useMemo(() => {
    const grossPnl = bots.reduce((s, b) => s + b.balance - b.startingBalance, 0);
    const totalTrades = trades.length;
    const avgTradeVal = totalTrades > 0
      ? trades.reduce((s, t) => s + t.quantity * t.price, 0) / totalTrades
      : 50;
    const startBal = bots.reduce((s, b) => s + b.startingBalance, 0);
    return calcFeeAdjusted(grossPnl, totalTrades, avgTradeVal, startBal);
  }, [bots, trades]);

  const selected = decision?.selectedBot;
  const topBots  = decision?.topBots ?? [];

  return (
    <div className="min-h-full bg-background text-foreground">
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">

        {/* ── Header ── */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <div className="flex items-center gap-2.5 mb-1">
              <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[10px] font-bold tracking-[0.25em] uppercase text-emerald-400">AutoPilot Active</span>
              <span className="hidden sm:inline px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-blue-600/20 border border-blue-600/30 text-blue-400 uppercase tracking-widest">
                Paper Trading
              </span>
            </div>
            <h1 className="text-2xl font-black tracking-tight text-zinc-100">
              SignalX <span className="text-red-400">AutoPilot</span>
            </h1>
            <p className="text-xs text-zinc-500 mt-0.5">
              {user ? `Welcome, ${user.name} · ` : ''}Intelligent decision engine · evaluates every 5 seconds
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <RiskBadge level={decision?.riskLevel ?? 'SAFE'} />
            <span className="text-[10px] text-zinc-600 hidden sm:inline">
              {decision ? fmtTime(decision.timestamp) : '–'}
            </span>
            {decision?.riskLevel === 'DANGER' ? (
              <button
                onClick={() => {
                  start();
                  setLog(prev => [makeLogEntry('resume', 'Engine manually resumed by user', 'info'), ...prev].slice(0, MAX_LOG));
                }}
                className="px-3 py-1.5 text-[11px] font-bold rounded-lg border border-emerald-600/40 bg-emerald-600/10 text-emerald-400 hover:bg-emerald-600/20 transition-colors"
              >
                Resume
              </button>
            ) : null}
          </div>
        </div>

        {/* ── Bot Fleet Control (real-balance allocation) ── */}
        <BotFleetPanel
          totalBots={bots.length}
          realBalanceUSD={loadWallet().virtualBalance}
          minNotionalUSD={10}
        />

        {/* ── No data state ── */}
        {!selected && (
          <div className="text-center py-20 text-zinc-500">
            <div className="text-4xl mb-3">🤖</div>
            <div className="font-semibold text-zinc-300 mb-1">AutoPilot warming up…</div>
            <div className="text-sm">Waiting for bots to generate trading data</div>
          </div>
        )}

        {selected && (
          <>
            {/* ── Best Bot + Signal ── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

              {/* Selected bot info */}
              <div className="bg-zinc-900/50 border border-zinc-800/60 rounded-2xl p-5 space-y-4">
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">
                  <span>Best Bot Now</span>
                </div>

                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl flex-shrink-0" style={{ background: selected.bot.color + '30', border: `2px solid ${selected.bot.color}60` }}>
                    <div className="w-full h-full flex items-center justify-center">
                      <span className="font-black text-sm" style={{ color: selected.bot.color }}>
                        {selected.bot.name.slice(0, 2).toUpperCase()}
                      </span>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="font-bold text-zinc-100 text-base truncate">{selected.bot.name}</div>
                      {simOnlyForSymbol(selected.bot.symbol) && (
                        <SimOnlyBadge
                          exchangeName={exchangeName}
                          category={ASSET_MAP[selected.bot.symbol]?.category ?? 'Asset'}
                        />
                      )}
                    </div>
                    <div className="text-[11px] text-zinc-500">{selected.bot.symbol} · {selected.bot.strategy}</div>
                  </div>
                </div>

                {simOnlyForSymbol(selected.bot.symbol) && (
                  <div className="rounded-xl border border-amber-700/40 bg-amber-900/10 px-3 py-2 text-[11px] text-amber-300 leading-relaxed">
                    <strong className="text-amber-200">Simulator-only on {exchangeName}.</strong>{' '}
                    {ASSET_MAP[selected.bot.symbol]?.category ?? 'This asset'} can't be routed live through{' '}
                    {exchangeName}. Switch to a broker that supports it, or to demo/paper mode, to take this
                    signal live.
                  </div>
                )}

                {/* Stats */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-zinc-800/40 rounded-lg px-3 py-2">
                    <div className="text-[9px] uppercase tracking-wider text-zinc-600 mb-0.5">Net P&L</div>
                    <div className={`font-mono font-bold text-base ${selected.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {fmtPnL(selected.pnl)}
                    </div>
                    <div className={`text-[10px] font-mono ${selected.pnlPct >= 0 ? 'text-emerald-400/70' : 'text-red-400/70'}`}>
                      {fmtPct(selected.pnlPct)}
                    </div>
                  </div>
                  <div className="bg-zinc-800/40 rounded-lg px-3 py-2">
                    <div className="text-[9px] uppercase tracking-wider text-zinc-600 mb-0.5">Win Rate</div>
                    <div className={`font-mono font-bold text-base ${selected.winRate >= 50 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {fmt(selected.winRate, 0)}%
                    </div>
                    <div className="text-[10px] text-zinc-500">{selected.tradeCount} trades</div>
                  </div>
                  <div className="bg-zinc-800/40 rounded-lg px-3 py-2">
                    <div className="text-[9px] uppercase tracking-wider text-zinc-600 mb-0.5">Drawdown</div>
                    <div className={`font-mono font-bold text-base ${selected.drawdown < 3 ? 'text-emerald-400' : selected.drawdown < 8 ? 'text-amber-400' : 'text-red-400'}`}>
                      {fmt(selected.drawdown, 1)}%
                    </div>
                    <div className="text-[10px] text-zinc-500">max loss</div>
                  </div>
                  <div className="bg-zinc-800/40 rounded-lg px-3 py-2">
                    <div className="text-[9px] uppercase tracking-wider text-zinc-600 mb-0.5">Score</div>
                    <div className={`font-mono font-bold text-base ${selected.score >= 70 ? 'text-emerald-400' : selected.score >= 45 ? 'text-amber-400' : 'text-red-400'}`}>
                      {selected.score.toFixed(0)}/100
                    </div>
                    <div className="text-[10px] text-zinc-500 capitalize">{selected.health}</div>
                  </div>
                </div>

                {/* Reasons */}
                <div>
                  <div className="text-[9px] uppercase tracking-wider text-zinc-600 mb-2 font-semibold">Why This Bot</div>
                  <div className="space-y-1">
                    {selected.reasons.slice(0, 3).map((r, i) => (
                      <div key={i} className="flex items-center gap-2 text-[11px] text-zinc-400">
                        <span className="text-emerald-500 flex-shrink-0">✓</span>
                        <span>{r}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Signal */}
              <div className="flex flex-col gap-4">
                <ActionSignal
                  action={decision.masterAction}
                  confidence={selected.confidence}
                />

                {/* Risk reason */}
                <div className={`rounded-xl border px-4 py-3 text-xs ${
                  decision.riskLevel === 'SAFE'     ? 'border-emerald-800/40 bg-emerald-900/10 text-emerald-300' :
                  decision.riskLevel === 'MODERATE' ? 'border-amber-800/40 bg-amber-900/10 text-amber-300' :
                  decision.riskLevel === 'HIGH'     ? 'border-orange-800/40 bg-orange-900/10 text-orange-300' :
                  'border-red-800/40 bg-red-900/15 text-red-300'
                }`}>
                  <div className="text-[9px] uppercase tracking-widest opacity-60 mb-1 font-bold">Risk Engine</div>
                  {decision.riskReason}
                </div>
              </div>
            </div>

            {/* ── Portfolio overview ── */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard
                label="Gross P&L"
                value={fmtPnL(decision.portfolioPnL)}
                sub={fmtPct(decision.portfolioPnLPct)}
                green={decision.portfolioPnL >= 0}
              />
              <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl px-4 py-3 flex flex-col gap-0.5">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-medium">Net P&L (after fees)</div>
                <div className={`font-mono font-bold text-xl ${netFeeMetrics.netPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {fmtPnL(netFeeMetrics.netPnl)}
                </div>
                <div className="text-[10px] text-zinc-500">fees: ${fmt(netFeeMetrics.totalFees, 2)} · {PLATFORM_FEE_RATE * 100}% rate</div>
              </div>
              <StatCard
                label="Total Portfolio"
                value={`$${fmt(bots.filter(b => b.isRunning).reduce((s, b) => s + getBotTotalValue(b, getCurrentPrice(b.symbol)), 0))}`}
                sub={`${decision.activeBotCount} bots active`}
              />
              <StatCard
                label="Total Trades"
                value={trades.length.toLocaleString()}
                sub={`${trades.filter(t => t.type === 'SELL' && t.pnl > 0).length} profitable`}
              />
            </div>

            {/* ── Risk Meter ── */}
            <div className="bg-zinc-900/40 border border-zinc-800/50 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="text-[9px] uppercase tracking-widest text-zinc-500 font-semibold mb-0.5">Risk Level</div>
                  <div className="flex items-center gap-2">
                    <RiskBadge level={decision.riskLevel} />
                    <span className="text-[10px] text-zinc-500">
                      Daily limit: −3% &nbsp;·&nbsp; Per-bot limit: −8%
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <div className={`font-mono font-bold text-lg ${decision.portfolioPnLPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {fmtPct(decision.portfolioPnLPct)}
                  </div>
                  <div className="text-[10px] text-zinc-500">today's return</div>
                </div>
              </div>
              <RiskMeter pnlPct={decision.portfolioPnLPct} riskLevel={decision.riskLevel} />
            </div>

            {/* ── Top performers ── */}
            {topBots.length > 0 && (
              <div>
                <SectionTitle>Top Performers</SectionTitle>
                <div className="space-y-2">
                  {topBots.map((ev, i) => (
                    <TopBotRow
                      key={ev.bot.id}
                      eval={ev}
                      rank={i + 1}
                      simOnly={simOnlyForSymbol(ev.bot.symbol)}
                      exchangeName={exchangeName}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* ── Decision log ── */}
            {log.length > 0 && (
              <div>
                <SectionTitle>Decision Log</SectionTitle>
                <div className="bg-zinc-900/40 border border-zinc-800/50 rounded-2xl px-4 py-2 max-h-56 overflow-y-auto">
                  {log.map(e => <LogRow key={e.id} entry={e} />)}
                </div>
              </div>
            )}
          </>
        )}

        {/* ── Standby pool peek ── */}
        {bots.filter(b => !b.isRunning).length > 0 && (
          <div>
            <SectionTitle>Standby Pool</SectionTitle>
            <div className="flex flex-wrap gap-2">
              {bots.filter(b => !b.isRunning).slice(0, 8).map(b => {
                const sim = simOnlyForSymbol(b.symbol);
                return (
                  <div
                    key={b.id}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-900/50 border border-zinc-800/50 text-[11px] text-zinc-400 ${sim ? 'opacity-60' : ''}`}
                    title={sim ? `${ASSET_MAP[b.symbol]?.category ?? 'This asset'} isn't tradable live on ${exchangeName}. Bot will only run in the simulator.` : undefined}
                  >
                    <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: b.color }} />
                    <span className="truncate max-w-[100px]">{b.name}</span>
                    <span className="text-zinc-600">·</span>
                    <span className="text-zinc-500 text-[10px]">{b.symbol}</span>
                    {sim && (
                      <span className="ml-1 px-1 rounded text-[9px] font-bold uppercase tracking-wider border border-amber-600/40 bg-amber-900/15 text-amber-400">
                        Sim
                      </span>
                    )}
                  </div>
                );
              })}
              {bots.filter(b => !b.isRunning).length > 8 && (
                <div className="flex items-center px-2.5 py-1.5 text-[11px] text-zinc-600">
                  +{bots.filter(b => !b.isRunning).length - 8} more
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Disclaimer ── */}
        <div className="flex items-start gap-2 px-4 py-3 rounded-xl border border-zinc-800/40 bg-zinc-900/20 text-[10px] text-zinc-600">
          <ShieldAlert size={12} className="text-amber-600 flex-shrink-0 mt-0.5" />
          <span>
            <strong className="text-zinc-500">Paper Trading Only.</strong> All trades use virtual funds.
            Results are simulated — not real performance. No financial advice is provided.
            Fees shown are estimated at {PLATFORM_FEE_RATE * 100}% per trade.
            Past simulated results do not guarantee future real-market performance.
          </span>
        </div>

        <div className="pb-4" />
      </div>
    </div>
  );
}
