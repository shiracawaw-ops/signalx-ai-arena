
import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import { useArena } from '@/hooks/use-arena';
import { usePerf } from '@/hooks/use-perf';
import { getBotPnL } from '@/lib/engine';
import { ASSETS, STRATEGIES } from '@/lib/storage';
import { exchangeMode, modeLabel } from '@/lib/exchange-mode';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import {
  Play, Pause, RotateCcw, Plus, Stethoscope, Search, AlertTriangle,
  TrendingUp, TrendingDown, DollarSign, Activity, Zap, Menu, CircleDot,
  Shield, Bot, X, Cpu,
} from 'lucide-react';

// ── Formatters ────────────────────────────────────────────────────────────────
function fmt(n: number, dec = 2) {
  return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  const sign = n >= 0 ? '+' : '-';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000)     return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}

// ── Stat pill ─────────────────────────────────────────────────────────────────
function StatPill({
  label, value, color = 'text-zinc-200', icon: Icon,
}: {
  label: string; value: string; color?: string; icon?: React.ElementType;
}) {
  return (
    <div className="flex items-center gap-1 px-2 h-7 bg-zinc-900/70 rounded border border-zinc-800/60 flex-shrink-0">
      {Icon && <Icon size={10} className={`${color} flex-shrink-0`} />}
      <span className="text-[9px] text-zinc-500 uppercase tracking-wide hidden lg:inline leading-none">{label}</span>
      <motion.span
        key={value}
        initial={{ opacity: 0, y: -3 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className={`text-[11px] font-mono font-bold ${color} leading-none`}
      >
        {value}
      </motion.span>
    </div>
  );
}

function Divider() {
  return <div className="w-px h-5 bg-zinc-800/70 flex-shrink-0 mx-0.5" />;
}

// ── Mode badge — reads live from exchangeMode singleton ───────────────────────
function ModeBadge() {
  const [mode, setMode] = useState(exchangeMode.get().mode);
  useEffect(() => exchangeMode.subscribe(s => setMode(s.mode)), []);
  const label = modeLabel(mode);
  const color =
    mode === 'real'    ? 'text-red-400    border-red-600/40    bg-red-600/10'    :
    mode === 'testnet' ? 'text-orange-400 border-orange-600/40 bg-orange-600/10' :
    mode === 'paper'   ? 'text-yellow-400 border-yellow-600/40 bg-yellow-600/10' :
                         'text-blue-400   border-blue-600/40   bg-blue-600/10';
  return (
    <div className={`flex items-center gap-1 px-2 h-7 rounded border flex-shrink-0 ${color}`}>
      <Shield size={10} className="flex-shrink-0" />
      <span className="text-[9px] text-zinc-500 uppercase tracking-wide hidden xl:inline">Mode</span>
      <span className="text-[10px] font-bold">{label}</span>
    </div>
  );
}

// ── AI Performance badge ──────────────────────────────────────────────────────
function PerfBadge() {
  const { fps, quality } = usePerf();
  const color = quality === 'high' ? 'text-emerald-400 border-emerald-600/30 bg-emerald-600/8'
              : quality === 'medium' ? 'text-amber-400 border-amber-600/30 bg-amber-600/8'
              : 'text-red-400 border-red-600/30 bg-red-600/8';
  const label = quality === 'high' ? 'HIGH' : quality === 'medium' ? 'MED' : 'LOW';
  return (
    <div
      title={`AI Optimizer active — ${fps}fps ${quality} quality. Tick rate and animations auto-adjusted.`}
      className={`flex items-center gap-1 px-2 h-7 rounded border ${color} cursor-default flex-shrink-0`}
    >
      <Cpu size={10} />
      <span className="text-[9px] uppercase font-bold hidden xl:inline">AI</span>
      <span className="text-[10px] font-mono font-bold">{fps}<span className="text-[8px] opacity-60">fps</span></span>
      <span className={`text-[9px] font-bold hidden sm:inline ${
        quality === 'high' ? 'text-emerald-400' : quality === 'medium' ? 'text-amber-400' : 'text-red-400'
      }`}>{label}</span>
    </div>
  );
}

// ── Add Bot dialog ────────────────────────────────────────────────────────────
function AddBotDialog() {
  const { addBot } = useArena();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('BTC');
  const [strategy, setStrategy] = useState('RSI');

  const handleAdd = () => {
    const n = name.trim() || `${symbol} ${strategy} Bot`;
    addBot(n, symbol, strategy);
    toast({ title: `Bot added: ${n}`, description: `${symbol} · ${strategy}` });
    setName(''); setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="flex items-center gap-1 px-2 h-7 rounded border border-blue-600/40 bg-blue-600/10 text-blue-400 text-[11px] font-semibold hover:bg-blue-600/20 transition-colors flex-shrink-0">
          <Plus size={11} /> <span className="hidden sm:inline">Add Bot</span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-sm bg-zinc-950 border-zinc-800">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <Bot size={14} className="text-blue-400" /> Add New Bot
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <div className="space-y-1">
            <Label className="text-xs">Name (optional)</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Auto-generated" className="h-8 text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Symbol</Label>
            <Select value={symbol} onValueChange={setSymbol}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ASSETS.map(a => <SelectItem key={a.symbol} value={a.symbol} className="text-xs">{a.symbol} — {a.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Strategy</Label>
            <Select value={strategy} onValueChange={setStrategy}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {STRATEGIES.map(s => <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={handleAdd} className="w-full h-8 text-xs">
            <Plus size={12} className="mr-1.5" /> Create Bot
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── CSS-based ticker (GPU-accelerated, zero JS animation overhead) ─────────────
function TickerStrip() {
  // Use refs to avoid re-renders on every tick — interval snapshots data every 5s
  const { bots, trades, market, getCurrentPrice } = useArena();
  const botsRef   = useRef(bots);
  const tradesRef = useRef(trades);
  const marketRef = useRef(market);
  // Direct ref updates in render — no useEffect needed, no extra re-renders
  botsRef.current   = bots;
  tradesRef.current = trades;
  marketRef.current = market;

  // Compute ticker items — refreshed every 5 seconds via own interval
  const [items, setItems] = useState<Array<{ label: string; value: string; color: string }>>([]);

  const buildItems = useCallback(() => {
    const _bots    = botsRef.current;
    const _trades  = tradesRef.current;
    const _market  = marketRef.current;

    const totalPnL   = _bots.reduce((s, b) => s + getBotPnL(b, getCurrentPrice(b.symbol)), 0);
    const totalFees  = _trades.reduce((s, t) => s + (((t as unknown as Record<string, number>)['fee']) ?? 0), 0);
    const sells      = _trades.filter(t => t.type === 'SELL');
    const winRate    = sells.length > 0 ? (sells.filter(t => t.pnl > 0).length / sells.length) * 100 : 0;
    const active     = _bots.filter(b => b.isRunning).length;

    const sorted     = [..._bots].sort((a, b) => getBotPnL(b, getCurrentPrice(b.symbol)) - getBotPnL(a, getCurrentPrice(a.symbol)));
    const topBot     = sorted[0];
    const worstBot   = sorted[sorted.length - 1];

    const keySymbols = ['BTC', 'ETH', 'SOL', 'NVDA', 'GOLD', 'EURUSD', 'TSLA', 'AAPL', 'OIL', 'GBPUSD'];
    const prices = keySymbols.flatMap(sym => {
      const c = _market[sym];
      if (!c || c.length < 2) return [];
      const price = c[c.length - 1].close;
      const prev  = c[c.length - 2].close;
      const chg   = prev > 0 ? ((price - prev) / prev) * 100 : 0;
      return [{ sym, price, chg }];
    });

    const out: Array<{ label: string; value: string; color: string }> = [
      ...prices.map(p => ({
        label: p.sym,
        value: `${p.price > 10 ? '$' + fmt(p.price, p.price > 100 ? 0 : 2) : '$' + p.price.toFixed(4)} (${p.chg >= 0 ? '+' : ''}${p.chg.toFixed(2)}%)`,
        color: p.chg >= 0 ? 'text-emerald-400' : 'text-red-400',
      })),
      { label: 'NET P&L',  value: fmtCompact(totalPnL),              color: totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400' },
      { label: 'FEES',     value: `-$${fmt(totalFees, 0)}`,           color: 'text-amber-400' },
      { label: 'WIN RATE', value: `${winRate.toFixed(1)}%`,           color: 'text-blue-400' },
      { label: 'TRADES',   value: _trades.length.toLocaleString(),    color: 'text-zinc-300' },
      { label: 'ACTIVE',   value: `${active}/${_bots.length}`,        color: 'text-purple-400' },
      ...(topBot  ? [{ label: '🏆 TOP',   value: `${topBot.name} ${fmtCompact(getBotPnL(topBot, getCurrentPrice(topBot.symbol)))}`,     color: 'text-emerald-400' }] : []),
      ...(worstBot ? [{ label: '⚠ WORST', value: `${worstBot.name} ${fmtCompact(getBotPnL(worstBot, getCurrentPrice(worstBot.symbol)))}`, color: 'text-red-400' }] : []),
    ];
    setItems(out);
  }, [getCurrentPrice]);

  // Build once immediately, then refresh every 5 seconds (not every tick)
  useEffect(() => { buildItems(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = setInterval(buildItems, 5000);
    return () => clearInterval(id);
  }, [buildItems]);

  const tickerContent = items.map((item, i) => (
    <span key={i} className="flex items-center flex-shrink-0">
      <span className="text-[9px] text-zinc-600 uppercase tracking-widest px-2 font-mono">{item.label}</span>
      <span className={`text-[10px] font-mono font-semibold ${item.color}`}>{item.value}</span>
      <span className="text-zinc-800 mx-3 text-[10px]">│</span>
    </span>
  ));

  return (
    <div className="h-6 overflow-hidden flex items-center bg-zinc-950 border-b border-zinc-800/40 relative select-none">
      {/* Fades */}
      <div className="absolute left-0 top-0 bottom-0 w-8 bg-gradient-to-r from-zinc-950 to-transparent z-10 pointer-events-none" />
      <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-zinc-950 to-transparent z-10 pointer-events-none" />
      {/* CSS animated strip — GPU-accelerated, zero JS cost */}
      {items.length > 0 && (
        <div className="signalx-ticker flex items-center whitespace-nowrap w-max">
          {tickerContent}
          {tickerContent}
        </div>
      )}
    </div>
  );
}

// ── Main GlobalControlBar ─────────────────────────────────────────────────────
interface GlobalControlBarProps {
  onMobileOpen: () => void;
  alerts?: number;
}

export function GlobalControlBar({ onMobileOpen, alerts = 0 }: GlobalControlBarProps) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const {
    bots, trades, isGlobalRunning,
    start, stop, resetAll, getCurrentPrice,
    searchQuery, setSearchQuery,
  } = useArena();

  // ── Throttled display stats — recompute at most every 2s via interval ─────
  // Refs are updated inline (not via useEffect) to always reflect latest data
  const botsRef   = useRef(bots);
  const tradesRef = useRef(trades);
  const gcRef     = useRef(getCurrentPrice);
  botsRef.current   = bots;
  tradesRef.current = trades;
  gcRef.current     = getCurrentPrice;

  const computeStats = useCallback(() => {
    const b = botsRef.current;
    const t = tradesRef.current;
    const gp = gcRef.current;
    const activeBots   = b.filter(x => x.isRunning).length;
    const pausedBots   = b.filter(x => !x.isRunning).length;
    const totalPnL     = b.reduce((s, x) => s + getBotPnL(x, gp(x.symbol)), 0);
    const totalFees    = t.reduce((s, x) => s + (((x as unknown as Record<string, number>)['fee']) ?? 0), 0);
    const sells        = t.filter(x => x.type === 'SELL');
    const winRate      = sells.length > 0 ? (sells.filter(x => x.pnl > 0).length / sells.length) * 100 : 0;
    const weakBots     = b.filter(x => x.startingBalance > 0 && (x.startingBalance - x.balance) / x.startingBalance > 0.15).length;
    const criticalBots = b.filter(x => x.startingBalance > 0 && (x.startingBalance - x.balance) / x.startingBalance > 0.30).length;
    return { activeBots, pausedBots, totalPnL, totalFees, winRate, weakBots, criticalBots };
  }, []);

  const [stats, setStats] = useState(computeStats);
  // Interval-only update — refs are always fresh, so no bots/trades deps needed.
  // This prevents setStats from being called on every single tick.
  useEffect(() => {
    const id = setInterval(() => setStats(computeStats()), 2000);
    return () => clearInterval(id);
  }, [computeStats]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStartAll  = () => { start();    toast({ title: '▶ Arena Resumed', description: `${stats.activeBots} bots trading.` }); };
  const handlePauseAll  = () => { stop();     toast({ title: '⏸ Arena Paused',  description: 'All bot activity halted.' }); };
  const handleResetAll  = () => { resetAll(); toast({ title: '↺ Arena Reset',   description: 'All bots re-seeded.' }); };
  const handleDoctor    = () => navigate('/doctor');

  return (
    <div className="flex-shrink-0">

      {/* ── Control bar ───────────────────────────────────────────────────── */}
      <div className="h-11 border-b border-zinc-800/60 bg-zinc-950/95 backdrop-blur-sm flex items-center px-2 gap-1 overflow-x-auto">

        {/* Mobile menu */}
        <button className="lg:hidden text-zinc-400 hover:text-white mr-1 flex-shrink-0" onClick={onMobileOpen}>
          <Menu size={16} />
        </button>

        {/* Live pulse */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <div className={`w-1.5 h-1.5 rounded-full ${isGlobalRunning ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
          <span className={`text-[10px] font-bold tracking-wide hidden sm:inline ${isGlobalRunning ? 'text-emerald-400' : 'text-amber-400'}`}>
            {isGlobalRunning ? 'LIVE' : 'PAUSED'}
          </span>
        </div>

        <Divider />

        {/* Bot counts */}
        <StatPill label="Active"  value={`${stats.activeBots}`} color="text-emerald-400" icon={CircleDot} />
        <StatPill label="Paused"  value={`${stats.pausedBots}`} color="text-amber-400"   icon={Pause} />

        <Divider />

        {/* Financial stats */}
        <StatPill
          label="Net P&L"
          value={fmtCompact(stats.totalPnL)}
          color={stats.totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}
          icon={stats.totalPnL >= 0 ? TrendingUp : TrendingDown}
        />
        <StatPill label="Fees"    value={`-$${fmt(stats.totalFees, 0)}`} color="text-amber-400" icon={DollarSign} />
        <StatPill label="Win%"    value={`${stats.winRate.toFixed(0)}%`} color="text-blue-400"  icon={Activity} />

        <Divider />

        {/* Market mode — reads live from exchangeMode singleton */}
        <ModeBadge />

        {/* AI Perf badge */}
        <PerfBadge />

        {/* Weak bot warning */}
        <AnimatePresence>
          {stats.weakBots > 0 && (
            <motion.button
              initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}
              onClick={handleDoctor}
              className={`flex items-center gap-1 px-2 h-7 rounded border text-[10px] font-bold transition-colors flex-shrink-0
                ${stats.criticalBots > 0
                  ? 'border-red-600/50 bg-red-600/10 text-red-400 hover:bg-red-600/20'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'}`}
            >
              <span className="animate-pulse">
                <AlertTriangle size={11} />
              </span>
              <span className="hidden sm:inline">
                {stats.criticalBots > 0 ? `${stats.criticalBots} critical` : `${stats.weakBots} weak`}
              </span>
            </motion.button>
          )}
        </AnimatePresence>

        {/* Spacer */}
        <div className="flex-1 min-w-2" />

        {/* Search */}
        <div className="relative flex-shrink-0 hidden md:flex items-center">
          <Search size={11} className="absolute left-2 text-zinc-500 pointer-events-none" />
          <input
            type="text"
            placeholder="Search bots…"
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); if (e.target.value) navigate('/'); }}
            className="h-7 w-36 xl:w-44 pl-6 pr-6 bg-zinc-900/70 border border-zinc-700 rounded text-[11px] text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-zinc-500 transition-colors"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} className="absolute right-1.5 text-zinc-600 hover:text-zinc-400">
              <X size={10} />
            </button>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1 flex-shrink-0">

          {isGlobalRunning ? (
            <button onClick={handlePauseAll} title="Pause All"
              className="flex items-center gap-1 px-2 h-7 rounded border border-amber-600/40 bg-amber-600/10 text-amber-400 text-[11px] font-semibold hover:bg-amber-600/20 transition-colors">
              <Pause size={11} /> <span className="hidden xl:inline">Pause All</span>
            </button>
          ) : (
            <button onClick={handleStartAll} title="Start All"
              className="flex items-center gap-1 px-2 h-7 rounded border border-emerald-600/40 bg-emerald-600/10 text-emerald-400 text-[11px] font-semibold hover:bg-emerald-600/20 transition-colors">
              <Play size={11} /> <span className="hidden xl:inline">Start All</span>
            </button>
          )}

          <button onClick={handleResetAll} title="Reset All"
            className="flex items-center gap-1 px-2 h-7 rounded border border-zinc-700 bg-zinc-900/70 text-zinc-400 text-[11px] font-semibold hover:border-zinc-500 hover:text-zinc-200 transition-colors">
            <RotateCcw size={11} /> <span className="hidden xl:inline">Reset All</span>
          </button>

          <AddBotDialog />

          <button onClick={handleDoctor} title="Bot Doctor"
            className={`flex items-center gap-1 px-2 h-7 rounded border text-[11px] font-semibold transition-colors
              ${stats.criticalBots > 0
                ? 'border-red-600/50 bg-red-600/10 text-red-400 hover:bg-red-600/20'
                : 'border-zinc-700 bg-zinc-900/70 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'}`}>
            <Stethoscope size={11} /> <span className="hidden xl:inline">Bot Doctor</span>
          </button>
        </div>

        {/* Alerts bell */}
        <button className="relative flex-shrink-0 w-7 h-7 rounded border border-zinc-700 flex items-center justify-center text-zinc-400 hover:text-white hover:border-zinc-500 transition-colors">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
          </svg>
          {alerts > 0 && (
            <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-red-600 rounded-full text-[8px] text-white flex items-center justify-center font-bold">
              {alerts}
            </span>
          )}
        </button>
      </div>

      {/* ── Ticker strip ──────────────────────────────────────────────────── */}
      <TickerStrip />
    </div>
  );
}
