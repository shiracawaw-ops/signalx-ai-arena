// ── Real Profit Panel ─────────────────────────────────────────────────────────
// Compact, read-only summary of REALIZED profit on real exchanges. Drops into
// reports.tsx alongside the existing KPI strip. No redesign — same Card look.

import { useRealProfit, netRealized } from '@/lib/real-profit-store';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

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
