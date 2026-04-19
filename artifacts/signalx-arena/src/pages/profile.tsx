
import { useState } from 'react';
import { useUser } from '@/context/user-context';
import { PLAN_FEATURES } from '@/lib/user-store';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import {
  User, Settings, Key, Crown, CheckCircle2, AlertTriangle,
  Eye, EyeOff, Shield, LogOut, ShieldAlert,
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

export default function ProfilePage() {
  const { user, logout, updateSettings, updateProfile } = useUser();
  const { toast } = useToast();
  const [tab,      setTab]      = useState<Tab>('profile');
  const [name,     setName]     = useState(user?.name ?? '');
  const [apiKey,   setApiKey]   = useState('');
  const [apiSec,   setApiSec]   = useState('');
  const [showKey,  setShowKey]  = useState(false);
  const [showSec,  setShowSec]  = useState(false);

  if (!user) return null;

  const planMeta = PLAN_FEATURES[user.plan];

  const saveProfile = () => {
    updateProfile({ name: name.trim() || user.name });
    toast({ title: 'Profile updated' });
  };

  const saveApiKeys = () => {
    if (!apiKey.trim()) { toast({ title: 'API key required', variant: 'destructive' }); return; }
    updateSettings({
      binanceApiKeyMasked: apiKey.slice(0, 6) + '****' + apiKey.slice(-4),
      binanceSecretMasked: '****' + apiSec.slice(-4),
      binanceConnected: true,
    });
    setApiKey('');
    setApiSec('');
    toast({ title: 'API keys saved (masked)', description: 'Keys are stored locally only.' });
  };

  const disconnectExchange = () => {
    updateSettings({ binanceConnected: false, binanceApiKeyMasked: '', binanceSecretMasked: '' });
    toast({ title: 'Exchange disconnected' });
  };

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
                <p className="text-[10px] text-zinc-600">Email cannot be changed in demo mode.</p>
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
                { label: 'Trading mode',    value: user.settings.tradingMode === 'paper' ? 'Paper Trading' : 'Live Ready' },
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
              {(['paper', 'live_ready'] as const).map(mode => (
                <div key={mode} onClick={() => updateSettings({ tradingMode: mode })}
                  className={`flex items-center justify-between p-3 rounded-xl border cursor-pointer transition-all ${
                    user.settings.tradingMode === mode
                      ? 'border-red-600/40 bg-red-600/10 text-red-400'
                      : 'border-zinc-800 hover:border-zinc-700 text-zinc-400'
                  }`}>
                  <div>
                    <div className="text-sm font-semibold">{mode === 'paper' ? 'Paper Trading' : 'Live Trading Ready'}</div>
                    <div className="text-[10px] mt-0.5 text-zinc-500">
                      {mode === 'paper'
                        ? 'Simulated trades, virtual funds, zero risk'
                        : 'Connects to exchange API — real funds at risk'}
                    </div>
                  </div>
                  {user.settings.tradingMode === mode && <CheckCircle2 size={14} className="text-red-400" />}
                </div>
              ))}
              {user.settings.tradingMode === 'live_ready' && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-400">
                  <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
                  Live trading is not yet enabled. Connect your Binance API first.
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4"><CardTitle className="text-sm">Risk Preference</CardTitle></CardHeader>
            <CardContent className="p-4 space-y-2">
              {RISK_OPTIONS.map(opt => (
                <div key={opt.value} onClick={() => updateSettings({ riskPreference: opt.value as any })}
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
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">Binance Testnet</div>
                  <div className="text-[10px] text-zinc-500">Use testnet instead of mainnet</div>
                </div>
                <Switch checked={user.settings.binanceTestnet} onCheckedChange={v => updateSettings({ binanceTestnet: v })} />
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── API Keys ── */}
      {tab === 'exchange' && (
        <div className="space-y-4">
          <div className="px-4 py-3 rounded-xl border border-amber-500/30 bg-amber-500/5 text-xs text-amber-400 flex items-start gap-2">
            <ShieldAlert size={13} className="flex-shrink-0 mt-0.5" />
            <div>
              <strong>Important:</strong> API key connection is for structure and preparation only.
              Live trading is NOT enabled. Your keys are stored locally in your browser only — never sent to any server.
            </div>
          </div>

          {user.settings.binanceConnected ? (
            <Card className="border-emerald-500/20 bg-emerald-500/5">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <CheckCircle2 size={14} className="text-emerald-400" />
                  <span className="text-sm font-semibold text-emerald-400">Binance Connected</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500">
                    {user.settings.binanceTestnet ? 'Testnet' : 'Mainnet'}
                  </span>
                </div>
                <div className="space-y-2 text-xs text-zinc-400 mb-4">
                  <div className="flex justify-between">
                    <span className="text-zinc-500">API Key</span>
                    <span className="font-mono">{user.settings.binanceApiKeyMasked || '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Secret</span>
                    <span className="font-mono">{user.settings.binanceSecretMasked || '—'}</span>
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={disconnectExchange}
                  className="text-xs border-red-600/40 text-red-400 hover:bg-red-600/10">
                  Disconnect
                </Button>
              </CardContent>
            </Card>
          ) : (
            <Card className="border-zinc-800/60">
              <CardHeader className="py-3 px-4">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Key size={13} className="text-amber-400" /> Connect Binance API
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">API Key</Label>
                  <div className="relative">
                    <Input type={showKey ? 'text' : 'password'} value={apiKey} onChange={e => setApiKey(e.target.value)}
                      placeholder="Paste your Binance API key" className="pr-9 h-9 text-sm bg-zinc-800/60 border-zinc-700 font-mono text-xs" />
                    <button onClick={() => setShowKey(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-600">
                      {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Secret Key</Label>
                  <div className="relative">
                    <Input type={showSec ? 'text' : 'password'} value={apiSec} onChange={e => setApiSec(e.target.value)}
                      placeholder="Paste your secret key" className="pr-9 h-9 text-sm bg-zinc-800/60 border-zinc-700 font-mono text-xs" />
                    <button onClick={() => setShowSec(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-600">
                      {showSec ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  </div>
                </div>
                <div className="text-[10px] text-zinc-600 space-y-1">
                  <p>• Enable <strong className="text-zinc-500">Read Info</strong> and <strong className="text-zinc-500">Spot Trading</strong> only</p>
                  <p>• Disable withdrawals for safety</p>
                  <p>• Keys are never transmitted — stored in your browser only</p>
                </div>
                <Button size="sm" onClick={saveApiKeys} disabled={!apiKey.trim()}>
                  <Shield size={12} className="mr-1.5" /> Save API Keys (Local Only)
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── Subscription ── */}
      {tab === 'subscription' && (
        <div className="space-y-4">
          {/* Current plan */}
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

          {/* Upgrade options */}
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
                  SignalX is a <strong className="text-zinc-400">paper trading simulator</strong>. No subscription includes real trading.
                  All results are simulated with virtual funds. Past performance does not guarantee future results.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
