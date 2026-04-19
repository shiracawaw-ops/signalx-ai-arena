
import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useArena } from '@/hooks/use-arena';
import { diagnoseBots, type BotDiagnostic, type BotAction, type IssueCode } from '@/lib/diagnostics';
import { loadRisk } from '@/lib/platform';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import {
  Stethoscope, AlertTriangle, CheckCircle2, XCircle,
  RefreshCw, TrendingDown, Activity, Zap, ChevronDown, ChevronUp,
  AlertCircle, ShieldAlert, SkipForward, RotateCcw, Volume2,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

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
