// ─── Trading Pipeline Diagnostics Page ────────────────────────────────────────
// Single dashboard for the 14-system pre-trade pipeline upgrade:
//   1. Asset Study Engine     5. Capital Allocation
//   2. Compliance Engine      6. Smart Execution Planner
//   3. Symbol Unification     7. Diagnostics
//   4. Rejection Shield       8. Cache stats
//
// Plus per-bot study cards, exchange compliance matrix, capital plan,
// and a one-click "preflight" simulation against the active exchange.

import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  Activity, AlertTriangle, BarChart3, CheckCircle2, Cpu, Database,
  Layers, RefreshCw, Shield, Target, TrendingUp, XCircle, Zap,
} from 'lucide-react';

import { loadBots, loadTrades, ASSETS } from '@/lib/storage';
import { initMarket, tickMarket, type MarketData } from '@/lib/engine';
import { exchangeMode } from '@/lib/exchange-mode';
import { takeSnapshot, type PipelineSnapshot } from '@/lib/pipeline-diagnostics';
import { SUPPORTED_EXCHANGES, type ExchangeId } from '@/lib/asset-compliance';
import { preflight, type ShieldVerdict } from '@/lib/rejection-shield';
import { planExecution, type ExecutionPlan } from '@/lib/execution-planner';
import { pipelineCache } from '@/lib/pipeline-cache';
import { credentialStore } from '@/lib/credential-store';

const SYSTEMS = [
  { num:  1, name: 'Asset Study Engine',     icon: Target,        color: 'text-blue-400'   },
  { num:  2, name: 'Compliance Engine',      icon: Shield,        color: 'text-emerald-400'},
  { num:  3, name: 'Symbol Unification',     icon: Layers,        color: 'text-cyan-400'   },
  { num:  4, name: 'Rejection Shield',       icon: AlertTriangle, color: 'text-amber-400'  },
  { num:  5, name: 'Capital Allocator',      icon: BarChart3,     color: 'text-violet-400' },
  { num:  6, name: 'Execution Planner',      icon: Zap,           color: 'text-yellow-400' },
  { num:  7, name: 'Pipeline Diagnostics',   icon: Activity,      color: 'text-pink-400'   },
  { num:  8, name: 'Smart Cache',            icon: Database,      color: 'text-teal-400'   },
  { num:  9, name: 'Per-Bot Study Cards',    icon: Cpu,           color: 'text-sky-400'    },
  { num: 10, name: 'Compliance Matrix',      icon: Shield,        color: 'text-emerald-400'},
  { num: 11, name: 'Allocation Table',       icon: BarChart3,     color: 'text-violet-400' },
  { num: 12, name: 'Preflight Simulator',    icon: TrendingUp,    color: 'text-orange-400' },
  { num: 13, name: 'Plan Inspector',         icon: Zap,           color: 'text-yellow-400' },
  { num: 14, name: 'Live Refresh Pulse',     icon: RefreshCw,     color: 'text-blue-400'   },
] as const;

export default function PipelinePage() {
  const [snapshot, setSnapshot] = useState<PipelineSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [market, setMarket] = useState<MarketData>(() => initMarket());
  const [shieldResult, setShieldResult] = useState<ShieldVerdict | null>(null);
  const [plan, setPlan] = useState<ExecutionPlan | null>(null);
  const [simSymbol, setSimSymbol] = useState<string>('BTC');
  const [simAmount, setSimAmount] = useState<number>(250);
  const [simSide, setSimSide] = useState<'buy' | 'sell'>('buy');
  const exch = exchangeMode.get().exchange as ExchangeId;

  const refresh = () => {
    setRefreshing(true);
    const bots = loadBots();
    const trades = loadTrades();
    const totalCapital = bots.reduce((s, b) => s + b.balance + b.position * (market[b.symbol]?.[market[b.symbol].length - 1]?.close ?? 0), 0) || 50_000;
    const symbols = ASSETS.map(a => a.symbol);
    const snap = takeSnapshot({
      exchange:     exch,
      totalCapital,
      bots: bots.map(b => ({ bot: b, candles: market[b.symbol] ?? [], trades, exchange: exch, amountUSD: 100 })),
      symbols,
    });
    setSnapshot(snap);
    setRefreshing(false);
  };

  useEffect(() => {
    refresh();
    const tick = setInterval(() => setMarket(m => tickMarket(m)), 2_000);
    const r    = setInterval(refresh, 5_000);
    return () => { clearInterval(tick); clearInterval(r); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runPreflight = async () => {
    const candles = market[simSymbol] ?? [];
    const refPrice = candles[candles.length - 1]?.close ?? 100;
    const creds = credentialStore.get(exch) ?? null;
    const v = await preflight({
      exchange: exch, arenaSymbol: simSymbol, side: simSide,
      amountUSD: simAmount, refPrice, credentials: creds,
    });
    setShieldResult(v);
    const p = planExecution({
      exchange: exch, arenaSymbol: simSymbol, side: simSide,
      amountUSD: simAmount, refPrice,
    });
    setPlan(p);
  };

  const matrixRows = useMemo(() => {
    if (!snapshot) return [];
    return SUPPORTED_EXCHANGES.map(ex => {
      const m = snapshot.compliance[ex];
      const total = m.ok + m.blocked;
      return { ex, ok: m.ok, blocked: m.blocked, pct: total > 0 ? (m.ok / total) * 100 : 0 };
    }).sort((a, b) => b.ok - a.ok);
  }, [snapshot]);

  return (
    <div className="px-4 py-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Cpu className="w-6 h-6 text-blue-400" /> Trading Pipeline
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            14-system pre-trade engine — Active exchange:
            <Badge className="ml-2" variant="outline">{exch.toUpperCase()}</Badge>
          </p>
        </div>
        <Button onClick={refresh} disabled={refreshing} size="sm" variant="outline">
          <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* ── 14 systems status grid ─────────────────────────────────── */}
      <Card>
        <CardHeader><CardTitle className="text-base">Pipeline Systems</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {SYSTEMS.map(s => {
              const Icon = s.icon;
              return (
                <div key={s.num} className="flex items-center gap-3 p-3 rounded-lg bg-zinc-900/50 border border-zinc-800">
                  <Icon className={`w-5 h-5 ${s.color}`} />
                  <div className="min-w-0">
                    <div className="text-xs text-zinc-400">System #{s.num}</div>
                    <div className="text-sm font-medium truncate">{s.name}</div>
                  </div>
                  <CheckCircle2 className="w-4 h-4 ml-auto text-emerald-400 shrink-0" />
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* ── KPIs ───────────────────────────────────────────────────── */}
      {snapshot && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Kpi label="Bots Studied"  value={snapshot.studySummary.total} />
          <Kpi label="Ready"         value={snapshot.studySummary.ready}        color="text-emerald-400" />
          <Kpi label="Blocked"       value={snapshot.studySummary.blocked}      color="text-red-400" />
          <Kpi label="Avg Confidence" value={`${snapshot.studySummary.avgConfidence.toFixed(0)}%`} color="text-blue-400" />
          <Kpi label="Cache Hits"    value={snapshot.cache.hits}                color="text-teal-400" />
          <Kpi label="Cache Misses"  value={snapshot.cache.misses} />
          <Kpi label="Capital Pool"  value={`$${snapshot.totalCapital.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} color="text-violet-400" />
          <Kpi label="Cooldown Symbols" value={snapshot.shield.total}           color="text-amber-400" />
        </div>
      )}

      {/* ── Compliance matrix ───────────────────────────────────────── */}
      <Card>
        <CardHeader><CardTitle className="text-base">Exchange Compliance Matrix</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2">
            {matrixRows.map(r => (
              <div key={r.ex} className="flex items-center gap-3 text-sm">
                <div className="w-24 font-medium uppercase text-zinc-300">{r.ex}</div>
                <Progress value={r.pct} className="flex-1 h-2" />
                <div className="w-32 text-right text-xs text-zinc-400">
                  <span className="text-emerald-400">{r.ok} ok</span> · <span className="text-red-400">{r.blocked} blocked</span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── Capital allocation ──────────────────────────────────────── */}
      {snapshot && snapshot.allocation.allocations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Capital Allocation —
              <span className="text-zinc-400 ml-2 text-sm font-normal">
                deployed ${snapshot.allocation.deployedUSD.toLocaleString()} / reserve ${snapshot.allocation.reservedUSD.toLocaleString()}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-zinc-500">
                  <tr>
                    <th className="text-left p-2">Bot</th>
                    <th className="text-left p-2">Symbol</th>
                    <th className="text-right p-2">Amount</th>
                    <th className="text-right p-2">Weight</th>
                    <th className="text-left p-2">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.allocation.allocations.map(a => (
                    <tr key={a.botId} className="border-t border-zinc-800">
                      <td className="p-2 font-medium">{a.botName}</td>
                      <td className="p-2"><Badge variant="outline">{a.symbol}</Badge></td>
                      <td className="p-2 text-right text-emerald-400">${a.amountUSD.toFixed(2)}</td>
                      <td className="p-2 text-right text-zinc-400">{(a.weight * 100).toFixed(1)}%</td>
                      <td className="p-2 text-xs text-zinc-400">{a.reason}</td>
                    </tr>
                  ))}
                  {snapshot.allocation.skipped.map(a => (
                    <tr key={a.botId} className="border-t border-zinc-800 opacity-60">
                      <td className="p-2 font-medium">{a.botName}</td>
                      <td className="p-2"><Badge variant="outline">{a.symbol}</Badge></td>
                      <td className="p-2 text-right text-zinc-500">—</td>
                      <td className="p-2 text-right text-zinc-500">skip</td>
                      <td className="p-2 text-xs text-red-400">{a.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Per-bot studies ─────────────────────────────────────────── */}
      {snapshot && snapshot.studies.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Per-Bot Asset Study</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {snapshot.studies.map(s => (
                <div key={s.botId} className="p-3 rounded-lg bg-zinc-900/50 border border-zinc-800 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="font-semibold text-sm">{s.botName}</div>
                    <VerdictBadge verdict={s.verdict} />
                  </div>
                  <div className="text-xs text-zinc-400">
                    {s.arenaSymbol} → <span className="text-zinc-200">{s.exchangeSymbol}</span>
                  </div>
                  <div className="grid grid-cols-3 text-xs gap-1">
                    <div><div className="text-zinc-500">Signal</div><div className={s.signal === 'BUY' ? 'text-emerald-400' : s.signal === 'SELL' ? 'text-red-400' : ''}>{s.signal}</div></div>
                    <div><div className="text-zinc-500">RSI</div><div>{s.rsi.toFixed(1)}</div></div>
                    <div><div className="text-zinc-500">Trend</div><div>{s.trend}</div></div>
                    <div><div className="text-zinc-500">Win%</div><div>{s.recentWinRate.toFixed(0)}</div></div>
                    <div><div className="text-zinc-500">Trades</div><div>{s.recentTrades}</div></div>
                    <div><div className="text-zinc-500">Conf</div><div>{s.confidence.toFixed(0)}%</div></div>
                  </div>
                  <div className="text-xs text-zinc-400 italic">{s.recommendation}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Preflight simulator ─────────────────────────────────────── */}
      <Card>
        <CardHeader><CardTitle className="text-base">Preflight Simulator</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div>
              <label className="text-xs text-zinc-500">Symbol</label>
              <select value={simSymbol} onChange={e => setSimSymbol(e.target.value)}
                className="block bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm">
                {ASSETS.map(a => <option key={a.symbol} value={a.symbol}>{a.symbol} — {a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-zinc-500">Side</label>
              <select value={simSide} onChange={e => setSimSide(e.target.value as 'buy' | 'sell')}
                className="block bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm">
                <option value="buy">BUY</option><option value="sell">SELL</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-zinc-500">Amount USD</label>
              <input type="number" value={simAmount} min={5} max={50_000}
                onChange={e => setSimAmount(Number(e.target.value))}
                className="block w-28 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm" />
            </div>
            <Button size="sm" onClick={runPreflight}>
              <Zap className="w-4 h-4 mr-2" /> Run Preflight
            </Button>
          </div>

          {shieldResult && (
            <div className="mt-3 p-3 rounded-lg bg-zinc-900/50 border border-zinc-800 space-y-2">
              <div className="flex items-center gap-2">
                {shieldResult.outcome === 'pass'  && <CheckCircle2 className="w-5 h-5 text-emerald-400" />}
                {shieldResult.outcome === 'warn'  && <AlertTriangle className="w-5 h-5 text-amber-400" />}
                {shieldResult.outcome === 'block' && <XCircle className="w-5 h-5 text-red-400" />}
                <div className="font-semibold capitalize">{shieldResult.outcome}</div>
                <div className="text-sm text-zinc-300 ml-2">{shieldResult.reason}</div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                <div><span className="text-zinc-500">Symbol</span> <span className="ml-1">{shieldResult.exchangeSymbol}</span></div>
                <div><span className="text-zinc-500">Notional</span> <span className="ml-1">${shieldResult.notional.toFixed(2)}</span></div>
                <div><span className="text-zinc-500">Qty</span> <span className="ml-1">{shieldResult.estimatedQty.toFixed(6)}</span></div>
                <div><span className="text-zinc-500">Category</span> <span className="ml-1">{shieldResult.category}</span></div>
              </div>
              <div className="space-y-1 mt-2">
                {shieldResult.checks.map(c => (
                  <div key={c.id} className="flex items-center gap-2 text-xs">
                    {c.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" /> : <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />}
                    <span className="text-zinc-400 w-24 shrink-0">{c.id}</span>
                    <span className="text-zinc-300">{c.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {plan && (
            <div className="mt-3 p-3 rounded-lg bg-zinc-900/50 border border-zinc-800 space-y-2">
              <div className="font-semibold text-sm flex items-center gap-2">
                <Zap className="w-4 h-4 text-yellow-400" /> Execution Plan
                <Badge variant="outline" className="ml-2">{plan.planId}</Badge>
              </div>
              {!plan.ok ? (
                <div className="text-sm text-red-400">{plan.reason}</div>
              ) : (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                    <div><span className="text-zinc-500">Type</span> <span className="ml-1 uppercase">{plan.type}</span></div>
                    <div><span className="text-zinc-500">Effective</span> <span className="ml-1">${plan.effectivePrice.toFixed(4)}</span></div>
                    <div><span className="text-zinc-500">Slippage cap</span> <span className="ml-1">{plan.expectedSlippagePct}%</span></div>
                    <div><span className="text-zinc-500">Children</span> <span className="ml-1">{plan.children.length}</span></div>
                  </div>
                  <div className="space-y-1 mt-1">
                    {plan.children.map(c => (
                      <div key={c.index} className="text-xs text-zinc-400">
                        #{c.index + 1}: {c.side.toUpperCase()} ${c.amountUSD.toFixed(2)} {c.symbol} — {c.notes}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Cache controls ─────────────────────────────────────────── */}
      {snapshot && (
        <Card>
          <CardHeader><CardTitle className="text-base">Smart Cache</CardTitle></CardHeader>
          <CardContent className="flex items-center justify-between">
            <div className="text-sm text-zinc-400">
              {snapshot.cache.entries} entries · {snapshot.cache.hits} hits · {snapshot.cache.misses} misses
            </div>
            <Button size="sm" variant="outline" onClick={() => { pipelineCache.clearAll(); refresh(); }}>
              Clear cache
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Kpi({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div className="p-3 rounded-lg bg-zinc-900/50 border border-zinc-800">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`text-lg font-semibold mt-0.5 ${color ?? 'text-zinc-100'}`}>{value}</div>
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict: string }) {
  const map: Record<string, string> = {
    ready:    'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    'warm-up':'bg-blue-500/15 text-blue-300 border-blue-500/30',
    blocked:  'bg-red-500/15 text-red-300 border-red-500/30',
    risky:    'bg-amber-500/15 text-amber-300 border-amber-500/30',
    stalled:  'bg-zinc-500/15 text-zinc-300 border-zinc-500/30',
  };
  return <Badge className={map[verdict] ?? ''}>{verdict}</Badge>;
}
