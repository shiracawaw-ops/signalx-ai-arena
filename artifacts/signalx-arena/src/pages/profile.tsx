
import { useState, useEffect, useMemo } from 'react';
import { Link } from 'wouter';
import { useUser } from '@/context/user-context';
import { PLAN_FEATURES } from '@/lib/user-store';
import { exchangeMode, type ExchangeModeState } from '@/lib/exchange-mode';
import { credentialStore } from '@/lib/credential-store';
import { KNOWN_EXCHANGES } from '@/lib/exchange';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import {
  User, Settings, Key, Crown, CheckCircle2, AlertTriangle,
  Shield, LogOut, ShieldAlert, ExternalLink, Activity, Wifi, WifiOff,
} from 'lucide-react';

const TABS = [
  { key: 'profile',      label: 'Profile',      icon: User          },
  { key: 'settings',     label: 'Settings',     icon: Settings      },
  { key: 'exchange',     label: 'API Keys',     icon: Key           },
  { key: 'subscription', label: 'Plan',         icon: Crown         },
] as const;

type Tab = typeof TABS[number]['key'];

const RISK_OPTIONS: Array<{ value: string; label: string; desc: string; color: string }> = [
  { value: 'conservative', label: 'Conservative', desc: 'Max -1% daily, small positions',  color: 'border-emerald-500/40 text-emerald-400' },
  { value: 'moderate',     label: 'Moderate',     desc: 'Max -3% daily, balanced',          color: 'border-amber-500/40 text-amber-400'    },
  { value: 'aggressive',   label: 'Aggressive',   desc: 'Max -5% daily, larger positions',  color: 'border-red-500/40 text-red-400'        },
];

function modeLabel(m: ExchangeModeState['mode']): string {
  switch (m) {
    case 'demo':    return 'Demo (Local Simulator)';
    case 'paper':   return 'Paper (Live Prices, Simulated Fills)';
    case 'testnet': return 'Testnet (Sandbox API)';
    case 'real':    return 'Real (Live Funds)';
  }
}

function modeColor(m: ExchangeModeState['mode']): string {
  switch (m) {
    case 'demo':    return 'text-blue-400';
    case 'paper':   return 'text-amber-400';
    case 'testnet': return 'text-purple-400';
    case 'real':    return 'text-red-400';
  }
}

export default function ProfilePage() {
  const { user, logout, updateSettings, updateProfile } = useUser();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('profile');
  const [name, setName] = useState(user?.name ?? '');
  const [exState, setExState] = useState<ExchangeModeState>(() => exchangeMode.get());

  useEffect(() => exchangeMode.subscribe(setExState), []);

  const activeExchange = useMemo(
    () => KNOWN_EXCHANGES.find(e => e.id === exState.exchange),
    [exState.exchange],
  );
  const hint = useMemo(
    () => credentialStore.getMaskedHint(exState.exchange),
    [exState.exchange, exState.connectedAt],
  );

  if (!user) return null;

  const planMeta = PLAN_FEATURES[user.plan];

  const saveProfile = () => {
    updateProfile({ name: name.trim() || user.name });
    toast({ title: 'Profile updated' });
  };

  const isLiveMode = exState.mode === 'real' || exState.mode === 'testnet';
  const isConnected = exState.connectionState === 'connected'
                   || exState.connectionState === 'balance_loaded';
  const liveTradingActive = exState.mode === 'real' && exState.armed;

  return (
    <div className="p-4 max-w-2xl mx-auto">

      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-red-600/30 to-orange-600/20 border border-red-600/30 flex items-center justify-center">
          <span className="text-lg font-black text-red-400">{user.name.charAt(0).toUpperCase()}</span>
        </div>
        <div>
          <h1 className="text-lg font-bold">{user.name}</h1>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-zinc-500">{user.email}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-bold ${planMeta.color} bg-zinc-900`}>
              {planMeta.label.toUpperCase()}
            </span>
          </div>
        </div>
        <button onClick={logout} className="ml-auto flex items-center gap-1.5 text-xs text-zinc-500 hover:text-red-400 transition-colors px-2 py-1 rounded-lg hover:bg-red-600/10">
          <LogOut size={12} /> Sign out
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-6 border-b border-zinc-800/60 pb-3">
        {TABS.map(t => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors font-medium
                ${active ? 'bg-zinc-800/70 text-zinc-100 border border-zinc-700/50' : 'text-zinc-500 hover:text-zinc-300'}`}>
              <Icon size={12} />{t.label}
            </button>
          );
        })}
      </div>

      {/* ── Profile ── */}
      {tab === 'profile' && (
        <div className="space-y-4">
          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4"><CardTitle className="text-sm">Personal Info</CardTitle></CardHeader>
            <CardContent className="p-4 space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Display Name</Label>
                <Input value={name} onChange={e => setName(e.target.value)} className="h-9 text-sm bg-zinc-800/60 border-zinc-700" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Email</Label>
                <Input value={user.email} disabled className="h-9 text-sm bg-zinc-900/60 border-zinc-800 text-zinc-500" />
              </div>
              <Button size="sm" onClick={saveProfile}>Save Changes</Button>
            </CardContent>
          </Card>

          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4"><CardTitle className="text-sm">Account Details</CardTitle></CardHeader>
            <CardContent className="p-4 space-y-3">
              {[
                { label: 'Account ID',      value: user.id },
                { label: 'Member since',    value: new Date(user.createdAt).toLocaleDateString() },
                { label: 'Last login',      value: new Date(user.lastLogin).toLocaleString()     },
                { label: 'Active exchange', value: activeExchange?.name ?? exState.exchange },
                { label: 'Trading mode',    value: modeLabel(exState.mode) },
                { label: 'Live trading',    value: liveTradingActive ? 'ARMED' : 'Disarmed' },
              ].map(r => (
                <div key={r.label} className="flex items-center justify-between text-xs">
                  <span className="text-zinc-500">{r.label}</span>
                  <span className="font-mono text-zinc-300">{r.value}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Settings ── */}
      {tab === 'settings' && (
        <div className="space-y-4">
          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4"><CardTitle className="text-sm">Trading Mode</CardTitle></CardHeader>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between p-3 rounded-xl border border-zinc-800 bg-zinc-900/40">
                <div>
                  <div className={`text-sm font-semibold ${modeColor(exState.mode)}`}>
                    {modeLabel(exState.mode)}
                  </div>
                  <div className="text-[10px] mt-0.5 text-zinc-500">
                    Mode is controlled from the Exchange page — single source of truth across the app.
                  </div>
                </div>
                <Link href="/exchange">
                  <Button variant="outline" size="sm" className="text-xs h-8">
                    Open Exchange <ExternalLink size={11} className="ml-1" />
                  </Button>
                </Link>
              </div>
              {exState.mode === 'real' && !exState.armed && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-400">
                  <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
                  <span>Real mode selected but trading is not armed yet. Use <strong>Start Real Trading</strong> on the Exchange page once all readiness checks pass.</span>
                </div>
              )}
              {liveTradingActive && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-400">
                  <Activity size={12} className="flex-shrink-0 mt-0.5" />
                  <span><strong>Live trading is ARMED.</strong> Bot signals are submitting real orders to {activeExchange?.name ?? exState.exchange}.</span>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4"><CardTitle className="text-sm">Risk Preference</CardTitle></CardHeader>
            <CardContent className="p-4 space-y-2">
              {RISK_OPTIONS.map(opt => (
                <div key={opt.value} onClick={() => updateSettings({ riskPreference: opt.value as 'conservative' | 'moderate' | 'aggressive' })}
                  className={`flex items-center justify-between p-3 rounded-xl border cursor-pointer transition-all ${
                    user.settings.riskPreference === opt.value
                      ? `${opt.color} bg-zinc-800/40`
                      : 'border-zinc-800 hover:border-zinc-700 text-zinc-400'
                  }`}>
                  <div>
                    <div className="text-sm font-semibold">{opt.label}</div>
                    <div className="text-[10px] text-zinc-500">{opt.desc}</div>
                  </div>
                  {user.settings.riskPreference === opt.value && <CheckCircle2 size={14} />}
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4"><CardTitle className="text-sm">Preferences</CardTitle></CardHeader>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">Notifications</div>
                  <div className="text-[10px] text-zinc-500">Risk alerts and decision logs</div>
                </div>
                <Switch checked={user.settings.notifications} onCheckedChange={v => updateSettings({ notifications: v })} />
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── API Keys (read-only mirror of exchangeMode) ── */}
      {tab === 'exchange' && (
        <div className="space-y-4">
          <div className="px-4 py-3 rounded-xl border border-zinc-800 bg-zinc-900/40 text-xs text-zinc-400 flex items-start gap-2">
            <ShieldAlert size={13} className="flex-shrink-0 mt-0.5 text-amber-400" />
            <div>
              <strong className="text-zinc-200">API keys are managed on the Exchange page.</strong>
              <p className="mt-0.5 text-zinc-500">
                Secrets are kept in memory only — never written to localStorage, never sent to any third-party server.
                Only a masked hint is persisted so the UI can recognize a previously-connected key.
              </p>
            </div>
          </div>

          <Card className={isConnected ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-zinc-800/60'}>
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-sm flex items-center gap-2">
                {isConnected ? <Wifi size={13} className="text-emerald-400" /> : <WifiOff size={13} className="text-zinc-500" />}
                Active Exchange
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-3 text-xs">
              <div className="flex justify-between">
                <span className="text-zinc-500">Exchange</span>
                <span className="font-mono text-zinc-200">{activeExchange?.name ?? exState.exchange}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Mode</span>
                <span className={`font-mono ${modeColor(exState.mode)}`}>{modeLabel(exState.mode)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Connection</span>
                <span className={`font-mono ${isConnected ? 'text-emerald-400' : 'text-zinc-500'}`}>
                  {exState.connectionState}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">API Validated</span>
                <span className={`font-mono ${exState.apiValidated ? 'text-emerald-400' : 'text-zinc-500'}`}>
                  {exState.apiValidated ? 'Yes' : 'No'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Trade Permission</span>
                <span className={`font-mono ${exState.permissions.trade ? 'text-emerald-400' : 'text-zinc-500'}`}>
                  {exState.permissions.trade ? 'Granted' : '—'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Trading Armed</span>
                <span className={`font-mono ${exState.armed ? 'text-red-400' : 'text-zinc-500'}`}>
                  {exState.armed ? 'ARMED' : 'Disarmed'}
                </span>
              </div>
              {hint && (
                <div className="flex justify-between">
                  <span className="text-zinc-500">Saved Key</span>
                  <span className="font-mono text-zinc-300">{hint.maskedKey}</span>
                </div>
              )}
              <div className="pt-2">
                <Link href="/exchange">
                  <Button variant="outline" size="sm" className="text-xs w-full">
                    <Shield size={12} className="mr-1.5" /> Manage Keys & Mode on Exchange Page
                    <ExternalLink size={11} className="ml-1.5" />
                  </Button>
                </Link>
              </div>
            </CardContent>
          </Card>

          {!isLiveMode && (
            <div className="px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/30 text-xs text-blue-300">
              You are currently in <strong>{modeLabel(exState.mode)}</strong>. No real funds are at risk in this mode.
            </div>
          )}
        </div>
      )}

      {/* ── Subscription (unchanged) ── */}
      {tab === 'subscription' && (
        <div className="space-y-4">
          <Card className={`border-zinc-800/60 ${user.plan === 'admin' ? 'border-red-600/30' : user.plan === 'pro' ? 'border-amber-600/30' : ''}`}>
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="text-[10px] text-zinc-500 uppercase tracking-widest">Current Plan</div>
                  <div className={`text-2xl font-black mt-0.5 ${planMeta.color}`}>{planMeta.label}</div>
                </div>
                <Crown size={28} className={planMeta.color} />
              </div>
              <div className="space-y-1.5">
                {planMeta.features.map(f => (
                  <div key={f} className="flex items-center gap-2 text-xs text-zinc-400">
                    <CheckCircle2 size={11} className="text-emerald-400 flex-shrink-0" />
                    {f}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {user.plan === 'free' && (
            <Card className="border-amber-600/30 bg-amber-500/5">
              <CardContent className="p-5">
                <div className="flex items-center gap-2 mb-3">
                  <Crown size={16} className="text-amber-400" />
                  <span className="text-base font-bold text-amber-400">Upgrade to Pro</span>
                  <span className="text-xs text-zinc-500 ml-auto">Coming soon</span>
                </div>
                <p className="text-xs text-zinc-400 mb-4">
                  Get unlimited bots, full AutoPilot, advanced analytics, and priority support.
                </p>
                <div className="space-y-1.5 mb-4">
                  {PLAN_FEATURES.pro.features.map(f => (
                    <div key={f} className="flex items-center gap-2 text-xs text-zinc-400">
                      <CheckCircle2 size={11} className="text-amber-400 flex-shrink-0" />
                      {f}
                    </div>
                  ))}
                </div>
                <Button disabled className="w-full text-sm opacity-60">
                  Upgrade to Pro — $29/month (soon)
                </Button>
              </CardContent>
            </Card>
          )}

          <Card className="border-zinc-800/60">
            <CardContent className="p-4">
              <div className="flex items-start gap-2 text-xs text-zinc-500">
                <ShieldAlert size={12} className="text-amber-500 flex-shrink-0 mt-0.5" />
                <p>
                  Subscription plans cover features only. Real trading requires connecting your own exchange API keys
                  on the Exchange page and accepting the explicit live-funds confirmation.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
