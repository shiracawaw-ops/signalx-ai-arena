
import { useState, useMemo, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useArena } from '@/hooks/use-arena';
import { getBotTotalValue, getBotPnL } from '@/lib/engine';
import { loadRisk, saveRisk, loadUser, DEFAULT_RISK, addAlert, loadAlerts, type RiskConfig } from '@/lib/platform';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import {
  Settings, Shield, Users, Activity, Zap, AlertTriangle,
  RefreshCw, StopCircle, BarChart2, Bell, CheckCircle2, XCircle,
  TrendingUp, Database, Bot, DollarSign, ChevronDown,
} from 'lucide-react';

function fmt(n: number, dec = 2) {
  return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

const BOT_COUNT_PRESETS  = [10, 25, 50, 100, 200, 500];
const BALANCE_PRESETS = [1, 10, 100, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 1_000_000];

function fmtBalance(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n}`;
}

export default function AdminPage() {
  const {
    bots, trades, market, getCurrentPrice,
    resetAll, start, stop, isGlobalRunning,
    botCount, demoBalance, setBotCount, setDemoBalance, tickCount, healLog,
  } = useArena();

  const [risk, setRisk]         = useState<RiskConfig>(() => loadRisk());
  const [section, setSection]   = useState<'overview' | 'bots' | 'risk' | 'alerts' | 'system'>('overview');
  const [balanceInput, setBalanceInput] = useState(String(demoBalance));
  const { toast } = useToast();

  const user   = useMemo(() => loadUser(), []);
  // Load alerts lazily — refresh every 3s when the alerts tab is open, not every tick
  const [alertsData, setAlertsData] = useState(() => loadAlerts().slice(-20).reverse());
  useEffect(() => {
    if (section !== 'alerts') return;
    setAlertsData(loadAlerts().slice(-20).reverse());
    const id = setInterval(() => setAlertsData(loadAlerts().slice(-20).reverse()), 3000);
    return () => clearInterval(id);
  }, [section]);

  const saveRiskCfg = () => {
    saveRisk(risk);
    addAlert('info', 'Risk configuration updated by admin', 'Admin Panel');
    toast({ title: 'Risk config saved', description: 'New limits will apply to all bots.' });
  };

  const handleEmergencyStop = () => {
    stop();
    addAlert('critical', 'EMERGENCY STOP triggered by admin', 'Admin Panel');
    toast({ title: '🛑 Emergency Stop Activated', description: 'All bot trading halted.', variant: 'destructive' });
  };

  const handleResetArena = () => {
    resetAll();
    toast({ title: '♻ Arena Reset', description: `${botCount} bots re-seeded with ${fmtBalance(demoBalance)} each.` });
  };

  const handleSetBotCount = (n: number) => {
    setBotCount(n);
    toast({ title: `Bot count changed to ${n}`, description: 'Engine restarted. Please wait for warm-up.' });
  };

  const handleSetBalance = (n: number) => {
    setDemoBalance(n);
    setBalanceInput(String(n));
    toast({ title: `Demo balance set to ${fmtBalance(n)}`, description: 'Takes effect on next Reset.' });
  };

  const handleCustomBalance = () => {
    const v = parseFloat(balanceInput.replace(/[^0-9.]/g, ''));
    if (!isNaN(v) && v >= 1 && v <= 1_000_000) {
      handleSetBalance(v);
    } else {
      toast({ title: 'Invalid balance', description: 'Must be between $1 and $1,000,000', variant: 'destructive' });
    }
  };

  const totalValue     = bots.reduce((s, b) => s + getBotTotalValue(b, getCurrentPrice(b.symbol)), 0);
  const totalPnl       = bots.reduce((s, b) => s + getBotPnL(b, getCurrentPrice(b.symbol)), 0);
  const activeBots     = bots.filter(b => b.isRunning).length;
  const pausedBots     = bots.filter(b => !b.isRunning).length;
  const totalTrades    = trades.length;
  const sellTrades     = trades.filter(t => t.type === 'SELL');
  const winTrades      = sellTrades.filter(t => t.pnl > 0).length;
  const overallWinRate = sellTrades.length > 0 ? (winTrades / sellTrades.length) * 100 : 0;

  const SECTIONS = [
    { key: 'overview', label: 'Overview',  icon: BarChart2 },
    { key: 'bots',     label: 'Bot Config',icon: Bot       },
    { key: 'risk',     label: 'Risk',      icon: Shield    },
    { key: 'alerts',   label: 'Alerts',    icon: Bell      },
    { key: 'system',   label: 'System',    icon: Settings  },
  ] as const;

  return (
    <div className="p-4 max-w-screen-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-purple-600/10 border border-purple-600/30 flex items-center justify-center">
          <Settings size={18} className="text-purple-400" />
        </div>
        <div>
          <h1 className="text-lg font-bold">Admin Dashboard</h1>
          <p className="text-xs text-zinc-500">Platform control · <span className="text-purple-400">{user.name}</span> · tick #{tickCount.toLocaleString()}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleResetArena} className="flex items-center gap-1.5 text-xs border-amber-600/40 text-amber-400 hover:bg-amber-600/10">
            <RefreshCw size={12} /> Reset All
          </Button>
          {isGlobalRunning
            ? <Button variant="destructive" size="sm" onClick={handleEmergencyStop} className="flex items-center gap-1.5">
                <StopCircle size={14} /> Stop
              </Button>
            : <Button size="sm" onClick={start} className="flex items-center gap-1.5">
                <Zap size={14} /> Resume
              </Button>
          }
        </div>
      </div>

      {/* Section tabs */}
      <div className="flex items-center gap-2 mb-6 border-b border-zinc-800/60 pb-3 overflow-x-auto">
        {SECTIONS.map(s => {
          const Icon = s.icon;
          const active = section === s.key;
          return (
            <button key={s.key} onClick={() => setSection(s.key)}
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors font-medium whitespace-nowrap
                ${active ? 'bg-purple-600/15 border border-purple-600/30 text-purple-400' : 'text-zinc-400 hover:text-zinc-200'}`}>
              <Icon size={13} />
              {s.label}
            </button>
          );
        })}
      </div>

      {/* ── Overview ── */}
      {section === 'overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Total Platform Value', value: `$${fmt(totalValue)}`,                                          icon: Database,    color: 'text-blue-400',    bg: 'bg-blue-600/10 border-blue-600/20' },
              { label: 'Platform P&L',          value: `${totalPnl >= 0 ? '+' : ''}$${fmt(totalPnl)}`,               icon: TrendingUp,  color: totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400', bg: 'bg-zinc-900 border-zinc-800' },
              { label: 'Active / Paused',        value: `${activeBots} / ${pausedBots}`,                              icon: Activity,    color: 'text-purple-400',  bg: 'bg-purple-600/10 border-purple-600/20' },
              { label: 'Overall Win Rate',       value: `${fmt(overallWinRate, 0)}%`,                                 icon: BarChart2,   color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/20' },
            ].map(s => {
              const Icon = s.icon;
              return (
                <Card key={s.label} className={`border ${s.bg}`}>
                  <CardContent className="p-3 flex items-center gap-3">
                    <Icon size={18} className={s.color} />
                    <div>
                      <div className="text-[10px] text-zinc-500 uppercase tracking-wide">{s.label}</div>
                      <div className={`font-mono font-bold text-lg ${s.color}`}>{s.value}</div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Live stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Bot Count',      value: `${bots.length}`,             color: 'text-zinc-200' },
              { label: 'Demo Balance',   value: fmtBalance(demoBalance),       color: 'text-emerald-400' },
              { label: 'Total Trades',   value: totalTrades.toLocaleString(),  color: 'text-blue-400' },
              { label: 'Tick Rate',      value: bots.length > 100 ? '1.2s' : '0.8s', color: 'text-zinc-400' },
            ].map(s => (
              <Card key={s.label} className="border-zinc-800/60 bg-zinc-900/40">
                <CardContent className="p-3">
                  <div className="text-[10px] text-zinc-500 uppercase tracking-wide mb-1">{s.label}</div>
                  <div className={`font-mono font-bold text-lg ${s.color}`}>{s.value}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Platform status */}
          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4"><CardTitle className="text-sm">Platform Status</CardTitle></CardHeader>
            <CardContent className="p-4 space-y-3">
              {[
                { label: 'Trading Engine',   ok: isGlobalRunning,  note: isGlobalRunning ? `Running — ${bots.length > 100 ? '1.2s' : '0.8s'} tick` : 'Paused' },
                { label: 'Market Data Feed', ok: true,             note: '38 symbols · Mock data' },
                { label: 'Risk Engine',      ok: !risk.safeMode,   note: risk.safeMode ? 'Safe mode ON' : 'Normal mode' },
                { label: 'Exchange Adapter', ok: true,             note: 'Demo mode (Binance Mock)' },
                { label: 'Wallet Service',   ok: true,             note: `Virtual — ${fmtBalance(demoBalance)} per bot` },
                { label: 'Bot Diagnostics',  ok: true,             note: `Monitoring ${bots.length} bots` },
              ].map(item => (
                <div key={item.label} className="flex items-center gap-3">
                  {item.ok ? <CheckCircle2 size={14} className="text-emerald-400" /> : <XCircle size={14} className="text-amber-400" />}
                  <span className="text-sm flex-1">{item.label}</span>
                  <span className="text-xs text-zinc-500">{item.note}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Bot Config ── */}
      {section === 'bots' && (
        <div className="space-y-5">

          {/* Bot count */}
          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <Bot size={14} className="text-purple-400" /> Bot Count
                <Badge variant="outline" className="ml-2 font-mono text-purple-400 border-purple-500/30">
                  Currently: {bots.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              <p className="text-xs text-zinc-500">
                Select how many bots run in the arena. Changing this will re-seed all bots and reset all data.
                Larger counts use a 1.2s tick interval instead of 0.8s for stability.
              </p>
              <div className="flex flex-wrap gap-2">
                {BOT_COUNT_PRESETS.map(n => (
                  <button
                    key={n}
                    onClick={() => handleSetBotCount(n)}
                    className={`px-4 py-2 rounded-lg text-sm font-bold border transition-all ${
                      botCount === n
                        ? 'bg-purple-600/20 border-purple-500/50 text-purple-300'
                        : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <div className="text-xs text-zinc-500 bg-zinc-900 border border-zinc-800 rounded-lg p-3">
                ⚠ Changing bot count will <strong className="text-zinc-300">re-seed the arena</strong> and reset all P&L, trades, and rankings.
              </div>
            </CardContent>
          </Card>

          {/* Demo balance */}
          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <DollarSign size={14} className="text-emerald-400" /> Starting Demo Balance
                <Badge variant="outline" className="ml-2 font-mono text-emerald-400 border-emerald-500/30">
                  Current: {fmtBalance(demoBalance)}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              <p className="text-xs text-zinc-500">
                Set the virtual starting balance for each bot. Takes effect on the next Reset All.
              </p>
              <div className="flex flex-wrap gap-2">
                {BALANCE_PRESETS.map(n => (
                  <button
                    key={n}
                    onClick={() => handleSetBalance(n)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${
                      demoBalance === n
                        ? 'bg-emerald-600/20 border-emerald-500/50 text-emerald-300'
                        : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
                    }`}
                  >
                    {fmtBalance(n)}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  value={balanceInput}
                  onChange={e => setBalanceInput(e.target.value)}
                  placeholder="Any amount from $1"
                  className="h-8 text-xs w-56"
                  min={1}
                  max={1_000_000}
                />
                <Button size="sm" onClick={handleCustomBalance} variant="outline" className="text-xs">
                  Set Custom
                </Button>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleResetArena}
                  className="flex items-center gap-1.5 text-xs bg-amber-600/20 border border-amber-600/40 text-amber-300 hover:bg-amber-600/30"
                  variant="ghost"
                >
                  <RefreshCw size={12} /> Apply Balance (Reset All)
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Bot table summary */}
          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4"><CardTitle className="text-sm">Bot Status Summary</CardTitle></CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto max-h-64">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-zinc-900">
                    <tr className="border-b border-zinc-800 text-zinc-500">
                      {['#', 'Name', 'Symbol', 'Strategy', 'Balance', 'Status'].map(h => (
                        <th key={h} className="text-left px-3 py-2 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {bots.slice(0, 50).map((b, i) => (
                      <tr key={b.id} className="border-b border-zinc-800/30 hover:bg-zinc-900/50">
                        <td className="px-3 py-1.5 text-zinc-600 font-mono">{i + 1}</td>
                        <td className="px-3 py-1.5">
                          <div className="flex items-center gap-1.5">
                            <div className="w-1.5 h-1.5 rounded-full" style={{ background: b.color }} />
                            {b.name}
                          </div>
                        </td>
                        <td className="px-3 py-1.5 text-zinc-400">{b.symbol}</td>
                        <td className="px-3 py-1.5 text-zinc-400">{b.strategy}</td>
                        <td className="px-3 py-1.5 font-mono">${fmt(b.balance)}</td>
                        <td className="px-3 py-1.5">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${b.isRunning ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : 'bg-zinc-700/30 text-zinc-500 border-zinc-600/30'}`}>
                            {b.isRunning ? 'Active' : 'Paused'}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {bots.length > 50 && (
                      <tr className="border-b border-zinc-800/30">
                        <td colSpan={6} className="px-3 py-2 text-center text-zinc-600 text-[10px]">
                          … and {bots.length - 50} more bots (showing first 50)
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Risk Engine ── */}
      {section === 'risk' && (
        <div className="space-y-4">
          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <Shield size={14} className="text-purple-400" /> Risk Configuration
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-5">
              <div className="flex items-center justify-between py-3 border-b border-zinc-800">
                <div>
                  <Label className="text-sm font-medium">Safe Mode</Label>
                  <p className="text-xs text-zinc-500 mt-0.5">Reduce all bot exposures automatically</p>
                </div>
                <Switch checked={risk.safeMode} onCheckedChange={v => setRisk(r => ({ ...r, safeMode: v }))} />
              </div>
              <div className="flex items-center justify-between py-3 border-b border-zinc-800">
                <div>
                  <Label className="text-sm font-medium">Trading Enabled</Label>
                  <p className="text-xs text-zinc-500 mt-0.5">Master switch for all bot trading</p>
                </div>
                <Switch checked={risk.tradingEnabled} onCheckedChange={v => setRisk(r => ({ ...r, tradingEnabled: v }))} />
              </div>
              {[
                { key: 'maxDailyLossPercent',     label: 'Max Daily Loss %',        note: 'Halt trading when daily loss exceeds this %' },
                { key: 'maxBotDrawdownPercent',   label: 'Max Bot Drawdown %',      note: 'Auto-replace bot if drawdown exceeds this %' },
                { key: 'maxUserExposurePercent',  label: 'Max User Exposure %',     note: 'Max % of capital in open positions' },
                { key: 'maxSymbolExposurePercent',label: 'Max Symbol Exposure %',   note: 'Max concentration per symbol' },
                { key: 'emergencyStopLoss',       label: 'Emergency Stop Loss ($)', note: 'Kill switch triggers at this absolute $ loss' },
              ].map(f => (
                <div key={f.key} className="space-y-1">
                  <Label className="text-xs font-medium">{f.label}</Label>
                  <p className="text-[10px] text-zinc-500">{f.note}</p>
                  <Input type="number" value={(risk as any)[f.key]}
                    onChange={e => setRisk(r => ({ ...r, [f.key]: parseFloat(e.target.value) || 0 }))}
                    className="h-8 text-xs w-36" />
                </div>
              ))}
              <div className="flex gap-2">
                <Button onClick={saveRiskCfg}>Save Risk Configuration</Button>
                <Button variant="outline" onClick={() => { setRisk(DEFAULT_RISK); saveRisk(DEFAULT_RISK); toast({ title: 'Risk reset to defaults' }); }}>
                  Reset Defaults
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Alerts ── */}
      {section === 'alerts' && (
        <div className="space-y-3">
          {alertsData.length === 0 && (
            <div className="text-center py-16 text-zinc-500">
              <Bell size={32} className="mx-auto mb-3 text-zinc-600" />
              <p>No alerts recorded</p>
            </div>
          )}
          {alertsData.map(a => (
            <Card key={a.id} className={`border ${a.level === 'critical' ? 'border-red-600/30' : a.level === 'warn' ? 'border-amber-500/20' : 'border-zinc-800/60'}`}>
              <CardContent className="p-3 flex items-start gap-2.5">
                {a.level === 'critical' ? <XCircle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
                  : a.level === 'warn'   ? <AlertTriangle size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
                  : <CheckCircle2 size={14} className="text-blue-400 flex-shrink-0 mt-0.5" />}
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-zinc-200">{a.message}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-zinc-500">{new Date(a.timestamp).toLocaleTimeString()}</span>
                    <span className="text-[10px] text-zinc-600">·</span>
                    <span className="text-[10px] text-zinc-500">{a.source}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ── System ── */}
      {section === 'system' && (
        <div className="space-y-4">
          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4"><CardTitle className="text-sm">System Information</CardTitle></CardHeader>
            <CardContent className="p-4 space-y-3 text-xs">
              {[
                ['Platform',      'SignalX AI Arena v3.0'],
                ['Mode',          'Local Demo / Virtual Trading'],
                ['Storage',       'localStorage (browser)'],
                ['Bots',          `${bots.length} (${activeBots} active, ${pausedBots} paused)`],
                ['Bot Count',     `${botCount} selected`],
                ['Demo Balance',  fmtBalance(demoBalance) + ' per bot'],
                ['Symbols',       '38 assets (Crypto + Stocks + Metals + Forex)'],
                ['Strategies',    '7 (RSI, MACD, VWAP, Bollinger, SMA, Breakout, Multi-Signal)'],
                ['Tick Rate',     bots.length > 100 ? '1,200ms (large pool)' : '800ms'],
                ['Tick Count',    tickCount.toLocaleString()],
                ['Total Trades',  totalTrades.toLocaleString()],
                ['Exchange',      'Binance Mock Adapter (Demo Mode)'],
                ['Risk Engine',   risk.tradingEnabled ? 'Active' : 'Disabled'],
                ['Safe Mode',     risk.safeMode ? 'ON' : 'OFF'],
              ].map(([k, v]) => (
                <div key={k} className="flex items-center gap-4 py-1 border-b border-zinc-800/30 last:border-0">
                  <span className="text-zinc-500 w-36 flex-shrink-0">{k}</span>
                  <span className="text-zinc-200 font-mono">{v}</span>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4"><CardTitle className="text-sm">Quick Actions</CardTitle></CardHeader>
            <CardContent className="p-4 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={handleResetArena} className="flex items-center gap-1.5 text-xs">
                <RefreshCw size={12} /> Reset Arena
              </Button>
              <Button variant="outline" size="sm"
                onClick={() => { addAlert('info', 'Manual health check triggered', 'Admin'); toast({ title: 'Health check complete' }); }}
                className="flex items-center gap-1.5 text-xs">
                <Activity size={12} /> Health Check
              </Button>
              <Button variant="outline" size="sm"
                onClick={() => { setRisk(DEFAULT_RISK); saveRisk(DEFAULT_RISK); toast({ title: 'Risk reset to defaults' }); }}
                className="flex items-center gap-1.5 text-xs">
                <Shield size={12} /> Reset Risk Limits
              </Button>
            </CardContent>
          </Card>

          {/* Self-Healing Log */}
          {healLog.length > 0 && (
            <Card className="border-zinc-800/60">
              <CardHeader className="py-3 px-4">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Zap size={13} className="text-emerald-400" /> Self-Healing Events
                  <span className="ml-auto text-[10px] font-normal text-zinc-500">{healLog.length} total</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-1">
                {[...healLog].reverse().slice(0, 15).map(ev => (
                  <div key={ev.id} className="flex items-center gap-3 text-[11px] py-1 border-b border-zinc-800/30 last:border-0">
                    <span className="text-zinc-600 font-mono w-20 flex-shrink-0">{new Date(ev.timestamp).toLocaleTimeString()}</span>
                    <span className={`w-28 flex-shrink-0 font-medium ${
                      ev.type === 'pause_critical' ? 'text-red-400' :
                      ev.type === 'activate_standby' ? 'text-emerald-400' :
                      ev.type === 'load_shed' ? 'text-amber-400' :
                      ev.type === 'watchdog_restart' ? 'text-blue-400' : 'text-purple-400'
                    }`}>{ev.type.replace(/_/g, ' ')}</span>
                    <span className="text-zinc-300 truncate">{ev.botName}</span>
                    <span className="text-zinc-600 truncate hidden lg:inline">{ev.reason}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
