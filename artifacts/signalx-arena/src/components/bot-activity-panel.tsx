// ── Bot Activity Transparency Panel ──────────────────────────────────────────
// Shows the user, in plain language, exactly what every bot is doing right
// now in real-trading mode: who's eligible, who's standing by, who's been
// blocked and why. Drops into autopilot.tsx under the Bot Fleet panel.

import { useMemo } from 'react';
import { useBotActivity, botActivityStore } from '@/lib/bot-activity-store';
import { useRealProfit } from '@/lib/real-profit-store';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export function BotActivityPanel() {
  const a = useBotActivity();
  const p = useRealProfit();

  // Sort: blocked first (need attention), then standby, then active.
  const rows = useMemo(() => {
    const list = Object.values(a.bots);
    list.sort((x, y) => {
      const score = (b: typeof x) => {
        if (b.lastRejectTs > b.lastSuccessTs) return 0;     // blocked
        if (b.eligibleNow && b.lastAttemptTs === 0) return 1; // standby
        return 2;                                           // active / other
      };
      return score(x) - score(y);
    });
    return list.slice(0, 10);
  }, [a.bots]);

  return (
    <Card className="border-zinc-800/60 bg-zinc-900/40">
      <CardHeader className="py-3 px-4 flex flex-row items-center justify-between">
        <CardTitle className="text-sm flex items-center gap-2">
          Bot Activity Transparency
          <Badge variant="outline" className="text-[10px] border-amber-600/40 text-amber-300">
            LIVE
          </Badge>
        </CardTitle>
        <button
          onClick={() => botActivityStore.reset()}
          className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
          title="Clear activity history (does not affect realized PnL)"
        >
          Reset
        </button>
      </CardHeader>
      <CardContent className="pb-4 space-y-3">
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center text-[11px]">
          <Stat label="Total"      value={a.totals.totalBots} />
          <Stat label="Eligible"   value={a.totals.eligibleForReal} tone="info" />
          <Stat label="Active 5m"  value={a.totals.activeNow}        tone="up" />
          <Stat label="Today"      value={a.totals.executedRealToday} tone="up" />
          <Stat label="Standby"    value={a.totals.standby}           tone="warn" />
          <Stat label="Blocked"    value={a.totals.blocked}           tone="down" />
        </div>

        {rows.length === 0 ? (
          <div className="text-center text-xs text-zinc-500 py-3">
            No bot activity yet. Activate real trading and the Bot Fleet to populate this panel.
          </div>
        ) : (
          <div className="border border-zinc-800/60 rounded-lg overflow-hidden">
            <table className="w-full text-[11px]">
              <thead className="bg-zinc-900/60 text-zinc-500 uppercase tracking-wider">
                <tr>
                  <th className="text-left  px-3 py-1.5">Bot</th>
                  <th className="text-left  px-3 py-1.5">State</th>
                  <th className="text-right px-3 py-1.5">Realized PnL</th>
                  <th className="text-right px-3 py-1.5">Today</th>
                  <th className="text-right px-3 py-1.5">Last Trade</th>
                  <th className="text-right px-3 py-1.5">Reject %</th>
                  <th className="text-right px-3 py-1.5">Exec Q.</th>
                  <th className="text-left  px-3 py-1.5">Doctor</th>
                  <th className="text-left  px-3 py-1.5">Last reason</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(b => {
                  const stat = p.perBot[b.botId];
                  const realized = stat?.realizedPnlUSD ?? 0;
                  const fees     = stat?.feesPaidUSD    ?? 0;
                  const net      = realized - fees;
                  const rate     = botActivityStore.rejectionRate(b.botId) * 100;
                  const todayNet = stat?.todayNetPnlUSD ?? 0;
                  const lastTradeNet = stat?.lastTradeNetPnlUSD ?? 0;
                  const execQ = b.executionQualityScore ?? stat?.executionQualityScore ?? Math.max(0, 100 - rate);
                  const doctor = b.doctorHealthStatus ?? stat?.doctorHealthStatus ?? 'healthy';
                  const state =
                    b.lastRejectTs > b.lastSuccessTs ? { label: 'Blocked', tone: 'text-red-400 bg-red-900/20'   } :
                    b.eligibleNow && b.lastAttemptTs === 0
                                                    ? { label: 'Standby', tone: 'text-amber-300 bg-amber-900/20' } :
                    !b.eligibleNow                  ? { label: 'Benched', tone: 'text-zinc-400 bg-zinc-800/40' } :
                                                      { label: 'Active',  tone: 'text-emerald-400 bg-emerald-900/20' };
                  const lastReason = b.lastRejectCode ?? '—';
                  return (
                    <tr key={b.botId} className="border-t border-zinc-800/40">
                      <td className="px-3 py-1.5 font-medium truncate max-w-[140px]">
                        {b.name ?? b.botId}
                      </td>
                      <td className="px-3 py-1.5">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${state.tone}`}>
                          {state.label}
                        </span>
                      </td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${net >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {net >= 0 ? '+' : ''}${net.toFixed(2)}
                      </td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${todayNet >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {todayNet >= 0 ? '+' : ''}${todayNet.toFixed(2)}
                      </td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${lastTradeNet >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {lastTradeNet >= 0 ? '+' : ''}${lastTradeNet.toFixed(2)}
                      </td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${rate >= 30 ? 'text-red-400' : rate >= 10 ? 'text-amber-400' : 'text-zinc-300'}`}>
                        {rate.toFixed(0)}%
                      </td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${execQ < 45 ? 'text-red-400' : execQ < 70 ? 'text-amber-400' : 'text-emerald-400'}`}>
                        {execQ.toFixed(0)}
                      </td>
                      <td className={`px-3 py-1.5 text-[10px] uppercase tracking-wide ${
                        doctor === 'benched' || doctor === 'critical' ? 'text-red-300' : doctor === 'watch' ? 'text-amber-300' : 'text-emerald-300'
                      }`}>
                        {doctor}
                      </td>
                      <td className="px-3 py-1.5 text-zinc-400 truncate max-w-[180px]" title={b.lastRejectDetail ?? ''}>
                        {lastReason}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat(p: { label: string; value: number; tone?: 'up' | 'down' | 'warn' | 'info' }) {
  const colour =
    p.tone === 'up'   ? 'text-emerald-400 border-emerald-700/40' :
    p.tone === 'down' ? 'text-red-400     border-red-700/40'     :
    p.tone === 'warn' ? 'text-amber-300   border-amber-700/40'   :
    p.tone === 'info' ? 'text-sky-300     border-sky-700/40'     :
                        'text-zinc-200    border-zinc-800/60';
  return (
    <div className={`rounded-md border px-2 py-1.5 bg-zinc-900/40 ${colour}`}>
      <div className="text-[9px] uppercase tracking-wider text-zinc-500 font-semibold">{p.label}</div>
      <div className="text-base font-bold tabular-nums">{p.value}</div>
    </div>
  );
}
