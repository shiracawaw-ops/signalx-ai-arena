import { useMemo } from 'react';
import {
  botFleet,
  useBotFleet,
  summarizeFleet,
  FLEET_MAX_BOTS,
  FLEET_MIN_BOTS,
  CAPITAL_USAGE_OPTIONS,
  type RemainingMode,
  type CapitalUsagePct,
  type AssignmentMode,
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

const ASSIGNMENT_OPTIONS: { id: AssignmentMode; title: string; desc: string }[] = [
  { id: 'auto_best',             title: 'Smart (Best Overall)',  desc: 'Composite score: win-rate × confidence × stability' },
  { id: 'auto_recent',           title: 'Recent Performance',    desc: 'Bots that just had a hot streak' },
  { id: 'auto_lowest_rejection', title: 'Fewest Rejections',     desc: 'Bots whose orders fill the most reliably' },
  { id: 'auto_highest_stability',title: 'Most Stable',           desc: 'Bots with the smoothest equity curve' },
  { id: 'manual',                title: 'Manual (Pinned)',       desc: 'Keep whichever bots you currently selected' },
];

export function BotFleetPanel({ totalBots, realBalanceUSD, minNotionalUSD = 10 }: Props) {
  const cfg = useBotFleet();

  const summary = useMemo(
    () => summarizeFleet({ cfg, totalBots, realBalanceUSD, minNotionalUSD }),
    [cfg, totalBots, realBalanceUSD, minNotionalUSD],
  );

  const setMax = (n: number) => botFleet.set({ maxBots: n });
  const setActive = (n: number) => botFleet.set({ activeRealBots: n });
  const setMode = (m: RemainingMode) => botFleet.set({ remainingMode: m });
  const setUsage = (p: CapitalUsagePct) => botFleet.set({ capitalUsagePct: p });
  const setAssign = (a: AssignmentMode) => botFleet.set({ assignmentMode: a });

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

      {/* ── Capital Usage % ── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-[11px] font-semibold text-zinc-300">
            Capital Usage
            <span className="ml-2 text-zinc-500 font-normal">(of real balance)</span>
          </label>
          <span className="font-mono text-sm text-cyan-400 font-bold" data-testid="value-capital-usage">
            {cfg.capitalUsagePct}%
          </span>
        </div>
        <div className="grid grid-cols-5 gap-1.5">
          {CAPITAL_USAGE_OPTIONS.map(p => {
            const selected = cfg.capitalUsagePct === p;
            return (
              <button
                key={p}
                type="button"
                onClick={() => setUsage(p)}
                data-testid={`button-usage-${p}`}
                className={
                  'rounded-lg px-2 py-1.5 text-xs font-bold border transition-colors ' +
                  (selected
                    ? 'border-cyan-500/60 bg-cyan-600/15 text-cyan-300'
                    : 'border-zinc-800 bg-zinc-950/40 text-zinc-400 hover:bg-zinc-800/40')
                }
              >
                {p}%
              </button>
            );
          })}
        </div>
        <div className="text-[10px] text-zinc-500 leading-snug">
          Only this share of your real balance is exposed to live trading. The rest stays in reserve.
        </div>
      </div>

      {/* ── Assignment Mode ── */}
      <div className="space-y-2">
        <label className="text-[11px] font-semibold text-zinc-300">
          Real-Bot Selection
        </label>
        <div className="grid grid-cols-1 gap-1.5">
          {ASSIGNMENT_OPTIONS.map(opt => {
            const selected = cfg.assignmentMode === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setAssign(opt.id)}
                data-testid={`button-assignment-${opt.id}`}
                className={
                  'rounded-lg px-3 py-2 text-left text-xs font-semibold border transition-colors ' +
                  (selected
                    ? 'border-emerald-500/60 bg-emerald-600/15 text-emerald-300'
                    : 'border-zinc-800 bg-zinc-950/40 text-zinc-400 hover:bg-zinc-800/40')
                }
              >
                <div className="flex items-center gap-1.5">
                  <span>{opt.title}</span>
                  {opt.id === 'auto_best' && (
                    <span className="text-[8px] uppercase tracking-wider text-emerald-500/80">recommended</span>
                  )}
                </div>
                <div className="text-[10px] font-normal text-zinc-500 mt-0.5 leading-snug">
                  {opt.desc}
                </div>
              </button>
            );
          })}
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
          <SummaryStat
            label={`Usable Capital (${summary.capitalUsagePct}%)`}
            value={`$${summary.usableCapitalUSD.toFixed(2)}`}
            color="text-cyan-400"
          />
          <SummaryStat
            label="Held in Reserve"
            value={`$${summary.reservedCapitalUSD.toFixed(2)}`}
            color="text-zinc-300"
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
