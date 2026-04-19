
import { useState, useEffect, useRef } from 'react';
import { useArena } from '@/hooks/use-arena';
import { loadAlerts, type AlertRecord } from '@/lib/platform';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Activity, CheckCircle2, AlertTriangle, XCircle, Server,
  Shield, Cpu, BarChart3, Clock, Zap, Info, ShieldAlert,
} from 'lucide-react';

function timeSince(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)  return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

const SYSTEM_VERSION = '2.1.0';
const BUILD_DATE     = 'April 2026';

interface ComponentStatus {
  name:    string;
  icon:    React.ElementType;
  status:  'operational' | 'degraded' | 'down';
  latency: number | null;
  detail:  string;
}

export default function StatusPage() {
  const { bots, trades, isGlobalRunning, tickCount } = useArena();
  const [alerts,   setAlerts]   = useState<AlertRecord[]>([]);
  const [uptime,   setUptime]   = useState(0);
  const startRef               = useRef(Date.now());

  useEffect(() => {
    setAlerts(loadAlerts().slice(-50).reverse());
    const id = setInterval(() => {
      setUptime(Math.floor((Date.now() - startRef.current) / 1000));
      setAlerts(loadAlerts().slice(-50).reverse());
    }, 3000);
    return () => clearInterval(id);
  }, []);

  const activeBots   = bots.filter(b => b.isRunning).length;
  const totalTrades  = trades.length;
  const avgPnl       = bots.reduce((s, b) => s + b.balance - b.startingBalance, 0);

  const criticalAlerts = alerts.filter(a => a.level === 'critical' && !a.dismissed).length;
  const warnAlerts     = alerts.filter(a => a.level === 'warn'     && !a.dismissed).length;

  const components: ComponentStatus[] = [
    {
      name:    'Decision Engine',
      icon:    Cpu,
      status:  isGlobalRunning ? 'operational' : 'degraded',
      latency: 5,
      detail:  isGlobalRunning ? `Running · Tick #${tickCount}` : 'Paused',
    },
    {
      name:    'Bot Fleet',
      icon:    Activity,
      status:  activeBots > 0 ? 'operational' : 'degraded',
      latency: null,
      detail:  `${activeBots} active / ${bots.length} total`,
    },
    {
      name:    'Trade Engine',
      icon:    BarChart3,
      status:  'operational',
      latency: null,
      detail:  `${totalTrades} trades processed`,
    },
    {
      name:    'Risk Monitor',
      icon:    Shield,
      status:  criticalAlerts > 0 ? 'degraded' : 'operational',
      latency: null,
      detail:  criticalAlerts > 0 ? `${criticalAlerts} critical alert(s)` : 'All clear',
    },
    {
      name:    'Data Feed',
      icon:    Zap,
      status:  'operational',
      latency: 12,
      detail:  'Simulated market prices',
    },
    {
      name:    'Exchange API',
      icon:    Server,
      status:  'degraded',
      latency: null,
      detail:  'Demo mode — no live connection',
    },
  ];

  const overallStatus =
    components.some(c => c.status === 'down')      ? 'down'
    : components.some(c => c.status === 'degraded') ? 'degraded'
    : 'operational';

  const statusCfg = {
    operational: { label: 'All Systems Operational', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/30', icon: CheckCircle2 },
    degraded:    { label: 'Partial Degradation',      color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/30',     icon: AlertTriangle },
    down:        { label: 'Service Disruption',        color: 'text-red-400',     bg: 'bg-red-500/10 border-red-500/30',         icon: XCircle       },
  }[overallStatus];

  const StatusIcon = statusCfg.icon;

  const fmtUptime = (s: number) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return [h, m, ss].map(v => String(v).padStart(2, '0')).join(':');
  };

  return (
    <div className="p-4 max-w-3xl mx-auto">

      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-blue-600/10 border border-blue-600/30 flex items-center justify-center">
          <Activity size={18} className="text-blue-400" />
        </div>
        <div>
          <h1 className="text-lg font-bold">System Status</h1>
          <p className="text-xs text-zinc-500">Transparency · Trust · Full visibility</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Clock size={11} className="text-zinc-600" />
          <span className="text-xs font-mono text-zinc-500">Session: {fmtUptime(uptime)}</span>
        </div>
      </div>

      {/* Overall status banner */}
      <div className={`mb-6 px-4 py-3 rounded-xl border flex items-center gap-3 ${statusCfg.bg}`}>
        <StatusIcon size={18} className={statusCfg.color} />
        <div>
          <div className={`font-bold text-sm ${statusCfg.color}`}>{statusCfg.label}</div>
          <div className="text-[10px] text-zinc-500">
            v{SYSTEM_VERSION} · {BUILD_DATE} · Paper trading mode · No real funds
          </div>
        </div>
        <div className="ml-auto text-right">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wide">Updated</div>
          <div className="text-xs font-mono text-zinc-400">{new Date().toLocaleTimeString()}</div>
        </div>
      </div>

      {/* Component grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
        {components.map(c => {
          const Icon = c.icon;
          const cfg  = {
            operational: { dot: 'bg-emerald-400', label: 'Operational', text: 'text-emerald-400' },
            degraded:    { dot: 'bg-amber-400 animate-pulse', label: 'Degraded', text: 'text-amber-400' },
            down:        { dot: 'bg-red-500 animate-pulse',   label: 'Down',     text: 'text-red-400' },
          }[c.status];
          return (
            <Card key={c.name} className="border-zinc-800/60 bg-zinc-900/40">
              <CardContent className="p-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <Icon size={13} className="text-zinc-500" />
                  <span className="text-xs font-semibold text-zinc-300">{c.name}</span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <div className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                    <span className={`text-[10px] font-medium ${cfg.text}`}>{cfg.label}</span>
                  </div>
                </div>
                <div className="text-[11px] text-zinc-500">{c.detail}</div>
                {c.latency !== null && (
                  <div className="text-[10px] text-zinc-600 mt-0.5">Latency: {c.latency}ms</div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        {[
          { label: 'Active Bots',   value: activeBots.toLocaleString(),           color: 'text-blue-400'  },
          { label: 'Total Trades',  value: totalTrades.toLocaleString(),           color: 'text-purple-400' },
          { label: 'Portfolio P&L', value: `${avgPnl >= 0 ? '+' : ''}$${Math.abs(avgPnl).toFixed(0)}`, color: avgPnl >= 0 ? 'text-emerald-400' : 'text-red-400' },
          { label: 'Engine Tick',   value: `#${tickCount.toLocaleString()}`,       color: 'text-zinc-300'  },
        ].map(s => (
          <Card key={s.label} className="border-zinc-800/60 bg-zinc-900/40">
            <CardContent className="p-3">
              <div className="text-[9px] text-zinc-600 uppercase tracking-wide mb-0.5">{s.label}</div>
              <div className={`font-mono font-bold text-base ${s.color}`}>{s.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Activity log */}
      <Card className="border-zinc-800/60 mb-6">
        <CardHeader className="py-3 px-4 flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Activity Log</CardTitle>
          <div className="flex items-center gap-2 text-[10px]">
            {criticalAlerts > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/30 font-bold">
                {criticalAlerts} critical
              </span>
            )}
            {warnAlerts > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30 font-bold">
                {warnAlerts} warn
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0 max-h-64 overflow-y-auto">
          {alerts.length === 0 ? (
            <div className="py-10 text-center text-zinc-600 text-sm">No activity logged yet</div>
          ) : alerts.map(a => {
            const Icon = a.level === 'critical' ? XCircle : a.level === 'warn' ? AlertTriangle : Info;
            const col  = a.level === 'critical' ? 'text-red-400' : a.level === 'warn' ? 'text-amber-400' : 'text-blue-400';
            return (
              <div key={a.id} className="flex items-start gap-3 px-4 py-2.5 border-b border-zinc-800/40 last:border-0 hover:bg-zinc-900/50 transition-colors">
                <Icon size={12} className={`${col} flex-shrink-0 mt-0.5`} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-zinc-300 truncate">{a.message}</div>
                  <div className="text-[10px] text-zinc-600">{a.source} · {timeSince(a.timestamp)}</div>
                </div>
                <span className={`text-[9px] font-bold uppercase ${col}`}>{a.level}</span>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Trust / Disclaimer */}
      <Card className="border-amber-600/20 bg-amber-500/5">
        <CardHeader className="py-3 px-4">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldAlert size={13} className="text-amber-400" /> Risk & Transparency Notice
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 space-y-2 text-[11px] text-zinc-400 leading-relaxed">
          <p>
            <strong className="text-zinc-300">SignalX AutoPilot</strong> is a <strong className="text-amber-400">paper trading simulator</strong>.
            All trades executed are with virtual funds only. No real money is at risk at any time.
          </p>
          <p>
            Bot performance results shown are simulated based on algorithmic strategies applied to live market price feeds.
            Simulated performance does not guarantee or predict future real market performance.
          </p>
          <p>
            <strong className="text-zinc-300">No financial advice is provided.</strong> This platform is for educational
            and research purposes only. Always do your own research (DYOR) before making any real investment decisions.
          </p>
          <p>
            Crypto trading involves substantial risk of loss. Never invest more than you can afford to lose.
          </p>
          <div className="pt-2 border-t border-zinc-800/60 text-zinc-600">
            SignalX v{SYSTEM_VERSION} · {BUILD_DATE} · All data is local-only · No server connection required
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
