
import { useMemo, useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence, useSpring, useTransform, useMotionValue } from 'framer-motion';
import { useArena } from '@/hooks/use-arena';
import { getBotTotalValue, getBotPnL } from '@/lib/engine';
import { calcFeeAdjusted } from '@/lib/platform';
import { ASSET_MAP } from '@/lib/storage';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  BarChart3, TrendingUp, TrendingDown, Award, AlertTriangle,
  FileText, Download, Trophy, Flame, Skull, Activity, Zap,
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip,
  LineChart, Line, Cell, Area, AreaChart, CartesianGrid,
} from 'recharts';

function fmt(n: number, dec = 2) {
  return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function fmtShort(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1000) return `${n >= 0 ? '+' : ''}$${(n / 1000).toFixed(1)}k`;
  return `${n >= 0 ? '+' : ''}$${fmt(n)}`;
}

// ── Animated number component ────────────────────────────────────────────────
function AnimatedNumber({
  value,
  prefix = '',
  suffix = '',
  decimals = 2,
  className = '',
  colorize = false,
}: {
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  className?: string;
  colorize?: boolean;
}) {
  const prevRef = useRef(value);
  const [display, setDisplay] = useState(value);
  const [delta, setDelta] = useState<'up' | 'down' | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (Math.abs(value - prevRef.current) < 0.0001) return;
    const dir = value > prevRef.current ? 'up' : 'down';
    setDelta(dir);
    prevRef.current = value;

    const steps = 12;
    const from = display;
    const to = value;
    let step = 0;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      step++;
      const t = step / steps;
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (to - from) * eased);
      if (step >= steps) {
        clearInterval(timerRef.current!);
        setDisplay(to);
        setTimeout(() => setDelta(null), 600);
      }
    }, 30);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const colorClass = colorize
    ? display >= 0 ? 'text-emerald-400' : 'text-red-400'
    : '';

  return (
    <span className={`relative inline-flex items-center ${className} ${colorClass}`}>
      {prefix}{display.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}{suffix}
      <AnimatePresence>
        {delta && (
          <motion.span
            key={delta + Date.now()}
            className={`absolute -top-3 left-0 text-[9px] font-bold ${delta === 'up' ? 'text-emerald-400' : 'text-red-400'}`}
            initial={{ opacity: 1, y: 0 }}
            animate={{ opacity: 0, y: delta === 'up' ? -8 : 8 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6 }}
          >
            {delta === 'up' ? '▲' : '▼'}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

// ── P&L history tracker hook ─────────────────────────────────────────────────
interface PnLSnapshot {
  ts: number;
  gross: number;
  net: number;
  fees: number;
  trades: number;
  winRate: number;
}

function usePnLHistory(gross: number, net: number, fees: number, trades: number, winRate: number) {
  const [history, setHistory] = useState<PnLSnapshot[]>([]);
  const lastPush = useRef(0);

  useEffect(() => {
    const now = Date.now();
    if (now - lastPush.current < 3000) return;
    lastPush.current = now;
    setHistory(prev => {
      const next = [...prev, { ts: now, gross, net, fees, trades, winRate }];
      return next.slice(-60);
    });
  }, [gross, net, fees, trades, winRate]);

  return history;
}

// ── Bot report type ──────────────────────────────────────────────────────────
interface BotReport {
  id: string;
  name: string;
  symbol: string;
  category: string;
  strategy: string;
  color: string;
  totalValue: number;
  grossPnl: number;
  netPnl: number;
  totalFees: number;
  feeImpact: number;
  returnPct: number;
  netReturnPct: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  maxDrawdown: number;
  profitFactor: number;
  rank: number;
  prevRank: number;
  status: 'top' | 'good' | 'weak' | 'failing';
}

// ── Delta badge ──────────────────────────────────────────────────────────────
function DeltaBadge({ value, prevValue }: { value: number; prevValue: number }) {
  const diff = value - prevValue;
  if (Math.abs(diff) < 0.01) return null;
  return (
    <motion.span
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      className={`text-[9px] px-1 py-0.5 rounded font-bold ml-1 ${diff > 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}
    >
      {diff > 0 ? '▲' : '▼'} {Math.abs(diff).toFixed(1)}
    </motion.span>
  );
}

// ── Rank change indicator ────────────────────────────────────────────────────
function RankChange({ rank, prev }: { rank: number; prev: number }) {
  const diff = prev - rank;
  if (diff === 0) return <span className="text-zinc-600 text-[10px]">—</span>;
  return (
    <motion.span
      initial={{ opacity: 0, x: diff > 0 ? -4 : 4 }}
      animate={{ opacity: 1, x: 0 }}
      className={`text-[10px] font-bold ${diff > 0 ? 'text-emerald-400' : 'text-red-400'}`}
    >
      {diff > 0 ? `↑${diff}` : `↓${Math.abs(diff)}`}
    </motion.span>
  );
}

// ── Mini sparkline ─────────────────────────────────────────────────────────
function Sparkline({ data, positive }: { data: number[]; positive: boolean }) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const h = 28, w = 60;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg width={w} height={h} className="opacity-70">
      <polyline
        points={pts}
        fill="none"
        stroke={positive ? '#10b981' : '#ef4444'}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────
const SECTIONS = [
  { key: 'overview', label: 'Overview',     icon: BarChart3     },
  { key: 'top',      label: 'Top Bots',     icon: Trophy        },
  { key: 'weak',     label: 'Weak Bots',    icon: AlertTriangle },
  { key: 'daily',    label: 'Daily Report', icon: FileText      },
] as const;

export default function ReportsPage() {
  const { bots, trades, getCurrentPrice, market, tickCount } = useArena();
  const [section, setSection] = useState<'overview' | 'top' | 'weak' | 'daily'>('overview');

  const prevReportsRef = useRef<Record<string, { rank: number; netPnl: number }>>({});

  const reports: BotReport[] = useMemo(() => {
    const prev = prevReportsRef.current;
    const computed = bots
      .map(bot => {
        const price     = getCurrentPrice(bot.symbol);
        const botTrades = trades.filter(t => t.botId === bot.id);
        const sells     = botTrades.filter(t => t.type === 'SELL');
        const wins      = sells.filter(t => t.pnl > 0).length;
        const losses    = sells.length - wins;
        const winRate   = sells.length > 0 ? (wins / sells.length) * 100 : 0;
        const grossPnl  = getBotPnL(bot, price);
        const totalValue = getBotTotalValue(bot, price);
        const avgTradeVal = sells.length > 0
          ? sells.reduce((s, t) => s + t.quantity * t.price, 0) / sells.length
          : 50;
        const feeAdj = calcFeeAdjusted(grossPnl, botTrades.length, avgTradeVal, bot.startingBalance);
        const returnPct = (grossPnl / bot.startingBalance) * 100;

        let peak = 0, maxDD = 0, runPnl = 0;
        for (const t of sells) {
          runPnl += t.pnl;
          if (runPnl > peak) peak = runPnl;
          const dd = peak > 0 ? ((peak - runPnl) / (bot.startingBalance + peak)) * 100 : 0;
          if (dd > maxDD) maxDD = dd;
        }
        const grossW = sells.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
        const grossL = Math.abs(sells.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
        const profitFactor = grossL > 0 ? grossW / grossL : grossW > 0 ? 99 : 1;
        const status: BotReport['status'] =
          feeAdj.netPnl > 50 ? 'top' : feeAdj.netPnl > 0 ? 'good' : feeAdj.netPnl > -50 ? 'weak' : 'failing';

        return {
          id: bot.id, name: bot.name, symbol: bot.symbol,
          category: ASSET_MAP[bot.symbol]?.category ?? 'Unknown',
          strategy: bot.strategy, color: bot.color,
          totalValue, grossPnl, netPnl: feeAdj.netPnl,
          totalFees: feeAdj.totalFees, feeImpact: feeAdj.feeImpactPercent,
          returnPct, netReturnPct: feeAdj.netReturn,
          trades: botTrades.length, wins, losses, winRate,
          maxDrawdown: maxDD, profitFactor,
          rank: 0, prevRank: prev[bot.id]?.rank ?? 0, status,
        };
      })
      .sort((a, b) => b.netPnl - a.netPnl)
      .map((r, i) => ({ ...r, rank: i + 1 }));

    const next: Record<string, { rank: number; netPnl: number }> = {};
    computed.forEach(r => { next[r.id] = { rank: r.rank, netPnl: r.netPnl }; });
    prevReportsRef.current = next;
    return computed;
  }, [bots, trades, market]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalGross  = reports.reduce((s, r) => s + r.grossPnl, 0);
  const totalNet    = reports.reduce((s, r) => s + r.netPnl, 0);
  const totalFees   = reports.reduce((s, r) => s + r.totalFees, 0);
  const totalTrades = reports.reduce((s, r) => s + r.trades, 0);
  // Only average win rate over bots that have at least 1 completed SELL trade
  const tradingBots = reports.filter(r => r.wins + r.losses > 0);
  const avgWinRate  = tradingBots.length > 0
    ? tradingBots.reduce((s, r) => s + r.winRate, 0) / tradingBots.length
    : 0;

  const history = usePnLHistory(totalGross, totalNet, totalFees, totalTrades, avgWinRate);

  const pnlChartData = history.map((h, i) => ({
    i,
    gross: parseFloat(h.gross.toFixed(2)),
    net:   parseFloat(h.net.toFixed(2)),
    fees:  parseFloat(h.fees.toFixed(2)),
  }));

  const barChartData = reports.slice(0, 15).map(r => ({
    name: r.name.split(' ')[0],
    netPnl: parseFloat(r.netPnl.toFixed(2)),
    fill: r.netPnl >= 0 ? '#10b981' : '#ef4444',
  }));

  const topBots  = reports.filter(r => r.status === 'top'  || r.status === 'good').slice(0, 5);
  const weakBots = reports.filter(r => r.status === 'weak' || r.status === 'failing').slice(-5);

  // Per-bot sparkline history (net pnl rolling window)
  const sparkRef = useRef<Record<string, number[]>>({});
  useEffect(() => {
    reports.forEach(r => {
      if (!sparkRef.current[r.id]) sparkRef.current[r.id] = [];
      sparkRef.current[r.id].push(r.netPnl);
      if (sparkRef.current[r.id].length > 30) sparkRef.current[r.id].shift();
    });
  }, [tickCount]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="p-4 max-w-screen-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-600/10 border border-blue-600/30 flex items-center justify-center">
            <BarChart3 size={18} className="text-blue-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold">Reports</h1>
            <p className="text-xs text-zinc-500">Fee-adjusted · Live engine · {totalTrades.toLocaleString()} trades</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <motion.div
            className="w-1.5 h-1.5 rounded-full bg-emerald-500"
            animate={{ opacity: [1, 0.3, 1], scale: [1, 1.3, 1] }}
            transition={{ duration: 1.2, repeat: Infinity }}
          />
          <span className="text-[10px] text-emerald-400 font-medium">LIVE</span>
          <span className="text-[10px] text-zinc-600 ml-1">tick #{tickCount}</span>
        </div>
      </div>

      {/* Section tabs */}
      <div className="flex items-center gap-2 mb-6 border-b border-zinc-800/60 pb-3">
        {SECTIONS.map(s => {
          const Icon = s.icon;
          const active = section === s.key;
          return (
            <button
              key={s.key}
              onClick={() => setSection(s.key)}
              className={`relative flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors font-medium
                ${active ? 'text-blue-400' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              {active && (
                <motion.div
                  layoutId="tab-bg"
                  className="absolute inset-0 bg-blue-600/15 border border-blue-600/30 rounded-lg"
                />
              )}
              <Icon size={13} className="relative z-10" />
              <span className="relative z-10">{s.label}</span>
            </button>
          );
        })}
      </div>

      {/* ── Overview ── */}
      {section === 'overview' && (
        <div className="space-y-5">

          {/* KPI row */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              {
                label: 'Gross P&L',
                value: totalGross,
                prefix: totalGross >= 0 ? '+$' : '-$',
                abs: true,
                color: totalGross >= 0 ? 'text-emerald-400' : 'text-red-400',
                border: totalGross >= 0 ? 'border-emerald-600/20' : 'border-red-600/20',
                icon: totalGross >= 0 ? TrendingUp : TrendingDown,
                iconColor: totalGross >= 0 ? 'text-emerald-500' : 'text-red-500',
              },
              {
                label: 'Total Fees',
                value: totalFees,
                prefix: '$',
                abs: false,
                color: 'text-amber-400',
                border: 'border-amber-600/20',
                icon: Zap,
                iconColor: 'text-amber-500',
              },
              {
                label: 'Net P&L',
                value: totalNet,
                prefix: totalNet >= 0 ? '+$' : '-$',
                abs: true,
                color: totalNet >= 0 ? 'text-emerald-400' : 'text-red-400',
                border: totalNet >= 0 ? 'border-emerald-600/20' : 'border-red-600/20',
                icon: Activity,
                iconColor: totalNet >= 0 ? 'text-emerald-500' : 'text-red-500',
              },
              {
                label: 'Total Trades',
                value: totalTrades,
                prefix: '',
                abs: false,
                color: 'text-blue-400',
                border: 'border-blue-600/20',
                icon: BarChart3,
                iconColor: 'text-blue-500',
              },
              {
                label: 'Avg Win Rate',
                value: avgWinRate,
                prefix: '',
                abs: false,
                suffix: '%',
                decimals: 1,
                color: avgWinRate >= 50 ? 'text-emerald-400' : avgWinRate >= 40 ? 'text-amber-400' : 'text-red-400',
                border: 'border-purple-600/20',
                icon: Award,
                iconColor: 'text-purple-500',
              },
            ].map(kpi => {
              const Icon = kpi.icon;
              const displayVal = kpi.abs ? Math.abs(kpi.value) : kpi.value;
              return (
                <Card key={kpi.label} className={`border-zinc-800/60 ${kpi.border} bg-zinc-900/40`}>
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] text-zinc-500 uppercase tracking-wide">{kpi.label}</span>
                      <Icon size={13} className={kpi.iconColor} />
                    </div>
                    <div className={`font-mono font-bold text-xl ${kpi.color}`}>
                      <AnimatedNumber
                        value={displayVal}
                        prefix={kpi.prefix}
                        suffix={(kpi as any).suffix ?? ''}
                        decimals={(kpi as any).decimals ?? 2}
                      />
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* P&L Timeline chart */}
          {pnlChartData.length > 1 && (
            <Card className="border-zinc-800/60">
              <CardHeader className="py-3 px-4 flex flex-row items-center justify-between">
                <CardTitle className="text-sm">Live P&L Timeline</CardTitle>
                <div className="flex items-center gap-3 text-[10px]">
                  <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-emerald-500 rounded" />Gross</span>
                  <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-blue-400 rounded" />Net</span>
                  <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-amber-400 rounded" />Fees</span>
                </div>
              </CardHeader>
              <CardContent className="pb-4">
                <ResponsiveContainer width="100%" height={180}>
                  <AreaChart data={pnlChartData} margin={{ left: -10 }}>
                    <defs>
                      <linearGradient id="grossGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.15} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="netGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#60a5fa" stopOpacity={0.15} />
                        <stop offset="95%" stopColor="#60a5fa" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                    <XAxis dataKey="i" hide />
                    <YAxis tick={{ fontSize: 9, fill: '#71717a' }} />
                    <Tooltip
                      contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, fontSize: 11 }}
                      formatter={(v: number, name: string) => [`$${fmt(v)}`, name.charAt(0).toUpperCase() + name.slice(1)]}
                    />
                    <Area type="monotone" dataKey="gross" stroke="#10b981" fill="url(#grossGrad)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    <Area type="monotone" dataKey="net"   stroke="#60a5fa" fill="url(#netGrad)"   strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    <Line  type="monotone" dataKey="fees"  stroke="#f59e0b" strokeWidth={1}        dot={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          {/* Bot bar chart */}
          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4"><CardTitle className="text-sm">Net P&L by Bot (Top 15)</CardTitle></CardHeader>
            <CardContent className="pb-4">
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={barChartData} margin={{ left: -10 }}>
                  <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#71717a' }} />
                  <YAxis tick={{ fontSize: 9, fill: '#71717a' }} />
                  <Tooltip
                    contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, fontSize: 11 }}
                    formatter={(v: number) => [`$${fmt(v)}`, 'Net P&L']}
                  />
                  <Bar dataKey="netPnl" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                    {barChartData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Full rankings table */}
          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4"><CardTitle className="text-sm">Full Bot Rankings — Live</CardTitle></CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-500">
                      {['#', '±', 'Bot', 'Asset', 'Strat', 'Trades', 'Win%', 'Gross', 'Fees', 'Net P&L', 'DD%', 'Trend', 'Status'].map(h => (
                        <th key={h} className="text-left px-2 py-2 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {reports.map(r => (
                      <motion.tr
                        key={r.id}
                        layout
                        className="border-b border-zinc-800/40 hover:bg-zinc-900/40 transition-colors"
                      >
                        <td className="px-2 py-2 text-zinc-500 font-mono">#{r.rank}</td>
                        <td className="px-2 py-2">
                          <RankChange rank={r.rank} prev={r.prevRank || r.rank} />
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-1.5">
                            <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: r.color }} />
                            <span className="font-medium truncate max-w-[90px]">{r.name}</span>
                          </div>
                        </td>
                        <td className="px-2 py-2 text-zinc-400">{r.symbol}</td>
                        <td className="px-2 py-2 text-zinc-400">{r.strategy}</td>
                        <td className="px-2 py-2 font-mono">{r.trades.toLocaleString()}</td>
                        <td className={`px-2 py-2 font-mono ${r.winRate >= 50 ? 'text-emerald-400' : r.winRate >= 35 ? 'text-amber-400' : 'text-red-400'}`}>
                          <AnimatedNumber value={r.winRate} suffix="%" decimals={0} />
                        </td>
                        <td className={`px-2 py-2 font-mono ${r.grossPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          <AnimatedNumber value={r.grossPnl} prefix={r.grossPnl >= 0 ? '+$' : '-$'} decimals={2} />
                        </td>
                        <td className="px-2 py-2 font-mono text-amber-400">
                          -$<AnimatedNumber value={r.totalFees} decimals={2} />
                        </td>
                        <td className={`px-2 py-2 font-mono font-bold ${r.netPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          <AnimatedNumber value={r.netPnl} prefix={r.netPnl >= 0 ? '+$' : '-$'} decimals={2} />
                        </td>
                        <td className={`px-2 py-2 font-mono ${r.maxDrawdown < 10 ? 'text-zinc-400' : r.maxDrawdown < 20 ? 'text-amber-400' : 'text-red-400'}`}>
                          {fmt(r.maxDrawdown, 1)}%
                        </td>
                        <td className="px-2 py-2">
                          <Sparkline
                            data={sparkRef.current[r.id] ?? [r.netPnl]}
                            positive={r.netPnl >= 0}
                          />
                        </td>
                        <td className="px-2 py-2">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                            r.status === 'top'    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' :
                            r.status === 'good'   ? 'bg-blue-500/10 text-blue-400 border-blue-500/30' :
                            r.status === 'weak'   ? 'bg-amber-500/10 text-amber-400 border-amber-500/30' :
                                                    'bg-red-500/10 text-red-400 border-red-500/30'
                          }`}>
                            {r.status === 'top' ? '🏆 Top' : r.status === 'good' ? '✓ Good' : r.status === 'weak' ? '⚠ Weak' : '✗ Fail'}
                          </span>
                        </td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Top Bots ── */}
      {section === 'top' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <Trophy size={16} className="text-amber-400" />
            <h2 className="font-semibold">Best Performing Bots</h2>
            <span className="text-xs text-zinc-500">(Net P&L after fees)</span>
          </div>
          <AnimatePresence mode="sync">
            {reports.filter(r => r.status === 'top' || r.status === 'good').slice(0, 10).map((r, i) => (
              <motion.div
                key={r.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
              >
                <Card className="border-zinc-800/60">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center font-bold text-sm flex-shrink-0
                        ${i === 0 ? 'bg-amber-500/20 text-amber-400' : i === 1 ? 'bg-zinc-400/20 text-zinc-300' : i === 2 ? 'bg-orange-600/20 text-orange-400' : 'bg-zinc-800 text-zinc-500'}`}>
                        #{r.rank}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: r.color }} />
                          <span className="font-semibold text-sm">{r.name}</span>
                          <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">{r.symbol}</Badge>
                          <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">{r.strategy}</Badge>
                          <RankChange rank={r.rank} prev={r.prevRank || r.rank} />
                        </div>
                        <div className="flex items-center gap-4 mt-1.5 flex-wrap text-[11px]">
                          <span className="text-zinc-500">{r.trades.toLocaleString()} trades</span>
                          <span className={r.winRate >= 50 ? 'text-emerald-400' : 'text-amber-400'}>
                            Win: <AnimatedNumber value={r.winRate} suffix="%" decimals={0} />
                          </span>
                          <span className="text-amber-400">Fees: -$<AnimatedNumber value={r.totalFees} decimals={2} /></span>
                          <span className="text-zinc-500">DD: {fmt(r.maxDrawdown, 1)}%</span>
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="font-mono font-bold text-emerald-400 text-lg">
                          <AnimatedNumber value={r.netPnl} prefix="+$" decimals={2} />
                        </div>
                        <div className="text-[10px] text-zinc-500">
                          <AnimatedNumber value={r.netReturnPct} prefix="+" suffix="% net" decimals={2} />
                        </div>
                        <div className="mt-1">
                          <Sparkline data={sparkRef.current[r.id] ?? [r.netPnl]} positive={true} />
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* ── Weak Bots ── */}
      {section === 'weak' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle size={16} className="text-red-400" />
            <h2 className="font-semibold">Underperforming Bots</h2>
            <span className="text-xs text-zinc-500">(Requiring attention)</span>
          </div>
          <AnimatePresence>
            {reports.filter(r => r.status === 'weak' || r.status === 'failing').map((r, i) => (
              <motion.div
                key={r.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
              >
                <Card className="border-red-600/20">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-red-600/10 flex items-center justify-center flex-shrink-0">
                        <Skull size={14} className="text-red-400" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: r.color }} />
                          <span className="font-semibold text-sm">{r.name}</span>
                          <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">{r.symbol}</Badge>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                            r.status === 'failing'
                              ? 'bg-red-500/10 text-red-400 border-red-500/30'
                              : 'bg-amber-500/10 text-amber-400 border-amber-500/30'}`}>
                            {r.status === 'failing' ? '✗ Failing' : '⚠ Weak'}
                          </span>
                        </div>
                        <div className="flex items-center gap-4 mt-1.5 flex-wrap text-[11px]">
                          <span className="text-zinc-500">{r.trades.toLocaleString()} trades</span>
                          <span className={r.winRate < 30 ? 'text-red-400' : 'text-amber-400'}>
                            Win: <AnimatedNumber value={r.winRate} suffix="%" decimals={0} />
                          </span>
                          <span className="text-zinc-500">PF: {fmt(r.profitFactor, 2)}</span>
                          <span className={r.maxDrawdown > 15 ? 'text-red-400' : 'text-amber-400'}>
                            DD: {fmt(r.maxDrawdown, 1)}%
                          </span>
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="font-mono font-bold text-red-400 text-lg">
                          <AnimatedNumber value={r.netPnl} prefix={r.netPnl >= 0 ? '+$' : '-$'} decimals={2} />
                        </div>
                        <div className="text-[10px] text-zinc-500">
                          <AnimatedNumber value={r.netReturnPct} suffix="% net" decimals={2} />
                        </div>
                        <div className="mt-1">
                          <Sparkline data={sparkRef.current[r.id] ?? [r.netPnl]} positive={false} />
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
          {reports.filter(r => r.status === 'weak' || r.status === 'failing').length === 0 && (
            <div className="text-center py-16 text-zinc-500">
              <Trophy size={32} className="mx-auto mb-3 text-emerald-500" />
              <p className="font-medium">All bots performing well</p>
            </div>
          )}
        </div>
      )}

      {/* ── Daily Report ── */}
      {section === 'daily' && (
        <div className="space-y-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-bold text-base">Daily Summary Report</h2>
                <p className="text-xs text-zinc-500">
                  {new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                </p>
              </div>
              <button className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors">
                <Download size={12} />
                Export CSV
              </button>
            </div>
            <Separator className="mb-4" />

            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-4">
              {[
                { label: 'Active Bots',   value: `${bots.filter(b => b.isRunning).length}/${bots.length}`, color: 'text-blue-400' },
                { label: 'Total Trades',  value: totalTrades.toLocaleString(), color: 'text-zinc-200' },
                { label: 'Gross P&L',     value: `${totalGross >= 0 ? '+' : ''}$${fmt(totalGross)}`, color: totalGross >= 0 ? 'text-emerald-400' : 'text-red-400' },
                { label: 'Total Fees',    value: `$${fmt(totalFees)}`, color: 'text-amber-400' },
                { label: 'Net P&L',       value: `${totalNet >= 0 ? '+' : ''}$${fmt(totalNet)}`, color: totalNet >= 0 ? 'text-emerald-400' : 'text-red-400' },
              ].map(s => (
                <div key={s.label}>
                  <div className="text-[10px] text-zinc-500 uppercase tracking-wide">{s.label}</div>
                  <div className={`font-mono font-bold text-sm mt-0.5 ${s.color}`}>{s.value}</div>
                </div>
              ))}
            </div>

            <Separator className="mb-4" />

            <h3 className="font-semibold text-sm mb-3 text-emerald-400">🏆 Top Performers</h3>
            <div className="space-y-2 mb-5">
              {topBots.map((r, i) => (
                <motion.div
                  key={r.id}
                  layout
                  className="flex items-center gap-2 text-xs py-1 border-b border-zinc-800/40"
                >
                  <span className="text-zinc-500 w-5 font-mono">#{i + 1}</span>
                  <div className="w-1.5 h-1.5 rounded-full" style={{ background: r.color }} />
                  <span className="font-medium flex-1">{r.name}</span>
                  <span className="text-zinc-500">{r.symbol}</span>
                  <span className="text-zinc-500">{r.strategy}</span>
                  <span className="font-mono text-zinc-500">{r.trades}t</span>
                  <span className="font-mono text-emerald-400 font-bold">
                    +$<AnimatedNumber value={r.netPnl} decimals={2} />
                  </span>
                </motion.div>
              ))}
            </div>

            {weakBots.length > 0 && (
              <>
                <h3 className="font-semibold text-sm mb-3 text-red-400">⚠ Underperformers</h3>
                <div className="space-y-2">
                  {weakBots.map(r => (
                    <motion.div
                      key={r.id}
                      layout
                      className="flex items-center gap-2 text-xs py-1 border-b border-zinc-800/40"
                    >
                      <span className="text-red-400 w-5">↓</span>
                      <div className="w-1.5 h-1.5 rounded-full" style={{ background: r.color }} />
                      <span className="font-medium flex-1">{r.name}</span>
                      <span className="text-zinc-500">{r.symbol}</span>
                      <span className={`font-mono font-bold ${r.netPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        <AnimatedNumber value={r.netPnl} prefix={r.netPnl >= 0 ? '+$' : '-$'} decimals={2} />
                      </span>
                    </motion.div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Fee breakdown */}
          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4"><CardTitle className="text-sm">Fee Breakdown by Category</CardTitle></CardHeader>
            <CardContent className="pb-4">
              {(['Crypto', 'Stocks', 'Metals', 'Forex'] as const).map(cat => {
                const catBots = reports.filter(r => r.category === cat);
                const catFees = catBots.reduce((s, r) => s + r.totalFees, 0);
                const catNet  = catBots.reduce((s, r) => s + r.netPnl, 0);
                const pct     = totalFees > 0 ? (catFees / totalFees) * 100 : 0;
                return (
                  <div key={cat} className="flex items-center gap-3 py-2 border-b border-zinc-800/40 last:border-0 text-xs">
                    <span className="w-16 text-zinc-400 font-medium">{cat}</span>
                    <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                      <motion.div
                        className="h-full bg-amber-500 rounded-full"
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ duration: 0.6 }}
                      />
                    </div>
                    <span className="w-10 text-zinc-500 text-right">{fmt(pct, 0)}%</span>
                    <span className="w-20 text-amber-400 font-mono text-right">-${fmt(catFees)}</span>
                    <span className={`w-20 font-mono font-bold text-right ${catNet >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {catNet >= 0 ? '+' : ''}${fmt(catNet)}
                    </span>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
