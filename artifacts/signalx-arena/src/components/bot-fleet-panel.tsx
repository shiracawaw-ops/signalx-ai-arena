import { useMemo } from 'react';
import {
  botFleet,
  useBotFleet,
  summarizeFleet,
  FLEET_MAX_BOTS,
  FLEET_MIN_BOTS,
  type RemainingMode,
} from '@/lib/bot-fleet';

interface Props {
  totalBots:       number;
  realBalanceUSD:  number;
  minNotionalUSD?: number;
}

const MODE_LABEL: Record<RemainingMode, string> = {
  standby:  'Standby',
  paper:    'Paper',
  disabled: 'Disabled',
};

const MODE_DESC: Record<RemainingMode, string> = {
  standby:  'Idle — no trades, ready to switch in',
  paper:    'Trade in simulation only — no real capital',
  disabled: 'Stopped — bot will not run at all',
};

export function BotFleetPanel({ totalBots, realBalanceUSD, minNotionalUSD = 10 }: Props) {
  const cfg = useBotFleet();

  const summary = useMemo(
    () => summarizeFleet({ cfg, totalBots, realBalanceUSD, minNotionalUSD }),
    [cfg, totalBots, realBalanceUSD, minNotionalUSD],
  );

  const setMax = (n: number) => botFleet.set({ maxBots: n });
  const setActive = (n: number) => botFleet.set({ activeRealBots: n });
  const setMode = (m: RemainingMode) => botFleet.set({ remainingMode: m });

  return (
    <div
      className="bg-zinc-900/60 border border-zinc-800/60 rounded-2xl p-5 space-y-5"
      data-testid="bot-fleet-panel"
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">
            Bot Fleet Control
          </div>
          <div className="text-sm font-bold text-zinc-100 mt-0.5">
            Real-Balance Trading Allocation
          </div>
        </div>
        <button
          type="button"
          onClick={() => botFleet.reset()}
          className="px-2.5 py-1 text-[10px] font-semibold rounded-lg border border-zinc-700/60 text-zinc-400 hover:bg-zinc-800/60 transition-colors"
          data-testid="button-fleet-reset"
        >
          Reset
        </button>
      </div>

      {/* ── Total Bots ── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-[11px] font-semibold text-zinc-300">
            Total Bots
            <span className="ml-2 text-zinc-500 font-normal">
              (max {FLEET_MAX_BOTS})
            </span>
          </label>
          <span className="font-mono text-sm text-emerald-400 font-bold" data-testid="value-max-bots">
            {cfg.maxBots}
          </span>
        </div>
        <input
          type="range"
          min={FLEET_MIN_BOTS}
          max={FLEET_MAX_BOTS}
          step={1}
          value={cfg.maxBots}
          onChange={e => setMax(Number(e.target.value))}
          className="w-full accent-emerald-500"
          data-testid="slider-max-bots"
        />
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={FLEET_MIN_BOTS}
            max={FLEET_MAX_BOTS}
            value={cfg.maxBots}
            onChange={e => setMax(Number(e.target.value))}
            className="w-20 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs font-mono text-zinc-200"
            data-testid="input-max-bots"
          />
          <span className="text-[10px] text-zinc-500">bots in fleet</span>
        </div>
      </div>

      {/* ── Active Real Bots ── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-[11px] font-semibold text-zinc-300">
            Active Real Bots
            <span className="ml-2 text-zinc-500 font-normal">
              (max {cfg.maxBots})
            </span>
          </label>
          <span className="font-mono text-sm text-amber-400 font-bold" data-testid="value-active-real-bots">
            {cfg.activeRealBots}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={cfg.maxBots}
          step={1}
          value={cfg.activeRealBots}
          onChange={e => setActive(Number(e.target.value))}
          className="w-full accent-amber-500"
          data-testid="slider-active-real-bots"
        />
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            max={cfg.maxBots}
            value={cfg.activeRealBots}
            onChange={e => setActive(Number(e.target.value))}
            className="w-20 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs font-mono text-zinc-200"
            data-testid="input-active-real-bots"
          />
          <span className="text-[10px] text-zinc-500">trade with real balance</span>
        </div>
      </div>

      {/* ── Remaining Bots Mode ── */}
      <div className="space-y-2">
        <label className="text-[11px] font-semibold text-zinc-300">
          Remaining Bots Mode
        </label>
        <div className="grid grid-cols-3 gap-2">
          {(['standby', 'paper', 'disabled'] as RemainingMode[]).map(m => {
            const selected = cfg.remainingMode === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                data-testid={`button-mode-${m}`}
                className={
                  'rounded-xl px-3 py-2 text-xs font-bold border transition-colors text-left ' +
                  (selected
                    ? 'border-emerald-500/60 bg-emerald-600/15 text-emerald-300'
                    : 'border-zinc-800 bg-zinc-950/40 text-zinc-400 hover:bg-zinc-800/40')
                }
              >
                <div>{MODE_LABEL[m]}</div>
                <div className="text-[9px] font-normal text-zinc-500 mt-0.5 leading-snug">
                  {MODE_DESC[m]}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Summary ── */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4 space-y-3">
        <div className="text-[9px] uppercase tracking-widest text-zinc-500 font-bold">
          Configuration Summary
        </div>
        <div className="grid grid-cols-2 gap-3 text-[11px]">
          <SummaryStat label="Total Bots"      value={`${summary.totalBots} / ${summary.maxBots}`} />
          <SummaryStat
            label="Real Bots"
            value={`${summary.effectiveRealBots}${summary.effectiveRealBots !== summary.activeRealBots ? ` (req ${summary.activeRealBots})` : ''}`}
            color="text-amber-400"
          />
          <SummaryStat
            label="Remaining Bots"
            value={`${summary.remainingBots} → ${MODE_LABEL[summary.remainingMode]}`}
          />
          <SummaryStat
            label="Per-Bot Allocation"
            value={summary.effectiveRealBots > 0 ? `$${summary.allocationPerBot.toFixed(2)}` : '—'}
            color={
              summary.effectiveRealBots > 0 && summary.allocationPerBot < minNotionalUSD
                ? 'text-red-400'
                : 'text-emerald-400'
            }
          />
        </div>

        {summary.warnings.length > 0 && (
          <div className="space-y-1.5 pt-1" data-testid="fleet-warnings">
            {summary.warnings.map((w, i) => (
              <div
                key={i}
                className={
                  'flex items-start gap-2 rounded-lg px-3 py-2 text-[11px] leading-snug border ' +
                  (summary.blocking
                    ? 'border-red-700/50 bg-red-900/15 text-red-300'
                    : 'border-amber-700/40 bg-amber-900/10 text-amber-300')
                }
              >
                <span className="mt-[1px]">{summary.blocking ? '✕' : '!'}</span>
                <span>{w}</span>
              </div>
            ))}
          </div>
        )}

        {summary.warnings.length === 0 && summary.effectiveRealBots > 0 && (
          <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-3 py-2 text-[11px] text-emerald-300">
            ✓ Configuration valid — {summary.effectiveRealBots} bot{summary.effectiveRealBots === 1 ? '' : 's'} will trade with real balance.
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryStat({
  label, value, color = 'text-zinc-100',
}: { label: string; value: string; color?: string }) {
  return (
    <div className="space-y-0.5">
      <div className="text-[9px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`font-mono font-bold ${color}`}>{value}</div>
    </div>
  );
}
