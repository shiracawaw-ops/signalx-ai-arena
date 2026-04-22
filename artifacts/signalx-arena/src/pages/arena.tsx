
import { useState, useMemo, useCallback, memo, useEffect } from 'react';
import { useArena } from '@/hooks/use-arena';
import { getBotTotalValue, getBotPnL, getBotPnLPercent } from '@/lib/engine';
import { computeAllIndicators } from '@/lib/indicators';
import { SYMBOLS, STRATEGIES, CATEGORIES, ASSETS, ASSET_MAP } from '@/lib/storage';
import { useBotDoctor, type DustMark } from '@/lib/bot-doctor-store';
import { exchangeMode, type ExchangeModeState } from '@/lib/exchange-mode';
import { baseTicker } from '@/lib/risk-manager';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { ResponsiveContainer, LineChart, Line } from 'recharts';
import { Sparkles } from 'lucide-react';

function fmt(n: number, dec = 2) {
  return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function pct(n: number) {
  return `${n >= 0 ? '+' : ''}${fmt(n)}%`;
}

function SignalBadge({ signal }: { signal: 'BUY' | 'SELL' | 'HOLD' }) {
  const colors = { BUY: 'bg-emerald-500', SELL: 'bg-red-500', HOLD: 'bg-slate-600' };
  return <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded text-white ${colors[signal]}`}>{signal}</span>;
}

// Memoized sparkline — only re-renders when candle count or direction changes
const MiniSparkline = memo(function MiniSparkline({ candles, isUp }: { candles: any[]; isUp: boolean }) {
  if (!candles || candles.length < 10) return <div className="h-8 bg-muted/20 rounded" />;
  const data = candles.slice(-30).map((c, i) => ({ i, v: c.close }));
  return (
    <div className="h-8 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <Line type="monotone" dataKey="v" stroke={isUp ? '#10b981' : '#ef4444'} strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}, (prev, next) => prev.candles.length === next.candles.length && prev.isUp === next.isUp);

// Indicator grid — throttled computation (updates every ~3s, not every tick)
const IndicatorGrid = memo(function IndicatorGrid({ candles }: { candles: any[] }) {
  const ind = useMemo(() => {
    if (!candles || candles.length < 52) return null;
    return computeAllIndicators(candles);
  // Recompute only when candle length changes, not every price tick
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles.length]);

  if (!ind) return <div className="text-[10px] text-muted-foreground py-1">Warming up…</div>;
  const rows = [
    { label: 'RSI(14)', value: fmt(ind.rsi.value, 1),                                               signal: ind.rsi.signal },
    { label: 'MACD',    value: (ind.macd.histogram >= 0 ? '+' : '') + fmt(ind.macd.histogram, 3),   signal: ind.macd.signal_dir },
    { label: 'VWAP',    value: '$' + fmt(ind.vwap.value),                                            signal: ind.vwap.signal },
    { label: 'BB',      value: `${fmt(ind.bollinger.lower, 0)}–${fmt(ind.bollinger.upper, 0)}`,      signal: ind.bollinger.signal },
    { label: 'SMA',     value: `${fmt(ind.sma.sma20, 0)}/${fmt(ind.sma.sma50, 0)}`,                  signal: ind.sma.signal },
    { label: 'Break',   value: `${fmt(ind.breakout.support, 0)}–${fmt(ind.breakout.resistance, 0)}`, signal: ind.breakout.signal },
  ];
  return (
    <div className="space-y-1 mt-1">
      {rows.map(row => (
        <div key={row.label} className="flex items-center justify-between text-[10px]">
          <span className="text-muted-foreground">{row.label}</span>
          <div className="flex items-center gap-1.5">
            <span className="font-mono">{row.value}</span>
            <SignalBadge signal={row.signal} />
          </div>
        </div>
      ))}
    </div>
  );
}, (prev, next) => prev.candles.length === next.candles.length);

function AddBotDialog({ onAdd }: { onAdd: (name: string, symbol: string, strategy: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('AAPL');
  const [strategy, setStrategy] = useState('RSI');

  const handleAdd = () => {
    if (!name.trim()) return;
    onAdd(name.trim(), symbol, strategy);
    setName('');
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="default" size="sm" className="h-7 text-xs">+ Bot</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Add Trading Bot</DialogTitle></DialogHeader>
        <div className="space-y-3 pt-2">
          <div className="space-y-1">
            <Label>Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="My Bot" onKeyDown={e => e.key === 'Enter' && handleAdd()} />
          </div>
          <div className="space-y-1">
            <Label>Symbol</Label>
            <Select value={symbol} onValueChange={setSymbol}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{SYMBOLS.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Strategy</Label>
            <Select value={strategy} onValueChange={setStrategy}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{STRATEGIES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <Button onClick={handleAdd} className="w-full" disabled={!name.trim()}>Deploy ($1,000 virtual)</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// BotCard — memoized, skips re-render unless meaningful data changed
interface BotCardProps {
  bot: any; price: number; priceChange: number; pnl: number; pnlPct: number; totalValue: number;
  tradeCount: number; candles: any[];
  dust: DustMark | null;
  toggleBot: (id: string) => void;
  resetBot:  (id: string) => void;
  removeBot: (id: string) => void;
}
const BotCard = memo(function BotCard({
  bot, price, priceChange: _priceChange, pnl, pnlPct, totalValue, tradeCount, candles, dust,
  toggleBot, resetBot, removeBot,
}: BotCardProps) {
  const [showInd, setShowInd] = useState(false);
  const isUp = candles.length >= 2 && candles[candles.length - 1].close >= candles[candles.length - 20]?.close;
  // Stable per-bot handlers — botId and context callbacks never change
  const onToggle = useCallback(() => toggleBot(bot.id), [toggleBot, bot.id]);
  const onReset  = useCallback(() => resetBot(bot.id),  [resetBot,  bot.id]);
  const onRemove = useCallback(() => removeBot(bot.id), [removeBot, bot.id]);

  return (
    <Card className="overflow-hidden border-border/60 hover:border-border transition-colors">
      <div className="h-0.5" style={{ background: bot.color }} />
      <CardContent className="p-3">
        {/* Header row */}
        <div className="flex items-start justify-between gap-1 mb-1.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 mb-0.5">
              <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: bot.color }} />
              <span className="font-semibold text-xs truncate">{bot.name}</span>
            </div>
            <div className="flex items-center gap-1 flex-wrap">
              <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">{bot.symbol}</Badge>
              <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">{bot.strategy}</Badge>
              <span className={`text-[9px] px-1 py-0 rounded ${bot.isRunning ? 'text-emerald-400' : 'text-muted-foreground'}`}>
                {bot.isRunning ? '▶' : '⏸'}
              </span>
            </div>
          </div>
          <div className="flex gap-0.5 flex-shrink-0">
            <button onClick={onToggle} className="text-[10px] px-1.5 py-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
              {bot.isRunning ? '⏸' : '▶'}
            </button>
            <button onClick={onReset} className="text-[10px] px-1.5 py-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">↺</button>
            <button onClick={onRemove} className="text-[10px] px-1.5 py-0.5 rounded hover:bg-muted text-red-400 hover:text-red-300 transition-colors">✕</button>
          </div>
        </div>

        {/* Sparkline */}
        <MiniSparkline candles={candles} isUp={isUp} />

        {/* Key numbers */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-2 text-[11px]">
          <div>
            <span className="text-muted-foreground">Value </span>
            <span className="font-mono font-bold">${fmt(totalValue)}</span>
          </div>
          <div>
            <span className={`font-mono font-bold ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {pnl >= 0 ? '+' : ''}${fmt(pnl)}
            </span>
            <span className={`text-[10px] ml-1 ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>({pct(pnlPct)})</span>
          </div>
          <div>
            <span className="text-muted-foreground">Price </span>
            <span className="font-mono">${fmt(price)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Cash </span>
            <span className="font-mono">${fmt(bot.balance)}</span>
          </div>
          {bot.position > 0 && (
            <div className="col-span-2 text-[10px] text-muted-foreground flex items-center gap-1.5 flex-wrap">
              <span>Pos: {fmt(bot.position, 3)} @ ${fmt(bot.avgEntryPrice)}</span>
              {dust && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 text-[9px] font-semibold uppercase tracking-wide"
                      data-testid={`badge-bot-dust-${bot.id}`}
                      aria-label={`${bot.symbol} marked as dust on ${dust.exchange}`}
                    >
                      <Sparkles size={9} />
                      Dust
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs text-xs">
                    <div className="font-semibold mb-1">Marked as dust on {dust.exchange}</div>
                    <div className="text-zinc-300 mb-1">{dust.reason}</div>
                    <div className="text-[10px] text-zinc-400">
                      Marked {new Date(dust.markedAt).toLocaleString()}
                    </div>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between mt-2">
          <span className="text-[10px] text-muted-foreground">{tradeCount} trades</span>
          <button
            onClick={() => setShowInd(v => !v)}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {showInd ? 'hide ▲' : 'indicators ▼'}
          </button>
        </div>

        {showInd && (
          <>
            <Separator className="my-1.5" />
            <IndicatorGrid candles={candles} />
          </>
        )}
      </CardContent>
    </Card>
  );
// Custom comparator — skip re-render if key visual data hasn't changed meaningfully
}, (prev, next) => {
  if (prev.bot.id !== next.bot.id) return false;
  if (prev.bot.isRunning !== next.bot.isRunning) return false;
  if (prev.tradeCount !== next.tradeCount) return false;
  if (prev.candles.length !== next.candles.length) return false;
  if (Math.abs(prev.pnl - next.pnl) > 0.005) return false;
  if (Math.abs(prev.price - next.price) > 0.0001) return false;
  if (Math.abs(prev.totalValue - next.totalValue) > 0.005) return false;
  if ((prev.dust?.markedAt ?? 0) !== (next.dust?.markedAt ?? 0)) return false;
  if ((prev.dust?.reason ?? '') !== (next.dust?.reason ?? '')) return false;
  return true; // same — skip re-render
});

export default function ArenaPage() {
  const {
    bots, market, trades, isGlobalRunning, tickCount,
    spendPct, setSpendPct,
    searchQuery,
    start, stop, addBot, removeBot, toggleBot, resetBot, resetAll, getCurrentPrice,
  } = useArena();

  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [symbolFilter, setSymbolFilter] = useState<string>('ALL');
  const [strategyFilter, setStrategyFilter] = useState<string>('ALL');

  // Dust warnings — match Wallet/Holdings: scoped to the active exchange.
  const doctor = useBotDoctor();
  const [exState, setExState] = useState<ExchangeModeState>(() => exchangeMode.get());
  useEffect(() => exchangeMode.subscribe(setExState), []);

  const sorted = useMemo(() => {
    return [...bots].sort((a, b) =>
      getBotTotalValue(b, getCurrentPrice(b.symbol)) - getBotTotalValue(a, getCurrentPrice(a.symbol))
    );
  // getCurrentPrice reads from stateRef — always fresh without needing market in deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bots]);

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return sorted.filter(b => {
      const asset = ASSET_MAP[b.symbol];
      const matchesSearch = !q || b.name.toLowerCase().includes(q) || b.symbol.toLowerCase().includes(q) || b.strategy.toLowerCase().includes(q);
      return (
        matchesSearch &&
        (categoryFilter === 'ALL' || asset?.category === categoryFilter) &&
        (symbolFilter === 'ALL' || b.symbol === symbolFilter) &&
        (strategyFilter === 'ALL' || b.strategy === strategyFilter)
      );
    });
  }, [sorted, categoryFilter, symbolFilter, strategyFilter, searchQuery]);

  // O(n) trade count map — avoids O(n×m) per-card filter
  const tradeCountMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of trades) map.set(t.botId, (map.get(t.botId) ?? 0) + 1);
    return map;
  }, [trades]);

  // O(n) per-bot win/loss stats for leaderboard — single pass, avoids 3× filter per bot
  const botTradeStats = useMemo(() => {
    const map = new Map<string, { tc: number; wins: number; losses: number }>();
    for (const t of trades) {
      const s = map.get(t.botId) ?? { tc: 0, wins: 0, losses: 0 };
      s.tc++;
      if (t.type === 'SELL') { if (t.pnl > 0) s.wins++; else s.losses++; }
      map.set(t.botId, s);
    }
    return map;
  }, [trades]);

  // Memoized portfolio stats
  const { totalPortfolio, totalPnL, totalPnLPct, winRate, wins, losses } = useMemo(() => {
    const totalPortfolio = bots.reduce((s, b) => s + getBotTotalValue(b, getCurrentPrice(b.symbol)), 0);
    const totalStarting  = bots.reduce((s, b) => s + b.startingBalance, 0);
    const totalPnL       = totalPortfolio - totalStarting;
    const totalPnLPct    = totalStarting > 0 ? (totalPnL / totalStarting) * 100 : 0;
    const sellTrades     = trades.filter(t => t.type === 'SELL');
    const wins           = sellTrades.filter(t => t.pnl > 0).length;
    const losses         = sellTrades.filter(t => t.pnl <= 0).length;
    const winRate        = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0;
    return { totalPortfolio, totalStarting, totalPnL, totalPnLPct, winRate, wins, losses };
  }, [bots, trades, market]);

  return (
    <div className="bg-background text-foreground flex flex-col min-h-full">
      {/* ── Arena top bar ── */}
      <div className="border-b border-zinc-800/60 bg-zinc-950/60 backdrop-blur-sm sticky top-0 z-10">
        <div className="px-4 py-2 flex items-center gap-3 justify-between flex-wrap">
          {/* Stats */}
          <div className="flex items-center gap-3 text-xs overflow-x-auto">
            <Stat label="Bots"      value={`${bots.length}`} />
            <Stat label="Portfolio" value={`$${fmt(totalPortfolio)}`} />
            <Stat label="P&L"       value={`${totalPnL >= 0 ? '+' : ''}$${fmt(totalPnL)}`} green={totalPnL >= 0} />
            <Stat label="Return"    value={pct(totalPnLPct)} green={totalPnLPct >= 0} />
            <Stat label="Trades"    value={trades.length.toString()} />
            <Stat label="Win%"      value={`${fmt(winRate, 0)}%`} />
            <Stat label="Tick"      value={`#${tickCount}`} />
          </div>

          <div className="flex items-center gap-1.5 flex-shrink-0">
            {/* Spend % */}
            <div className="flex items-center gap-1 bg-zinc-900 rounded-md px-2 py-1 border border-zinc-700">
              <span className="text-[10px] text-zinc-500 font-medium hidden sm:inline">Spend</span>
              <select
                value={spendPct}
                onChange={e => setSpendPct(parseFloat(e.target.value))}
                className="bg-transparent text-[11px] font-bold text-blue-400 outline-none cursor-pointer"
              >
                {[5, 10, 15, 20, 25, 30, 40, 50].map(p => (
                  <option key={p} value={p / 100}>{p}%</option>
                ))}
              </select>
            </div>
            <Badge variant={isGlobalRunning ? 'default' : 'secondary'} className="text-[10px] px-1.5 h-5 hidden sm:flex">
              {isGlobalRunning ? '⚡ LIVE' : '⏸ PAUSED'}
            </Badge>
            {isGlobalRunning
              ? <Button variant="destructive" size="sm" className="h-7 text-xs" onClick={stop}>Pause</Button>
              : <Button variant="default" size="sm" className="h-7 text-xs" onClick={start}>Resume</Button>
            }
            <AddBotDialog onAdd={addBot} />
          </div>
        </div>
      </div>

      <div className="px-4 py-4 flex-1 w-full max-w-screen-2xl mx-auto">
        <Tabs defaultValue="arena">
          <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
            <TabsList>
              <TabsTrigger value="arena" className="text-xs">Arena ({bots.length})</TabsTrigger>
              <TabsTrigger value="leaderboard" className="text-xs">Leaderboard</TabsTrigger>
              <TabsTrigger value="trades" className="text-xs">Trades ({trades.length})</TabsTrigger>
              <TabsTrigger value="market" className="text-xs">Market</TabsTrigger>
            </TabsList>

            {/* Filters */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {/* Category pills */}
              {(['ALL', ...CATEGORIES] as string[]).map(cat => (
                <button
                  key={cat}
                  onClick={() => { setCategoryFilter(cat); setSymbolFilter('ALL'); }}
                  className={`text-[10px] px-2 py-1 rounded-full border transition-colors ${
                    categoryFilter === cat
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-border text-muted-foreground hover:border-foreground'
                  }`}
                >
                  {cat === 'ALL' ? 'All' : cat}
                </button>
              ))}
              <div className="w-px h-4 bg-border mx-1" />
              {/* Symbol filter — scoped to category */}
              <Select value={symbolFilter} onValueChange={setSymbolFilter}>
                <SelectTrigger className="h-7 text-[10px] w-24"><SelectValue placeholder="Symbol" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All symbols</SelectItem>
                  {ASSETS
                    .filter(a => categoryFilter === 'ALL' || a.category === categoryFilter)
                    .map(a => <SelectItem key={a.symbol} value={a.symbol}>{a.symbol} — {a.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={strategyFilter} onValueChange={setStrategyFilter}>
                <SelectTrigger className="h-7 text-[10px] w-28"><SelectValue placeholder="Strategy" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All strategies</SelectItem>
                  {STRATEGIES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* ── ARENA ── */}
          <TabsContent value="arena">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-2.5">
              {filtered.map(bot => {
                const price = getCurrentPrice(bot.symbol);
                const candles = market[bot.symbol] || [];
                const prev = candles[candles.length - 2];
                const priceChange = prev ? ((candles[candles.length - 1]?.close - prev.close) / prev.close) * 100 : 0;
                const totalValue = getBotTotalValue(bot, price);
                const pnl = getBotPnL(bot, price);
                const pnlPct = getBotPnLPercent(bot, price);
                const tradeCount = tradeCountMap.get(bot.id) ?? 0;
                const dust = exState.exchange
                  ? doctor.dust[`${exState.exchange}:${baseTicker(bot.symbol)}`] ?? null
                  : null;

                return (
                  <BotCard
                    key={bot.id}
                    bot={bot}
                    price={price}
                    priceChange={priceChange}
                    pnl={pnl}
                    pnlPct={pnlPct}
                    totalValue={totalValue}
                    tradeCount={tradeCount}
                    candles={candles}
                    dust={dust}
                    toggleBot={toggleBot}
                    resetBot={resetBot}
                    removeBot={removeBot}
                  />
                );
              })}
            </div>
            {filtered.length === 0 && (
              <div className="text-center text-muted-foreground py-12">No bots match the current filter.</div>
            )}
          </TabsContent>

          {/* ── LEADERBOARD ── */}
          <TabsContent value="leaderboard">
            <div className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: 'Total Portfolio', value: `$${fmt(totalPortfolio)}`, sub: `+${fmt(totalPnLPct)}% return`, green: totalPnL >= 0 },
                  { label: 'Combined P&L', value: `${totalPnL >= 0 ? '+' : ''}$${fmt(totalPnL)}`, green: totalPnL >= 0 },
                  { label: 'Total Trades', value: trades.length.toString(), sub: `${bots.filter(b => b.isRunning).length} bots active` },
                  { label: 'Win Rate', value: `${fmt(winRate, 0)}%`, sub: `${wins}W / ${losses}L`, green: winRate >= 50 },
                ].map(stat => (
                  <Card key={stat.label}>
                    <CardContent className="pt-3 pb-3">
                      <div className="text-xs text-muted-foreground mb-0.5">{stat.label}</div>
                      <div className={`font-mono font-bold text-2xl ${stat.green === true ? 'text-emerald-400' : stat.green === false ? 'text-red-400' : ''}`}>{stat.value}</div>
                      {stat.sub && <div className="text-xs text-muted-foreground mt-0.5">{stat.sub}</div>}
                    </CardContent>
                  </Card>
                ))}
              </div>

              <Card>
                <CardHeader className="pb-2 pt-4">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">Rankings</CardTitle>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="outline" size="sm" className="text-xs h-7">Reset All</Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Reset all 30 bots?</AlertDialogTitle>
                          <AlertDialogDescription>Restores all bots to $1,000 and re-runs warm-up simulation.</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={resetAll}>Reset All</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-[480px]">
                    <div className="space-y-1.5">
                      {sorted.map((bot, idx) => {
                        const price = getCurrentPrice(bot.symbol);
                        const totalValue = getBotTotalValue(bot, price);
                        const pnl = getBotPnL(bot, price);
                        const pnlPct = getBotPnLPercent(bot, price);
                        const ts = botTradeStats.get(bot.id);
                        const tc = ts?.tc ?? 0;
                        const bw = ts?.wins ?? 0;
                        const bl = ts?.losses ?? 0;
                        const wr = (bw + bl) > 0 ? (bw / (bw + bl)) * 100 : 0;
                        const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}`;

                        return (
                          <div key={bot.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/20 hover:bg-muted/40 transition-colors">
                            <span className={`w-8 text-center text-sm flex-shrink-0 ${idx < 3 ? 'text-base' : 'font-mono text-xs text-muted-foreground'}`}>{medal}</span>
                            <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: bot.color }} />
                            <div className="flex-1 min-w-0">
                              <div className="font-medium text-xs truncate">{bot.name}</div>
                              <div className="text-[10px] text-muted-foreground">{bot.symbol} · {bot.strategy}</div>
                            </div>
                            <div className="text-right flex-shrink-0 w-24">
                              <div className="font-mono text-sm font-bold">${fmt(totalValue)}</div>
                              <div className={`text-[10px] font-mono ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                {pnl >= 0 ? '+' : ''}${fmt(pnl)} ({pct(pnlPct)})
                              </div>
                            </div>
                            <div className="text-right text-[10px] text-muted-foreground w-16 hidden md:block">
                              <div>{tc} trades</div>
                              <div className={wr >= 50 ? 'text-emerald-400' : 'text-red-400'}>{fmt(wr, 0)}% win</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </ScrollArea>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* ── TRADES ── */}
          <TabsContent value="trades">
            <Card>
              <CardHeader className="pb-2 pt-4">
                <CardTitle className="text-base">Live Trade Feed <span className="font-normal text-muted-foreground text-sm">({trades.length} total)</span></CardTitle>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[600px]">
                  {/* Column headers */}
                  <div className="grid grid-cols-[20px_100px_50px_36px_110px_80px_80px_1fr_60px] gap-2 text-[10px] text-muted-foreground px-1 pb-1.5 border-b border-border/40">
                    <span></span><span>Bot</span><span>Symbol</span><span>Type</span><span>Price × Qty</span><span>Value</span><span>P&L</span><span>Signal</span><span>Time</span>
                  </div>
                  <div className="space-y-0.5 mt-1">
                    {[...trades].reverse().map(trade => {
                      const bot = bots.find(b => b.id === trade.botId);
                      const cost = trade.price * trade.quantity;
                      return (
                        <div key={trade.id} className="grid grid-cols-[20px_100px_50px_36px_110px_80px_80px_1fr_60px] gap-2 text-[11px] items-center px-1 py-1 rounded hover:bg-muted/20">
                          <div className="w-1.5 h-1.5 rounded-full" style={{ background: bot?.color ?? '#888' }} />
                          <span className="truncate font-medium">{bot?.name ?? '?'}</span>
                          <span className="text-muted-foreground">{trade.symbol}</span>
                          <span className={`font-bold ${trade.type === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>{trade.type}</span>
                          <span className="font-mono text-[10px]">${fmt(trade.price)} × {fmt(trade.quantity, 3)}</span>
                          <span className="font-mono text-[10px] text-muted-foreground">${fmt(cost)}</span>
                          <span className={`font-mono text-[10px] ${trade.type === 'SELL' ? (trade.pnl >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-muted-foreground'}`}>
                            {trade.type === 'SELL' ? `${trade.pnl >= 0 ? '+' : ''}$${fmt(trade.pnl)}` : '—'}
                          </span>
                          <span className="text-muted-foreground text-[10px] truncate">{trade.indicators}</span>
                          <span className="text-muted-foreground text-[10px]">{new Date(trade.timestamp).toLocaleTimeString()}</span>
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── MARKET ── */}
          <TabsContent value="market">
            {CATEGORIES.map(cat => {
              const assetsInCat = ASSETS.filter(a => a.category === cat);
              return (
                <div key={cat} className="mb-6">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-2 px-0.5">
                    {cat === 'Crypto' ? '🪙' : cat === 'Stocks' ? '📈' : cat === 'Metals' ? '🏅' : '💱'} {cat}
                  </h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-2.5">
                    {assetsInCat.map(asset => {
                      const symbol = asset.symbol;
                      const candles = market[symbol] || [];
                      return <MarketCard key={symbol} symbol={symbol} asset={asset} candles={candles} bots={bots} />;
                    })}
                  </div>
                </div>
              );
            })}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function MarketCard({ symbol, asset, candles, bots }: { symbol: string; asset: any; candles: any[]; bots: any[] }) {
  if (!candles || candles.length === 0) return null;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const change = prev ? ((last.close - prev.close) / prev.close) * 100 : 0;
  const dayCandles = candles.slice(-60);
  const dayHigh = Math.max(...dayCandles.map((c: any) => c.high));
  const dayLow = Math.min(...dayCandles.map((c: any) => c.low));
  const isUp = last.close >= (candles[candles.length - 20]?.close ?? last.close);
  const botsHere = bots.filter(b => b.symbol === symbol);

  const fmtPrice = (p: number) => {
    if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (p >= 1) return p.toFixed(2);
    return p.toFixed(4);
  };

  return (
    <Card className="overflow-hidden">
      <div className={`h-0.5 ${isUp ? 'bg-emerald-500' : 'bg-red-500'}`} />
      <CardContent className="pt-2.5 pb-2.5 px-3">
        <div className="flex items-center justify-between mb-0.5">
          <div>
            <span className="font-bold text-sm">{symbol}</span>
            <span className="text-[9px] text-muted-foreground ml-1 hidden sm:inline">{asset.name}</span>
          </div>
          <span className={`text-[10px] font-medium ${change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {change >= 0 ? '+' : ''}{change.toFixed(2)}%
          </span>
        </div>
        <p className="font-mono text-base font-bold">{fmtPrice(last.close)}</p>
        <MiniSparkline candles={candles} isUp={isUp} />
        <div className="grid grid-cols-2 gap-x-2 text-[9px] text-muted-foreground mt-1">
          <span>H: {fmtPrice(dayHigh)}</span>
          <span>L: {fmtPrice(dayLow)}</span>
        </div>
        {botsHere.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-0.5">
            {botsHere.map(b => (
              <span key={b.id} className="text-[8px] px-1 py-0.5 rounded" style={{ background: b.color + '25', color: b.color }}>
                {b.name.split(' ')[0]}
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}


function Stat({ label, value, green }: { label: string; value: string; green?: boolean }) {
  return (
    <div className="text-center flex-shrink-0">
      <div className="text-[9px] text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className={`font-mono font-bold text-xs ${green === true ? 'text-emerald-400' : green === false ? 'text-red-400' : ''}`}>{value}</div>
    </div>
  );
}
