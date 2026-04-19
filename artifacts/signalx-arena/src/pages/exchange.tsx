
import { useState, useEffect, useCallback, useRef } from 'react';
import { ErrorBoundary } from '@/components/error-boundary';
import { motion } from 'framer-motion';
import {
  getExchangeAdapter, checkTradingPermission, KNOWN_EXCHANGES,
  type ExchangeBalance, type ExchangeOrder, type ExchangeMeta,
} from '@/lib/exchange';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import {
  ArrowLeftRight, CheckCircle2, XCircle, RefreshCw, Shield,
  Eye, EyeOff, Zap, Wallet, Clock, Lock, ExternalLink, Globe,
  Activity, Settings, FileText, AlertTriangle, Crosshair,
} from 'lucide-react';

// ── New engine imports ────────────────────────────────────────────────────────
import { exchangeMode as exMode }   from '@/lib/exchange-mode';
import type { ExchangeModeState, ConnectionState } from '@/lib/exchange-mode';
import { tradeConfig, type TradeConfig } from '@/lib/trade-config';
import { executionLog, type ExecutionEntry } from '@/lib/execution-log';
import { apiClient, type ExchangeErrorCode } from '@/lib/api-client';
import { setCredentials }           from '@/lib/execution-engine';
import { credentialStore }          from '@/lib/credential-store';
import { exchangeEvents, type ExchangeEvent } from '@/lib/exchange-events';

// Map a backend error code (or fetch failure) to a connection-machine state.
function codeToState(code: ExchangeErrorCode | undefined): ConnectionState {
  switch (code) {
    case 'auth':         return 'invalid_credentials';
    case 'permission':   return 'permission_denied';
    case 'rate_limit':   return 'rate_limited';
    case 'network':      return 'network_error';
    case 'empty':        return 'balance_empty';
    case 'account_type': return 'balance_error';
    default:             return 'balance_error';
  }
}

// Connection states that warrant the persistent inline error card.
// `balance_empty` is a successful fetch (just no funds) so it is not an error.
const CONNECTION_ERROR_STATES: ReadonlySet<ConnectionState> = new Set([
  'network_error', 'invalid_credentials', 'permission_denied',
  'rate_limited',  'balance_error',
]);

function friendlyConnectionError(
  state: ConnectionState, exName: string, error?: string,
): { title: string; body: string; needsKeys: boolean } {
  switch (state) {
    case 'network_error':
      return {
        title: `Can't reach ${exName}`,
        body: error ?? 'We could not reach the exchange. Check your internet connection and try again.',
        needsKeys: false,
      };
    case 'invalid_credentials':
      return {
        title: 'API credentials were rejected',
        body: error ?? 'Your API key or secret was not accepted. Re-enter your keys to continue.',
        needsKeys: true,
      };
    case 'permission_denied':
      return {
        title: 'API key is missing a required permission',
        body: error ?? 'This key does not have the permissions needed to read balances or place trades. Re-enter a key with read + trade enabled.',
        needsKeys: true,
      };
    case 'rate_limited':
      return {
        title: `${exName} rate limit hit`,
        body: error ?? 'The exchange temporarily blocked further requests. Wait a moment, then retry.',
        needsKeys: false,
      };
    case 'balance_error':
      return {
        title: 'Could not load your balance',
        body: error ?? 'Something went wrong while fetching your account balance. Retry, or open Diagnostics for details.',
        needsKeys: false,
      };
    default:
      return { title: 'Connection issue', body: error ?? 'Something went wrong with this connection.', needsKeys: false };
  }
}

// Numeric coercion that always returns a finite number — protects every
// downstream `.toFixed`, sum, and division from a bad shape on the wire.
function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmt(n: number, dec = 2) {
  return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

const MODES = [
  { key: 'demo',    label: 'Demo',    desc: 'Virtual funds — no API keys needed',   color: 'text-blue-400',   border: 'border-blue-500/30 bg-blue-500/5'       },
  { key: 'paper',   label: 'Paper',   desc: 'Real prices, simulated fills',         color: 'text-yellow-400', border: 'border-yellow-500/30 bg-yellow-500/5'   },
  { key: 'testnet', label: 'Testnet', desc: 'Sandbox — test API keys required',     color: 'text-orange-400', border: 'border-orange-500/30 bg-orange-500/5'   },
  { key: 'real',    label: 'Real',    desc: '⚠ Real funds — proceed with caution', color: 'text-red-400',    border: 'border-red-500/30 bg-red-500/5'         },
] as const;

const ACCENT_DOT: Record<string, string> = {
  amber:   'bg-amber-400', blue:   'bg-blue-500',  violet:  'bg-violet-500',
  zinc:    'bg-zinc-400',  yellow: 'bg-yellow-400', teal:   'bg-teal-400',
  emerald: 'bg-emerald-400', sky: 'bg-sky-400',    orange:  'bg-orange-400',
  red:     'bg-red-400',   cyan:   'bg-cyan-400',
};
const ACCENT_RING: Record<string, string> = {
  amber:   'ring-amber-500/40', blue:   'ring-blue-500/40',  violet:  'ring-violet-500/40',
  zinc:    'ring-zinc-500/40',  yellow: 'ring-yellow-500/40', teal:   'ring-teal-500/40',
  emerald: 'ring-emerald-500/40', sky: 'ring-sky-500/40',    orange:  'ring-orange-500/40',
  red:     'ring-red-500/40',   cyan:   'ring-cyan-500/40',
};
const ACCENT_BORDER: Record<string, string> = {
  amber:   'border-amber-500/40 bg-amber-500/5', blue:   'border-blue-500/40 bg-blue-500/5',
  violet:  'border-violet-500/40 bg-violet-500/5', zinc: 'border-zinc-500/40 bg-zinc-800/30',
  yellow:  'border-yellow-500/40 bg-yellow-500/5', teal: 'border-teal-500/40 bg-teal-500/5',
  emerald: 'border-emerald-500/40 bg-emerald-500/5', sky: 'border-sky-500/40 bg-sky-500/5',
  orange:  'border-orange-500/40 bg-orange-500/5', red:  'border-red-500/40 bg-red-500/5',
  cyan:    'border-cyan-500/40 bg-cyan-500/5',
};
const ACCENT_TEXT: Record<string, string> = {
  amber: 'text-amber-400', blue: 'text-blue-400', violet: 'text-violet-400',
  zinc: 'text-zinc-300', yellow: 'text-yellow-400', teal: 'text-teal-400',
  emerald: 'text-emerald-400', sky: 'text-sky-400', orange: 'text-orange-400',
  red: 'text-red-400', cyan: 'text-cyan-400',
};

const TABS = [
  { key: 'exchanges',   label: 'Exchanges',     icon: Globe          },
  { key: 'connection',  label: 'Connection',    icon: ArrowLeftRight },
  { key: 'balances',    label: 'Balances',      icon: Wallet         },
  { key: 'orders',      label: 'Order History', icon: Clock          },
  { key: 'permissions', label: 'Permissions',   icon: Shield         },
  { key: 'livestatus',  label: 'Live Status',   icon: Activity       },
  { key: 'tradeconfig', label: 'Trade Config',  icon: Settings       },
  { key: 'execlog',     label: 'Execution Log', icon: FileText       },
  { key: 'diagnostics', label: 'Diagnostics',   icon: AlertTriangle  },
] as const;

// ── Status dot ────────────────────────────────────────────────────────────────
function StatusDot({ ok }: { ok: boolean }) {
  return ok
    ? <CheckCircle2 size={13} className="text-emerald-400 flex-shrink-0" />
    : <XCircle      size={13} className="text-zinc-600 flex-shrink-0" />;
}

// ── Trade Config row ─────────────────────────────────────────────────────────
function CfgRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-zinc-800/40 last:border-0">
      <span className="text-xs text-zinc-400">{label}</span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

export default function ExchangePage() {
  const [tab,         setTab]         = useState<typeof TABS[number]['key']>('exchanges');
  // Initialize selected exchange from the engine singleton so navigating
  // away and back to /exchange does NOT reset the user's active exchange.
  const initialEx: ExchangeMeta =
    KNOWN_EXCHANGES.find(e => e.id === exMode.get().exchange) ?? KNOWN_EXCHANGES[0];
  const [selectedEx,  setSelectedEx]  = useState<ExchangeMeta>(initialEx);
  const [mode,        setMode]        = useState<'demo' | 'paper' | 'testnet' | 'real'>(() => exMode.get().mode);
  // Credentials live in the singleton credentialStore so they survive
  // page navigation. Local state mirrors them only for the controlled inputs.
  const [apiKey,      setApiKey]      = useState(() => credentialStore.get(initialEx.id)?.apiKey    ?? '');
  const [secretKey,   setSecretKey]   = useState(() => credentialStore.get(initialEx.id)?.secretKey ?? '');
  const [passphrase,  setPassphrase]  = useState(() => credentialStore.get(initialEx.id)?.passphrase ?? '');
  const [showSecret,  setShowSecret]  = useState(false);
  const [isConnected, setIsConnected] = useState(() => credentialStore.has(initialEx.id));
  const [diagEvents,  setDiagEvents]  = useState<ExchangeEvent[]>(() => exchangeEvents.all());
  const [connecting,  setConnecting]  = useState(false);
  const [balances,    setBalances]    = useState<ExchangeBalance[]>([]);
  const [orders,      setOrders]      = useState<ExchangeOrder[]>([]);
  const [latency,     setLatency]     = useState<number | null>(null);

  // ── Engine state ──────────────────────────────────────────────────────────
  const [modeState,   setModeState]   = useState<ExchangeModeState>(exMode.get());
  const [config,      setConfig]      = useState<TradeConfig>(tradeConfig.get(selectedEx.id));
  const [logEntries,  setLogEntries]  = useState<ExecutionEntry[]>(executionLog.all());
  const [liveBalances, setLiveBalances] = useState<Array<{ asset: string; available: number; hold: number; total: number }>>([]);
  const [liveOrders,   setLiveOrders]  = useState<unknown[]>([]);
  const [livePermissions, setLivePermissions] = useState<{ read: boolean; trade: boolean; withdraw: boolean; futures: boolean } | null>(null);
  const [refreshing,   setRefreshing]  = useState(false);
  const [validating,   setValidating]  = useState(false);
  const [balError,     setBalError]    = useState<string | null>(null);
  const [ordError,     setOrdError]    = useState<string | null>(null);

  const { toast } = useToast();
  const adapter = getExchangeAdapter(selectedEx.id);

  // ── Subscribe to engine singletons ────────────────────────────────────────
  useEffect(() => {
    const unsub1 = exMode.subscribe(setModeState);
    const unsub2 = tradeConfig.subscribe(configs => setConfig(configs[selectedEx.id] ?? tradeConfig.get(selectedEx.id)));
    const unsub3 = executionLog.subscribe(setLogEntries);
    const unsub4 = exchangeEvents.subscribe(setDiagEvents);
    return () => { unsub1(); unsub2(); unsub3(); unsub4(); };
  }, [selectedEx.id]);

  // ── Sync mode singleton when user changes mode selector ──────────────────
  // Must use setMode() — not update() — so armed/networkUp/balanceFetched/
  // apiValidated flags are cleared when the user switches modes.
  // Skip first run: the local `mode` was initialized FROM the singleton, so
  // calling setMode() on mount would needlessly clear connection flags and
  // break "connection visibly alive after returning to /exchange".
  const modeMounted = useRef(false);
  useEffect(() => {
    if (!modeMounted.current) { modeMounted.current = true; return; }
    if (exMode.get().mode === mode) return;
    exMode.setMode(mode);
    exchangeEvents.log('switch-mode', selectedEx.id, `User selected mode "${mode}"`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // ── Switch exchanges: keep saved creds, restore connection state from store
  // Same first-mount guard so a passive page return doesn't wipe flags
  // or clear cached live balances/orders that the user expects to still
  // see after returning to /exchange.
  const exMounted = useRef(false);
  useEffect(() => {
    setConfig(tradeConfig.get(selectedEx.id));

    if (!exMounted.current) {
      // First mount: rehydrate cached live data for this exchange so the
      // user sees the same balances/orders they had before navigating away.
      exMounted.current = true;
      const cached = credentialStore.getCache(selectedEx.id);
      if (cached) {
        if (cached.liveBalances)   setLiveBalances(cached.liveBalances);
        if (cached.liveOrders)     setLiveOrders(cached.liveOrders);
        if (cached.permissions)    setLivePermissions(cached.permissions);
        if (typeof cached.latency === 'number') setLatency(cached.latency);
      }
    } else {
      // Active exchange switch: reset everything for the new exchange.
      setBalances([]);
      setOrders([]);
      setLiveBalances([]);
      setLiveOrders([]);
      setLivePermissions(null);
      setLatency(null);
      setBalError(null);
      setOrdError(null);
      if (exMode.get().exchange !== selectedEx.id) {
        exMode.setExchange(selectedEx.id);
      }
    }

    // Rehydrate creds + connection flag from the singleton store.
    const saved = credentialStore.get(selectedEx.id);
    setApiKey(saved?.apiKey     ?? '');
    setSecretKey(saved?.secretKey ?? '');
    setPassphrase(saved?.passphrase ?? '');
    setIsConnected(!!saved);
    setCredentials(saved);
    exchangeEvents.log('state-change', selectedEx.id,
      saved ? 'Restored saved credentials for this exchange' : 'No saved credentials for this exchange');
  }, [selectedEx.id]);

  // ── Demo data loader ──────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    const [bals, ords, lat] = await Promise.all([
      adapter.getBalances(),
      adapter.getOrderHistory(undefined, 20),
      adapter.ping(),
    ]);
    setBalances(bals);
    setOrders(ords);
    setLatency(lat);
  }, [adapter]);

  // ── Live data refresh ─────────────────────────────────────────────────────
  const refreshLiveData = useCallback(async () => {
    if ((mode !== 'real' && mode !== 'testnet') || !apiKey || !secretKey) return;
    setRefreshing(true);
    setBalError(null);
    setOrdError(null);
    const creds = { apiKey, secretKey, ...(passphrase ? { passphrase } : {}) };
    exchangeEvents.log('fetch-balance', selectedEx.id, 'Fetching live balances + orders', { apiKey });
    try {
      const [balRes, ordRes] = await Promise.all([
        apiClient.getBalances(selectedEx.id, creds),
        apiClient.getOrderHistory(selectedEx.id, creds, undefined, 50),
      ]);

      if (balRes.ok) {
        let bals: Array<{ asset: string; available: number; hold: number; total: number }> = [];
        try {
          const raw = (balRes.data as { balances?: unknown }).balances;
          if (Array.isArray(raw)) {
            // Defensive normalization — never trust upstream shape.
            bals = raw
              .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
              .map(b => ({
                asset:     String(b['asset'] ?? ''),
                available: num(b['available']),
                hold:      num(b['hold']),
                total:     num(b['total']),
              }))
              .filter(b => b.asset);
          }
        } catch (parseErr) {
          exchangeEvents.log('parse-response', selectedEx.id,
            `Balance parse failed: ${(parseErr as Error).message}`,
            { level: 'error' });
        }
        setLiveBalances(bals);
        credentialStore.setCache(selectedEx.id, { liveBalances: bals });
        exMode.update({ balanceFetched: true });
        if (bals.length === 0) {
          setBalError('No assets found. Make sure your API key has read permission and funds exist in any account type.');
          exMode.setConnectionState('balance_empty', 'Balance fetch returned no assets');
          exchangeEvents.log('parse-response', selectedEx.id, 'Balance response had 0 assets', { level: 'warn' });
        } else {
          exMode.setConnectionState('balance_loaded');
          exchangeEvents.log('fetch-balance', selectedEx.id, `Loaded ${bals.length} asset(s)`);
        }
      } else {
        const errMsg = balRes.error ?? 'Balance fetch failed';
        const code   = balRes.code;
        setBalError(errMsg);
        exMode.setConnectionState(codeToState(code), errMsg);
        exchangeEvents.log('fetch-balance', selectedEx.id, errMsg, { level: 'error', data: { code } });
        toast({ title: 'Balance fetch failed', description: errMsg, variant: 'destructive' });
      }

      if (ordRes.ok) {
        const rawOrders = (ordRes.data as { orders?: unknown }).orders;
        const ordsArr = Array.isArray(rawOrders) ? rawOrders : [];
        setLiveOrders(ordsArr);
        credentialStore.setCache(selectedEx.id, { liveOrders: ordsArr });
      } else {
        const errMsg = ordRes.error ?? 'Order history fetch failed';
        setOrdError(errMsg);
        exchangeEvents.log('fetch-balance', selectedEx.id, `Order history failed: ${errMsg}`, { level: 'warn', data: { code: ordRes.code } });
      }
    } catch (e) {
      const msg = (e as Error).message ?? 'Unexpected error';
      setBalError(msg);
      setOrdError(msg);
      exMode.setConnectionState('balance_error', msg);
      exchangeEvents.log('fetch-balance', selectedEx.id, `Unexpected refresh error: ${msg}`, { level: 'error' });
      toast({ title: 'Refresh failed', description: msg, variant: 'destructive' });
    } finally {
      setRefreshing(false);
    }
  }, [mode, apiKey, secretKey, passphrase, selectedEx.id, toast]);

  // ── Connect ───────────────────────────────────────────────────────────────
  const handleConnect = async () => {
    if (mode !== 'demo' && mode !== 'paper') {
      if (!apiKey.trim()) {
        toast({ title: 'API key required', description: `Enter your ${selectedEx.name} API key.`, variant: 'destructive' });
        return;
      }
      if (apiKey.trim().length < 10) {
        toast({ title: 'Invalid API key', description: 'API key appears too short.', variant: 'destructive' });
        return;
      }
      if (!secretKey.trim()) {
        toast({ title: 'Secret key required', description: 'Enter your secret key.', variant: 'destructive' });
        return;
      }
    }
    setConnecting(true);

    if (mode === 'demo' || mode === 'paper') {
      await new Promise(r => setTimeout(r, 800));
      setIsConnected(true);
      setConnecting(false);
      await loadData();
      const simLabel = mode === 'paper' ? 'Paper' : 'Demo';
      exMode.update({ mode, apiValidated: true, permissions: { read: true, trade: false, withdraw: false, futures: false }, connectedAt: Date.now() });
      setCredentials(null);
      toast({ title: `Connected to ${selectedEx.name} (${simLabel})`, description: mode === 'paper' ? 'Paper trading active. Simulated fills only — no real orders.' : 'Simulated portfolio loaded. No real funds.' });
      return;
    }

    // Testnet / Real — validate via backend
    setValidating(true);
    const creds = {
      apiKey:     apiKey.trim(),
      secretKey:  secretKey.trim(),
      ...(passphrase.trim() ? { passphrase: passphrase.trim() } : {}),
    };

    // Persist creds into the in-memory singleton FIRST so a tab-switch or
    // transient render error during validate cannot lose them. They will be
    // cleared if validation produces an unrecoverable auth/permission error.
    credentialStore.set(selectedEx.id, creds);
    setCredentials(creds);
    exMode.setConnectionState('validating');
    exchangeEvents.log('save-keys', selectedEx.id, 'Credentials saved to session store', { apiKey: creds.apiKey });

    try {
      // 1. Check exchange is reachable (no auth needed)
      exchangeEvents.log('connect', selectedEx.id, 'Pinging exchange…');
      const pingRes = await apiClient.ping(selectedEx.id);
      if ('error' in pingRes) {
        // Network blip — DO NOT silently switch to Demo. Stay in Real, mark
        // the connection state so the UI can show a retry button.
        exMode.setConnectionState('network_error', pingRes.error);
        exchangeEvents.log('connect', selectedEx.id, `Ping failed: ${pingRes.error}`, { level: 'error' });
        toast({
          title:       'Cannot reach exchange server',
          description: `${pingRes.error} You are still in ${mode === 'testnet' ? 'Testnet' : 'Real'} mode — try Connect again when the network recovers.`,
          variant:     'destructive',
        });
        setConnecting(false);
        setValidating(false);
        return;
      }
      const lat = pingRes.latency;
      exMode.update({ networkUp: true });
      exchangeEvents.log('connect', selectedEx.id, `Ping ok (${lat}ms)`);

      // 2. Validate credentials via backend proxy
      exchangeEvents.log('validate', selectedEx.id, 'Validating API credentials…', { apiKey: creds.apiKey });
      const valRes = await apiClient.validate(selectedEx.id, creds);
      if (!valRes.ok) {
        const errMsg = valRes.error ?? 'Validation failed';
        const next   = codeToState(valRes.code);
        exMode.setConnectionState(next, errMsg);
        exchangeEvents.log('validate', selectedEx.id, errMsg, { level: 'error', data: { code: valRes.code } });
        // Auth / permission failures = bad keys → drop them so the user must
        // re-enter. Network/rate_limit failures = keep them so a retry works.
        if (valRes.code === 'auth' || valRes.code === 'permission') {
          credentialStore.clear(selectedEx.id, { keepHint: true });
          setCredentials(null);
          setIsConnected(false);
        }
        toast({
          title:       valRes.code === 'auth' ? 'Invalid API credentials'
                     : valRes.code === 'permission' ? 'API key missing required permission'
                     : 'API validation failed',
          description: `${errMsg} You are still in ${mode === 'testnet' ? 'Testnet' : 'Real'} mode.`,
          variant:     'destructive',
        });
        setConnecting(false);
        setValidating(false);
        return;
      }

      // 3. Extract permissions from validated response
      const vData = (valRes as {
        data: { permissions?: { read: boolean; trade: boolean; withdraw: boolean; futures: boolean } };
      }).data;
      const perms = vData?.permissions ?? { read: true, trade: false, withdraw: false, futures: false };
      setLivePermissions(perms);
      credentialStore.setCache(selectedEx.id, { permissions: perms, latency: lat });

      // 4. Update global engine state — credentials stay in session store
      exMode.update({
        mode,
        networkUp:    true,
        apiValidated: true,
        permissions:  perms,
        connectedAt:  Date.now(),
        latency:      lat,
      });
      exMode.setConnectionState('connected');
      setLatency(lat);
      setIsConnected(true);
      exchangeEvents.log('connect', selectedEx.id, 'Connected', { data: { perms } });

      // 5. Load live balances / orders
      await refreshLiveData();

      const modeLabelStr = mode === 'testnet' ? 'Testnet' : 'Real';
      toast({
        title: `Connected to ${selectedEx.name} (${modeLabelStr})`,
        description: perms.trade
          ? 'API validated — trading permission confirmed.'
          : 'API connected but trading permission is missing on this key.',
        variant: perms.trade ? 'default' : 'destructive',
      });

    } catch (e) {
      // Unexpected error — DO NOT switch to Demo. Surface the failure and
      // keep the user where they were. Drop creds only if the error looks
      // like an auth problem.
      const msg = (e as Error)?.message ?? 'Unknown error';
      exMode.setConnectionState('balance_error', msg);
      exchangeEvents.log('connect', selectedEx.id, `Unexpected error: ${msg}`, { level: 'error' });
      toast({
        title:       'Connection error',
        description: `${msg} You are still in ${mode === 'testnet' ? 'Testnet' : 'Real'} mode — review Diagnostics tab and try again.`,
        variant:     'destructive',
      });
    } finally {
      setConnecting(false);
      setValidating(false);
    }
  };

  const handleDisconnect = () => {
    setIsConnected(false);
    setBalances([]);
    setOrders([]);
    setLiveBalances([]);
    setLiveOrders([]);
    setLivePermissions(null);
    setLatency(null);
    setCredentials(null);
    setApiKey(''); setSecretKey(''); setPassphrase('');
    credentialStore.clear(selectedEx.id);
    exMode.disconnect();
    exchangeEvents.log('disconnect', selectedEx.id, 'User disconnected');
    toast({ title: 'Disconnected', description: `${selectedEx.name} connection terminated.` });
  };

  // ── Retry connect+balance after a classified failure ─────────────────────
  // Used by the persistent inline error card. For network / rate-limit /
  // balance errors the saved creds are still in the session store, so we
  // can simply re-run the full validate+balance flow. For auth/permission
  // failures the creds were already cleared, so the card surfaces a
  // "Re-enter keys" shortcut instead and this function jumps to that tab.
  //
  // `handleConnect` closes over a lot of local state (apiKey, mode, etc.)
  // and is re-created every render. To avoid stale-closure bugs without
  // re-creating retryConnection on every render, mirror the latest
  // handleConnect into a ref and call through it.
  const handleConnectRef = useRef(handleConnect);
  useEffect(() => { handleConnectRef.current = handleConnect; });
  const retryConnection = useCallback(async () => {
    if (!credentialStore.has(selectedEx.id)) {
      setTab('connection');
      toast({ title: 'Re-enter your API keys', description: `Provide a valid ${selectedEx.name} API key to retry.` });
      return;
    }
    await handleConnectRef.current();
  }, [selectedEx.id, selectedEx.name, toast]);

  const permCheck = checkTradingPermission(['read', 'trade'], mode);
  // Defensive sums — guard every numeric input against NaN / undefined so a
  // single malformed balance row can never crash the page.
  const totalUsdValue = balances.reduce((s, b) => s + num(b?.usdtValue), 0);
  // Include all stablecoins, not just USDT
  const STABLES       = new Set(['USDT', 'USD', 'USDC', 'BUSD', 'TUSD', 'USDP', 'DAI', 'FDUSD', 'USDD']);
  const liveTotalUSD  = liveBalances
    .filter(b => b && STABLES.has(b.asset))
    .reduce((s, b) => s + num(b?.total), 0);
  const ac = selectedEx.accent;
  const isLive = mode === 'real';  // true only in real mode — real exchange data & orders

  // ── Readiness checks for Live Status tab ─────────────────────────────────
  const ready = exMode.readinessReport();

  return (
    <div className="p-4 max-w-screen-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className={`w-10 h-10 rounded-xl border flex items-center justify-center ${ACCENT_BORDER[ac]}`}>
          <ArrowLeftRight size={18} className={ACCENT_TEXT[ac]} />
        </div>
        <div>
          <h1 className="text-lg font-bold">Exchange Integration</h1>
          <p className="text-xs text-zinc-500">{selectedEx.name} · {mode === 'demo' ? 'Demo Mode' : mode === 'paper' ? 'Paper Mode' : mode === 'testnet' ? 'Testnet' : 'Real Mode'}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {isConnected ? (
            <div className="flex items-center gap-1.5 text-xs text-emerald-400">
              <motion.div className="w-2 h-2 rounded-full bg-emerald-500"
                animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1.5, repeat: Infinity }} />
              Connected · {latency !== null ? `${latency}ms` : '–'}
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
              <div className="w-2 h-2 rounded-full bg-zinc-600" /> Disconnected
            </div>
          )}
        </div>
      </div>

      {/* Status banner — demo vs live */}
      {isLive ? (
        <div className={`mb-4 px-4 py-2.5 rounded-xl border flex items-center gap-2.5 text-xs ${isConnected && modeState.permissions.trade ? 'border-red-500/30 bg-red-500/5 text-red-400' : 'border-amber-500/30 bg-amber-500/5 text-amber-400'}`}>
          <AlertTriangle size={13} className="flex-shrink-0" />
          <span>
            <strong>Real Mode</strong> — {selectedEx.name}.
            {isConnected
              ? modeState.permissions.trade
                ? ' API validated. Trade permission confirmed. Arm trading to execute real orders.'
                : ' API connected but trading permission is missing from this API key.'
              : ' Connect with real API keys to activate live trading.'}
          </span>
        </div>
      ) : mode === 'testnet' ? (
        <div className="mb-4 px-4 py-2.5 rounded-xl border flex items-center gap-2.5 text-xs border-amber-500/30 bg-amber-500/5 text-amber-400">
          <AlertTriangle size={13} className="flex-shrink-0" />
          <span>
            <strong>Testnet Mode</strong> — {selectedEx.name} sandbox.
            {isConnected ? ' Testnet API validated. Sandbox orders only — no real funds.' : ' Connect with testnet API keys. No real funds at risk.'}
          </span>
        </div>
      ) : (
        <div className={`mb-4 px-4 py-2.5 rounded-xl border flex items-center gap-2.5 text-xs ${ACCENT_BORDER[ac]} ${ACCENT_TEXT[ac]}`}>
          <Shield size={13} className="flex-shrink-0" />
          <span>
            <strong>{mode === 'paper' ? 'Paper Mode Active' : 'Demo Mode Active'}</strong> — {mode === 'paper' ? `Simulated fills on ${selectedEx.name}. Real price feed. No real orders sent.` : `Simulated ${selectedEx.name} environment. No real API keys required. No real funds at risk.`}
          </span>
        </div>
      )}

      {/* Persistent inline error card — visible across tabs while the connection
          is in a classified error state. Auto-dismisses on success because the
          connection state will leave CONNECTION_ERROR_STATES. */}
      {(mode === 'real' || mode === 'testnet') && CONNECTION_ERROR_STATES.has(modeState.connectionState) && (() => {
        const info = friendlyConnectionError(modeState.connectionState, selectedEx.name, modeState.connectionError);
        return (
          <div
            role="alert"
            className="mb-4 rounded-xl border border-red-500/40 bg-red-500/5 px-4 py-3"
            data-testid="connection-error-card"
          >
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg border border-red-500/40 bg-red-500/10 flex items-center justify-center flex-shrink-0">
                <AlertTriangle size={15} className="text-red-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold text-red-300">{info.title}</p>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-red-500/30 text-red-400 font-mono">
                    {modeState.connectionState}
                  </span>
                </div>
                <p className="text-xs text-zinc-300 mt-1 break-words">{info.body}</p>
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <Button
                    size="sm" variant="outline"
                    onClick={retryConnection} disabled={connecting || validating || refreshing}
                    className="text-xs h-7 border-red-500/40 text-red-300 hover:bg-red-500/10"
                    data-testid="connection-error-retry"
                  >
                    <RefreshCw size={11} className={`mr-1.5 ${(connecting || validating || refreshing) ? 'animate-spin' : ''}`} />
                    Retry
                  </Button>
                  {info.needsKeys && (
                    <Button
                      size="sm" variant="outline"
                      onClick={() => setTab('connection')}
                      className="text-xs h-7 border-amber-500/40 text-amber-300 hover:bg-amber-500/10"
                      data-testid="connection-error-reenter-keys"
                    >
                      <Lock size={11} className="mr-1.5" />
                      Re-enter keys
                    </Button>
                  )}
                  <button
                    type="button"
                    onClick={() => setTab('diagnostics')}
                    className="text-xs text-zinc-400 hover:text-zinc-200 underline underline-offset-2 ml-1"
                    data-testid="connection-error-open-diagnostics"
                  >
                    Open diagnostics
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Tabs */}
      <div className="flex items-center gap-2 mb-6 border-b border-zinc-800/60 pb-3 overflow-x-auto">
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors font-medium whitespace-nowrap
                ${tab === t.key
                  ? `border ${ACCENT_BORDER[ac]} ${ACCENT_TEXT[ac]}`
                  : 'text-zinc-400 hover:text-zinc-200'}`}>
              <Icon size={13} />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* ── Exchange Selector ── */}
      {tab === 'exchanges' && (<ErrorBoundary label="exchange:tab:exchanges">
        <div className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-zinc-300 mb-1">Select Exchange</h2>
            <p className="text-xs text-zinc-500 mb-4">All exchanges run in demo mode — no real funds, no API keys needed.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {KNOWN_EXCHANGES.map(ex => {
              const isSelected = selectedEx.id === ex.id;
              const dot = ACCENT_DOT[ex.accent];
              const ring = ACCENT_RING[ex.accent];
              const border = ACCENT_BORDER[ex.accent];
              return (
                <button
                  key={ex.id}
                  onClick={() => { setSelectedEx(ex); setTab('connection'); }}
                  className={`text-left p-4 rounded-xl border transition-all duration-200 group
                    ${isSelected ? `${border} ring-2 ${ring}` : 'border-zinc-800 hover:border-zinc-600'}`}
                >
                  <div className="flex items-center gap-3 mb-2">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${isSelected ? border : 'bg-zinc-800'}`}>
                      <div className={`w-3 h-3 rounded-full ${dot}`} />
                    </div>
                    <div className="min-w-0">
                      <div className={`font-semibold text-sm truncate ${isSelected ? ACCENT_TEXT[ex.accent] : 'text-zinc-200'}`}>
                        {ex.name}
                      </div>
                      <div className="text-[10px] text-zinc-500">{ex.website}</div>
                    </div>
                    {isSelected && (
                      <CheckCircle2 size={14} className={`ml-auto flex-shrink-0 ${ACCENT_TEXT[ex.accent]}`} />
                    )}
                  </div>
                  <p className="text-[11px] text-zinc-500 leading-relaxed mb-3">{ex.description}</p>
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {ex.markets.map(m => (
                      <span key={m} className="text-[9px] px-1.5 py-0.5 rounded-full bg-zinc-800 text-zinc-500 border border-zinc-700">{m}</span>
                    ))}
                  </div>
                  <div className="flex items-center gap-3 text-[10px] text-zinc-500 pt-2 border-t border-zinc-800">
                    <span>Maker: <strong className="text-zinc-300">{ex.makerFee === 0 ? '0%' : ex.makerFee < 0 ? `+${Math.abs(ex.makerFee)}% rebate` : `${ex.makerFee}%`}</strong></span>
                    <span>Taker: <strong className="text-zinc-300">{ex.takerFee}%</strong></span>
                    {ex.hasTestnet && <span className="text-emerald-400">✓ Testnet</span>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </ErrorBoundary>)}

      {/* ── Connection ── */}
      {tab === 'connection' && (<ErrorBoundary label="exchange:tab:connection">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Exchange info */}
          <Card className={`border ${ACCENT_BORDER[ac]}`}>
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${ACCENT_DOT[ac]}`} />
                {selectedEx.name}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-3">
              <p className="text-xs text-zinc-400">{selectedEx.description}</p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-2 rounded-lg bg-zinc-800/40">
                  <div className="text-zinc-500 mb-0.5">Maker fee</div>
                  <div className="font-mono font-semibold">
                    {selectedEx.makerFee === 0 ? '0.00%' : selectedEx.makerFee < 0
                      ? <span className="text-emerald-400">+{Math.abs(selectedEx.makerFee)}% rebate</span>
                      : `${selectedEx.makerFee}%`}
                  </div>
                </div>
                <div className="p-2 rounded-lg bg-zinc-800/40">
                  <div className="text-zinc-500 mb-0.5">Taker fee</div>
                  <div className="font-mono font-semibold">{selectedEx.takerFee}%</div>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {selectedEx.markets.map(m => (
                  <span key={m} className={`text-[10px] px-2 py-0.5 rounded-full border ${ACCENT_BORDER[ac]} ${ACCENT_TEXT[ac]}`}>{m}</span>
                ))}
              </div>
              <a href={`https://${selectedEx.website}`} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
                <ExternalLink size={11} /> {selectedEx.website}
              </a>
            </CardContent>
          </Card>

          {/* Mode + API config */}
          <div className="space-y-3">
            <Card className="border-zinc-800/60">
              <CardHeader className="py-3 px-4"><CardTitle className="text-sm">Exchange Mode</CardTitle></CardHeader>
              <CardContent className="p-4 space-y-2">
                {MODES.filter(m => m.key !== 'testnet' || selectedEx.hasTestnet).map(m => (
                  <button key={m.key} onClick={() => setMode(m.key)}
                    className={`w-full text-left p-3 rounded-xl border transition-colors
                      ${mode === m.key ? m.border : 'border-zinc-800 hover:border-zinc-600'}`}>
                    <div className={`font-semibold text-sm ${mode === m.key ? m.color : 'text-zinc-300'}`}>{m.label}</div>
                    <div className="text-[10px] text-zinc-500 mt-0.5">{m.desc}</div>
                  </button>
                ))}
              </CardContent>
            </Card>

            <Card className="border-zinc-800/60">
              <CardHeader className="py-3 px-4">
                <CardTitle className="text-sm flex items-center gap-2">
                  API Key Configuration
                  {isConnected && (
                    <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-normal ml-auto">
                      <motion.div className="w-1.5 h-1.5 rounded-full bg-emerald-500"
                        animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1.5, repeat: Infinity }} />
                      Connected · {latency !== null ? `${latency}ms` : '–'}
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-3">
                {isConnected ? (
                  <div className={`flex items-center gap-3 p-3 rounded-xl border ${ACCENT_BORDER[ac]}`}>
                    <CheckCircle2 size={20} className={ACCENT_TEXT[ac]} />
                    <div>
                      <p className={`font-semibold text-sm ${ACCENT_TEXT[ac]}`}>
                        Connected to {selectedEx.name}
                      </p>
                      <p className="text-[10px] text-zinc-500 mt-0.5">
                        {(mode === 'demo' || mode === 'paper') ? `${mode === 'paper' ? 'Paper' : 'Demo'} mode — simulated portfolio data.` : `${mode === 'testnet' ? 'Testnet' : 'Real'} mode — API key active.`}
                      </p>
                      {isLive && livePermissions && !livePermissions.trade && (
                        <p className="text-[10px] text-amber-400 mt-1">⚠ API connected but trading permission missing</p>
                      )}
                    </div>
                  </div>
                ) : (mode === 'demo' || mode === 'paper') ? (
                  <div className="px-4 py-3 rounded-xl bg-zinc-800/40 border border-zinc-700 text-xs text-zinc-400 space-y-1">
                    <p className="font-medium text-zinc-200">{mode === 'paper' ? 'Paper mode' : 'Demo mode'} — no API keys required</p>
                    <p>Click Connect to {mode === 'paper' ? 'activate paper trading on' : 'load simulated'} {selectedEx.name} {mode === 'paper' ? '— fills are simulated, no real orders sent.' : 'portfolio data.'}</p>
                    <p className="text-zinc-600">All trading is virtual. No real funds involved.</p>
                  </div>
                ) : (
                  <>
                    <div className="space-y-1.5">
                      <Label className="text-xs">{selectedEx.name} API Key</Label>
                      <Input value={apiKey} onChange={e => setApiKey(e.target.value)}
                        placeholder={`Enter your ${selectedEx.shortName} API key`} className="h-8 text-xs font-mono" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Secret Key</Label>
                      <div className="relative">
                        <Input type={showSecret ? 'text' : 'password'} value={secretKey} onChange={e => setSecretKey(e.target.value)}
                          placeholder="Enter your secret key" className="h-8 text-xs font-mono pr-8" />
                        <button onClick={() => setShowSecret(v => !v)}
                          className="absolute right-2 top-2 text-zinc-500 hover:text-zinc-300">
                          {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>
                      </div>
                    </div>
                    {(selectedEx.id === 'okx' || selectedEx.id === 'kucoin' || selectedEx.id === 'bitget' || selectedEx.id === 'coinbase') && (
                      <div className="space-y-1.5">
                        <Label className="text-xs">Passphrase</Label>
                        <Input type="password" value={passphrase} onChange={e => setPassphrase(e.target.value)}
                          placeholder="Required for this exchange" className="h-8 text-xs font-mono" />
                      </div>
                    )}
                    <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-500/5 border border-amber-500/20 text-[10px] text-amber-400">
                      <Lock size={11} className="flex-shrink-0 mt-0.5" />
                      Keys are kept in memory for this session only — never written to disk. Only a masked hint (e.g. abcd***wxyz) is persisted so the UI can show "previously connected" after a restart. Never share your secret key.
                    </div>
                  </>
                )}
                {isConnected ? (
                  <Button variant="outline" size="sm" onClick={handleDisconnect} className="w-full text-xs border-red-600/30 text-red-400 hover:bg-red-600/10">
                    <XCircle size={12} className="mr-1.5" /> Disconnect
                  </Button>
                ) : (
                  <Button size="sm" onClick={handleConnect} disabled={connecting}
                    className={`w-full text-xs ${ACCENT_BORDER[ac]} ${ACCENT_TEXT[ac]} border bg-transparent hover:opacity-80`}>
                    {connecting
                      ? <><RefreshCw size={12} className="animate-spin mr-1.5" />{validating ? 'Validating API…' : `Connecting to ${selectedEx.shortName}…`}</>
                      : <><Zap size={12} className="mr-1.5" />Connect to {selectedEx.shortName}</>}
                  </Button>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </ErrorBoundary>)}

      {/* ── Balances ── */}
      {tab === 'balances' && (<ErrorBoundary label="exchange:tab:balances">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-2xl font-bold font-mono">${fmt(isLive && liveBalances.length > 0 ? liveTotalUSD : totalUsdValue)}</div>
              <div className="text-xs text-zinc-500">
                {isLive && liveBalances.length > 0 ? `Stablecoin balance · ${liveBalances.length} asset${liveBalances.length !== 1 ? 's' : ''} total` : 'Total portfolio value (USDT)'} · {selectedEx.name}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={isLive ? refreshLiveData : loadData} disabled={refreshing} className="flex items-center gap-1.5 text-xs">
              <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} /> Refresh
            </Button>
          </div>
          {isLive && balError && modeState.connectionState !== 'balance_empty' && (
            <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2.5 text-xs text-red-400">
              <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
              <span>{balError}</span>
            </div>
          )}
          {isLive && modeState.connectionState === 'balance_empty' && liveBalances.length === 0 && (
            <Card className="border-zinc-800/60 bg-zinc-900/40">
              <CardContent className="p-5">
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 mt-0.5 rounded-full bg-zinc-800/80 p-2">
                    <Wallet size={18} className="text-zinc-300" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-zinc-100">
                      Connected to {selectedEx.name} — no assets found
                    </div>
                    <div className="mt-1 text-xs text-zinc-400 leading-relaxed">
                      The connection and your API key are working. The account just looks empty right now. The most common reasons:
                    </div>
                    <ul className="mt-3 space-y-2 text-xs text-zinc-300">
                      <li className="flex items-start gap-2">
                        <span className="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-zinc-500" />
                        <span><span className="font-medium text-zinc-100">No funds yet.</span> Deposit or transfer assets into this account to start trading.</span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-zinc-500" />
                        <span><span className="font-medium text-zinc-100">Wrong account type.</span> Funds in Futures, Margin, Earn or Funding wallets won&apos;t show up under Spot — move them to the matching wallet, or pick a key tied to the right account.</span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-zinc-500" />
                        <span><span className="font-medium text-zinc-100">Read-only key on a different sub-account.</span> Sub-account API keys only see that sub-account&apos;s balances. Use a master-account key, or a key issued by the sub-account that actually holds the funds.</span>
                      </li>
                    </ul>
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1.5"
                        onClick={() => window.open(`https://${selectedEx.website}`, '_blank', 'noopener,noreferrer')}
                      >
                        <ExternalLink size={11} /> Fund on {selectedEx.shortName}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1.5"
                        onClick={() => window.open(`https://www.google.com/search?q=${encodeURIComponent(`${selectedEx.name} transfer between spot futures wallet`)}`, '_blank', 'noopener,noreferrer')}
                      >
                        <ArrowLeftRight size={11} /> Switch account type
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1.5"
                        onClick={refreshLiveData}
                        disabled={refreshing}
                      >
                        <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} /> Retry
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
          {isLive && liveBalances.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {liveBalances.map(b => (
                <Card key={b.asset} className="border-zinc-800/60">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="font-bold text-sm">{b.asset}</div>
                      <Badge variant="outline" className="text-[9px]">{b.hold > 0 ? 'Partial Lock' : 'Available'}</Badge>
                    </div>
                    <div className="font-mono font-bold text-xl">{fmt(b.available, 6)}</div>
                    <div className="text-xs text-zinc-500 mt-1">Total: {fmt(b.total, 6)}</div>
                    {b.hold > 0 && <div className="text-[10px] text-amber-400 mt-0.5">Locked: {fmt(b.hold, 6)}</div>}
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {balances.map(b => (
                <Card key={b.asset} className="border-zinc-800/60">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="font-bold text-sm">{b.asset}</div>
                      <Badge variant="outline" className="text-[9px]">{b.locked > 0 ? 'Partial Lock' : 'Available'}</Badge>
                    </div>
                    <div className="font-mono font-bold text-xl">{fmt(b.free, 4)}</div>
                    <div className="text-xs text-zinc-500 mt-1">${fmt(b.usdtValue)} USDT</div>
                    {b.locked > 0 && <div className="text-[10px] text-amber-400 mt-0.5">Locked: {fmt(b.locked, 4)}</div>}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </ErrorBoundary>)}

      {/* ── Orders ── */}
      {tab === 'orders' && (<ErrorBoundary label="exchange:tab:orders">
        <Card className="border-zinc-800/60">
          <CardHeader className="py-3 px-4 flex items-center justify-between">
            <CardTitle className="text-sm">
              {isLive ? 'Live Orders' : 'Recent Orders'} — {selectedEx.name}
            </CardTitle>
            <Button variant="outline" size="sm" onClick={isLive ? refreshLiveData : loadData} disabled={refreshing} className="flex items-center gap-1.5 text-xs h-7">
              <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} /> Refresh
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            {isLive && ordError && (
              <div className="flex items-start gap-2 mx-4 mt-3 rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2.5 text-xs text-red-400">
                <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
                <span>{ordError}</span>
              </div>
            )}
            {(isLive ? liveOrders : orders).length === 0 ? (
              <div className="text-center py-12 text-zinc-500 text-sm">
                {isLive ? 'No live orders found' : 'No orders yet'}
              </div>
            ) : isLive ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-500">
                      {['Order ID', 'Symbol', 'Side', 'Type', 'Qty', 'Price', 'Filled', 'Status', 'Time'].map(h => (
                        <th key={h} className="text-left px-3 py-2 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(liveOrders as Array<Record<string, unknown>>).map((o, i) => (
                      <tr key={String(o['orderId'] ?? i)} className="border-b border-zinc-800/40 hover:bg-zinc-900/40">
                        <td className="px-3 py-2 font-mono text-zinc-500 text-[10px]">{String(o['orderId'] ?? '').slice(0, 12)}…</td>
                        <td className="px-3 py-2">{String(o['symbol'] ?? '')}</td>
                        <td className={`px-3 py-2 font-semibold ${String(o['side']) === 'buy' ? 'text-emerald-400' : 'text-red-400'}`}>{String(o['side'] ?? '').toUpperCase()}</td>
                        <td className="px-3 py-2 text-zinc-400">{String(o['type'] ?? o['orderType'] ?? '').toUpperCase()}</td>
                        <td className="px-3 py-2 font-mono">{fmt(Number(o['quantity'] ?? 0), 6)}</td>
                        <td className="px-3 py-2 font-mono">{Number(o['price']) > 0 ? `$${fmt(Number(o['price']))}` : 'Market'}</td>
                        <td className="px-3 py-2 font-mono text-emerald-400">{fmt(Number(o['filledQty'] ?? 0), 6)}</td>
                        <td className="px-3 py-2">
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">{String(o['status'] ?? 'open')}</span>
                        </td>
                        {/* eslint-disable-next-line react-hooks/purity */}
                        <td className="px-3 py-2 text-zinc-500">{new Date(Number(o['timestamp']) || Date.now()).toLocaleTimeString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-500">
                      {['Order ID', 'Symbol', 'Side', 'Qty', 'Price', 'Fee', 'Status', 'Time'].map(h => (
                        <th key={h} className="text-left px-3 py-2 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(orders as ExchangeOrder[]).map(o => (
                      <tr key={o.orderId} className="border-b border-zinc-800/40 hover:bg-zinc-900/40">
                        <td className="px-3 py-2 font-mono text-zinc-500 text-[10px]">{o.orderId.slice(0, 12)}…</td>
                        <td className="px-3 py-2">{o.symbol}</td>
                        <td className={`px-3 py-2 font-semibold ${o.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>{o.side}</td>
                        <td className="px-3 py-2 font-mono">{fmt(o.quantity, 4)}</td>
                        <td className="px-3 py-2 font-mono">${fmt(o.price)}</td>
                        <td className="px-3 py-2 font-mono text-amber-400">${fmt(o.fee, 4)}</td>
                        <td className="px-3 py-2">
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">{o.status}</span>
                        </td>
                        <td className="px-3 py-2 text-zinc-500">{new Date(o.timestamp).toLocaleTimeString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </ErrorBoundary>)}

      {/* ── Permissions ── */}
      {tab === 'permissions' && (<ErrorBoundary label="exchange:tab:permissions">
        <div className="space-y-4">
          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4"><CardTitle className="text-sm">API Permissions & Security — {selectedEx.name}</CardTitle></CardHeader>
            <CardContent className="p-4 space-y-3">
              <div className={`flex items-center gap-3 p-3 rounded-xl border ${permCheck.allowed ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
                {permCheck.allowed ? <CheckCircle2 size={16} className="text-emerald-400" /> : <XCircle size={16} className="text-red-400" />}
                <div>
                  <div className={`text-sm font-medium ${permCheck.allowed ? 'text-emerald-400' : 'text-red-400'}`}>
                    Trading Permission: {permCheck.allowed ? 'Allowed' : 'Denied'}
                  </div>
                  <div className="text-xs text-zinc-500">{permCheck.reason}</div>
                </div>
              </div>
              {isLive && livePermissions && (
                <div className="p-3 rounded-xl bg-zinc-800/30 border border-zinc-700 text-xs space-y-2">
                  <p className="text-zinc-400 font-medium">Live API permissions from {selectedEx.name}:</p>
                  {[
                    { label: 'Read / General',   ok: livePermissions.read     },
                    { label: 'Trade',             ok: livePermissions.trade    },
                    { label: 'Withdraw',          ok: livePermissions.withdraw },
                    { label: 'Futures',           ok: livePermissions.futures  },
                  ].map(p => (
                    <div key={p.label} className="flex items-center gap-2">
                      <StatusDot ok={p.ok} />
                      <span className={p.ok ? 'text-zinc-200' : 'text-zinc-500'}>{p.label}</span>
                      {!p.ok && p.label === 'Trade' && (
                        <span className="text-amber-400 text-[10px]">— trading blocked</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {[
                { perm: 'Read Balance',   granted: true,           risk: 'Low'  },
                { perm: 'Read Orders',    granted: true,           risk: 'Low'  },
                { perm: 'Place Orders',   granted: mode !== 'real', risk: mode === 'real' ? 'High' : mode === 'testnet' ? 'Sandbox' : 'Simulated' },
                { perm: 'Cancel Orders',  granted: true,           risk: 'Low'  },
                { perm: 'Withdraw Funds', granted: false,          risk: 'Critical — disabled for safety' },
              ].map(p => (
                <div key={p.perm} className="flex items-center gap-3 py-2 border-b border-zinc-800/40 last:border-0">
                  {p.granted ? <CheckCircle2 size={13} className="text-emerald-400" /> : <XCircle size={13} className="text-zinc-600" />}
                  <span className="text-sm flex-1">{p.perm}</span>
                  <span className={`text-[10px] ${p.risk === 'Critical — disabled for safety' ? 'text-red-400' : p.risk === 'High' ? 'text-amber-400' : 'text-zinc-500'}`}>{p.risk}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </ErrorBoundary>)}

      {/* ── Live Status (NEW) ── */}
      {tab === 'livestatus' && (<ErrorBoundary label="exchange:tab:livestatus">
        <div className="space-y-4">
          {isLive && modeState.connectionState === 'balance_empty' && liveBalances.length === 0 && (
            <Card className="border-zinc-800/60 bg-zinc-900/40">
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 mt-0.5 rounded-full bg-zinc-800/80 p-2">
                    <Wallet size={16} className="text-zinc-300" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-zinc-100">
                      Connected to {selectedEx.name} — no assets found
                    </div>
                    <div className="mt-1 text-xs text-zinc-400 leading-relaxed">
                      The connection and your API key are working — the account just looks empty. Common causes: no funds yet, funds in a different wallet (Futures, Margin, Earn, Funding), or a sub-account key that can&apos;t see this balance.
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1.5"
                        onClick={() => setTab('balances')}
                      >
                        See Balances tab for details
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1.5"
                        onClick={refreshLiveData}
                        disabled={refreshing}
                      >
                        <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} /> Retry
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
          {/* Readiness summary */}
          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4"><CardTitle className="text-sm flex items-center gap-2"><Activity size={13} /> Execution Readiness — {selectedEx.name}</CardTitle></CardHeader>
            <CardContent className="p-4 space-y-2">
              {[
                { label: 'Live Mode',         ok: !!ready['liveMode'],        note: ready['liveMode'] ? '' : 'Switch to Real in Connection tab' },
                { label: 'Network Up',         ok: !!ready['networkUp'],       note: ready['networkUp'] ? '' : 'Connect to exchange first' },
                { label: 'API Validated',      ok: !!ready['apiValidated'],    note: ready['apiValidated'] ? '' : 'Connect with real API keys' },
                { label: 'Balance Fetched',    ok: !!ready['balanceFetched'],  note: ready['balanceFetched'] ? '' : 'Fetch balances after connecting' },
                { label: 'Trade Permission',   ok: !!ready['tradePermission'], note: ready['tradePermission'] ? '' : 'API key must have trade permission' },
                { label: 'Trading Armed',      ok: !!ready['tradingArmed'],    note: ready['tradingArmed'] ? '' : 'Toggle arm below' },
              ].map(r => (
                <div key={r.label} className="flex items-center gap-3 py-1.5 border-b border-zinc-800/30 last:border-0">
                  <StatusDot ok={r.ok} />
                  <span className={`text-xs flex-1 ${r.ok ? 'text-zinc-200' : 'text-zinc-500'}`}>{r.label}</span>
                  {r.note && <span className="text-[10px] text-zinc-600 max-w-[180px] text-right">{r.note}</span>}
                </div>
              ))}
              <div className={`mt-3 px-3 py-2 rounded-xl border text-xs font-medium flex items-center gap-2 ${ready['ready'] ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-400' : 'border-zinc-700 bg-zinc-800/30 text-zinc-500'}`}>
                <Crosshair size={12} />
                {ready['ready'] ? 'Execution Ready — signals will place real orders.' : 'Not ready — complete all checks above before arming.'}
              </div>
            </CardContent>
          </Card>

          {/* Arm / Disarm */}
          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4"><CardTitle className="text-sm">Trading Armed</CardTitle></CardHeader>
            <CardContent className="p-4 space-y-3">
              <div className={`flex items-center justify-between p-3 rounded-xl border ${modeState.armed ? 'border-red-500/30 bg-red-500/5' : 'border-zinc-700 bg-zinc-800/20'}`}>
                <div>
                  <p className={`text-sm font-semibold ${modeState.armed ? 'text-red-400' : 'text-zinc-400'}`}>
                    {modeState.armed ? '🔴 ARMED — Live orders will be placed' : '⚪ DISARMED — No real orders will be placed'}
                  </p>
                  <p className="text-[10px] text-zinc-600 mt-0.5">Requires: Real mode + network up + validated API + balance fetched + trade permission</p>
                </div>
                <Switch
                  checked={modeState.armed}
                  disabled={!exMode.canArm() && !modeState.armed}
                  onCheckedChange={checked => {
                    if (!checked) { exMode.disarm(); return; }
                    if (modeState.mode !== 'real') {
                      toast({ title: 'Cannot arm', description: 'Switch to Real mode first.', variant: 'destructive' }); return;
                    }
                    if (!modeState.networkUp) {
                      toast({ title: 'Cannot arm', description: 'Connection is not healthy. Reconnect first.', variant: 'destructive' }); return;
                    }
                    if (!modeState.apiValidated) {
                      toast({ title: 'Cannot arm', description: 'Validate your API key first.', variant: 'destructive' }); return;
                    }
                    if (!modeState.balanceFetched) {
                      toast({ title: 'Cannot arm', description: 'Fetch your live balance first.', variant: 'destructive' }); return;
                    }
                    if (!modeState.permissions.trade) {
                      toast({ title: 'Cannot arm', description: 'API key does not have trade permission.', variant: 'destructive' }); return;
                    }
                    if (!exMode.arm()) {
                      toast({ title: 'Cannot arm', description: 'Readiness check failed. Open the Live Status tab to see what\u2019s missing.', variant: 'destructive' });
                    }
                  }}
                  className={modeState.armed ? 'data-[state=checked]:bg-red-500' : ''}
                />
              </div>
              <div className="space-y-1.5 text-[10px] text-zinc-600">
                <p>• Arming only possible when all readiness checks pass</p>
                <p>• Trading is disarmed automatically when you disconnect or reload</p>
                <p>• Emergency stop in Trade Config overrides arm status</p>
              </div>
            </CardContent>
          </Card>

          {/* Live connection details */}
          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4"><CardTitle className="text-sm">Connection Details</CardTitle></CardHeader>
            <CardContent className="p-4 space-y-2 text-xs">
              {[
                { label: 'Exchange',        value: selectedEx.name },
                { label: 'Mode',            value: mode === 'demo' ? 'Demo' : mode === 'paper' ? 'Paper' : mode === 'testnet' ? 'Testnet' : 'Real' },
                { label: 'Connected',       value: isConnected ? 'Yes' : 'No' },
                { label: 'Latency',         value: latency !== null ? `${latency}ms` : '—' },
                { label: 'Last Sync',       value: modeState.connectedAt ? new Date(modeState.connectedAt).toLocaleTimeString() : '—' },
                { label: 'UID / Account',   value: modeState.uid ?? '—' },
                { label: 'Adapter Status',  value: isConnected ? 'Ready' : 'Disconnected' },
              ].map(row => (
                <div key={row.label} className="flex items-center justify-between py-1 border-b border-zinc-800/30 last:border-0">
                  <span className="text-zinc-500">{row.label}</span>
                  <span className="text-zinc-300 font-mono">{row.value}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </ErrorBoundary>)}

      {/* ── Trade Config (NEW) ── */}
      {tab === 'tradeconfig' && (<ErrorBoundary label="exchange:tab:tradeconfig">
        <div className="space-y-4">
          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <Settings size={13} /> Trade Settings — {selectedEx.name}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-1">
              <CfgRow label="Trade amount per order (USD)">
                <Input type="number" value={config.tradeAmountUSD} min={1}
                  onChange={e => tradeConfig.set(selectedEx.id, { tradeAmountUSD: Number(e.target.value) })}
                  className="h-7 w-28 text-xs font-mono text-right" />
              </CfgRow>
              <CfgRow label="Max daily trades (0 = unlimited)">
                <Input type="number" value={config.maxDailyTrades} min={0}
                  onChange={e => tradeConfig.set(selectedEx.id, { maxDailyTrades: Number(e.target.value) })}
                  className="h-7 w-28 text-xs font-mono text-right" />
              </CfgRow>
              <CfgRow label="Max open positions (0 = unlimited)">
                <Input type="number" value={config.maxOpenPositions} min={0}
                  onChange={e => tradeConfig.set(selectedEx.id, { maxOpenPositions: Number(e.target.value) })}
                  className="h-7 w-28 text-xs font-mono text-right" />
              </CfgRow>
              <CfgRow label="Stop loss %">
                <Input type="number" value={config.stopLossPct} min={0} step={0.1}
                  onChange={e => tradeConfig.set(selectedEx.id, { stopLossPct: Number(e.target.value) })}
                  className="h-7 w-28 text-xs font-mono text-right" />
              </CfgRow>
              <CfgRow label="Take profit %">
                <Input type="number" value={config.takeProfitPct} min={0} step={0.1}
                  onChange={e => tradeConfig.set(selectedEx.id, { takeProfitPct: Number(e.target.value) })}
                  className="h-7 w-28 text-xs font-mono text-right" />
              </CfgRow>
              <CfgRow label="Cooldown between trades (seconds)">
                <Input type="number" value={config.cooldownSeconds} min={0}
                  onChange={e => tradeConfig.set(selectedEx.id, { cooldownSeconds: Number(e.target.value) })}
                  className="h-7 w-28 text-xs font-mono text-right" />
              </CfgRow>
              <CfgRow label="Order type">
                <select value={config.orderType}
                  onChange={e => tradeConfig.set(selectedEx.id, { orderType: e.target.value as 'market' | 'limit' })}
                  className="h-7 px-2 text-xs bg-zinc-800 border border-zinc-700 rounded text-zinc-200">
                  <option value="market">Market</option>
                  <option value="limit">Limit</option>
                </select>
              </CfgRow>
              <CfgRow label="Only-long (spot — disable short)">
                <Switch checked={config.onlyLong}
                  onCheckedChange={v => tradeConfig.set(selectedEx.id, { onlyLong: v })} />
              </CfgRow>
              <CfgRow label="Allowed symbols (comma-separated, empty = all)">
                <Input value={config.allowedSymbols.join(',')} placeholder="BTC,ETH,SOL"
                  onChange={e => tradeConfig.set(selectedEx.id, { allowedSymbols: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                  className="h-7 w-36 text-xs font-mono" />
              </CfgRow>
              <CfgRow label="Emergency stop (halts ALL execution)">
                <Switch checked={config.emergencyStop}
                  onCheckedChange={v => {
                    tradeConfig.set(selectedEx.id, { emergencyStop: v });
                    if (v) toast({ title: '🛑 Emergency Stop ACTIVATED', description: 'All trade execution is now halted.', variant: 'destructive' });
                    else toast({ title: 'Emergency Stop deactivated', description: 'Trading can resume when all conditions are met.' });
                  }}
                  className={config.emergencyStop ? 'data-[state=checked]:bg-red-600' : ''} />
              </CfgRow>
            </CardContent>
          </Card>
          <Button variant="outline" size="sm" onClick={() => { tradeConfig.reset(selectedEx.id); setConfig(tradeConfig.get(selectedEx.id)); }}
            className="text-xs text-zinc-500 border-zinc-700">
            Reset to defaults
          </Button>
        </div>
      </ErrorBoundary>)}

      {/* ── Execution Log (NEW) ── */}
      {tab === 'execlog' && (<ErrorBoundary label="exchange:tab:execlog">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-zinc-300">Execution Log</h2>
              <p className="text-xs text-zinc-500">{logEntries.length} entries · last 500 preserved</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => { executionLog.clear(); }} className="text-xs border-zinc-700 text-zinc-500 h-7">
              Clear log
            </Button>
          </div>

          {/* Summary stats */}
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: 'Executed', count: executionLog.executed().length, color: 'text-emerald-400' },
              { label: 'Pending',  count: executionLog.pending().length,  color: 'text-amber-400'   },
              { label: 'Rejected', count: executionLog.rejected().length, color: 'text-red-400'     },
              { label: 'Total',    count: logEntries.length,              color: 'text-zinc-300'    },
            ].map(s => (
              <div key={s.label} className="p-3 rounded-xl bg-zinc-800/40 border border-zinc-800 text-center">
                <div className={`text-xl font-bold font-mono ${s.color}`}>{s.count}</div>
                <div className="text-[10px] text-zinc-500 mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>

          {/* Log table */}
          <Card className="border-zinc-800/60">
            <CardContent className="p-0">
              {logEntries.length === 0 ? (
                <div className="text-center py-12 text-zinc-500 text-sm">No execution log entries yet</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-zinc-800 text-zinc-500">
                        {['Time', 'Mode', 'Exchange', 'Symbol', 'Side', 'Qty', 'Price ($)', 'Status', 'Detail'].map(h => (
                          <th key={h} className="text-left px-3 py-2 font-medium whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {logEntries.map(e => (
                        <tr key={e.id} className="border-b border-zinc-800/40 hover:bg-zinc-900/40">
                          <td className="px-3 py-2 text-zinc-500 whitespace-nowrap">{new Date(e.ts).toLocaleTimeString()}</td>
                          <td className="px-3 py-2">
                            <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${
                              e.mode === 'real'    ? 'border-red-500/40 text-red-400 bg-red-500/5'          :
                              e.mode === 'testnet' ? 'border-orange-500/40 text-orange-400 bg-orange-500/5' :
                              e.mode === 'paper'   ? 'border-yellow-500/40 text-yellow-400 bg-yellow-500/5' :
                                                     'border-blue-500/30 text-blue-400 bg-blue-500/5'
                            }`}>
                              {e.mode.toUpperCase()}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-zinc-400">{e.exchange}</td>
                          <td className="px-3 py-2 font-mono font-semibold">{e.symbol}</td>
                          <td className={`px-3 py-2 font-semibold ${e.side === 'buy' ? 'text-emerald-400' : 'text-red-400'}`}>{e.side.toUpperCase()}</td>
                          <td className="px-3 py-2 font-mono">{e.quantity > 0 ? fmt(e.quantity, 5) : '—'}</td>
                          <td className="px-3 py-2 font-mono">{e.price > 0 ? fmt(e.price) : '—'}</td>
                          <td className="px-3 py-2">
                            <span className={`text-[9px] px-1.5 py-0.5 rounded-full border whitespace-nowrap
                              ${e.status === 'executed' ? 'border-emerald-500/30 text-emerald-400 bg-emerald-500/5' :
                                e.status === 'rejected' || e.status === 'failed' ? 'border-red-500/30 text-red-400 bg-red-500/5' :
                                e.status === 'executing' ? 'border-amber-500/30 text-amber-400 bg-amber-500/5' :
                                'border-zinc-700 text-zinc-400'}`}>
                              {e.status}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-zinc-600 max-w-[200px] truncate">
                            {e.rejectReason ? <span className="text-red-400">{e.rejectReason}</span>
                              : e.orderId ? <span className="font-mono text-zinc-500">#{e.orderId.slice(0, 10)}</span>
                              : e.errorMsg ? <span className="text-amber-400">{e.errorMsg.slice(0, 40)}</span>
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </ErrorBoundary>)}

      {/* ── Diagnostics ── */}
      {tab === 'diagnostics' && (<ErrorBoundary label="exchange:tab:diagnostics">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-zinc-200">Connection Diagnostics</h2>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                Connection state: <span className="text-zinc-300 font-mono">{modeState.connectionState}</span>
                {modeState.connectionError ? <> · <span className="text-red-400">{modeState.connectionError}</span></> : null}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline" size="sm"
                onClick={async () => {
                  try { await navigator.clipboard.writeText(exchangeEvents.toText()); toast({ title: 'Diagnostics copied to clipboard' }); }
                  catch { toast({ title: 'Clipboard unavailable', variant: 'destructive' }); }
                }}
                className="text-xs h-7"
              >Copy log</Button>
              <Button
                variant="outline" size="sm"
                onClick={() => { exchangeEvents.clear(); }}
                className="text-xs h-7 border-zinc-700 text-zinc-500"
              >Clear</Button>
            </div>
          </div>

          <Card className="border-zinc-800/60">
            <CardContent className="p-0">
              {diagEvents.length === 0 ? (
                <div className="text-center py-12 text-zinc-500 text-sm">No exchange events recorded yet.</div>
              ) : (
                <div className="overflow-x-auto max-h-[60vh]">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-zinc-950">
                      <tr className="border-b border-zinc-800 text-zinc-500">
                        {['Time', 'Stage', 'Exchange', 'Level', 'Message'].map(h => (
                          <th key={h} className="text-left px-3 py-2 font-medium whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...diagEvents].reverse().map(ev => (
                        <tr key={ev.id} className="border-b border-zinc-800/40 hover:bg-zinc-900/40 align-top">
                          <td className="px-3 py-2 text-zinc-500 whitespace-nowrap font-mono text-[10px]">
                            {new Date(ev.ts).toLocaleTimeString()}
                          </td>
                          <td className="px-3 py-2 text-zinc-300 font-mono text-[10px] whitespace-nowrap">{ev.stage}</td>
                          <td className="px-3 py-2 text-zinc-400">{ev.exchange || '—'}</td>
                          <td className="px-3 py-2">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                              ev.level === 'error' ? 'border-red-500/40 text-red-400 bg-red-500/5' :
                              ev.level === 'warn'  ? 'border-amber-500/40 text-amber-400 bg-amber-500/5' :
                                                     'border-zinc-700 text-zinc-400 bg-zinc-800/30'}`}>
                              {ev.level}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-zinc-300">
                            <div className="break-words">{ev.message}</div>
                            {ev.data && Object.keys(ev.data).length > 0 && (
                              <div className="text-[10px] text-zinc-600 mt-0.5 font-mono break-all">
                                {JSON.stringify(ev.data)}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </ErrorBoundary>)}
    </div>
  );
}
