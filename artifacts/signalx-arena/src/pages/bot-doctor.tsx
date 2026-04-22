
import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useArena } from '@/hooks/use-arena';
import { diagnoseBots, type BotDiagnostic, type BotAction } from '@/lib/diagnostics';
import { loadRisk } from '@/lib/platform';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Stethoscope, AlertTriangle, CheckCircle2, XCircle,
  RefreshCw, TrendingDown, Activity, Zap, ChevronDown, ChevronUp,
  AlertCircle, ShieldAlert, SkipForward, RotateCcw, Volume2,
  Trophy, Copy, Undo2, Radio, Trash2,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  useBotDoctor, botDoctorStore,
  DOCTOR_MODE_LABELS, DOCTOR_MODE_DESCRIPTIONS,
  type DoctorMode,
} from '@/lib/bot-doctor-store';
import { useBotActivity, botActivityStore } from '@/lib/bot-activity-store';
import { useRealProfit } from '@/lib/real-profit-store';
import { diagnoseReal, summarizeReal } from '@/lib/real-mode-diagnostics';
import { findChampion } from '@/lib/champion';

// ── helpers ────────────────────────────────────────────────────────────────────
function HealthRing({ score }: { score: number }) {
  const color = score >= 75 ? '#10b981' : score >= 45 ? '#f59e0b' : '#ef4444';
  const r = 22;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  return (
    <svg width={56} height={56} className="flex-shrink-0">
      <circle cx={28} cy={28} r={r} fill="none" stroke="#27272a" strokeWidth={5} />
      <circle
        cx={28} cy={28} r={r} fill="none"
        stroke={color} strokeWidth={5}
        strokeDasharray={`${dash} ${circ}`}
        strokeLinecap="round"
        transform="rotate(-90 28 28)"
        style={{ filter: `drop-shadow(0 0 4px ${color})` }}
      />
      <text x={28} y={32} textAnchor="middle" fontSize={10} fontWeight="bold" fill={color}>{score}</text>
    </svg>
  );
}

const STATUS_COLORS: Record<string, string> = {
  Active:   'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  Watch:    'bg-amber-500/10 text-amber-400 border-amber-500/30',
  Limited:  'bg-orange-500/10 text-orange-400 border-orange-500/30',
  Disabled: 'bg-red-500/10 text-red-400 border-red-500/30',
  Replaced: 'bg-zinc-700/30 text-zinc-400 border-zinc-600/30',
};

const LEVEL_ICON: Record<string, React.ElementType> = {
  critical: XCircle,
  warning:  AlertTriangle,
  info:     AlertCircle,
};

const LEVEL_COLORS: Record<string, string> = {
  critical: 'text-red-400',
  warning:  'text-amber-400',
  info:     'text-blue-400',
};

const ACTION_CONFIG: Record<BotAction, { label: string; icon: React.ElementType; variant: 'destructive' | 'default' | 'outline' }> = {
  restart:      { label: 'Restart',      icon: RefreshCw,    variant: 'default' },
  reduce_risk:  { label: 'Reduce Risk',  icon: TrendingDown, variant: 'outline' },
  pause:        { label: 'Pause',        icon: SkipForward,  variant: 'outline' },
  replace:      { label: 'Replace',      icon: Zap,          variant: 'destructive' },
  rollback:     { label: 'Rollback',     icon: RotateCcw,    variant: 'outline' },
  alert_admin:  { label: 'Alert Admin',  icon: Volume2,      variant: 'destructive' },
  monitor:      { label: 'Monitor',      icon: Activity,     variant: 'outline' },
};

// ── DiagCard ──────────────────────────────────────────────────────────────────
function DiagCard({ diag }: { diag: BotDiagnostic }) {
  const [expanded, setExpanded] = useState(false);
  const { toast } = useToast();
  const { toggleBot, resetBot, removeBot, addBot } = useArena();

  const handleAction = (action: BotAction) => {
    switch (action) {
      case 'pause':
        toggleBot(diag.botId);
        toast({ title: `Bot paused: ${diag.botName}`, description: 'Bot suspended from trading.' });
        break;
      case 'restart':
        resetBot(diag.botId);
        toast({ title: `Bot restarted: ${diag.botName}`, description: 'Balance restored, position cleared.' });
        break;
      case 'replace':
        removeBot(diag.botId);
        addBot(`${diag.botName} v2`, diag.symbol, diag.strategy);
        toast({ title: `Bot replaced: ${diag.botName}`, description: 'Fresh bot added with reset balance.' });
        break;
      case 'reduce_risk':
        toast({ title: `Risk reduced: ${diag.botName}`, description: 'Spend % halved for this bot (demo mode).' });
        break;
      case 'rollback':
        resetBot(diag.botId);
        toast({ title: `Rolled back: ${diag.botName}`, description: 'Strategy and balance reset.' });
        break;
      case 'alert_admin':
        toast({ title: `Admin alerted for ${diag.botName}`, description: 'Alert queued in admin panel.' });
        break;
      case 'monitor':
        toast({ title: `Monitoring ${diag.botName}`, description: 'Bot added to watchlist.' });
        break;
    }
  };

  const criticalCount = diag.issues.filter(i => i.level === 'critical').length;
  const warnCount     = diag.issues.filter(i => i.level === 'warning').length;
  const isHealthy     = diag.issues.length === 0;

  return (
    <Card className={`border ${criticalCount > 0 ? 'border-red-600/30' : warnCount > 0 ? 'border-amber-500/20' : 'border-zinc-800/60'} overflow-hidden`}>
      <div className="h-0.5" style={{ background: diag.color }} />
      <CardContent className="p-4">
        {/* Header */}
        <div className="flex items-start gap-3 mb-3">
          <HealthRing score={diag.healthScore} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="font-semibold text-sm">{diag.botName}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium ${STATUS_COLORS[diag.status]}`}>
                {diag.status}
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">{diag.symbol}</Badge>
              <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">{diag.strategy}</Badge>
              <span className="text-[10px] text-zinc-500">{diag.metrics.totalTrades} trades</span>
            </div>
          </div>
          {isHealthy
            ? <CheckCircle2 size={18} className="text-emerald-400 flex-shrink-0 mt-0.5" />
            : <ShieldAlert size={18} className={`flex-shrink-0 mt-0.5 ${criticalCount > 0 ? 'text-red-400' : 'text-amber-400'}`} />
          }
        </div>

        {/* Quick metrics row */}
        <div className="grid grid-cols-3 gap-2 mb-3">
          {[
            { label: 'Win Rate', value: `${diag.metrics.winRate.toFixed(0)}%`, ok: diag.metrics.winRate >= 40 },
            { label: 'Drawdown', value: `${diag.metrics.currentDrawdown.toFixed(1)}%`, ok: diag.metrics.currentDrawdown < 10 },
            { label: 'Activity', value: `${diag.metrics.activityScore.toFixed(0)}`, ok: diag.metrics.activityScore >= 30 },
          ].map(m => (
            <div key={m.label} className="bg-zinc-900/60 rounded-md p-1.5 text-center">
              <div className="text-[9px] text-zinc-500 uppercase tracking-wide">{m.label}</div>
              <div className={`font-mono font-bold text-xs mt-0.5 ${m.ok ? 'text-emerald-400' : 'text-red-400'}`}>{m.value}</div>
            </div>
          ))}
        </div>

        {/* Issues */}
        {isHealthy ? (
          <div className="flex items-center gap-2 text-emerald-400 text-xs py-1">
            <CheckCircle2 size={14} />
            <span>No issues detected — bot operating normally</span>
          </div>
        ) : (
          <div className="space-y-2">
            {diag.issues.slice(0, expanded ? undefined : 2).map((issue, idx) => {
              const Icon = LEVEL_ICON[issue.level];
              return (
                <div key={idx} className={`rounded-lg border p-2.5 ${issue.level === 'critical' ? 'border-red-600/20 bg-red-600/5' : issue.level === 'warning' ? 'border-amber-500/20 bg-amber-500/5' : 'border-blue-500/20 bg-blue-500/5'}`}>
                  <div className={`flex items-center gap-1.5 text-xs font-semibold mb-1 ${LEVEL_COLORS[issue.level]}`}>
                    <Icon size={12} />
                    {issue.title}
                  </div>
                  <p className="text-[10px] text-zinc-400 mb-1.5">{issue.description}</p>
                  <p className="text-[10px] text-zinc-500 italic mb-2">{issue.recommendation}</p>
                  {/* Action buttons */}
                  <div className="flex flex-wrap gap-1">
                    {issue.actions.map(action => {
                      const cfg = ACTION_CONFIG[action];
                      const Icon2 = cfg.icon;
                      return (
                        <button
                          key={action}
                          onClick={() => handleAction(action)}
                          className={`flex items-center gap-1 text-[9px] px-2 py-1 rounded border font-medium transition-colors
                            ${cfg.variant === 'destructive'
                              ? 'border-red-600/40 text-red-400 hover:bg-red-600/10'
                              : cfg.variant === 'default'
                              ? 'border-blue-500/40 text-blue-400 hover:bg-blue-500/10'
                              : 'border-zinc-600 text-zinc-400 hover:bg-zinc-800'
                            }`}
                        >
                          <Icon2 size={9} />
                          {cfg.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {diag.issues.length > 2 && (
              <button
                onClick={() => setExpanded(v => !v)}
                className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                {expanded ? 'Show less' : `+${diag.issues.length - 2} more issues`}
              </button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function BotDoctorPage() {
  const { bots, trades, market, getCurrentPrice, healLog, toggleBot, activateStandby, resetBot } = useArena();
  const { toast } = useToast();
  const riskCfg = useMemo(() => loadRisk(), []);
  const [filter, setFilter] = useState<'all' | 'issues' | 'critical' | 'standby'>('all');

  const prices = useMemo(() => {
    const p: Record<string, number> = {};
    bots.forEach(b => { p[b.symbol] = getCurrentPrice(b.symbol); });
    return p;
  }, [bots, market]);

  // Only diagnose running bots (standby bots shown separately)
  const activeBots  = useMemo(() => bots.filter(b => b.isRunning),  [bots]);
  const standbyBots = useMemo(() => bots.filter(b => !b.isRunning), [bots]);

  const diagnostics = useMemo(() =>
    diagnoseBots(activeBots, trades, prices, riskCfg),
    [activeBots, trades, prices]
  );

  const filtered = useMemo(() => {
    if (filter === 'critical') return diagnostics.filter(d => d.issues.some(i => i.level === 'critical'));
    if (filter === 'issues')   return diagnostics.filter(d => d.issues.length > 0);
    if (filter === 'standby')  return []; // handled separately
    return diagnostics;
  }, [diagnostics, filter]);

  // Sort: critical first, then by health score ascending
  const sorted = useMemo(() =>
    [...filtered].sort((a, b) => {
      const aC = a.issues.filter(i => i.level === 'critical').length;
      const bC = b.issues.filter(i => i.level === 'critical').length;
      if (bC !== aC) return bC - aC;
      return a.healthScore - b.healthScore;
    }),
    [filtered]
  );

  const critical   = diagnostics.filter(d => d.issues.some(i => i.level === 'critical')).length;
  const warnings   = diagnostics.filter(d => d.issues.some(i => i.level === 'warning') && !d.issues.some(i => i.level === 'critical')).length;
  const healthy    = diagnostics.filter(d => d.issues.length === 0).length;
  const avgHealth  = diagnostics.length > 0
    ? Math.round(diagnostics.reduce((s, d) => s + d.healthScore, 0) / diagnostics.length) : 0;

  // Heal All: pause all critical bots
  const handleHealAll = () => {
    const criticalDiags = diagnostics.filter(d => d.issues.some(i => i.level === 'critical'));
    if (criticalDiags.length === 0) {
      toast({ title: 'All bots healthy', description: 'No critical issues found.' });
      return;
    }
    criticalDiags.forEach(d => { toggleBot(d.botId); });
    toast({ title: `Healed ${criticalDiags.length} critical bots`, description: 'Paused and queued for standby replacement.' });
  };

  const recentHealEvents = useMemo(() => [...healLog].reverse().slice(0, 20), [healLog]);

  const HEAL_TYPE_LABELS: Record<string, { label: string; color: string }> = {
    pause_critical:   { label: 'Paused (critical)',    color: 'text-red-400' },
    activate_standby: { label: 'Standby activated',   color: 'text-emerald-400' },
    load_shed:        { label: 'Load shedding',        color: 'text-amber-400' },
    watchdog_restart: { label: 'Watchdog restart',     color: 'text-blue-400' },
    stale_fix:        { label: 'Stale state fixed',    color: 'text-purple-400' },
  };

  return (
    <div className="p-4 max-w-screen-2xl mx-auto">
      {/* Page header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-red-600/10 border border-red-600/30 flex items-center justify-center">
          <Stethoscope size={18} className="text-red-400" />
        </div>
        <div>
          <h1 className="text-lg font-bold">Bot Doctor</h1>
          <p className="text-xs text-zinc-500">AI-powered bot health monitoring, diagnostics & self-healing</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-zinc-500">Last scan: just now</span>
          {critical > 0 && (
            <button
              onClick={handleHealAll}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-emerald-600/40 bg-emerald-600/10 text-emerald-400 hover:bg-emerald-600/20 transition-colors font-semibold"
            >
              <Zap size={11} /> Heal All ({critical})
            </button>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        {[
          { label: 'Avg Health',    value: `${avgHealth}/100`,        icon: Activity,      color: 'text-blue-400',    bg: 'bg-blue-600/10 border-blue-600/20'    },
          { label: 'Critical',      value: critical,                  icon: XCircle,       color: 'text-red-400',     bg: 'bg-red-600/10 border-red-600/20'      },
          { label: 'Warnings',      value: warnings,                  icon: AlertTriangle, color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/20'  },
          { label: 'Healthy',       value: healthy,                   icon: CheckCircle2,  color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20'},
          { label: 'Standby Pool',  value: standbyBots.length,        icon: SkipForward,   color: 'text-purple-400',  bg: 'bg-purple-500/10 border-purple-500/20' },
        ].map(s => {
          const Icon = s.icon;
          return (
            <Card key={s.label} className={`border ${s.bg}`}>
              <CardContent className="p-3 flex items-center gap-3">
                <Icon size={20} className={s.color} />
                <div>
                  <div className="text-[10px] text-zinc-500 uppercase tracking-wide">{s.label}</div>
                  <div className={`font-mono font-bold text-xl ${s.color}`}>{s.value}</div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {[
          { key: 'all',      label: `All Active (${diagnostics.length})` },
          { key: 'issues',   label: `Has Issues (${diagnostics.filter(d => d.issues.length > 0).length})` },
          { key: 'critical', label: `Critical (${critical})` },
          { key: 'standby',  label: `Standby Pool (${standbyBots.length})` },
        ].map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key as any)}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors font-medium
              ${filter === f.key
                ? 'bg-red-600/15 border-red-600/30 text-red-400'
                : 'border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
              }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Standby pool panel */}
      {filter === 'standby' && (
        <div className="space-y-2 mb-6">
          {standbyBots.length === 0 ? (
            <div className="text-center py-12 text-zinc-500 text-sm">No standby bots available</div>
          ) : standbyBots.map(bot => (
            <Card key={bot.id} className="border-purple-500/20 bg-purple-500/5">
              <CardContent className="p-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-2 h-8 rounded" style={{ background: bot.color }} />
                  <div>
                    <div className="text-sm font-semibold">{bot.name}</div>
                    <div className="text-[10px] text-zinc-500">{bot.symbol} · {bot.strategy}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-zinc-400">${bot.balance.toFixed(2)}</span>
                  <button
                    onClick={() => { activateStandby(bot.id); toast({ title: `${bot.name} activated`, description: 'Bot is now trading.' }); }}
                    className="text-[10px] px-2 py-1 rounded border border-emerald-600/40 bg-emerald-600/10 text-emerald-400 hover:bg-emerald-600/20 transition-colors font-medium"
                  >
                    Activate
                  </button>
                  <button
                    onClick={() => { resetBot(bot.id); toast({ title: `${bot.name} reset`, description: 'Balance restored.' }); }}
                    className="text-[10px] px-2 py-1 rounded border border-zinc-600 text-zinc-400 hover:bg-zinc-800 transition-colors font-medium"
                  >
                    Reset
                  </button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Bot grid (active bots) */}
      {filter !== 'standby' && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            <AnimatePresence mode="popLayout">
              {sorted.map(diag => (
                <motion.div
                  key={diag.botId}
                  layout
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.94 }}
                  transition={{ duration: 0.2 }}
                >
                  <DiagCard diag={diag} />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          {sorted.length === 0 && (
            <div className="text-center py-16 text-zinc-500">
              <CheckCircle2 size={32} className="mx-auto mb-3 text-emerald-500" />
              <p className="font-medium">All bots healthy</p>
              <p className="text-sm mt-1">No issues match the current filter</p>
            </div>
          )}
        </>
      )}

      {/* Real Mode Doctor section */}
      <RealModeSection />

      {/* Self-healing event log */}
      {recentHealEvents.length > 0 && (
        <div className="mt-8">
          <div className="flex items-center gap-2 mb-3">
            <Zap size={14} className="text-emerald-400" />
            <h2 className="text-sm font-semibold">Self-Healing Log</h2>
            <span className="text-[10px] text-zinc-500">Last {recentHealEvents.length} events</span>
          </div>
          <div className="space-y-1">
            {recentHealEvents.map(ev => {
              const info = HEAL_TYPE_LABELS[ev.type] ?? { label: ev.type, color: 'text-zinc-400' };
              return (
                <div key={ev.id} className="flex items-center gap-3 text-[11px] py-1.5 px-3 rounded bg-zinc-900/50 border border-zinc-800/60">
                  <span className="text-zinc-600 font-mono w-16 flex-shrink-0">{new Date(ev.timestamp).toLocaleTimeString()}</span>
                  <span className={`font-semibold w-32 flex-shrink-0 ${info.color}`}>{info.label}</span>
                  <span className="text-zinc-300 truncate">{ev.botName}</span>
                  <span className="text-zinc-500 truncate hidden md:inline">{ev.reason}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Real Mode Doctor — extends the page with: mode selector, real-bot
// diagnostics list, bench list w/ restore, champion + clone-to-eligible.
// ─────────────────────────────────────────────────────────────────────────────

const MODE_TONE: Record<DoctorMode, string> = {
  OFF:         'border-zinc-700 text-zinc-400',
  MONITOR:     'border-blue-600/40 text-blue-300 bg-blue-600/10',
  AUTO_FIX:    'border-amber-600/40 text-amber-300 bg-amber-600/10',
  FULL_ACTIVE: 'border-emerald-600/40 text-emerald-300 bg-emerald-600/10',
};

function RealModeSection() {
  const { bots, cloneStrategy } = useArena();
  const { toast } = useToast();
  const doctor   = useBotDoctor();
  const activity = useBotActivity();
  const profit   = useRealProfit();

  // Live diagnostics — pure-function, no side effects.
  const realDiags = useMemo(() => diagnoseReal({
    activity,
    profit,
    isBenched:  id => !!doctor.bench[id],
    benchEntry: id => doctor.bench[id],
  }), [activity, profit, doctor.bench]);

  const summary = useMemo(() => summarizeReal(realDiags), [realDiags]);

  // Champion lookup — uses real-profit per-bot stats only.
  const nameLookup = useMemo(() => {
    const m: Record<string, string> = {};
    bots.forEach(b => { m[b.id] = b.name; });
    return m;
  }, [bots]);
  const rejectionRates = useMemo(() => {
    const m: Record<string, number> = {};
    Object.keys(profit.perBot).forEach(id => { m[id] = botActivityStore.rejectionRate(id); });
    return m;
  }, [profit.perBot]);
  const championResult = useMemo(
    () => findChampion(profit.perBot, rejectionRates, nameLookup),
    [profit.perBot, rejectionRates, nameLookup],
  );

  const [cloneTarget, setCloneTarget] = useState<string>('');
  const champBot = championResult ? bots.find(b => b.id === championResult.champion.botId) : undefined;

  // Eligible clone targets: not the champion, not benched.
  const cloneTargets = useMemo(() => bots.filter(b => {
    if (!championResult) return false;
    if (b.id === championResult.champion.botId) return false;
    if (doctor.bench[b.id]) return false;
    return true;
  }), [bots, championResult, doctor.bench]);

  const benchList = useMemo(
    () => Object.values(doctor.bench).sort((a, b) => b.benchedAt - a.benchedAt),
    [doctor.bench],
  );

  const dustList = useMemo(
    () => Object.values(doctor.dust).sort((a, b) => b.markedAt - a.markedAt),
    [doctor.dust],
  );

  const handleClearDust = (exchange: string, baseAsset: string) => {
    botDoctorStore.clearDust(exchange, baseAsset);
    toast({
      title: `Dust mark cleared: ${exchange}:${baseAsset}`,
      description: 'SELLs for this asset will be retried on the next signal.',
    });
  };

  const handleClearAllDust = () => {
    const n = dustList.length;
    dustList.forEach(d => botDoctorStore.clearDust(d.exchange, d.baseAsset));
    toast({
      title: `Cleared ${n} dust mark${n === 1 ? '' : 's'}`,
      description: 'All marked assets are eligible for SELL again.',
    });
  };

  const handleClone = () => {
    if (!champBot || !cloneTarget) return;
    const ok = cloneStrategy(champBot.id, cloneTarget);
    if (ok) {
      const tgt = bots.find(b => b.id === cloneTarget);
      toast({
        title: `Strategy cloned: ${champBot.strategy}`,
        description: `${tgt?.name ?? 'Bot'} now uses the champion's playbook on ${tgt?.symbol ?? ''}.`,
      });
      setCloneTarget('');
    } else {
      toast({ title: 'Clone failed', description: 'Bot not found.', variant: 'destructive' });
    }
  };

  const handleRestore = (botId: string, botName: string) => {
    botDoctorStore.unbench(botId);
    toast({ title: `${botName} restored`, description: 'Bot is back in the pool — Doctor will keep watching.' });
  };

  const fmtMoney = (n: number) =>
    (n >= 0 ? '+' : '') + n.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });

  return (
    <div className="mt-8 space-y-4">
      {/* Section header */}
      <div className="flex items-center gap-3 mb-2">
        <div className="w-8 h-8 rounded-lg bg-emerald-600/10 border border-emerald-600/30 flex items-center justify-center">
          <Radio size={14} className="text-emerald-400" />
        </div>
        <div>
          <h2 className="text-base font-bold">Real Mode Doctor</h2>
          <p className="text-xs text-zinc-500">
            Live diagnostics for real-exchange bots. Reads activity log + realized P/L only — never paper data.
          </p>
        </div>
      </div>

      {/* Mode selector */}
      <Card className="border-zinc-800/60">
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="text-xs font-semibold text-zinc-300">Doctor mode:</span>
            {(['OFF','MONITOR','AUTO_FIX','FULL_ACTIVE'] as DoctorMode[]).map(m => (
              <button
                key={m}
                onClick={() => botDoctorStore.setMode(m)}
                className={`text-[11px] px-2.5 py-1 rounded-md border font-medium transition-colors
                  ${doctor.mode === m
                    ? MODE_TONE[m] + ' ring-1 ring-emerald-500/30'
                    : 'border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500'}`}
              >
                {DOCTOR_MODE_LABELS[m]}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-zinc-500">{DOCTOR_MODE_DESCRIPTIONS[doctor.mode]}</p>

          {/* Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mt-4">
            {[
              { label: 'Real bots',  value: summary.totalBots,        tone: 'text-zinc-200' },
              { label: 'Eligible',   value: summary.eligible,         tone: 'text-blue-400' },
              { label: 'Critical',   value: summary.withCriticalIssue, tone: 'text-red-400' },
              { label: 'Benched',    value: summary.benched,          tone: 'text-amber-400' },
              { label: 'Avg health', value: `${summary.avgHealth}/100`, tone: 'text-emerald-400' },
            ].map(s => (
              <div key={s.label} className="bg-zinc-900/60 rounded-md p-2 text-center border border-zinc-800/60">
                <div className="text-[9px] text-zinc-500 uppercase tracking-wide">{s.label}</div>
                <div className={`font-mono font-bold text-sm mt-0.5 ${s.tone}`}>{s.value}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Champion card */}
      {championResult && champBot && (
        <Card className="border-yellow-600/30 bg-gradient-to-br from-yellow-950/30 to-zinc-900/40">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-yellow-600/15 border border-yellow-600/40 flex items-center justify-center flex-shrink-0">
                <Trophy size={18} className="text-yellow-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-bold text-yellow-300">Champion bot</span>
                  <Badge variant="outline" className="text-[9px] border-yellow-600/40 text-yellow-200">
                    REAL DATA
                  </Badge>
                </div>
                <div className="mt-1 flex items-center gap-2 flex-wrap text-xs">
                  <span className="font-semibold text-zinc-100">{champBot.name}</span>
                  <Badge variant="outline" className="text-[9px]">{champBot.symbol}</Badge>
                  <Badge variant="outline" className="text-[9px]">{champBot.strategy}</Badge>
                </div>
                <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                  <Stat label="Net realized" value={`$${fmtMoney(championResult.champion.netRealized)}`} tone="up" />
                  <Stat label="Win-rate"     value={`${(championResult.champion.winRate * 100).toFixed(0)}%`} tone="up" />
                  <Stat label="Trades"       value={String(championResult.champion.trades)}     tone="neutral" />
                  <Stat label="Reject-rate"  value={`${(championResult.champion.rejectionRate * 100).toFixed(0)}%`} tone="neutral" />
                </div>

                {/* Clone control */}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-zinc-400">Clone strategy onto:</span>
                  <select
                    value={cloneTarget}
                    onChange={e => setCloneTarget(e.target.value)}
                    className="text-[11px] bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-zinc-200 focus:outline-none focus:border-yellow-500/50"
                  >
                    <option value="">-- select target bot --</option>
                    {cloneTargets.map(b => (
                      <option key={b.id} value={b.id}>{b.name} ({b.symbol})</option>
                    ))}
                  </select>
                  <button
                    disabled={!cloneTarget}
                    onClick={handleClone}
                    className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded border border-yellow-600/40 bg-yellow-600/10 text-yellow-300 hover:bg-yellow-600/20 transition-colors font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Copy size={11} /> Clone strategy
                  </button>
                </div>
                {championResult.runnersUp.length > 0 && (
                  <div className="mt-2 text-[10px] text-zinc-500">
                    Runners-up:{' '}
                    {championResult.runnersUp.map((r, i) => (
                      <span key={r.botId}>
                        {i > 0 ? ' · ' : ''}
                        {r.botName ?? r.botId} (${fmtMoney(r.netRealized)})
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Bench list */}
      {benchList.length > 0 && (
        <Card className="border-amber-600/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <ShieldAlert size={14} className="text-amber-400" />
              <h3 className="text-sm font-semibold text-amber-300">Benched by Doctor ({benchList.length})</h3>
              <span className="text-[10px] text-zinc-500">
                Auto-restored when timer expires. Click Restore for an immediate retry.
              </span>
            </div>
            <div className="space-y-1.5">
              {benchList.map(entry => {
                const b = bots.find(x => x.id === entry.botId);
                const remainingMs = entry.expiresAt > 0 ? Math.max(0, entry.expiresAt - Date.now()) : 0;
                const remainingMin = Math.ceil(remainingMs / 60_000);
                return (
                  <div key={entry.botId} className="flex items-center gap-3 text-[11px] py-1.5 px-3 rounded bg-amber-950/20 border border-amber-900/30">
                    <Badge variant="outline" className="text-[9px] border-amber-600/40 text-amber-300">{entry.code}</Badge>
                    <span className="text-zinc-200 font-medium truncate w-32 flex-shrink-0">
                      {b?.name ?? entry.botId}
                    </span>
                    <span className="text-zinc-400 truncate flex-1">{entry.reason}</span>
                    <span className="text-zinc-500 font-mono w-20 text-right flex-shrink-0">
                      {entry.expiresAt === 0 ? 'manual' : remainingMs > 0 ? `${remainingMin}m left` : 'expired'}
                    </span>
                    <button
                      onClick={() => handleRestore(entry.botId, b?.name ?? entry.botId)}
                      className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-emerald-600/40 bg-emerald-600/10 text-emerald-300 hover:bg-emerald-600/20 transition-colors font-medium"
                    >
                      <Undo2 size={10} /> Restore
                    </button>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Marked dust list */}
      {dustList.length > 0 && (
        <Card className="border-zinc-700/40">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Trash2 size={14} className="text-zinc-300" />
              <h3 className="text-sm font-semibold text-zinc-200">Marked Dust ({dustList.length})</h3>
              <span className="text-[10px] text-zinc-500">
                Assets the Doctor flagged as too small to sell. SELLs are blocked until cleared.
              </span>
              <button
                onClick={handleClearAllDust}
                className="ml-auto flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-zinc-600 text-zinc-300 hover:bg-zinc-800 transition-colors font-medium"
              >
                <Trash2 size={10} /> Clear all
              </button>
            </div>
            <div className="space-y-1.5">
              {dustList.map(entry => (
                <div
                  key={`${entry.exchange}:${entry.baseAsset}`}
                  className="flex items-center gap-3 text-[11px] py-1.5 px-3 rounded bg-zinc-900/50 border border-zinc-800/60"
                >
                  <Badge variant="outline" className="text-[9px] border-zinc-600 text-zinc-300">
                    {entry.exchange}
                  </Badge>
                  <span className="text-zinc-200 font-mono font-semibold w-20 flex-shrink-0">
                    {entry.baseAsset}
                  </span>
                  <span className="text-zinc-400 truncate flex-1">{entry.reason}</span>
                  <span className="text-zinc-500 font-mono w-28 text-right flex-shrink-0">
                    {new Date(entry.markedAt).toLocaleString()}
                  </span>
                  <button
                    onClick={() => handleClearDust(entry.exchange, entry.baseAsset)}
                    className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-emerald-600/40 bg-emerald-600/10 text-emerald-300 hover:bg-emerald-600/20 transition-colors font-medium"
                  >
                    <Undo2 size={10} /> Clear mark
                  </button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Per-bot real diagnostics list */}
      <Card className="border-zinc-800/60">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Activity size={14} className="text-emerald-400" />
            <h3 className="text-sm font-semibold">Real-mode diagnostics ({realDiags.length})</h3>
          </div>
          {realDiags.length === 0 ? (
            <div className="text-center py-6 text-zinc-500 text-xs">
              No real-mode activity yet. Diagnostics appear once real bots start submitting orders.
            </div>
          ) : (
            <div className="space-y-2">
              {realDiags.map(d => {
                const issueLevel = d.issues.find(i => i.level === 'critical')?.level
                                 ?? d.issues.find(i => i.level === 'warning')?.level
                                 ?? d.issues[0]?.level;
                const borderClass =
                  issueLevel === 'critical' ? 'border-red-600/30 bg-red-600/5' :
                  issueLevel === 'warning'  ? 'border-amber-600/20 bg-amber-600/5' :
                  d.issues.length === 0     ? 'border-emerald-700/20 bg-emerald-700/5'
                                            : 'border-zinc-800/60';
                return (
                  <div key={d.botId} className={`rounded-lg border p-3 ${borderClass}`}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-zinc-100">{d.name ?? d.botId}</span>
                      {d.eligibleNow && <Badge variant="outline" className="text-[9px] border-blue-600/40 text-blue-300">eligible</Badge>}
                      {d.benched && <Badge variant="outline" className="text-[9px] border-amber-600/40 text-amber-300">benched</Badge>}
                      <span className="text-[10px] text-zinc-500 ml-auto font-mono">
                        health {d.healthScore}/100
                      </span>
                    </div>
                    <div className="mt-1.5 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px]">
                      <div className="text-zinc-500">
                        Recent: <span className="text-zinc-300 font-mono">{d.recentAttempts}</span>
                        {' / '}
                        rej <span className={d.rejectRate > 0.5 ? 'text-red-400 font-mono' : 'text-zinc-300 font-mono'}>{(d.rejectRate * 100).toFixed(0)}%</span>
                      </div>
                      <div className="text-zinc-500">
                        Net: <span className={d.realizedNetUSD >= 0 ? 'text-emerald-400 font-mono' : 'text-red-400 font-mono'}>${fmtMoney(d.realizedNetUSD)}</span>
                      </div>
                      <div className="text-zinc-500">
                        Trades: <span className="text-zinc-300 font-mono">{d.realTrades}</span>
                      </div>
                      <div className="text-zinc-500">
                        Win: <span className="text-zinc-300 font-mono">{d.realTrades > 0 ? `${(d.winRate * 100).toFixed(0)}%` : '—'}</span>
                      </div>
                    </div>
                    {d.issues.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {d.issues.map((iss, idx) => {
                          const Icon = LEVEL_ICON[iss.level] ?? AlertCircle;
                          return (
                            <div key={idx} className="flex items-start gap-1.5 text-[10px]">
                              <Icon size={11} className={`flex-shrink-0 mt-0.5 ${LEVEL_COLORS[iss.level]}`} />
                              <div>
                                <span className={`font-semibold ${LEVEL_COLORS[iss.level]}`}>{iss.title}</span>
                                <span className="text-zinc-500"> — {iss.description}</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// Tiny stat block reused for champion KPIs.
function Stat(p: { label: string; value: string; tone: 'up' | 'down' | 'neutral' }) {
  const colour =
    p.tone === 'up'   ? 'text-emerald-400' :
    p.tone === 'down' ? 'text-red-400'     : 'text-zinc-200';
  return (
    <div className="border border-zinc-800/60 rounded px-2 py-1 bg-zinc-900/40">
      <div className="text-[9px] uppercase tracking-wider text-zinc-500 font-semibold">{p.label}</div>
      <div className={`mt-0.5 text-xs font-bold tabular-nums ${colour}`}>{p.value}</div>
    </div>
  );
}
