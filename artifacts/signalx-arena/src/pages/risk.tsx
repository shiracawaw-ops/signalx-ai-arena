
import { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { useArena } from '@/hooks/use-arena';
import { getBotTotalValue, getBotPnL } from '@/lib/engine';
import { loadRisk, saveRisk, addAlert, type RiskConfig } from '@/lib/platform';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/hooks/use-toast';
import {
  Shield, AlertTriangle, XCircle, CheckCircle2, Gauge, Zap,
  TrendingDown, Activity, StopCircle, Eye,
} from 'lucide-react';

function fmt(n: number, dec = 2) {
  return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function RiskGauge({ value, max, label, color }: { value: number; max: number; label: string; color: string }) {
  const pct = Math.min(100, (value / max) * 100);
  const isWarning = pct > 70;
  const isCritical = pct > 90;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-zinc-400">{label}</span>
        <span className={`font-mono font-semibold ${isCritical ? 'text-red-400' : isWarning ? 'text-amber-400' : 'text-zinc-300'}`}>
          {fmt(value, 1)} / {fmt(max, 0)}
        </span>
      </div>
      <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
        <motion.div
          className={`h-full rounded-full ${isCritical ? 'bg-red-500' : isWarning ? 'bg-amber-500' : color}`}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
          style={{ boxShadow: isCritical ? '0 0 8px #ef4444' : undefined }}
        />
      </div>
    </div>
  );
}

export default function RiskPage() {
  const { bots, trades, market, getCurrentPrice, stop } = useArena();
  const [risk, setRisk] = useState<RiskConfig>(() => loadRisk());
  const { toast } = useToast();

  const totalValue    = bots.reduce((s, b) => s + getBotTotalValue(b, getCurrentPrice(b.symbol)), 0);
  const totalPnl      = bots.reduce((s, b) => s + getBotPnL(b, getCurrentPrice(b.symbol)), 0);
  const totalStarting = bots.reduce((s, b) => s + b.startingBalance, 0);
  const dailyLossPct  = totalStarting > 0 ? Math.max(0, -totalPnl / totalStarting * 100) : 0;
  const totalPositionValue = bots.reduce((s, b) => s + b.position * getCurrentPrice(b.symbol), 0);
  const exposurePct = totalValue > 0 ? (totalPositionValue / totalValue) * 100 : 0;

  // Per-symbol exposure
  const symbolExposure = useMemo(() => {
    const map: Record<string, number> = {};
    bots.forEach(b => {
      const val = b.position * getCurrentPrice(b.symbol);
      map[b.symbol] = (map[b.symbol] || 0) + val;
    });
    return Object.entries(map)
      .map(([sym, val]) => ({ sym, val, pct: totalValue > 0 ? (val / totalValue) * 100 : 0 }))
      .filter(e => e.val > 0)
      .sort((a, b) => b.pct - a.pct);
  }, [bots, market]);

  const worstBot = useMemo(() => {
    return [...bots].sort((a, b) => getBotPnL(a, getCurrentPrice(a.symbol)) - getBotPnL(b, getCurrentPrice(b.symbol)))[0];
  }, [bots, market]);

  const worstBotPnl = worstBot ? getBotPnL(worstBot, getCurrentPrice(worstBot.symbol)) : 0;
  const worstDD = worstBotPnl < 0 ? Math.abs(worstBotPnl / (worstBot?.startingBalance || 1000)) * 100 : 0;

  const emergencyTriggered = Math.abs(totalPnl) >= risk.emergencyStopLoss && totalPnl < 0;

  const saveConfig = () => {
    saveRisk(risk);
    addAlert('info', 'Risk configuration updated', 'Risk Engine');
    toast({ title: 'Risk configuration saved' });
  };

  const triggerKillSwitch = () => {
    stop();
    addAlert('critical', 'Kill switch triggered manually', 'Risk Engine');
    toast({ title: '🛑 Kill Switch Activated', description: 'All trading halted.', variant: 'destructive' });
  };

  return (
    <div className="p-4 max-w-screen-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-red-600/10 border border-red-600/30 flex items-center justify-center">
          <Shield size={18} className="text-red-400" />
        </div>
        <div>
          <h1 className="text-lg font-bold">Risk Engine</h1>
          <p className="text-xs text-zinc-500">Real-time risk monitoring & control</p>
        </div>
        <div className="ml-auto">
          <Button variant="destructive" size="sm" onClick={triggerKillSwitch} className="flex items-center gap-1.5">
            <StopCircle size={13} /> Kill Switch
          </Button>
        </div>
      </div>

      {/* Emergency alert */}
      {emergencyTriggered && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-4 px-4 py-3 rounded-xl border border-red-600 bg-red-600/10 flex items-center gap-3"
        >
          <XCircle size={18} className="text-red-400" />
          <div>
            <div className="font-bold text-sm text-red-400">🚨 Emergency Stop Loss Threshold Breached</div>
            <div className="text-xs text-zinc-400">Total loss ${fmt(Math.abs(totalPnl))} ≥ limit ${fmt(risk.emergencyStopLoss)}</div>
          </div>
        </motion.div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Live exposure gauges */}
        <Card className="border-zinc-800/60">
          <CardHeader className="py-3 px-4"><CardTitle className="text-sm flex items-center gap-2"><Gauge size={14} className="text-red-400" /> Live Risk Exposure</CardTitle></CardHeader>
          <CardContent className="p-4 space-y-4">
            <RiskGauge value={dailyLossPct} max={risk.maxDailyLossPercent} label="Daily Loss %" color="bg-blue-500" />
            <RiskGauge value={worstDD} max={risk.maxBotDrawdownPercent} label="Worst Bot Drawdown %" color="bg-purple-500" />
            <RiskGauge value={exposurePct} max={risk.maxUserExposurePercent} label="Total Exposure %" color="bg-cyan-500" />
            {symbolExposure[0] && (
              <RiskGauge value={symbolExposure[0].pct} max={risk.maxSymbolExposurePercent} label={`Top Symbol (${symbolExposure[0].sym}) %`} color="bg-emerald-500" />
            )}
            <div className="pt-2">
              <div className="text-[10px] text-zinc-500 mb-2 uppercase tracking-wide">Symbol Exposure Breakdown</div>
              {symbolExposure.slice(0, 6).map(e => (
                <div key={e.sym} className="flex items-center gap-2 mb-1.5">
                  <span className="text-[11px] text-zinc-400 w-16 flex-shrink-0">{e.sym}</span>
                  <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.min(100, e.pct)}%` }} />
                  </div>
                  <span className="text-[10px] font-mono text-zinc-500 w-10 text-right">{fmt(e.pct, 1)}%</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Risk configuration */}
        <Card className="border-zinc-800/60">
          <CardHeader className="py-3 px-4"><CardTitle className="text-sm flex items-center gap-2"><Shield size={14} className="text-purple-400" /> Risk Limits</CardTitle></CardHeader>
          <CardContent className="p-4 space-y-4">
            <div className="flex items-center justify-between py-2 border-b border-zinc-800">
              <div>
                <Label className="text-sm font-medium">Safe Mode</Label>
                <p className="text-[10px] text-zinc-500">Auto-reduce all bot exposure</p>
              </div>
              <Switch checked={risk.safeMode} onCheckedChange={v => setRisk(r => ({ ...r, safeMode: v }))} />
            </div>
            <div className="flex items-center justify-between py-2 border-b border-zinc-800">
              <div>
                <Label className="text-sm font-medium">Trading Enabled</Label>
                <p className="text-[10px] text-zinc-500">Master trading switch</p>
              </div>
              <Switch checked={risk.tradingEnabled} onCheckedChange={v => setRisk(r => ({ ...r, tradingEnabled: v }))} />
            </div>
            {[
              { key: 'maxDailyLossPercent',      label: 'Max Daily Loss %' },
              { key: 'maxBotDrawdownPercent',    label: 'Max Bot Drawdown %' },
              { key: 'maxUserExposurePercent',   label: 'Max Exposure %' },
              { key: 'emergencyStopLoss',        label: 'Emergency Stop ($)' },
            ].map(f => (
              <div key={f.key} className="flex items-center justify-between gap-3">
                <Label className="text-xs">{f.label}</Label>
                <Input type="number" value={(risk as any)[f.key]}
                  onChange={e => setRisk(r => ({ ...r, [f.key]: parseFloat(e.target.value) || 0 }))}
                  className="h-7 text-xs w-24 text-right" />
              </div>
            ))}
            <Button onClick={saveConfig} size="sm" className="w-full mt-2">Save Configuration</Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
