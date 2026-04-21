// ─── Real-Mode Diagnostics ────────────────────────────────────────────────────
// Pure-function diagnostic engine that reads ONLY real-mode telemetry
// (bot-activity-store + real-profit-store) and surfaces actionable issues
// for the Bot Doctor panel. No synthetic / paper data is consumed here so
// the panel can never be misleading in real trading mode.
//
// Each diagnostic carries a code, a level, a human reason, and a
// recommended action — the UI maps the action to a one-click button
// (bench, restore, mark dust, switch mode etc.).

import type { BotActivity, BotActivityState } from './bot-activity-store.js';
import type { RealProfitState }               from './real-profit-store.js';
import type { BenchEntry }                    from './bot-doctor-store.js';

export type RealIssueLevel = 'critical' | 'warning' | 'info';

export type RealIssueCode =
  | 'ADAPTER_NOT_READY'
  | 'COOLDOWN_SPAM'
  | 'DUST_UNSELLABLE'
  | 'HIGH_REJECT_RATE'
  | 'BLOCKED_NO_SUCCESS'
  | 'INACTIVE_ELIGIBLE'
  | 'UNDERPERFORMING_REAL'
  | 'ALLOCATION_STARVED'
  | 'HEALTHY';

export type RealIssueAction =
  | 'bench'
  | 'restore'
  | 'mark_dust'
  | 'switch_to_auto_fix'
  | 'monitor';

export interface RealBotDiagnostic {
  botId:          string;
  name?:          string;
  eligibleNow:    boolean;
  benched:        boolean;
  benchReason?:   string;
  recentAttempts: number;
  recentRejects:  number;
  rejectRate:     number;
  lastRejectCode?: string;
  lastRejectDetail?: string;
  realizedNetUSD: number;
  realTrades:     number;
  winRate:        number;
  issues:         RealIssue[];
  healthScore:    number;          // 0..100
}

export interface RealIssue {
  code:           RealIssueCode;
  level:          RealIssueLevel;
  title:          string;
  description:    string;
  recommendation: string;
  actions:        RealIssueAction[];
}

export interface RealDiagnosticsSummary {
  totalBots:        number;
  eligible:         number;
  benched:          number;
  withCriticalIssue: number;
  withWarningIssue:  number;
  healthy:          number;
  avgHealth:        number;
}

// ── Per-bot reject-rate computation (uses recent[] window only) ──────────────
function rejectStats(b: BotActivity): { attempts: number; rejects: number; rate: number } {
  const r = b.recent ?? [];
  const submitted = r.filter(x => x.kind === 'attempt' || x.kind === 'success' || x.kind === 'reject').length;
  const rejects   = r.filter(x => x.kind === 'reject').length;
  const rate      = submitted === 0 ? 0 : rejects / submitted;
  return { attempts: submitted, rejects, rate };
}

function detectIssuesFor(
  activity: BotActivity,
  realStat: { realizedNetUSD: number; trades: number; wins: number; losses: number } | null,
  isBenched: boolean,
  benchEntry: BenchEntry | undefined,
): RealIssue[] {
  const issues: RealIssue[] = [];
  const stats = rejectStats(activity);

  // 1. Currently benched — surface as info so user sees the doctor's action.
  if (isBenched && benchEntry) {
    const minsLeft = benchEntry.expiresAt > 0
      ? Math.max(0, Math.round((benchEntry.expiresAt - Date.now()) / 60_000))
      : 0;
    issues.push({
      code: benchEntry.code === 'high_reject_rate' ? 'HIGH_REJECT_RATE'
          : benchEntry.code === 'cooldown_spam' ? 'COOLDOWN_SPAM'
          : benchEntry.code === 'dust_unsellable' ? 'DUST_UNSELLABLE'
          : benchEntry.code === 'adapter_not_ready' ? 'ADAPTER_NOT_READY'
          : benchEntry.code === 'underperforming_real' ? 'UNDERPERFORMING_REAL'
          : 'INACTIVE_ELIGIBLE',
      level: 'warning',
      title: `Benched by Doctor (${benchEntry.code})`,
      description: benchEntry.reason,
      recommendation: benchEntry.expiresAt > 0
        ? `Auto-restore in ~${minsLeft} min, or restore now.`
        : 'Manually benched — restore when ready.',
      actions: ['restore', 'monitor'],
    });
  }

  // 2. Adapter problems — repeated adapter_not_ready rejects.
  const adapterRejects = (activity.recent ?? []).filter(
    x => x.kind === 'reject' && /adapter_not_ready/i.test(x.reason ?? ''),
  ).length;
  if (!isBenched && adapterRejects >= 2) {
    issues.push({
      code: 'ADAPTER_NOT_READY',
      level: 'critical',
      title: 'Exchange adapter not ready',
      description: `Last ${adapterRejects} attempts rejected because the exchange adapter was unreachable or not initialised.`,
      recommendation: 'Reconnect the exchange (Exchange tab) or wait for the adapter to come back online.',
      actions: ['bench', 'monitor'],
    });
  }

  // 3. Cooldown / duplicate / stale signal spam.
  const cooldownRejects = (activity.recent ?? []).filter(
    x => x.kind === 'reject' && /cooldown|duplicate_signal|stale_price/i.test(x.reason ?? ''),
  ).length;
  if (!isBenched && cooldownRejects >= 4 && stats.rate >= 0.5) {
    issues.push({
      code: 'COOLDOWN_SPAM',
      level: 'warning',
      title: 'Cooldown / duplicate signal spam',
      description: `${cooldownRejects} of last ${stats.attempts} attempts hit a cooldown shield, duplicate-signal block or stale-price gate.`,
      recommendation: 'Bot is firing too fast for the market. Bench it briefly and review signal frequency.',
      actions: ['bench', 'monitor'],
    });
  }

  // 4. Min-notional / dust failures.
  const dustRejects = (activity.recent ?? []).filter(
    x => x.kind === 'reject' && /min_notional|owned_qty_below|insufficient_qty|filter_min/i.test(x.reason ?? ''),
  ).length;
  if (!isBenched && dustRejects >= 1) {
    issues.push({
      code: 'DUST_UNSELLABLE',
      level: 'warning',
      title: 'Position too small to trade',
      description: `${dustRejects} reject(s) due to position / order size below exchange minimum.`,
      recommendation: 'Mark this position as dust to stop retry storms, then manually clear when balance grows.',
      actions: ['mark_dust', 'monitor'],
    });
  }

  // 5. Generic high reject rate (after a meaningful sample).
  if (!isBenched && stats.attempts >= 8 && stats.rate >= 0.6 && cooldownRejects < 4 && adapterRejects < 2) {
    issues.push({
      code: 'HIGH_REJECT_RATE',
      level: 'critical',
      title: `High reject rate (${Math.round(stats.rate * 100)}%)`,
      description: `${stats.rejects} of last ${stats.attempts} real attempts were rejected.`,
      recommendation: 'Bench this bot and inspect last reject reason in the Activity panel.',
      actions: ['bench', 'monitor'],
    });
  }

  // 6. Blocked with no success — last reject is recent and there has been
  //    no successful trade since.
  if (
    !isBenched &&
    activity.lastRejectTs > 0 &&
    activity.lastRejectTs > activity.lastSuccessTs &&
    Date.now() - activity.lastRejectTs < 30 * 60 * 1000 &&
    stats.attempts >= 3 &&
    stats.rate >= 0.5
  ) {
    issues.push({
      code: 'BLOCKED_NO_SUCCESS',
      level: 'warning',
      title: 'Blocked — no recent successful trade',
      description: activity.lastRejectDetail
        ? `Last reject: ${activity.lastRejectCode ?? 'unknown'} — ${activity.lastRejectDetail}`
        : `Bot has had no successful real trade since last reject (${activity.lastRejectCode ?? 'unknown'}).`,
      recommendation: 'Review the last reject reason; bench if the cause is structural.',
      actions: ['bench', 'monitor'],
    });
  }

  // 7. Eligible but inactive — slot consumed without producing volume.
  if (
    activity.eligibleNow &&
    !isBenched &&
    activity.lastAttemptTs === 0 &&
    activity.lastSuccessTs === 0
  ) {
    issues.push({
      code: 'INACTIVE_ELIGIBLE',
      level: 'info',
      title: 'Eligible but no attempts yet',
      description: 'Bot is in the real-eligible set but has not produced any signal yet this session.',
      recommendation: 'Normal for slow strategies. Consider lowering the active-real-bots count if this persists.',
      actions: ['monitor'],
    });
  }

  // 8. Under-performing real bot.
  if (realStat && realStat.trades >= 5 && realStat.realizedNetUSD < 0) {
    const lossUsd = Math.abs(realStat.realizedNetUSD);
    issues.push({
      code: 'UNDERPERFORMING_REAL',
      level: lossUsd > 50 ? 'critical' : 'warning',
      title: `Net realized loss: -$${lossUsd.toFixed(2)}`,
      description: `${realStat.trades} closed trades, ${realStat.wins} wins / ${realStat.losses} losses.`,
      recommendation: 'Strategy is losing real money. Bench bot and consider cloning the champion strategy.',
      actions: ['bench', 'monitor'],
    });
  }

  return issues;
}

function calcHealth(issues: RealIssue[]): number {
  let s = 100;
  for (const i of issues) {
    if (i.level === 'critical') s -= 30;
    else if (i.level === 'warning') s -= 15;
    else s -= 5;
  }
  return Math.max(0, Math.min(100, s));
}

export interface DiagnoseRealInput {
  activity:        BotActivityState;
  profit:          RealProfitState;
  isBenched:       (botId: string) => boolean;
  benchEntry:      (botId: string) => BenchEntry | undefined;
  /** Optional: bots that are eligible but received zero capital (sub-min slice). */
  capitalStarved?: Set<string>;
}

export function diagnoseReal(input: DiagnoseRealInput): RealBotDiagnostic[] {
  const out: RealBotDiagnostic[] = [];
  for (const activity of Object.values(input.activity.bots)) {
    const stats = rejectStats(activity);
    const stat  = input.profit.perBot[activity.botId];
    const realStat = stat ? {
      realizedNetUSD: stat.realizedPnlUSD - stat.feesPaidUSD,
      trades: stat.wins + stat.losses,
      wins:   stat.wins,
      losses: stat.losses,
    } : null;
    const benched = input.isBenched(activity.botId);
    const benchEntry = input.benchEntry(activity.botId);
    const issues = detectIssuesFor(activity, realStat, benched, benchEntry);

    // Capital-starved flag — surfaced only when bot is eligible and has no
    // attempts (otherwise the inactive_eligible warning already covers it).
    if (input.capitalStarved?.has(activity.botId) && activity.lastAttemptTs === 0 && !benched) {
      issues.push({
        code: 'ALLOCATION_STARVED',
        level: 'warning',
        title: 'Allocated capital below exchange minimum',
        description: 'Per-bot slice fell below the min-notional threshold for this exchange.',
        recommendation: 'Add capital or reduce active real bots so each bot gets a tradeable slice.',
        actions: ['monitor'],
      });
    }

    out.push({
      botId:          activity.botId,
      name:           activity.name,
      eligibleNow:    activity.eligibleNow,
      benched,
      benchReason:    benchEntry?.reason,
      recentAttempts: stats.attempts,
      recentRejects:  stats.rejects,
      rejectRate:     stats.rate,
      lastRejectCode:   activity.lastRejectCode,
      lastRejectDetail: activity.lastRejectDetail,
      realizedNetUSD: realStat?.realizedNetUSD ?? 0,
      realTrades:     realStat?.trades ?? 0,
      winRate:        realStat && realStat.trades > 0 ? realStat.wins / realStat.trades : 0,
      issues,
      healthScore:    calcHealth(issues),
    });
  }
  // Sort: critical first, then by health ascending.
  return out.sort((a, b) => {
    const ac = a.issues.filter(i => i.level === 'critical').length;
    const bc = b.issues.filter(i => i.level === 'critical').length;
    if (bc !== ac) return bc - ac;
    return a.healthScore - b.healthScore;
  });
}

export function summarizeReal(diags: RealBotDiagnostic[]): RealDiagnosticsSummary {
  const total = diags.length;
  const elig  = diags.filter(d => d.eligibleNow).length;
  const benched = diags.filter(d => d.benched).length;
  const crit = diags.filter(d => d.issues.some(i => i.level === 'critical')).length;
  const warn = diags.filter(d => d.issues.some(i => i.level === 'warning') && !d.issues.some(i => i.level === 'critical')).length;
  const healthy = diags.filter(d => d.issues.length === 0).length;
  const avg = total > 0 ? Math.round(diags.reduce((s, d) => s + d.healthScore, 0) / total) : 0;
  return {
    totalBots: total, eligible: elig, benched,
    withCriticalIssue: crit, withWarningIssue: warn, healthy, avgHealth: avg,
  };
}
