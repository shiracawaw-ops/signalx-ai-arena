// ── Real Profit Panel ─────────────────────────────────────────────────────────
// Compact, read-only summary of REALIZED profit on real exchanges. Drops into
// reports.tsx alongside the existing KPI strip. No redesign — same Card look.
//
// Includes a collapsible "Real Profit Proof" log of every closed real trade
// so the user can audit exactly which trades made (or lost) money. The log
// is sourced from the same store as the KPIs above it — no recomputation,
// no mixing with paper/synthetic trades.

import { useState } from 'react';
import { useRealProfit, netRealized, realProfitStore } from '@/lib/real-profit-store';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, ChevronUp, Receipt } from 'lucide-react';

const fmt = (n: number, d = 2) =>
  (n >= 0 ? '+' : '') + n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });

export function RealProfitPanel() {
  const s   = useRealProfit();
  const net = netRealized(s);
  const totalEquityDelta = s.startingBalanceUSD > 0
    ? s.currentEquityUSD - s.startingBalanceUSD
    : 0;
  const winRate = (s.winsClosed + s.lossesClosed) > 0
    ? (s.winsClosed / (s.winsClosed + s.lossesClosed)) * 100
    : 0;

  const [expanded, setExpanded] = useState(false);
  const closed = expanded ? realProfitStore.getClosedTrades(20) : [];

  return (
    <Card className="border-emerald-700/30 bg-gradient-to-br from-emerald-950/30 to-zinc-900/40">
      <CardHeader className="py-3 px-4 flex flex-row items-center justify-between">
        <CardTitle className="text-sm flex items-center gap-2">
          Real Profit (live exchange money)
          <Badge variant="outline" className="text-[10px] border-emerald-600/40 text-emerald-300">
            REALIZED
          </Badge>
        </CardTitle>
        <span className="text-[10px] text-zinc-500">
          {s.lastUpdated ? new Date(s.lastUpdated).toLocaleTimeString() : '—'}
        </span>
      </CardHeader>
      <CardContent className="pb-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <Stat label="Net realized (after fees)"
              value={`$${fmt(net)}`}
              tone={net >= 0 ? 'up' : 'down'} />
        <Stat label="Gross realized"
              value={`$${fmt(s.realizedPnlUSD)}`}
              tone={s.realizedPnlUSD >= 0 ? 'up' : 'down'} />
        <Stat label="Fees paid"
              value={`$${s.feesPaidUSD.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
              tone="neutral" />
        <Stat label="Unrealized (open lots)"
              value={`$${fmt(s.unrealizedPnlUSD)}`}
              tone={s.unrealizedPnlUSD >= 0 ? 'up' : 'down'} />
        <Stat label="Starting balance"
              value={s.startingBalanceUSD > 0 ? `$${s.startingBalanceUSD.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
              tone="neutral" />
        <Stat label="Current equity"
              value={s.currentEquityUSD > 0 ? `$${s.currentEquityUSD.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
              tone="neutral" />
        <Stat label="Equity Δ"
              value={s.startingBalanceUSD > 0 ? `$${fmt(totalEquityDelta)}` : '—'}
              tone={totalEquityDelta >= 0 ? 'up' : 'down'} />
        <Stat label={`Win-rate (${s.winsClosed + s.lossesClosed} trades)`}
              value={(s.winsClosed + s.lossesClosed) > 0 ? `${winRate.toFixed(1)}%` : '—'}
              tone={winRate >= 50 ? 'up' : 'down'} />
      </CardContent>

      {/* Real Profit Proof — closed trades log */}
      <div className="border-t border-emerald-900/30 px-4 py-2">
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-2 text-xs text-emerald-300 hover:text-emerald-200 transition-colors w-full"
        >
          <Receipt size={12} />
          <span className="font-semibold">Real Profit Proof</span>
          <span className="text-zinc-500">
            ({s.winsClosed + s.lossesClosed} closed trades)
          </span>
          <span className="ml-auto">
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </span>
        </button>
        {expanded && (
          <div className="mt-2 space-y-1 max-h-72 overflow-y-auto">
            {closed.length === 0 ? (
              <div className="text-[11px] text-zinc-500 py-3 text-center">
                No closed real trades yet. They appear here as soon as the first SELL fills.
              </div>
            ) : (
              <table className="w-full text-[11px]">
                <thead className="text-zinc-500 uppercase tracking-wider text-[9px] sticky top-0 bg-emerald-950/30 backdrop-blur">
                  <tr>
                    <th className="text-left py-1 px-1">Time</th>
                    <th className="text-left py-1 px-1">Symbol</th>
                    <th className="text-right py-1 px-1">Qty</th>
                    <th className="text-right py-1 px-1">Entry</th>
                    <th className="text-right py-1 px-1">Exit</th>
                    <th className="text-right py-1 px-1">Fees</th>
                    <th className="text-right py-1 px-1">Net P/L</th>
                    <th className="text-left py-1 px-1">Bot</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {closed.map((t, i) => (
                    <tr key={i} className="border-t border-zinc-800/50">
                      <td className="py-1 px-1 text-zinc-400">{new Date(t.ts).toLocaleTimeString()}</td>
                      <td className="py-1 px-1 text-zinc-200">{t.exchange}:{t.baseAsset}</td>
                      <td className="py-1 px-1 text-right text-zinc-300">{t.qty.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                      <td className="py-1 px-1 text-right text-zinc-300">${t.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                      <td className="py-1 px-1 text-right text-zinc-300">${t.exitPrice.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                      <td className="py-1 px-1 text-right text-zinc-500">${t.feesUSD.toFixed(3)}</td>
                      <td className={`py-1 px-1 text-right font-bold ${t.netPnlUSD >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        ${fmt(t.netPnlUSD)}
                      </td>
                      <td className="py-1 px-1 text-zinc-400 truncate max-w-24">{t.botName ?? t.botId ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function Stat(p: { label: string; value: string; tone: 'up' | 'down' | 'neutral' }) {
  const colour =
    p.tone === 'up'   ? 'text-emerald-400' :
    p.tone === 'down' ? 'text-red-400'     : 'text-zinc-200';
  return (
    <div className="border border-zinc-800/60 rounded-lg px-3 py-2 bg-zinc-900/40">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">{p.label}</div>
      <div className={`mt-0.5 text-base font-bold tabular-nums ${colour}`}>{p.value}</div>
    </div>
  );
}
