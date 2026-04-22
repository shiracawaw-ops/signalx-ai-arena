
import React, { useState, useEffect, useCallback, useRef } from 'react';
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
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import {
  ArrowLeftRight, CheckCircle2, XCircle, RefreshCw, Shield,
  Eye, EyeOff, Zap, Wallet, Clock, Lock, ExternalLink, Globe,
  Activity, Settings, FileText, AlertTriangle, Crosshair, Send, X,
  ChevronDown,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

// ── New engine imports ────────────────────────────────────────────────────────
import { exchangeMode as exMode }   from '@/lib/exchange-mode';
import type { ExchangeModeState, ConnectionState } from '@/lib/exchange-mode';
import { tradeConfig, type TradeConfig, POLL_TIMEOUT_MIN_SEC, POLL_TIMEOUT_MAX_SEC } from '@/lib/trade-config';
import { executionLog, type ExecutionEntry } from '@/lib/execution-log';
import { apiClient, type ExchangeErrorCode } from '@/lib/api-client';
import { setCredentials, executeSignal } from '@/lib/execution-engine';
import { classifyHolding, POSITION_CATEGORY_LABELS, POSITION_CATEGORY_ORDER, type PositionCategory, type ClassifyResult } from '@/lib/position-classifier';
import { getOwned } from '@/lib/internal-positions';
import { pipelineCache } from '@/lib/pipeline-cache';
import { resolveCompliance, type ExchangeId } from '@/lib/asset-compliance';
import { botDoctorStore, useBotDoctor } from '@/lib/bot-doctor-store';
import type { SymbolRules } from '@/lib/risk-manager';
import { submitManualOrder }      from '@/lib/live-execution-bridge';
import { credentialStore }          from '@/lib/credential-store';
import { exchangeEvents, type ExchangeEvent, type ExchangeStage } from '@/lib/exchange-events';
import { orderProgress, TERMINAL_PHASES, type OrderProgress, type ProgressPhase } from '@/lib/order-progress';

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
  { key: 'manual',      label: 'Manual Order',  icon: Send           },
  { key: 'execlog',     label: 'Execution Log', icon: FileText       },
  { key: 'diagnostics', label: 'Diagnostics',   icon: AlertTriangle  },
] as const;

// Per-source key helpers for the shared `orderProgress` store.
const closeKey    = (asset: string)   => `close:${asset}`;
const manualKey   = (orderId: string) => `manual:${orderId}`;

// ── Status dot ────────────────────────────────────────────────────────────────
function StatusDot({ ok }: { ok: boolean }) {
  return ok
    ? <CheckCircle2 size={13} className="text-emerald-400 flex-shrink-0" />
    : <XCircle      size={13} className="text-zinc-600 flex-shrink-0" />;
}

// ── Shared inline progress panel (close-position, manual order, autopilot) ──
// Renders Submitting → Pending → Filled with fill-bar / qty / avg-price.
// Driven entirely by the singleton `orderProgress` store — see
// lib/order-progress.ts. Used in three places:
//   • Balances tab (close-position)
//   • Manual Order tab (manual submissions)
//   • Live Status tab (autopilot fills)
function OrderProgressPanel({
  p, dense, testIdSuffix, onDismiss, onResume, showHeader,
}: {
  p:            OrderProgress;
  dense?:       boolean;
  testIdSuffix: string;
  onDismiss:    () => void;
  onResume?:    () => void;
  showHeader?:  boolean;
}) {
  const STEPS: Array<{ key: ProgressPhase; label: string }> = [
    { key: 'submitting', label: 'Submitting' },
    { key: 'pending',    label: 'Pending'    },
    { key: 'filled',     label: 'Filled'     },
  ];
  const order: Record<ProgressPhase, number> = {
    submitting: 0, pending: 1, partial: 1,
    filled: 2, canceled: 2, rejected: 2, timeout: 2, error: 2,
  };
  const cur   = order[p.phase];
  const isErr = p.phase === 'rejected' || p.phase === 'error' || p.phase === 'canceled' || p.phase === 'timeout';
  const isDone = TERMINAL_PHASES.has(p.phase);
  const fillPct = p.quantity > 0
    ? Math.min(100, Math.max(0, (p.filledQty / p.quantity) * 100))
    : (p.phase === 'filled' ? 100 : 0);
  const phaseLabel =
    p.phase === 'submitting' ? 'Submitting…'
  : p.phase === 'pending'    ? 'Pending on exchange'
  : p.phase === 'partial'    ? 'Partial fill'
  : p.phase === 'filled'     ? (p.source === 'close' ? 'Fully filled — position flattened' : 'Fully filled')
  : p.phase === 'canceled'   ? 'Canceled by exchange'
  : p.phase === 'rejected'   ? 'Rejected'
  : p.phase === 'timeout'    ? 'Polling timed out'
                             : 'Error';
  return (
    <div
      className={`${dense ? 'mt-3' : 'mt-2'} rounded-md border ${dense ? 'p-2 text-[10px]' : 'p-3 text-xs'} ${
        isErr ? 'border-red-500/40 bg-red-500/5'
              : p.phase === 'filled' ? 'border-emerald-500/40 bg-emerald-500/5'
                                     : 'border-zinc-700/60 bg-zinc-800/30'}`}
      data-testid={`order-progress-${testIdSuffix}`}
    >
      {showHeader && (
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
            {p.label ?? `${p.source} ${p.side.toUpperCase()} ${p.symbol}`}
          </div>
          {isDone && (
            <button
              type="button"
              onClick={onDismiss}
              className="text-zinc-500 hover:text-zinc-300"
              aria-label="Dismiss progress panel"
              data-testid={`button-dismiss-progress-${testIdSuffix}`}
            >
              <X size={11} />
            </button>
          )}
        </div>
      )}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          {STEPS.map((s, i) => {
            const done = i < cur || (i === cur && (p.phase === 'filled' || p.phase === 'partial'));
            const active = i === cur && !isErr;
            return (
              <div key={s.key} className="flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 rounded-full ${
                  isErr && i === cur ? 'bg-red-400'
                    : done   ? 'bg-emerald-400'
                    : active ? 'bg-amber-400 animate-pulse'
                             : 'bg-zinc-600'}`} />
                <span className={`${
                  isErr && i === cur ? 'text-red-300'
                    : done ? 'text-emerald-300'
                    : active ? 'text-amber-300'
                             : 'text-zinc-500'}`}>{s.label}</span>
                {i < STEPS.length - 1 && <span className="text-zinc-700">›</span>}
              </div>
            );
          })}
        </div>
        {!showHeader && (
          <button
            type="button"
            onClick={onDismiss}
            className="text-zinc-500 hover:text-zinc-300"
            aria-label="Dismiss progress panel"
            data-testid={`button-dismiss-progress-${testIdSuffix}`}
          >
            <X size={11} />
          </button>
        )}
      </div>
      <div className="font-mono">
        <span className={isErr ? 'text-red-400' : p.phase === 'filled' ? 'text-emerald-400' : 'text-zinc-200'}>
          {phaseLabel}
        </span>
      </div>
      {(p.quantity > 0 || p.filledQty > 0) && (
        <>
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded bg-zinc-800">
            <div
              className={`h-full ${p.phase === 'filled' ? 'bg-emerald-400' : isErr ? 'bg-red-400' : 'bg-amber-400'}`}
              style={{ width: `${fillPct}%` }}
            />
          </div>
          <div className="mt-1 flex items-center justify-between text-zinc-400">
            <span>
              Filled <span className="font-mono text-zinc-200">{fmt(p.filledQty, 6)}</span>
              {p.quantity > 0 && <> / <span className="font-mono">{fmt(p.quantity, 6)}</span></>}
              {' '}{p.symbol}
            </span>
            <span>
              Avg <span className="font-mono text-zinc-200">${p.avgPrice > 0 ? fmt(p.avgPrice, 2) : '—'}</span>
            </span>
          </div>
        </>
      )}
      {p.message && (
        <div className={`mt-1 ${isErr ? 'text-red-300' : 'text-zinc-400'}`}>{p.message}</div>
      )}
      {!isDone && p.retry && p.retry.consecutiveErrors > 0 && (
        <div
          className="mt-1 flex items-center gap-1 text-amber-300"
          data-testid={`order-progress-retry-${testIdSuffix}`}
        >
          <RefreshCw size={10} className="animate-spin" />
          <span>
            Retrying in {Math.round(p.retry.nextDelayMs / 1000)}s — exchange unreachable
            {p.retry.consecutiveErrors > 1 && (
              <span className="text-zinc-500"> (attempt {p.retry.consecutiveErrors})</span>
            )}
          </span>
        </div>
      )}
      {p.phase === 'timeout' && p.resumable && onResume && (
        <div className="mt-2">
          <button
            type="button"
            onClick={onResume}
            className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold text-amber-300 hover:bg-amber-500/20 hover:text-amber-200"
            data-testid={`button-resume-progress-${testIdSuffix}`}
          >
            <RefreshCw size={10} /> Resume polling
          </button>
        </div>
      )}
      {p.orderId && (
        <div className="mt-1 text-zinc-500">Order: <span className="font-mono">{p.orderId.slice(0, 16)}{p.orderId.length > 16 ? '…' : ''}</span></div>
      )}
    </div>
  );
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
  const [diagStageFilter, setDiagStageFilter] = useState<Set<ExchangeStage>>(new Set());
  const [connecting,  setConnecting]  = useState(false);
  const [balances,    setBalances]    = useState<ExchangeBalance[]>([]);
  const [orders,      setOrders]      = useState<ExchangeOrder[]>([]);
  const [latency,     setLatency]     = useState<number | null>(null);

  // ── Engine state ──────────────────────────────────────────────────────────
  const [modeState,   setModeState]   = useState<ExchangeModeState>(exMode.get());
  const [config,      setConfig]      = useState<TradeConfig>(tradeConfig.get(selectedEx.id));
  const [logEntries,  setLogEntries]  = useState<ExecutionEntry[]>(executionLog.all());
  const [liveBalances, setLiveBalances] = useState<Array<{ asset: string; available: number; hold: number; total: number; usdtValue?: number; scope?: string }>>([]);
  const [liveSummary,  setLiveSummary]  = useState<import('../lib/api-client.js').BalanceSummary | null>(null);
  const [liveOrders,   setLiveOrders]  = useState<unknown[]>([]);
  const [livePermissions, setLivePermissions] = useState<{
    read: boolean; trade: boolean; withdraw: boolean; futures: boolean;
    spot?: boolean; margin?: boolean; options?: boolean; accountType?: string;
  } | null>(null);
  // ── Diagnostics state — populated by the "Run Self-Test" button. Kept in
  // a single object so we can render a transparent panel with every step
  // Binance returned (canTrade flag, accountType, IP, error codes, …).
  const [diagnostic, setDiagnostic] = useState<import('../lib/api-client.js').ExchangeDiagnostic | null>(null);
  const [selfTest,   setSelfTest]   = useState<import('../lib/api-client.js').SelfTestResult | null>(null);
  const [diagBusy,   setDiagBusy]   = useState(false);
  // ── Order Self-Test state — probes a real order against exchange filters
  // (and Binance /api/v3/order/test where supported) WITHOUT placing it.
  const [orderTestSymbol, setOrderTestSymbol] = useState('BTC');
  const [orderTestSide,   setOrderTestSide]   = useState<'buy' | 'sell'>('buy');
  const [orderTestUSD,    setOrderTestUSD]    = useState<string>('15');
  const [orderTestBusy,   setOrderTestBusy]   = useState(false);
  const [orderTestResult, setOrderTestResult] = useState<{
    ok: boolean; reason?: string; detail?: string; exchangeCode?: string | number;
    rules?: Record<string, unknown>; echo?: { symbol: string; side: string; quantity: string; price?: string };
    requestedUSD?: number; livePrice?: number;
  } | null>(null);
  const [refreshing,   setRefreshing]  = useState(false);
  const [validating,   setValidating]  = useState(false);
  const [balError,     setBalError]    = useState<string | null>(null);
  const [ordError,     setOrdError]    = useState<string | null>(null);

  // ── Manual Order form state ─────────────────────────────────────────────
  // The form is just a thin shell over executeSignal — it inherits every
  // gate (mode, armed, validated, perms, creds, risk, dedupe, retry) from
  // the engine. We deliberately do NOT bypass the engine here.
  const [manualSymbol, setManualSymbol] = useState('BTC');
  const [manualSide,   setManualSide]   = useState<'buy' | 'sell'>('buy');
  const [manualPriceOverride, setManualPriceOverride] = useState<string>('');
  const [manualSubmitting, setManualSubmitting] = useState(false);
  const [manualResult, setManualResult] = useState<{ ok: boolean; message: string } | null>(null);

  // ── Per-row action busy flags ──────────────────────────────────────────────
  // Keyed by orderId for cancels and by asset symbol for close-position so the
  // user can't double-click and so spinners only show on the row being acted on.
  const [cancellingOrders, setCancellingOrders] = useState<Set<string>>(new Set());
  const [closingPositions, setClosingPositions] = useState<Set<string>>(new Set());

  // ── Cancel-all-open-orders state ───────────────────────────────────────────
  // `cancelAllOpen` toggles the Real-mode "type CANCEL ALL" confirmation dialog.
  // `cancelAllConfirmText` is the controlled value of that input — only an
  // exact match unlocks the destructive action.
  // `cancellingAll` is the in-flight flag so the bulk button can show a
  // spinner and double-click guards work even while parallel cancels race.
  const [cancelAllOpen, setCancelAllOpen] = useState(false);
  const [cancelAllConfirmText, setCancelAllConfirmText] = useState('');
  const [cancellingAll, setCancellingAll] = useState(false);
  // Live progress while a bulk cancel is running. `total` is set when the
  // batch starts; `done` and `failed` increment per-result as each cancel
  // settles so the button can show "12 / 50 cancelled, 1 failed".
  const [cancelAllProgress, setCancelAllProgress] = useState<{ done: number; failed: number; total: number }>({ done: 0, failed: 0, total: 0 });
  // Targets that failed in the most recent bulk cancel. Powers the
  // "Retry failed (N)" affordance so users can re-run the cancel flow only
  // against the orderIds that didn't cancel — without re-issuing requests
  // for the ones that already succeeded.
  const [lastFailedTargets, setLastFailedTargets] = useState<Array<{ orderId: string; symbol: string; side: 'buy' | 'sell' }>>([]);
  // When the bulk-cancel action is scoped to a single symbol this holds the
  // symbol; null means "every cancellable order across all symbols".
  const [cancelAllSymbol, setCancelAllSymbol] = useState<string | null>(null);

  // ── Live order-progress (shared store) ────────────────────────────────────
  // Subscribes to the singleton `orderProgress` store so the same panel
  // renders for close-position, manual orders, and autopilot fills without
  // any per-source state being duplicated here.
  const [progressMap, setProgressMap] = useState<Record<string, OrderProgress>>(() => orderProgress.all());
  useEffect(() => orderProgress.subscribe(setProgressMap), []);

  // After a page refresh the in-memory pollers are gone but the store
  // rehydrates non-terminal rows from localStorage on construction. Re-attach
  // pollers using whatever credentials are currently in the credential store
  // so the manual / autopilot / close panels keep advancing instead of being
  // frozen at their last persisted phase. We also re-run resume() whenever
  // the credential store changes so a row whose creds weren't yet loaded on
  // mount (common after a full reload — secrets live in-memory only) starts
  // polling as soon as the user re-enters their keys.
  useEffect(() => {
    const tryResume = () => orderProgress.resumeAll(ex => credentialStore.get(ex));
    tryResume();
    return credentialStore.subscribe(tryResume);
  }, []);

  const { toast } = useToast();
  const adapter = getExchangeAdapter(selectedEx.id);

  // Track the latest active tab via a ref so async pollers (which capture
  // `tab` at submit time) can read the *current* tab when a terminal
  // event fires — otherwise users who switch tabs after starting a close
  // would never see the success toast.
  const tabRef = useRef(tab);
  useEffect(() => { tabRef.current = tab; }, [tab]);

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
      setLiveBalances([]); setLiveSummary(null);
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
  // `opts.auto` distinguishes a timer-driven retry from a manual call.
  // Manual calls always cancel any pending auto-retry first (so a click
  // and a timer can't race); auto calls mark the one-shot flag so they
  // can't loop into a retry storm. Accepts an options object (rather than
  // a bare boolean) so onClick handlers that pass a SyntheticEvent are
  // safely treated as manual.
  const refreshLiveData = useCallback(async (opts?: { auto?: boolean }) => {
    const isAuto = opts?.auto === true;
    if ((mode !== 'real' && mode !== 'testnet') || !apiKey || !secretKey) return;
    if (isAuto) {
      exMode.markAutoRetryConsumed();
      exchangeEvents.log('fetch-balance', selectedEx.id, 'Auto-retry firing after transient refresh error');
    } else {
      exMode.cancelAutoRetry();
    }
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
        let bals: Array<{ asset: string; available: number; hold: number; total: number; usdtValue?: number }> = [];
        try {
          const raw = (balRes.data as { balances?: unknown }).balances;
          if (Array.isArray(raw)) {
            // Defensive normalization — never trust upstream shape.
            bals = raw
              .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
              .map(b => {
                const usdtRaw = b['usdtValue'];
                const usdtNum = typeof usdtRaw === 'number' && Number.isFinite(usdtRaw)
                  ? usdtRaw
                  : undefined;
                return {
                  asset:     String(b['asset'] ?? ''),
                  available: num(b['available']),
                  hold:      num(b['hold']),
                  total:     num(b['total']),
                  ...(usdtNum !== undefined ? { usdtValue: usdtNum } : {}),
                };
              })
              .filter(b => b.asset);
          }
        } catch (parseErr) {
          exchangeEvents.log('parse-response', selectedEx.id,
            `Balance parse failed: ${(parseErr as Error).message}`,
            { level: 'error' });
        }
        setLiveBalances(bals);
        // Push the live USDT-equivalent equity into the Real Profit store so
        // the Reports panel can show real starting/current equity + delta.
        // We sum usdtValue across all assets — for assets without one we
        // fall back to `total` for stable-coins and 0 otherwise.
        try {
          const equity = bals.reduce((sum, b) => {
            if (typeof b.usdtValue === 'number' && Number.isFinite(b.usdtValue)) return sum + b.usdtValue;
            const a = b.asset.toUpperCase();
            if (a === 'USDT' || a === 'USDC' || a === 'BUSD' || a === 'DAI') return sum + b.total;
            return sum;
          }, 0);
          if (exMode.get().mode === 'real') {
            void import('../lib/real-profit-store.js').then(m => m.realProfitStore.setCurrentEquity(equity));
          }
        } catch { /* telemetry must never break refresh */ }
        // Capture optional per-scope breakdown so the UI can show transparently
        // how the displayed totals were assembled (Bybit Unified/Spot/Contract/
        // Funding). Adapters that don't provide one leave summary undefined.
        const sumRaw = (balRes.data as { summary?: unknown }).summary;
        if (sumRaw && typeof sumRaw === 'object') {
          setLiveSummary(sumRaw as import('../lib/api-client.js').BalanceSummary);
        } else {
          setLiveSummary(null);
        }
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
        const retryAfterMs = (balRes as { retryAfterMs?: number }).retryAfterMs;
        setBalError(errMsg);
        exMode.setConnectionState(codeToState(code), errMsg, retryAfterMs);
        exchangeEvents.log('fetch-balance', selectedEx.id, errMsg, { level: 'error', data: { code, retryAfterMs } });
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
        // If the balance side succeeded (so the connection itself is still
        // healthy) but the order fetch tripped on a transient blip, schedule
        // the same one-shot auto-retry the connect/balance path uses.
        if (balRes.ok && (ordRes.code === 'network' || ordRes.code === 'rate_limit')) {
          const reason = ordRes.code === 'network' ? 'network' : 'rate_limit';
          const ra = (ordRes as { retryAfterMs?: number }).retryAfterMs;
          exMode.scheduleAutoRetry(reason, ra);
        }
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

  // ── Cancel a live order ─────────────────────────────────────────────────
  // Only enabled in real/testnet modes; calls the existing apiClient.cancelOrder
  // path with the saved credentials, records the result in the Execution Log,
  // toasts the outcome, and refreshes the live orders table so the cancelled
  // row drops out (or shows the new status from the exchange).
  const cancelLiveOrder = useCallback(async (orderId: string, symbol: string, side: 'buy' | 'sell') => {
    if (!orderId) return;
    if (mode !== 'real' && mode !== 'testnet') {
      toast({ title: 'Cancel unavailable', description: 'Switch to Real or Testnet mode to cancel live orders.', variant: 'destructive' });
      return;
    }
    if (!apiKey || !secretKey) {
      toast({ title: 'Not connected', description: 'Connect with API credentials before cancelling orders.', variant: 'destructive' });
      return;
    }

    if (mode === 'real') {
      const ok = window.confirm(
        `Cancel live order on ${selectedEx.name}?\n\n` +
        `Order: ${orderId}\nSymbol: ${symbol || '—'}\n\n` +
        `This will send a cancel request to the exchange. The position (if filled) is NOT closed by this action.`
      );
      if (!ok) return;
    }

    setCancellingOrders(prev => { const n = new Set(prev); n.add(orderId); return n; });
    const creds = { apiKey, secretKey, ...(passphrase ? { passphrase } : {}) };
    exchangeEvents.log('connect', selectedEx.id, `Cancelling order ${orderId} (${symbol})`);

    const pending = executionLog.add({
      mode,
      exchange:  selectedEx.id,
      symbol:    symbol || '—',
      side,
      orderType: 'market',
      quantity:  0,
      price:     0,
      amountUSD: 0,
      status:    'executing',
      orderId,
      signalId:  `cancel_${orderId}`,
    });

    try {
      const res = await apiClient.cancelOrder(selectedEx.id, creds, orderId, symbol || undefined);
      if (res.ok) {
        executionLog.update(pending.id, { status: 'executed', exchangeResponse: res.data });
        exchangeEvents.log('connect', selectedEx.id, `Order ${orderId} cancelled`);
        toast({ title: 'Order cancelled', description: `${symbol || 'Order'} ${orderId.slice(0, 12)}… cancelled on ${selectedEx.name}.` });
      } else {
        const errMsg = res.error ?? 'Cancel failed';
        executionLog.update(pending.id, { status: 'failed', errorMsg: errMsg, exchangeResponse: res });
        exchangeEvents.log('connect', selectedEx.id, `Cancel failed for ${orderId}: ${errMsg}`, { level: 'error', data: { code: res.code } });
        toast({ title: 'Cancel failed', description: errMsg, variant: 'destructive' });
      }
    } catch (e) {
      const msg = (e as Error).message ?? 'Unexpected error';
      executionLog.update(pending.id, { status: 'failed', errorMsg: msg });
      exchangeEvents.log('connect', selectedEx.id, `Cancel error for ${orderId}: ${msg}`, { level: 'error' });
      toast({ title: 'Cancel failed', description: msg, variant: 'destructive' });
    } finally {
      setCancellingOrders(prev => { const n = new Set(prev); n.delete(orderId); return n; });
      // Refresh so the cancelled order drops/updates in the live table.
      refreshLiveData();
    }
  }, [mode, apiKey, secretKey, passphrase, selectedEx.id, selectedEx.name, toast, refreshLiveData]);

  // ── Cancel ALL open orders ────────────────────────────────────────────
  // Bulk-cancel every cancellable live order in parallel. Each cancel goes
  // through the same apiClient.cancelOrder path as the per-row action and
  // gets its own Execution Log entry so successes/failures are individually
  // auditable. A single summary toast reports N succeeded / M failed.
  // Real-mode confirmation is enforced by the dialog (typed "CANCEL ALL")
  // that calls this handler — the function itself does not re-prompt.
  const cancelAllOpenOrders = useCallback(async (
    targets: Array<{ orderId: string; symbol: string; side: 'buy' | 'sell' }>,
    scopeSymbol: string | null = null,
  ) => {
    if (targets.length === 0) return;
    const scopeLabel = scopeSymbol ? `${scopeSymbol} order(s)` : 'open order(s)';
    if (mode !== 'real' && mode !== 'testnet') {
      toast({ title: 'Cancel unavailable', description: 'Switch to Real or Testnet mode to cancel live orders.', variant: 'destructive' });
      return;
    }
    if (!apiKey || !secretKey) {
      toast({ title: 'Not connected', description: 'Connect with API credentials before cancelling orders.', variant: 'destructive' });
      return;
    }

    setCancellingAll(true);
    setCancelAllProgress({ done: 0, failed: 0, total: targets.length });
    // Clear any previous "Retry failed" set — this run will repopulate it
    // based on its own results so the affordance always reflects the most
    // recent batch (whether that's the original Cancel All or a retry).
    setLastFailedTargets([]);
    setCancellingOrders(prev => {
      const n = new Set(prev);
      for (const t of targets) n.add(t.orderId);
      return n;
    });

    const creds = { apiKey, secretKey, ...(passphrase ? { passphrase } : {}) };
    exchangeEvents.log('connect', selectedEx.id, `Bulk cancel: ${targets.length} ${scopeLabel}`);

    // Per-result state updates: each cancel resolves independently and
    // immediately bumps the progress counter + clears its row spinner so the
    // user sees "12 / 50 cancelled, 1 failed" tick up live instead of waiting
    // for every parallel cancel to settle.
    const results = await Promise.all(targets.map(async ({ orderId, symbol, side }) => {
      const pending = executionLog.add({
        mode,
        exchange:  selectedEx.id,
        symbol:    symbol || '—',
        side,
        orderType: 'market',
        quantity:  0,
        price:     0,
        amountUSD: 0,
        status:    'executing',
        orderId,
        signalId:  `cancel_all_${orderId}`,
      });
      const finish = (ok: boolean) => {
        setCancelAllProgress(p => ({
          ...p,
          done:   p.done + (ok ? 1 : 0),
          failed: p.failed + (ok ? 0 : 1),
        }));
        setCancellingOrders(prev => {
          const n = new Set(prev);
          n.delete(orderId);
          return n;
        });
      };
      try {
        const res = await apiClient.cancelOrder(selectedEx.id, creds, orderId, symbol || undefined);
        if (res.ok) {
          executionLog.update(pending.id, { status: 'executed', exchangeResponse: res.data });
          exchangeEvents.log('connect', selectedEx.id, `Order ${orderId} cancelled (bulk)`);
          finish(true);
          return { orderId, ok: true as const };
        }
        const errMsg = res.error ?? 'Cancel failed';
        executionLog.update(pending.id, { status: 'failed', errorMsg: errMsg, exchangeResponse: res });
        exchangeEvents.log('connect', selectedEx.id, `Bulk cancel failed for ${orderId}: ${errMsg}`, { level: 'error', data: { code: res.code } });
        finish(false);
        return { orderId, ok: false as const, error: errMsg };
      } catch (e) {
        const msg = (e as Error).message ?? 'Unexpected error';
        executionLog.update(pending.id, { status: 'failed', errorMsg: msg });
        exchangeEvents.log('connect', selectedEx.id, `Bulk cancel error for ${orderId}: ${msg}`, { level: 'error' });
        finish(false);
        return { orderId, ok: false as const, error: msg };
      }
    }));

    const succeeded = results.filter(r => r.ok).length;
    const failed    = results.length - succeeded;

    // Capture the orderIds that failed so the user can retry just those
    // without re-issuing requests for the ones that already succeeded.
    // Map back through `targets` to preserve symbol+side metadata.
    const failedIds = new Set(results.filter(r => !r.ok).map(r => r.orderId));
    const failedTargets = targets.filter(t => failedIds.has(t.orderId));
    setLastFailedTargets(failedTargets);

    setCancellingAll(false);
    setCancelAllProgress({ done: 0, failed: 0, total: 0 });

    if (failed === 0) {
      toast({
        title: scopeSymbol
          ? `All ${scopeSymbol} orders cancelled`
          : 'All open orders cancelled',
        description: `${succeeded} succeeded / 0 failed on ${selectedEx.name}.`,
      });
    } else {
      const action = scopeSymbol ? `Cancel ${scopeSymbol}` : 'Cancel All';
      toast({
        title: succeeded > 0 ? `${action} partially completed` : `${action} failed`,
        description: `${succeeded} succeeded / ${failed} failed on ${selectedEx.name}. See Execution Log for details.`,
        variant: succeeded > 0 ? 'default' : 'destructive',
      });
    }

    refreshLiveData();
  }, [mode, apiKey, secretKey, passphrase, selectedEx.id, selectedEx.name, toast, refreshLiveData]);

  // ── Close a non-zero asset position ────────────────────────────────────
  // Submits a market SELL through executeSignal so the close action inherits
  // every gating/risk check the rest of the app uses (armed, validated,
  // perms, dedupe, retry, risk-manager). The amount sized by the engine is
  // governed by trade-config (same as any other signal) — this is intentional
  // so users can't bypass risk caps via close-position.
  const closePosition = useCallback(async (asset: string) => {
    if (!asset) return;
    if (mode !== 'real' && mode !== 'testnet') {
      toast({ title: 'Close unavailable', description: 'Switch to Real or Testnet mode to close live positions.', variant: 'destructive' });
      return;
    }

    // Preflight: classify the holding using cached symbol rules. If the
    // classifier says it's not closable (dust, rules unknown, wallet-only),
    // surface the exact reason and bail BEFORE we hit the network. This is
    // the same gate the engine applies upfront — keeping it here means the
    // user gets an instant, descriptive toast instead of a delayed reject.
    try {
      const row = liveBalances.find(b => b.asset === asset);
      if (row) {
        const upper   = row.asset.toUpperCase();
        const isStable = STABLES.has(upper);
        const ledgerOwned = getOwned(selectedEx.id, upper);
        const compl  = resolveCompliance(asset, selectedEx.id as ExchangeId);
        const cachedRules = compl.ok
          ? pipelineCache.get<SymbolRules>(`rules:${selectedEx.id}:${compl.exchangeSymbol}`)
          : undefined;
        const verdict = classifyHolding({
          asset:        upper,
          available:    row.available,
          hold:         row.hold,
          ...(typeof row.usdtValue === 'number' ? { usdtValue: row.usdtValue } : {}),
          exchange:     selectedEx.id,
          ...(cachedRules ? { symbolRules: cachedRules } : {}),
          trackedQty:   ledgerOwned,
          isDustMarked: botDoctorStore.isDust(selectedEx.id, upper),
          isStable,
        });
        if (!verdict.canClose) {
          if (verdict.reason === 'unsellable_dust' || verdict.reason === 'below_min_notional' ||
              verdict.reason === 'below_min_sell_qty' || verdict.reason === 'residual_unsellable') {
            botDoctorStore.markDustWithReason(selectedEx.id, upper, verdict.reason, verdict.detail);
          }
          toast({ title: 'Close blocked', description: verdict.detail, variant: 'destructive' });
          return;
        }
      }
    } catch (e) { console.warn('[closePosition] preflight skipped:', (e as Error).message); }

    if (mode === 'real') {
      const ok = window.confirm(
        `Close ${asset} position on ${selectedEx.name}?\n\n` +
        `This submits a MARKET SELL through the trading engine. The size is ` +
        `governed by your Trade Config (not the full balance) so risk caps still apply.\n\n` +
        `Continue?`
      );
      if (!ok) return;
    }

    setClosingPositions(prev => { const n = new Set(prev); n.add(asset); return n; });
    const key = closeKey(asset);
    orderProgress.start({
      key, source: 'close', exchange: selectedEx.id, symbol: asset, side: 'sell',
      label: `Close ${asset}`,
    });

    try {
      // Resolve a live reference price — same approach as the manual order form.
      let price = 0;
      try {
        const pr = await apiClient.getPrice(selectedEx.id, asset);
        if (pr.ok) price = Number((pr.data as { price?: number }).price) || 0;
      } catch { /* fall through */ }

      if (price <= 0) {
        const m = `Cannot resolve a live price for ${asset} on ${selectedEx.name}. Retry once the exchange responds — refusing to size a live close from a placeholder.`;
        toast({ title: 'Close blocked', description: m, variant: 'destructive' });
        orderProgress.update(key, { phase: 'error', message: m });
        return;
      }

      const res = await executeSignal({
        id:     `close_${asset}_${Date.now()}`,
        symbol: asset,
        side:   'sell',
        price,
        ts:     Date.now(),
        source: 'close-position',
      });

      if (res.ok) {
        const orderId = res.orderId;
        toast({
          title:       'Close submitted',
          description: `Live SELL ${asset} placed — orderId ${orderId ?? '—'}`,
        });
        orderProgress.update(key, { phase: 'pending', orderId });

        // Demo/paper orderIds aren't real exchange orders — skip polling.
        const looksReal = !!orderId && !orderId.startsWith('demo_') && !orderId.startsWith('paper_');
        if (orderId && looksReal && (mode === 'real' || mode === 'testnet') && apiKey && secretKey) {
          const creds = { apiKey, secretKey, ...(passphrase ? { passphrase } : {}) };
          // The shared store handles the 1.5s/60s polling loop and partial /
          // terminal-state detection (was an inline poller before #63).
          // We layer the close-specific notifications on top via onTerminal
          // so users still get the "Close filled / canceled / rejected"
          // toasts and the execution-log row that the old inline poller
          // produced.
          orderProgress.poll({
            key, orderId, exchange: selectedEx.id, symbol: asset, creds,
            onTerminal: (final) => {
              const filled = final.filledQty;
              const qty    = final.quantity;
              const avg    = final.avgPrice;
              if (final.phase === 'filled') {
                if (tabRef.current !== 'balances') {
                  toast({
                    title:       'Close filled',
                    description: `Closed ${fmt(filled, 6)} ${asset} at avg ${fmt(avg, 2)} on ${selectedEx.name}.`,
                  });
                }
              } else if (final.phase === 'canceled' || final.phase === 'rejected') {
                const word = final.phase === 'canceled' ? 'canceled' : 'rejected';
                const msg  = `Close ${asset} was ${word} by ${selectedEx.name}` +
                  (filled > 0 ? ` after a partial fill of ${filled} ${asset}` : '') +
                  '. Check Order History for details.';
                toast({
                  title:       `Close ${word}`,
                  description: msg,
                  variant:     'destructive',
                });
                executionLog.add({
                  mode, exchange: selectedEx.id, symbol: asset, side: 'sell',
                  orderType: 'market', quantity: qty, price: avg || price,
                  amountUSD: (avg || price) * filled,
                  status: 'rejected', orderId, rejectReason: `exchange_${word}`,
                  errorMsg: msg,
                });
              } else if (final.phase === 'timeout') {
                const msg = `Close ${asset} — no final fill confirmation yet. The order may still be live; click Resume to keep polling, or check Order History on ${selectedEx.name}.`;
                toast({
                  title:       'Close still pending',
                  description: msg,
                  variant:     'destructive',
                });
                executionLog.add({
                  mode, exchange: selectedEx.id, symbol: asset, side: 'sell',
                  orderType: 'market', quantity: 0, price, amountUSD: 0,
                  status: 'failed', orderId, errorMsg: msg,
                });
              }
              refreshLiveData();
            },
          });
        } else {
          // No real orderId to poll — mark as filled since the engine already
          // recorded the simulated fill in the execution log.
          orderProgress.update(key, { phase: 'filled' });
        }
      } else {
        const reason = `${res.rejectReason ?? 'Rejected'}${res.detail ? ' — ' + res.detail : ''}`;
        toast({ title: 'Close blocked', description: reason, variant: 'destructive' });
        orderProgress.update(key, { phase: 'rejected', message: reason });
      }
    } catch (e) {
      const m = (e as Error).message ?? 'Unexpected error';
      toast({ title: 'Close failed', description: m, variant: 'destructive' });
      orderProgress.update(key, { phase: 'error', message: m });
    } finally {
      setClosingPositions(prev => { const n = new Set(prev); n.delete(asset); return n; });
      refreshLiveData();
    }
  }, [mode, selectedEx.id, selectedEx.name, apiKey, secretKey, passphrase, toast, refreshLiveData]);

  // Dismiss an inline progress panel and stop any active poller.
  const dismissProgress = useCallback((key: string) => {
    orderProgress.dismiss(key);
  }, []);

  // Resume polling on a row that previously timed out. The store remembers
  // the original creds/orderId/exchange so the UI just needs the key.
  const resumeProgress = useCallback((key: string) => {
    const ok = orderProgress.resume(key);
    if (!ok) {
      toast({
        title:       'Cannot resume',
        description: 'No saved polling context for this row — try the action again.',
        variant:     'destructive',
      });
    }
  }, [toast]);

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
        const retryAfterMs = (valRes as { retryAfterMs?: number }).retryAfterMs;
        exMode.setConnectionState(next, errMsg, retryAfterMs);
        exchangeEvents.log('validate', selectedEx.id, errMsg, { level: 'error', data: { code: valRes.code, retryAfterMs } });
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
        data: { permissions?: {
          read: boolean; trade: boolean; withdraw: boolean; futures: boolean;
          spot?: boolean; margin?: boolean; options?: boolean; accountType?: string;
        } };
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
          ? (perms.spot === false && perms.futures
              ? 'API validated — Futures trading enabled, Spot trading is NOT enabled on this key.'
              : 'API validated — trading permission confirmed.')
          : 'API connected but no trading permission on this key. Open the Permissions tab and run the Self-Test for the exact reason.',
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
    setLiveBalances([]); setLiveSummary(null);
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
  // Mirror the latest refreshLiveData + connected flag into refs so the
  // stable `retryConnection` callback can route an auto-retry to the
  // lighter refresh path (when the user is already connected and only a
  // refresh fetch tripped) without being re-created on every render.
  const refreshLiveDataRef = useRef(refreshLiveData);
  useEffect(() => { refreshLiveDataRef.current = refreshLiveData; });
  const isConnectedRef = useRef(isConnected);
  useEffect(() => { isConnectedRef.current = isConnected; });
  // Hard-guard so a manual click and an about-to-fire auto-retry timer can't
  // both kick off `handleConnect` in the same tick. The first caller wins
  // and the other becomes a no-op.
  const retryInFlightRef = useRef(false);
  // `auto` distinguishes a timer-driven retry from a manual click. Manual
  // clicks always cancel any pending auto-retry first; timer-driven ones
  // mark the one-shot flag so they cannot loop into a retry storm.
  const retryConnection = useCallback(async (auto = false) => {
    if (retryInFlightRef.current) return;
    if (!credentialStore.has(selectedEx.id)) {
      exMode.cancelAutoRetry();
      setTab('connection');
      if (!auto) toast({ title: 'Re-enter your API keys', description: `Provide a valid ${selectedEx.name} API key to retry.` });
      return;
    }
    // Auto-retries that fire while the user is already connected can use
    // the lighter refresh path — the connection is fine, only the latest
    // balance/order fetch tripped. `refreshLiveData({auto:true})` already
    // marks the one-shot consumed, so don't double-mark here.
    const useRefresh = auto && isConnectedRef.current;
    if (auto && !useRefresh) {
      exMode.markAutoRetryConsumed();
      exchangeEvents.log('connect', selectedEx.id, 'Auto-retry firing after transient connection error');
    } else if (!auto) {
      exMode.cancelAutoRetry();
    }
    retryInFlightRef.current = true;
    try {
      if (useRefresh) {
        await refreshLiveDataRef.current({ auto: true });
      } else {
        await handleConnectRef.current();
      }
    } finally {
      retryInFlightRef.current = false;
    }
  }, [selectedEx.id, selectedEx.name, toast]);

  // ── Auto-retry timer ─────────────────────────────────────────────────────
  // The connection state machine sets `autoRetryAt` when entering a
  // transient error state. We schedule a single timer to fire the silent
  // re-validation. Effect cleanup cancels the timer if the user disconnects,
  // switches mode/exchange, clicks Retry manually, or another error path
  // clears the schedule — preventing duplicate or stale retries.
  const autoRetryAt = modeState.autoRetryAt;
  useEffect(() => {
    if (!autoRetryAt) return;
    if (mode !== 'real' && mode !== 'testnet') return;
    const delay = Math.max(0, autoRetryAt - Date.now());
    const id = setTimeout(() => { void retryConnection(true); }, delay);
    return () => clearTimeout(id);
  }, [autoRetryAt, mode, retryConnection]);

  // Tick once per second so the countdown re-renders without forcing the
  // whole singleton to publish ticks. The effect is active only while a
  // retry is pending.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (!autoRetryAt) return;
    const id = setInterval(() => setNowTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [autoRetryAt]);

  const permCheck = checkTradingPermission(['read', 'trade'], mode);
  // Defensive sums — guard every numeric input against NaN / undefined so a
  // single malformed balance row can never crash the page.
  const totalUsdValue = balances.reduce((s, b) => s + num(b?.usdtValue), 0);
  // Include all stablecoins, not just USDT
  const STABLES       = new Set(['USDT', 'USD', 'USDC', 'BUSD', 'TUSD', 'USDP', 'DAI', 'FDUSD', 'USDD']);
  // Sum every asset's approximate USDT value (adapter-populated). Rows with
  // an undefined `usdtValue` (no USDT pair available) are explicitly excluded
  // from the total — counting them as 0 would silently understate the
  // portfolio when an adapter can't price an asset, so we instead surface
  // how many rows actually contributed to the headline number.
  const livePricedRows = liveBalances.filter(b => typeof b?.usdtValue === 'number');
  const liveTotalUSD  = livePricedRows.reduce((s, b) => s + num(b?.usdtValue), 0);
  const liveUnpricedCount = liveBalances.length - livePricedRows.length;
  const liveStableTotal = liveBalances
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
                ? (modeState.permissions.spot === false && modeState.permissions.futures
                    ? ' API validated. Futures trading enabled — Spot trading not enabled on this key.'
                    : ' API validated. Trade permission confirmed. Arm trading to execute real orders.')
                : ' API connected but trading permission missing. Open Permissions tab → Run Self-Test for the exact reason from the exchange.'
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
        const retrySecs = modeState.autoRetryAt
          ? Math.max(0, Math.ceil((modeState.autoRetryAt - Date.now()) / 1000))
          : null;
        const retryReasonLabel =
          modeState.autoRetryReason === 'rate_limit' ? 'rate-limit' : 'network';
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
                {retrySecs !== null && (
                  <p
                    className="text-[11px] text-amber-300 mt-1.5 flex items-center gap-1.5"
                    data-testid="connection-error-auto-retry-countdown"
                  >
                    <RefreshCw size={10} className="animate-spin" />
                    {retrySecs > 0
                      ? `Retrying in ${retrySecs}s after ${retryReasonLabel} blip…`
                      : `Retrying now after ${retryReasonLabel} blip…`}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <Button
                    size="sm" variant="outline"
                    onClick={() => { void retryConnection(false); }} disabled={connecting || validating || refreshing}
                    className="text-xs h-7 border-red-500/40 text-red-300 hover:bg-red-500/10"
                    data-testid="connection-error-retry"
                  >
                    <RefreshCw size={11} className={`mr-1.5 ${(connecting || validating || refreshing) ? 'animate-spin' : ''}`} />
                    Retry now
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
                        <p className="text-[10px] text-amber-400 mt-1">⚠ API connected but no trading permission — see Permissions tab → Self-Test</p>
                      )}
                      {isLive && livePermissions && livePermissions.trade && livePermissions.spot === false && livePermissions.futures && (
                        <p className="text-[10px] text-amber-400 mt-1">⚠ Futures trading enabled — Spot trading is NOT enabled on this key</p>
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
                {isLive && liveBalances.length > 0
                  ? `Total portfolio value (USDT) · ${livePricedRows.length}/${liveBalances.length} asset${liveBalances.length !== 1 ? 's' : ''} priced${liveUnpricedCount > 0 ? ` · ${liveUnpricedCount} excluded (no USDT pair)` : ''} · stables ${fmt(liveStableTotal)}`
                  : 'Total portfolio value (USDT)'} · {selectedEx.name}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => isLive ? refreshLiveData() : loadData()} disabled={refreshing} className="flex items-center gap-1.5 text-xs">
              <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} /> Refresh
            </Button>
          </div>
          {/* ── Per-scope balance breakdown (transparent: shows exactly how the
                exchange-reported total compares to what the app sees as
                tradable). Currently populated by the Bybit adapter. ─────── */}
          {isLive && liveSummary && (
            <Card className="border-zinc-800/60 bg-zinc-900/40" data-testid="balance-breakdown">
              <CardContent className="p-4 space-y-4">
                <div>
                  <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">
                    Balance breakdown · {selectedEx.name}
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-500">Total Account Value</div>
                      <div className="font-mono font-bold text-base">${fmt(liveSummary.totalEquityUSD)}</div>
                      <div className="text-[10px] text-zinc-500">all scopes incl. funding & PnL</div>
                    </div>
                    <div className="rounded-lg border border-emerald-700/40 bg-emerald-950/20 px-3 py-2.5">
                      <div className="text-[10px] uppercase tracking-wider text-emerald-400">Tradable Available</div>
                      <div className="font-mono font-bold text-base text-emerald-300">${fmt(liveSummary.totalAvailableUSD)}</div>
                      <div className="text-[10px] text-zinc-500">free in trading accounts</div>
                    </div>
                    <div className="rounded-lg border border-amber-700/40 bg-amber-950/20 px-3 py-2.5">
                      <div className="text-[10px] uppercase tracking-wider text-amber-400">Locked / In Orders</div>
                      <div className="font-mono font-bold text-base text-amber-300">${fmt(liveSummary.totalLockedUSD)}</div>
                      <div className="text-[10px] text-zinc-500">open orders + margin</div>
                    </div>
                    <div className="rounded-lg border border-sky-700/40 bg-sky-950/20 px-3 py-2.5">
                      <div className="text-[10px] uppercase tracking-wider text-sky-400">Funding Wallet</div>
                      <div className="font-mono font-bold text-base text-sky-300">${fmt(liveSummary.fundingUSD)}</div>
                      <div className="text-[10px] text-zinc-500">not tradable until transferred</div>
                    </div>
                    <div className="rounded-lg border border-fuchsia-700/40 bg-fuchsia-950/20 px-3 py-2.5">
                      <div className="text-[10px] uppercase tracking-wider text-fuchsia-400">External (Earn / Savings)</div>
                      <div className="font-mono font-bold text-base text-fuchsia-300">${fmt(liveSummary.externalUSD ?? 0)}</div>
                      <div className="text-[10px] text-zinc-500">redeem inside exchange to trade</div>
                    </div>
                  </div>
                </div>

                {/* Per-scope detail */}
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">Per-scope detail</div>
                  <div className="overflow-x-auto rounded-lg border border-zinc-800">
                    <table className="w-full text-xs">
                      <thead className="bg-zinc-900/60 text-[10px] uppercase tracking-wider text-zinc-500">
                        <tr>
                          <th className="text-left px-3 py-2">Scope</th>
                          <th className="text-right px-3 py-2">Total Equity</th>
                          <th className="text-right px-3 py-2">Wallet Balance</th>
                          <th className="text-right px-3 py-2">Available</th>
                          <th className="text-right px-3 py-2">Locked</th>
                          <th className="text-right px-3 py-2">Coins</th>
                          <th className="text-left px-3 py-2">Status</th>
                        </tr>
                      </thead>
                      <tbody className="font-mono">
                        {liveSummary.scopes.map(sc => (
                          <tr key={sc.accountType} className="border-t border-zinc-800">
                            <td className="px-3 py-2 font-sans font-semibold">{sc.accountType}</td>
                            <td className="text-right px-3 py-2">{typeof sc.totalEquityUSD   === 'number' ? `$${fmt(sc.totalEquityUSD)}`   : '—'}</td>
                            <td className="text-right px-3 py-2">{typeof sc.walletBalanceUSD === 'number' ? `$${fmt(sc.walletBalanceUSD)}` : '—'}</td>
                            <td className="text-right px-3 py-2 text-emerald-300">{typeof sc.availableUSD === 'number' ? `$${fmt(sc.availableUSD)}` : '—'}</td>
                            <td className="text-right px-3 py-2 text-amber-300">{typeof sc.lockedUSD    === 'number' ? `$${fmt(sc.lockedUSD)}`    : '—'}</td>
                            <td className="text-right px-3 py-2">{sc.coinCount ?? 0}</td>
                            <td className="px-3 py-2 font-sans">
                              {sc.fetched
                                ? <span className="text-emerald-400">OK</span>
                                : <span className="text-zinc-500" title={sc.error ?? ''}>not active</span>}
                              {sc.note && <div className="text-[10px] text-zinc-500 mt-0.5 max-w-md whitespace-normal">{sc.note}</div>}
                              {!sc.fetched && sc.error && <div className="text-[10px] text-rose-400 mt-0.5 max-w-md whitespace-normal">{sc.error}</div>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* External (Earn) breakdown */}
                {liveSummary.externalBreakdown && liveSummary.externalBreakdown.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">External (Earn / Savings / Staking)</div>
                    <div className="overflow-x-auto rounded-lg border border-fuchsia-900/40">
                      <table className="w-full text-xs">
                        <thead className="bg-fuchsia-950/30 text-[10px] uppercase tracking-wider text-fuchsia-300">
                          <tr>
                            <th className="text-left px-3 py-2">Source</th>
                            <th className="text-right px-3 py-2">USD Value</th>
                            <th className="text-right px-3 py-2">Coins</th>
                            <th className="text-left px-3 py-2">Note</th>
                          </tr>
                        </thead>
                        <tbody className="font-mono">
                          {liveSummary.externalBreakdown.map((e, i) => (
                            <tr key={i} className="border-t border-fuchsia-900/30">
                              <td className="px-3 py-2 font-sans font-semibold">{e.source}</td>
                              <td className="text-right px-3 py-2 text-fuchsia-300">${fmt(e.usd)}</td>
                              <td className="text-right px-3 py-2">{e.coinCount}</td>
                              <td className="px-3 py-2 font-sans text-[11px] text-zinc-400">{e.note ?? ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Exchange-reported reconciliation */}
                {liveSummary.exchangeReported?.totalEquityUSD && liveSummary.exchangeReported.totalEquityUSD > 0 && (
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-[11px] text-zinc-300">
                    <span className="text-zinc-500">Exchange-reported (matches what you see inside {selectedEx.name}): </span>
                    Total Equity <span className="font-mono">${fmt(liveSummary.exchangeReported.totalEquityUSD)}</span>
                    {liveSummary.exchangeReported.totalAvailableUSD ? <> · Available <span className="font-mono">${fmt(liveSummary.exchangeReported.totalAvailableUSD)}</span></> : null}
                  </div>
                )}

                {/* Notes (e.g. funding-wallet reminder) */}
                {liveSummary.notes.length > 0 && (
                  <ul className="text-[11px] text-zinc-400 space-y-1">
                    {liveSummary.notes.map((n, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <AlertTriangle size={11} className="mt-0.5 flex-shrink-0 text-amber-400" />
                        <span>{n}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}

          {isLive && balError && modeState.connectionState !== 'balance_empty' && (
            modeState.autoRetryAt ? (
              <div
                className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs text-amber-300"
                data-testid="balances-auto-retry-hint"
                role="status"
              >
                <RefreshCw size={13} className="mt-0.5 flex-shrink-0 animate-spin" />
                <span>
                  {(() => {
                    const secs = Math.max(0, Math.ceil((modeState.autoRetryAt - Date.now()) / 1000));
                    const reason = modeState.autoRetryReason === 'rate_limit' ? 'rate-limit' : 'network';
                    return secs > 0
                      ? `Retrying in ${secs}s after ${reason} blip…`
                      : `Retrying now after ${reason} blip…`;
                  })()}
                </span>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2.5 text-xs text-red-400">
                <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
                <span>{balError}</span>
              </div>
            )
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
                        onClick={() => refreshLiveData()}
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
            <ClassifiedBalances
              liveBalances={liveBalances}
              exchangeId={selectedEx.id}
              stables={STABLES}
              closingPositions={closingPositions}
              progressMap={progressMap}
              onClose={closePosition}
              onDismissProgress={dismissProgress}
              onResumeProgress={resumeProgress}
            />
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
        {(() => {
          // Pre-compute the cancellable order set ONCE so the header button
          // and the confirmation dialog stay in sync with what the table is
          // about to act on.
          const cancellableTargets: Array<{ orderId: string; symbol: string; side: 'buy' | 'sell' }> = isLive
            ? (liveOrders as Array<Record<string, unknown>>)
                .map(o => {
                  const orderId = String(o['orderId'] ?? '');
                  const symbol  = String(o['symbol'] ?? '');
                  const sideStr = String(o['side'] ?? '').toLowerCase();
                  const status  = String(o['status'] ?? 'open').toLowerCase();
                  const ok = !!orderId && (
                    status === 'open' || status === 'new' || status === 'partially_filled' ||
                    status === 'partial' || status === 'pending' || status === 'accepted'
                  );
                  return ok
                    ? { orderId, symbol, side: (sideStr === 'sell' ? 'sell' : 'buy') as 'buy' | 'sell' }
                    : null;
                })
                .filter((x): x is { orderId: string; symbol: string; side: 'buy' | 'sell' } => x !== null)
            : [];
          const cancellableCount = cancellableTargets.length;
          const showCancelAll = isLive && cancellableCount > 0;

          // Group cancellable targets by symbol so the dropdown can offer a
          // per-symbol bulk cancel that targets only that symbol's orders.
          const symbolGroups = new Map<string, typeof cancellableTargets>();
          for (const t of cancellableTargets) {
            const key = t.symbol || '—';
            const arr = symbolGroups.get(key) ?? [];
            arr.push(t);
            symbolGroups.set(key, arr);
          }
          const symbolGroupList = Array.from(symbolGroups.entries())
            .sort(([a], [b]) => a.localeCompare(b));
          const hasMultipleSymbols = symbolGroupList.length > 1;

          // Resolve the targets the dialog will act on based on the current
          // scope (null = all cancellable, string = just that symbol).
          const dialogTargets = cancelAllSymbol
            ? (symbolGroups.get(cancelAllSymbol) ?? [])
            : cancellableTargets;
          const dialogScopeLabel = cancelAllSymbol
            ? `${cancelAllSymbol} order(s)`
            : 'open order(s)';

          const startCancel = (symbol: string | null, targets: typeof cancellableTargets) => {
            if (targets.length === 0) return;
            if (mode === 'real') {
              setCancelAllSymbol(symbol);
              setCancelAllConfirmText('');
              setCancelAllOpen(true);
            } else {
              cancelAllOpenOrders(targets, symbol);
            }
          };

          // "Retry failed" only re-targets orderIds that (a) failed in the
          // last bulk cancel AND (b) are still cancellable now. An order that
          // got filled or cancelled out-of-band between the original batch
          // and the retry click would otherwise produce a guaranteed failure.
          const cancellableIds = new Set(cancellableTargets.map(t => t.orderId));
          const retryTargets = lastFailedTargets.filter(t => cancellableIds.has(t.orderId));
          const showRetryFailed = isLive && !cancellingAll && retryTargets.length > 0;

          const handleCancelAllClick = () => startCancel(null, cancellableTargets);

          return (
        <>
        <Card className="border-zinc-800/60">
          <CardHeader className="py-3 px-4 flex items-center justify-between gap-2">
            <CardTitle className="text-sm">
              {isLive ? 'Live Orders' : 'Recent Orders'} — {selectedEx.name}
            </CardTitle>
            <div className="flex items-center gap-2">
              {showCancelAll && (
                <div className="flex items-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCancelAllClick}
                    disabled={cancellingAll || refreshing}
                    className={`flex items-center gap-1.5 text-xs h-7 border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-300 ${hasMultipleSymbols ? 'rounded-r-none border-r-0' : ''}`}
                    data-testid="button-cancel-all-orders"
                    title={`Cancel all ${cancellableCount} open order(s) on ${selectedEx.name}`}
                  >
                    {cancellingAll
                      ? <RefreshCw size={11} className="animate-spin" />
                      : <X size={11} />}
                    {cancellingAll
                      ? (
                        <span data-testid="text-cancel-all-progress">
                          {cancelAllProgress.done} / {cancelAllProgress.total} cancelled
                          {cancelAllProgress.failed > 0 ? `, ${cancelAllProgress.failed} failed` : ''}
                        </span>
                      )
                      : `Cancel All (${cancellableCount})`}
                  </Button>
                  {hasMultipleSymbols && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={cancellingAll || refreshing}
                          className="h-7 px-1.5 rounded-l-none border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                          data-testid="button-cancel-by-symbol-trigger"
                          title="Cancel all orders for one symbol"
                          aria-label="Cancel orders for a specific symbol"
                        >
                          <ChevronDown size={11} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-[200px]">
                        <DropdownMenuLabel className="text-xs">
                          Cancel by symbol
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {symbolGroupList.map(([sym, list]) => (
                          <DropdownMenuItem
                            key={sym}
                            onSelect={() => startCancel(sym, list)}
                            data-testid={`button-cancel-symbol-${sym}`}
                            className="text-xs flex items-center justify-between gap-3 cursor-pointer"
                          >
                            <span className="font-medium">Cancel all {sym}</span>
                            <span className="text-zinc-500 font-mono">{list.length}</span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              )}
              {showRetryFailed && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => cancelAllOpenOrders(retryTargets)}
                  disabled={cancellingAll || refreshing}
                  className="flex items-center gap-1.5 text-xs h-7 border-amber-500/40 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300"
                  data-testid="button-retry-failed-cancels"
                  title={`Retry cancel for ${retryTargets.length} order(s) that failed in the last bulk cancel`}
                >
                  <RefreshCw size={11} />
                  {`Retry failed (${retryTargets.length})`}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => isLive ? refreshLiveData() : loadData()} disabled={refreshing} className="flex items-center gap-1.5 text-xs h-7">
                <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} /> Refresh
              </Button>
            </div>
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
                      {['Order ID', 'Symbol', 'Side', 'Type', 'Qty', 'Price', 'Filled', 'Status', 'Time', 'Actions'].map(h => (
                        <th key={h} className="text-left px-3 py-2 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(liveOrders as Array<Record<string, unknown>>).map((o, i) => {
                      const orderId  = String(o['orderId'] ?? '');
                      const symbol   = String(o['symbol'] ?? '');
                      const sideStr  = String(o['side'] ?? '').toLowerCase();
                      const sideForCancel: 'buy' | 'sell' = sideStr === 'sell' ? 'sell' : 'buy';
                      const status   = String(o['status'] ?? 'open').toLowerCase();
                      // Only "open / new / partially filled" orders are cancellable.
                      // Filled / cancelled / rejected orders show a disabled placeholder.
                      const isCancellable = !!orderId && (
                        status === 'open' || status === 'new' || status === 'partially_filled' ||
                        status === 'partial' || status === 'pending' || status === 'accepted'
                      );
                      const busy = cancellingOrders.has(orderId);
                      return (
                      <tr key={orderId || i} className="border-b border-zinc-800/40 hover:bg-zinc-900/40">
                        <td className="px-3 py-2 font-mono text-zinc-500 text-[10px]">{orderId.slice(0, 12)}…</td>
                        <td className="px-3 py-2">{symbol}</td>
                        <td className={`px-3 py-2 font-semibold ${sideStr === 'buy' ? 'text-emerald-400' : 'text-red-400'}`}>{sideStr.toUpperCase()}</td>
                        <td className="px-3 py-2 text-zinc-400">{String(o['type'] ?? o['orderType'] ?? '').toUpperCase()}</td>
                        <td className="px-3 py-2 font-mono">{fmt(Number(o['quantity'] ?? 0), 6)}</td>
                        <td className="px-3 py-2 font-mono">{Number(o['price']) > 0 ? `$${fmt(Number(o['price']))}` : 'Market'}</td>
                        <td className="px-3 py-2 font-mono text-emerald-400">{fmt(Number(o['filledQty'] ?? 0), 6)}</td>
                        <td className="px-3 py-2">
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">{String(o['status'] ?? 'open')}</span>
                        </td>
                        {/* eslint-disable-next-line react-hooks/purity */}
                        <td className="px-3 py-2 text-zinc-500">{new Date(Number(o['timestamp']) || Date.now()).toLocaleTimeString()}</td>
                        <td className="px-3 py-2">
                          {isCancellable ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-[10px] border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-300 gap-1"
                              disabled={busy}
                              onClick={() => cancelLiveOrder(orderId, symbol, sideForCancel)}
                              data-testid={`button-cancel-order-${orderId}`}
                              title={`Cancel order ${orderId}`}
                            >
                              {busy
                                ? <RefreshCw size={11} className="animate-spin" />
                                : <X size={11} />}
                              {busy ? 'Cancelling…' : 'Cancel'}
                            </Button>
                          ) : (
                            <span className="text-[10px] text-zinc-600">—</span>
                          )}
                        </td>
                      </tr>
                      );
                    })}
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

        {/* Real-mode strong confirmation: must type CANCEL ALL exactly.
            Same dialog handles both "cancel everything" and the per-symbol
            scoped variant — only the wording and target list differ. */}
        <Dialog open={cancelAllOpen} onOpenChange={(o) => { setCancelAllOpen(o); if (!o) { setCancelAllConfirmText(''); setCancelAllSymbol(null); } }}>
          <DialogContent className="border-red-500/40">
            <DialogHeader>
              <DialogTitle className="text-red-400 flex items-center gap-2">
                <AlertTriangle size={16} />
                {cancelAllSymbol
                  ? `Cancel ALL ${cancelAllSymbol} orders on ${selectedEx.name}?`
                  : `Cancel ALL open orders on ${selectedEx.name}?`}
              </DialogTitle>
              <DialogDescription className="text-zinc-300">
                This will send cancel requests for <span className="font-semibold text-zinc-100">{dialogTargets.length}</span> live {dialogScopeLabel} in parallel.
                {cancelAllSymbol
                  ? ` Orders for other symbols are NOT touched.`
                  : ''}
                {' '}Filled positions are NOT closed. This action cannot be undone.
                <br /><br />
                Type <span className="font-mono font-bold text-red-400">CANCEL ALL</span> below to confirm.
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              value={cancelAllConfirmText}
              onChange={(e) => setCancelAllConfirmText(e.target.value)}
              placeholder="CANCEL ALL"
              className="font-mono"
              data-testid="input-cancel-all-confirm"
            />
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => { setCancelAllOpen(false); setCancelAllConfirmText(''); setCancelAllSymbol(null); }}
                data-testid="button-cancel-all-dismiss"
              >
                Keep orders
              </Button>
              <Button
                variant="destructive"
                disabled={cancelAllConfirmText !== 'CANCEL ALL' || cancellingAll || dialogTargets.length === 0}
                onClick={() => {
                  const scope = cancelAllSymbol;
                  const targets = dialogTargets;
                  setCancelAllOpen(false);
                  setCancelAllConfirmText('');
                  setCancelAllSymbol(null);
                  cancelAllOpenOrders(targets, scope);
                }}
                data-testid="button-cancel-all-confirm"
              >
                {cancellingAll
                  ? `Cancelling… ${cancelAllProgress.done} / ${cancelAllProgress.total}${cancelAllProgress.failed > 0 ? ` (${cancelAllProgress.failed} failed)` : ''}`
                  : `Cancel ${dialogTargets.length} order(s)`}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </>
          );
        })()}
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
                  <div className="flex items-center justify-between">
                    <p className="text-zinc-400 font-medium">Live API permissions from {selectedEx.name}:</p>
                    {livePermissions.accountType && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-700/50 text-zinc-300 font-mono">{livePermissions.accountType}</span>
                    )}
                  </div>
                  {[
                    { label: 'Read / Account',   ok: livePermissions.read,     show: true,                                  hint: '' },
                    { label: 'Trade (any)',      ok: livePermissions.trade,    show: true,                                  hint: 'canonical canTrade flag' },
                    { label: 'Spot',             ok: !!livePermissions.spot,    show: livePermissions.spot     !== undefined, hint: 'spot order placement' },
                    { label: 'Margin',           ok: !!livePermissions.margin,  show: livePermissions.margin   !== undefined, hint: 'cross / iso margin' },
                    { label: 'Futures',          ok: livePermissions.futures,   show: true,                                  hint: 'derivatives' },
                    { label: 'Options',          ok: !!livePermissions.options, show: livePermissions.options  !== undefined, hint: '' },
                    { label: 'Withdraw',         ok: livePermissions.withdraw,  show: true,                                  hint: 'never required for trading' },
                  ].filter(p => p.show).map(p => (
                    <div key={p.label} className="flex items-center gap-2">
                      <StatusDot ok={p.ok} />
                      <span className={p.ok ? 'text-zinc-200' : 'text-zinc-500'}>{p.label}</span>
                      {p.hint && <span className="text-[10px] text-zinc-600">— {p.hint}</span>}
                      {!p.ok && p.label === 'Trade (any)' && (
                        <span className="text-amber-400 text-[10px] ml-auto">trading blocked</span>
                      )}
                      {!p.ok && p.label === 'Spot' && livePermissions.trade && (
                        <span className="text-amber-400 text-[10px] ml-auto">enable Spot on Binance</span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* ── Diagnostics & Self-Test ─────────────────────────────────
                  Transparent panel that surfaces EVERY signal the exchange
                  returns — outbound IP, account snapshot, signed-call
                  results, no-fill order test — so the user can see the
                  exact reason a permission check passes or fails. */}
              {isLive && (
                <div className="p-3 rounded-xl bg-zinc-900/60 border border-zinc-700/80 text-xs space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-zinc-200 font-medium flex items-center gap-1.5">
                        <Activity size={12} className="text-cyan-400" /> Trading Permission Diagnostics
                      </p>
                      <p className="text-[10px] text-zinc-500 mt-0.5">
                        Runs ping → server time → signed account → no-fill order test against {selectedEx.name}. Surfaces the exchange&apos;s own error codes.
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1.5 shrink-0"
                      disabled={diagBusy}
                      onClick={async () => {
                        const creds = credentialStore.get(selectedEx.id);
                        if (!creds) {
                          toast({ title: 'No API credentials in this session', description: 'Reconnect on the Connection tab first.', variant: 'destructive' });
                          return;
                        }
                        setDiagBusy(true);
                        setSelfTest(null);
                        setDiagnostic(null);
                        exchangeEvents.log('selftest', selectedEx.id, `Running Trading Permission Self-Test on ${selectedEx.name}…`, { apiKey: creds.apiKey });
                        try {
                          const r = await apiClient.runSelfTest(selectedEx.id, creds);
                          if (r.ok) {
                            setSelfTest(r.data.selfTest);
                            const dr = await apiClient.getDiagnostic(selectedEx.id, creds);
                            if (dr.ok) setDiagnostic(dr.data.diagnostic);
                            exchangeEvents.log('selftest', selectedEx.id, `Self-Test ${r.data.selfTest.pass ? 'PASS' : 'FAIL'} — ${r.data.selfTest.summary}`, { apiKey: creds.apiKey });
                            toast({
                              title: r.data.selfTest.pass ? 'Self-Test passed' : 'Self-Test failed',
                              description: r.data.selfTest.summary,
                              variant: r.data.selfTest.pass ? 'default' : 'destructive',
                            });
                          } else {
                            const msg = r.error ?? 'Self-test failed';
                            exchangeEvents.log('selftest', selectedEx.id, `Self-Test error — ${msg}`, { apiKey: creds.apiKey });
                            toast({ title: 'Self-Test error', description: msg, variant: 'destructive' });
                          }
                        } finally {
                          setDiagBusy(false);
                        }
                      }}
                    >
                      {diagBusy ? <RefreshCw size={11} className="animate-spin" /> : <Crosshair size={11} />}
                      Run Binance Trading Permission Self-Test
                    </Button>
                  </div>

                  {/* Diagnostic data summary */}
                  {(diagnostic || selfTest) && (
                    <div className="mt-2 space-y-2">
                      {diagnostic && (
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 px-2 py-2 rounded-lg bg-zinc-800/40 border border-zinc-700/50">
                          <div className="text-[10px] text-zinc-500">API key in use</div>
                          <div className="text-[10px] font-mono text-zinc-200 text-right">{diagnostic.apiKeyMasked}</div>
                          <div className="text-[10px] text-zinc-500">Mode</div>
                          <div className="text-[10px] text-zinc-200 text-right">{diagnostic.testnet ? 'TESTNET' : 'REAL'}</div>
                          <div className="text-[10px] text-zinc-500">Outbound IP (server → exchange)</div>
                          <div className="text-[10px] font-mono text-zinc-200 text-right">{diagnostic.outboundIp ?? 'unknown'}</div>
                          {diagnostic.accountType && (<>
                            <div className="text-[10px] text-zinc-500">Account type</div>
                            <div className="text-[10px] font-mono text-zinc-200 text-right">{diagnostic.accountType}</div>
                          </>)}
                        </div>
                      )}
                      {selfTest && (
                        <div className={`px-2 py-2 rounded-lg text-[11px] font-medium ${selfTest.pass ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border border-red-500/30 text-red-300'}`}>
                          {selfTest.pass ? '✓ ' : '✗ '}{selfTest.summary}
                        </div>
                      )}
                      {(selfTest?.steps ?? diagnostic?.steps ?? []).length > 0 && (
                        <div className="space-y-1 mt-2">
                          {(selfTest?.steps ?? diagnostic?.steps ?? []).map((s, i) => (
                            <div key={i} className="px-2 py-1.5 rounded bg-zinc-800/30 border border-zinc-700/40">
                              <div className="flex items-start gap-2">
                                <StatusDot ok={s.ok} />
                                <div className="flex-1 min-w-0">
                                  <div className="text-[11px] text-zinc-200 font-medium flex items-center gap-2">
                                    {s.step}
                                    {s.code !== undefined && <span className="text-[9px] font-mono text-zinc-500">code {String(s.code)}</span>}
                                    {s.httpStatus !== undefined && <span className="text-[9px] font-mono text-zinc-500">HTTP {s.httpStatus}</span>}
                                    {s.durationMs !== undefined && <span className="text-[9px] text-zinc-600 ml-auto">{s.durationMs}ms</span>}
                                  </div>
                                  {s.detail && <div className={`text-[10px] mt-0.5 ${s.ok ? 'text-zinc-400' : 'text-amber-300'} break-words`}>{s.detail}</div>}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {diagnostic?.recommendation && (
                        <div className="px-2 py-2 rounded-lg bg-cyan-500/5 border border-cyan-500/30 text-[11px] text-cyan-200">
                          <strong>Recommendation:</strong> {diagnostic.recommendation}
                        </div>
                      )}
                    </div>
                  )}
                  {!diagnostic && !selfTest && !diagBusy && (
                    <p className="text-[10px] text-zinc-600 italic">Click the button to run a complete trading-permission audit.</p>
                  )}
                </div>
              )}

              {/* ── Order Self-Test ─────────────────────────────────────────
                  Sends a NO-FILL order probe to the exchange (Binance
                  /api/v3/order/test where supported) so the user can
                  verify a specific symbol/side/amount BEFORE arming the
                  bot.  Surfaces the exact filter that would have been
                  tripped (LOT_SIZE, MIN_NOTIONAL, PRICE_FILTER, …),
                  the formatted qty/price the server would actually send,
                  and the symbol-rules source (live / cached / stub). */}
              {isLive && (
                <div className="p-3 rounded-xl bg-zinc-900/60 border border-zinc-700/80 text-xs space-y-2">
                  <div>
                    <p className="text-zinc-200 font-medium flex items-center gap-1.5">
                      <Activity size={12} className="text-emerald-400" /> Order Self-Test (No-Fill)
                    </p>
                    <p className="text-[10px] text-zinc-500 mt-0.5">
                      Probes a specific symbol/side/amount against {selectedEx.name}&apos;s filters and balance WITHOUT placing an order. Use this to debug -1013 / insufficient_balance before arming.
                    </p>
                  </div>
                  <div className="grid grid-cols-12 gap-2 mt-2">
                    <div className="col-span-4">
                      <label className="text-[9px] text-zinc-500 uppercase tracking-wide">Symbol</label>
                      <input
                        type="text"
                        className="w-full mt-0.5 px-2 py-1.5 rounded bg-zinc-800/60 border border-zinc-700/60 text-[11px] font-mono text-zinc-100 uppercase focus:outline-none focus:border-emerald-500/60"
                        value={orderTestSymbol}
                        onChange={e => setOrderTestSymbol(e.target.value.toUpperCase())}
                        placeholder="BTC"
                        disabled={orderTestBusy}
                      />
                    </div>
                    <div className="col-span-3">
                      <label className="text-[9px] text-zinc-500 uppercase tracking-wide">Side</label>
                      <select
                        className="w-full mt-0.5 px-2 py-1.5 rounded bg-zinc-800/60 border border-zinc-700/60 text-[11px] text-zinc-100 focus:outline-none focus:border-emerald-500/60"
                        value={orderTestSide}
                        onChange={e => setOrderTestSide(e.target.value as 'buy' | 'sell')}
                        disabled={orderTestBusy}
                      >
                        <option value="buy">BUY</option>
                        <option value="sell">SELL</option>
                      </select>
                    </div>
                    <div className="col-span-3">
                      <label className="text-[9px] text-zinc-500 uppercase tracking-wide">Amount (USD)</label>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        className="w-full mt-0.5 px-2 py-1.5 rounded bg-zinc-800/60 border border-zinc-700/60 text-[11px] font-mono text-zinc-100 focus:outline-none focus:border-emerald-500/60"
                        value={orderTestUSD}
                        onChange={e => setOrderTestUSD(e.target.value)}
                        disabled={orderTestBusy}
                      />
                    </div>
                    <div className="col-span-2 flex items-end">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-[30px] w-full text-[10px] gap-1"
                        disabled={orderTestBusy || !orderTestSymbol || Number(orderTestUSD) <= 0}
                        onClick={async () => {
                          const creds = credentialStore.get(selectedEx.id);
                          if (!creds) {
                            toast({ title: 'No API credentials', description: 'Reconnect on the Connection tab first.', variant: 'destructive' });
                            return;
                          }
                          setOrderTestBusy(true);
                          setOrderTestResult(null);
                          try {
                            const sym = orderTestSymbol.endsWith('USDT') ? orderTestSymbol : `${orderTestSymbol}USDT`;
                            // Fetch live price first so we can compute quantity
                            const priceRes = await apiClient.getPrice(selectedEx.id, sym);
                            const livePrice = priceRes.ok ? Number((priceRes.data as { price: number }).price) : 0;
                            if (livePrice <= 0) {
                              setOrderTestResult({ ok: false, reason: 'PRICE_UNAVAILABLE', detail: `Could not fetch live price for ${sym}.` });
                              return;
                            }
                            const qty = Number(orderTestUSD) / livePrice;
                            const r = await apiClient.testOrder(selectedEx.id, creds, {
                              symbol: sym, side: orderTestSide, type: 'market', quantity: qty,
                              testnet: modeState.mode === 'testnet',
                            });
                            if (r.ok) {
                              const t = r.data.test;
                              setOrderTestResult({ ...t, requestedUSD: Number(orderTestUSD), livePrice });
                              exchangeEvents.log('selftest', selectedEx.id, `Order self-test ${t.ok ? 'PASS' : 'FAIL'} — ${t.reason ?? 'ok'}: ${t.detail ?? ''}`, { apiKey: creds.apiKey });
                              toast({
                                title: t.ok ? 'Order would be accepted' : `Order would be rejected: ${t.reason}`,
                                description: t.detail ?? '',
                                variant: t.ok ? 'default' : 'destructive',
                              });
                            } else {
                              const msg = (r as { error?: string }).error ?? 'Order self-test failed';
                              setOrderTestResult({ ok: false, reason: 'NETWORK', detail: msg });
                              toast({ title: 'Order self-test error', description: msg, variant: 'destructive' });
                            }
                          } finally {
                            setOrderTestBusy(false);
                          }
                        }}
                      >
                        {orderTestBusy ? <RefreshCw size={10} className="animate-spin" /> : <Crosshair size={10} />}
                        Test
                      </Button>
                    </div>
                  </div>

                  {orderTestResult && (
                    <div className="mt-2 space-y-2">
                      <div className={`px-2 py-2 rounded-lg text-[11px] font-medium ${orderTestResult.ok ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border border-red-500/30 text-red-300'}`}>
                        {orderTestResult.ok ? '✓ Order would pass all filters & balance checks.' : `✗ ${orderTestResult.reason ?? 'REJECTED'} — ${orderTestResult.detail ?? ''}`}
                        {orderTestResult.exchangeCode !== undefined && (
                          <div className="text-[9px] font-mono opacity-70 mt-0.5">exchange code: {String(orderTestResult.exchangeCode)}</div>
                        )}
                      </div>
                      {(orderTestResult.echo || orderTestResult.livePrice) && (
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 px-2 py-2 rounded-lg bg-zinc-800/40 border border-zinc-700/50">
                          {orderTestResult.livePrice !== undefined && (<>
                            <div className="text-[10px] text-zinc-500">Live price</div>
                            <div className="text-[10px] font-mono text-zinc-200 text-right">${orderTestResult.livePrice.toLocaleString(undefined, { maximumFractionDigits: 8 })}</div>
                          </>)}
                          {orderTestResult.requestedUSD !== undefined && (<>
                            <div className="text-[10px] text-zinc-500">Requested USD</div>
                            <div className="text-[10px] font-mono text-zinc-200 text-right">${orderTestResult.requestedUSD}</div>
                          </>)}
                          {orderTestResult.echo?.symbol && (<>
                            <div className="text-[10px] text-zinc-500">Symbol sent</div>
                            <div className="text-[10px] font-mono text-zinc-200 text-right">{orderTestResult.echo.symbol}</div>
                          </>)}
                          {orderTestResult.echo?.side && (<>
                            <div className="text-[10px] text-zinc-500">Side sent</div>
                            <div className="text-[10px] font-mono text-zinc-200 text-right">{orderTestResult.echo.side}</div>
                          </>)}
                          {orderTestResult.echo?.quantity && (<>
                            <div className="text-[10px] text-zinc-500">Quantity (precision-formatted)</div>
                            <div className="text-[10px] font-mono text-zinc-200 text-right">{orderTestResult.echo.quantity}</div>
                          </>)}
                          {orderTestResult.echo?.price && (<>
                            <div className="text-[10px] text-zinc-500">Price (tick-aligned)</div>
                            <div className="text-[10px] font-mono text-zinc-200 text-right">{orderTestResult.echo.price}</div>
                          </>)}
                        </div>
                      )}
                      {orderTestResult.rules && (
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 px-2 py-2 rounded-lg bg-zinc-800/40 border border-zinc-700/50">
                          <div className="text-[10px] text-zinc-500 col-span-2 font-medium">Symbol rules <span className="text-[9px] text-zinc-600">({String(orderTestResult.rules['filterSource'] ?? 'unknown')})</span></div>
                          {(['minQty','maxQty','stepSize','minNotional','tickSize','status'] as const).map(k => (
                            orderTestResult.rules![k] !== undefined && (
                              <React.Fragment key={k}>
                                <div className="text-[10px] text-zinc-500">{k}</div>
                                <div className="text-[10px] font-mono text-zinc-200 text-right">{String(orderTestResult.rules![k])}</div>
                              </React.Fragment>
                            )
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {!orderTestResult && !orderTestBusy && (
                    <p className="text-[10px] text-zinc-600 italic">Pick a symbol, side and USD amount, then click Test. No order will be placed.</p>
                  )}
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
                        onClick={() => refreshLiveData()}
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
                { label: 'Trading Armed',      ok: !!ready['tradingArmed'],    note: ready['tradingArmed'] ? '' : 'Press Start Real Trading below' },
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

          {/* Start / Stop Real Trading */}
          <Card className={`border ${modeState.armed ? 'border-red-500/40 bg-red-500/5' : 'border-zinc-800/60'}`}>
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-sm flex items-center gap-2">
                {modeState.armed
                  ? <><span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" /> Real Trading Active</>
                  : <>Start / Stop Real Trading</>}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-3">
              <div className={`p-3 rounded-xl border ${modeState.armed ? 'border-red-500/30 bg-red-500/10' : 'border-zinc-700 bg-zinc-800/20'}`}>
                <p className={`text-sm font-semibold ${modeState.armed ? 'text-red-400' : 'text-zinc-300'}`}>
                  {modeState.armed
                    ? `🔴 LIVE — bot signals are placing real orders on ${selectedEx.name}`
                    : '⚪ Disarmed — bot signals will NOT place real orders'}
                </p>
                <p className="text-[10px] text-zinc-500 mt-1">
                  Requires: Real mode + network up + validated API + balance fetched + trade permission.
                </p>
              </div>

              {!modeState.armed ? (
                <Button
                  className="w-full bg-red-600 hover:bg-red-700 text-white font-bold"
                  disabled={!exMode.canArm()}
                  onClick={() => {
                    if (modeState.mode !== 'real') {
                      toast({ title: 'Cannot start', description: 'Switch to Real mode first.', variant: 'destructive' }); return;
                    }
                    if (!modeState.networkUp)        { toast({ title: 'Cannot start', description: 'Connection is not healthy.', variant: 'destructive' }); return; }
                    if (!modeState.apiValidated)     { toast({ title: 'Cannot start', description: 'Validate your API key first.', variant: 'destructive' }); return; }
                    if (!modeState.balanceFetched)   { toast({ title: 'Cannot start', description: 'Fetch your live balance first.', variant: 'destructive' }); return; }
                    if (!modeState.permissions.trade){ toast({ title: 'Cannot start', description: 'API key has no trade permission.', variant: 'destructive' }); return; }

                    const confirmed = window.confirm(
                      `⚠ START REAL TRADING on ${selectedEx.name}?\n\n` +
                      `Bot signals will place LIVE orders using your real funds.\n\n` +
                      `Type OK to confirm. You can stop trading at any time.`
                    );
                    if (!confirmed) return;

                    if (!exMode.arm()) {
                      toast({ title: 'Cannot start', description: 'Readiness check failed. See Live Status tab.', variant: 'destructive' });
                    } else {
                      toast({ title: '🔴 Real Trading Started', description: `Live on ${selectedEx.name}. Stop anytime from this page.` });
                    }
                  }}
                >
                  ▶ Start Real Trading
                </Button>
              ) : (
                <Button
                  variant="outline"
                  className="w-full border-red-500/50 text-red-400 hover:bg-red-500/10 font-bold"
                  onClick={() => {
                    exMode.disarm();
                    toast({ title: '⚪ Real Trading Stopped', description: 'No further real orders will be placed.' });
                  }}
                >
                  ■ Stop Real Trading
                </Button>
              )}

              <div className="space-y-1.5 text-[10px] text-zinc-600">
                <p>• Live trading is disarmed automatically when you disconnect or reload</p>
                <p>• Emergency stop in Trade Config overrides this</p>
                <p>• Open positions are NOT closed when stopping — close them manually if needed</p>
              </div>
            </CardContent>
          </Card>

          {/* Autopilot fill progress — live readout of executions dispatched
              by the AutoPilot/bot engine so users no longer rely on a single
              toast + log entry to see whether a real order actually filled. */}
          {(() => {
            const rows = Object.values(progressMap)
              .filter(p => p.source === 'autopilot')
              .sort((a, b) => b.startedAt - a.startedAt)
              .slice(0, 5);
            if (rows.length === 0) return null;
            return (
              <Card className="border-zinc-800/60">
                <CardHeader className="py-3 px-4">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Activity size={13} /> AutoPilot Fill Progress
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-2">
                  {rows.map(p => (
                    <OrderProgressPanel
                      key={p.key}
                      p={p}
                      showHeader
                      testIdSuffix={`autopilot-${p.orderId ?? p.startedAt}`}
                      onDismiss={() => dismissProgress(p.key)}
                      onResume={() => resumeProgress(p.key)}
                    />
                  ))}
                </CardContent>
              </Card>
            );
          })()}

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
              <CfgRow label="Allowed symbols (comma-separated, empty = all supported crypto)">
                <Input value={config.allowedSymbols.join(',')} placeholder="BTC,ETH,SOL"
                  onChange={e => tradeConfig.set(selectedEx.id, { allowedSymbols: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                  className="h-7 w-36 text-xs font-mono" />
              </CfgRow>
              <CfgRow label="Order tracking timeout — Close position (sec)">
                <Input type="number" value={config.pollTimeoutSeconds.close}
                  min={POLL_TIMEOUT_MIN_SEC} max={POLL_TIMEOUT_MAX_SEC} step={5}
                  onChange={e => tradeConfig.set(selectedEx.id, { pollTimeoutSeconds: { ...config.pollTimeoutSeconds, close: Number(e.target.value) } })}
                  title={`How long the app keeps polling a Close-position order before showing "Resume polling". Higher = patient with slow exchanges; lower = faster timeout. Range ${POLL_TIMEOUT_MIN_SEC}–${POLL_TIMEOUT_MAX_SEC}s.`}
                  className="h-7 w-28 text-xs font-mono text-right"
                  data-testid="input-poll-timeout-close" />
              </CfgRow>
              <CfgRow label="Order tracking timeout — Manual order (sec)">
                <Input type="number" value={config.pollTimeoutSeconds.manual}
                  min={POLL_TIMEOUT_MIN_SEC} max={POLL_TIMEOUT_MAX_SEC} step={5}
                  onChange={e => tradeConfig.set(selectedEx.id, { pollTimeoutSeconds: { ...config.pollTimeoutSeconds, manual: Number(e.target.value) } })}
                  title={`How long the app keeps polling a Manual order before showing "Resume polling". Raise this for illiquid limit orders that legitimately sit on the book. Range ${POLL_TIMEOUT_MIN_SEC}–${POLL_TIMEOUT_MAX_SEC}s.`}
                  className="h-7 w-28 text-xs font-mono text-right"
                  data-testid="input-poll-timeout-manual" />
              </CfgRow>
              <CfgRow label="Order tracking timeout — AutoPilot (sec)">
                <Input type="number" value={config.pollTimeoutSeconds.autopilot}
                  min={POLL_TIMEOUT_MIN_SEC} max={POLL_TIMEOUT_MAX_SEC} step={5}
                  onChange={e => tradeConfig.set(selectedEx.id, { pollTimeoutSeconds: { ...config.pollTimeoutSeconds, autopilot: Number(e.target.value) } })}
                  title={`How long AutoPilot tracks a fill before showing "Resume polling". Limit orders sitting on the book often need a longer window than market closes. Range ${POLL_TIMEOUT_MIN_SEC}–${POLL_TIMEOUT_MAX_SEC}s.`}
                  className="h-7 w-28 text-xs font-mono text-right"
                  data-testid="input-poll-timeout-autopilot" />
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

      {/* ── Manual Order ── */}
      {tab === 'manual' && (<ErrorBoundary label="exchange:tab:manual">
        <div className="space-y-4">
          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <Send size={13} /> Manual Order — {selectedEx.name}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              <div className={`p-3 rounded-xl border text-xs ${
                mode === 'real'    ? 'border-red-500/30 bg-red-500/5 text-red-300' :
                mode === 'testnet' ? 'border-orange-500/30 bg-orange-500/5 text-orange-300' :
                mode === 'paper'   ? 'border-yellow-500/30 bg-yellow-500/5 text-yellow-300' :
                                     'border-blue-500/30 bg-blue-500/5 text-blue-300'
              }`}>
                {mode === 'real'    && <><b>Real mode:</b> this places a LIVE order on {selectedEx.name} using your real funds. Trading must be armed in Live Status.</>}
                {mode === 'testnet' && <><b>Testnet mode:</b> orders go to the {selectedEx.name} sandbox. No real funds used.</>}
                {mode === 'paper'   && <><b>Paper mode:</b> simulated fill at the live market price. No real order is sent.</>}
                {mode === 'demo'    && <><b>Demo mode:</b> virtual fill — no API key used and no order is sent.</>}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-[11px] text-zinc-400">Symbol</Label>
                  <Input
                    value={manualSymbol}
                    onChange={e => setManualSymbol(e.target.value.toUpperCase().trim())}
                    placeholder="BTC"
                    className="h-9 text-sm font-mono"
                  />
                  <p className="text-[10px] text-zinc-500">Use the bare ticker (e.g. <span className="font-mono">BTC</span>, <span className="font-mono">ETH</span>) — the engine resolves the trading pair per exchange.</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11px] text-zinc-400">Side</Label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant={manualSide === 'buy' ? 'default' : 'outline'}
                      onClick={() => setManualSide('buy')}
                      className={`flex-1 h-9 text-xs font-bold ${manualSide === 'buy' ? 'bg-emerald-600 hover:bg-emerald-700' : 'border-zinc-700'}`}
                    >BUY</Button>
                    <Button
                      type="button"
                      variant={manualSide === 'sell' ? 'default' : 'outline'}
                      onClick={() => setManualSide('sell')}
                      className={`flex-1 h-9 text-xs font-bold ${manualSide === 'sell' ? 'bg-red-600 hover:bg-red-700' : 'border-zinc-700'}`}
                    >SELL</Button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11px] text-zinc-400">Order amount (USD)</Label>
                  <Input
                    type="number"
                    value={config.tradeAmountUSD}
                    min={1}
                    onChange={e => tradeConfig.set(selectedEx.id, { tradeAmountUSD: Number(e.target.value) })}
                    className="h-9 text-sm font-mono text-right"
                  />
                  <p className="text-[10px] text-zinc-500">Sourced from Trade Config — change here or in the Trade Config tab.</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11px] text-zinc-400">Reference price (optional)</Label>
                  <Input
                    type="number"
                    value={manualPriceOverride}
                    onChange={e => setManualPriceOverride(e.target.value)}
                    placeholder="auto-fetch"
                    className="h-9 text-sm font-mono text-right"
                  />
                  <p className="text-[10px] text-zinc-500">Used for stale-price guard + risk sizing. Leave blank to fetch from the exchange.</p>
                </div>
              </div>

              <Button
                type="button"
                disabled={manualSubmitting || !manualSymbol}
                onClick={async () => {
                  setManualSubmitting(true);
                  setManualResult(null);
                  try {
                    // Delegate price resolution + engine submission to the
                    // shared bridge so the bot tick, AutoPilot and Manual
                    // Order paths all run through the same code path. The
                    // bridge refuses to size a live order from a placeholder
                    // price and returns a uniform { ok, message } result.
                    const out = await submitManualOrder({
                      exchangeId:    selectedEx.id,
                      exchangeName:  selectedEx.name,
                      symbol:        manualSymbol,
                      side:          manualSide,
                      priceOverride: manualPriceOverride,
                      mode,
                    });
                    setManualResult({ ok: out.ok, message: out.message });
                    if (out.ok) {
                      toast({ title: 'Order accepted', description: out.message });
                      // Begin tracking the manual order's fill progress.
                      // Demo/paper orderIds aren't real exchange orders so we
                      // mark them filled immediately; live orders are polled.
                      const orderId = out.result?.orderId;
                      if (orderId) {
                        const key = manualKey(orderId);
                        orderProgress.start({
                          key, source: 'manual', exchange: selectedEx.id,
                          symbol: manualSymbol, side: manualSide,
                          label: `Manual ${manualSide.toUpperCase()} ${manualSymbol}`,
                        });
                        orderProgress.update(key, { orderId, phase: 'pending' });
                        const looksReal = !orderId.startsWith('demo_') && !orderId.startsWith('paper_');
                        if (looksReal && (mode === 'real' || mode === 'testnet') && apiKey && secretKey) {
                          const creds = { apiKey, secretKey, ...(passphrase ? { passphrase } : {}) };
                          orderProgress.poll({
                            key, orderId, exchange: selectedEx.id,
                            symbol: manualSymbol, creds,
                          });
                        } else {
                          orderProgress.update(key, { phase: 'filled' });
                        }
                      }
                    } else {
                      toast({ title: 'Order blocked', description: out.message, variant: 'destructive' });
                    }
                  } catch (e) {
                    const m = (e as Error).message ?? 'Unexpected error';
                    setManualResult({ ok: false, message: m });
                    toast({ title: 'Submission failed', description: m, variant: 'destructive' });
                  } finally {
                    setManualSubmitting(false);
                  }
                }}
                className={`w-full h-10 font-bold ${manualSide === 'buy' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'} text-white`}
              >
                {manualSubmitting
                  ? 'Submitting…'
                  : `Submit ${manualSide.toUpperCase()} ${manualSymbol || ''} via Engine`}
              </Button>

              {manualResult && (
                <div className={`p-3 rounded-xl border text-xs ${
                  manualResult.ok
                    ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300'
                    : 'border-red-500/30 bg-red-500/5 text-red-300'
                }`}>
                  {manualResult.message}
                </div>
              )}

              {/* Live fill-progress for in-flight + recently-completed manual orders. */}
              {Object.values(progressMap).filter(p => p.source === 'manual').length > 0 && (
                <div className="space-y-2">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
                    Manual Order Progress
                  </div>
                  {Object.values(progressMap)
                    .filter(p => p.source === 'manual')
                    .sort((a, b) => b.startedAt - a.startedAt)
                    .map(p => (
                      <OrderProgressPanel
                        key={p.key}
                        p={p}
                        showHeader
                        testIdSuffix={`manual-${p.orderId ?? p.startedAt}`}
                        onDismiss={() => dismissProgress(p.key)}
                        onResume={() => resumeProgress(p.key)}
                      />
                    ))}
                </div>
              )}

              <p className="text-[10px] text-zinc-500 leading-relaxed">
                Every submission flows through the same Execution Engine the bots and AutoPilot use, so it inherits all safety
                gates: mode check, trading-armed check, API validation, balance fetch, trade permission, credentials, risk
                manager, symbol rules and one-shot retry on transient network failures. Successes and rejections both appear
                in the <b>Execution Log</b> tab.
              </p>
            </CardContent>
          </Card>
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

          {diagEvents.length > 0 && (() => {
            const counts = new Map<ExchangeStage, number>();
            for (const ev of diagEvents) counts.set(ev.stage, (counts.get(ev.stage) ?? 0) + 1);
            const stages = Array.from(counts.keys()).sort();
            const toggle = (s: ExchangeStage) => setDiagStageFilter(prev => {
              const next = new Set(prev);
              if (next.has(s)) next.delete(s); else next.add(s);
              return next;
            });
            const allActive = diagStageFilter.size === 0;
            return (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setDiagStageFilter(new Set())}
                  className={`text-[10px] px-2 py-0.5 rounded-full border transition ${
                    allActive
                      ? 'border-zinc-500 text-zinc-200 bg-zinc-800/60'
                      : 'border-zinc-700 text-zinc-500 hover:text-zinc-300'}`}
                >All</button>
                {stages.map(s => {
                  const active = diagStageFilter.has(s);
                  const isOrderPoll = s === 'order-poll';
                  const baseInactive = isOrderPoll
                    ? 'border-cyan-500/30 text-cyan-500/70 hover:text-cyan-300'
                    : 'border-zinc-700 text-zinc-500 hover:text-zinc-300';
                  const baseActive = isOrderPoll
                    ? 'border-cyan-500/60 text-cyan-300 bg-cyan-500/10'
                    : 'border-zinc-500 text-zinc-200 bg-zinc-800/60';
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => toggle(s)}
                      className={`text-[10px] px-2 py-0.5 rounded-full border font-mono transition ${
                        active ? baseActive : baseInactive}`}
                    >
                      {s} <span className="opacity-60">{counts.get(s)}</span>
                    </button>
                  );
                })}
              </div>
            );
          })()}

          <Card className="border-zinc-800/60">
            <CardContent className="p-0">
              {(() => {
                const visible = diagStageFilter.size === 0
                  ? diagEvents
                  : diagEvents.filter(ev => diagStageFilter.has(ev.stage));
                if (visible.length === 0) {
                  return (
                    <div className="text-center py-12 text-zinc-500 text-sm">
                      {diagEvents.length === 0
                        ? 'No exchange events recorded yet.'
                        : 'No events match the selected filters.'}
                    </div>
                  );
                }
                return (
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
                      {[...visible].reverse().map(ev => (
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
                );
              })()}
            </CardContent>
          </Card>
        </div>
      </ErrorBoundary>)}
    </div>
  );
}

// ─── Classified Balances grid ────────────────────────────────────────────────
// Splits the live balances into 4 collapsible sections (Active / Partial /
// Dust / Wallet) and a hidden Fully-Closed bucket. Uses position-classifier
// + cached symbol rules so the Close button only appears when the SELL would
// actually clear exchange minimums.

interface ClassifiedBalancesProps {
  liveBalances: Array<{ asset: string; available: number; hold: number; total: number; usdtValue?: number; scope?: string }>;
  exchangeId:   string;
  stables:      Set<string>;
  closingPositions: Set<string>;
  progressMap:  Record<string, OrderProgress | undefined>;
  onClose:           (asset: string) => void;
  onDismissProgress: (key: string) => void;
  onResumeProgress:  (key: string) => void;
}

function ClassifiedBalances(p: ClassifiedBalancesProps) {
  const doctor = useBotDoctor();
  void doctor.lastUpdated; // re-render whenever doctor state changes
  const [open, setOpen] = useState<Record<PositionCategory, boolean>>({
    active_position:  true,
    partial_position: true,
    dust_balance:     false,
    wallet_holding:   false,
    fully_closed:     false,
  });

  const classified = p.liveBalances.map(b => {
    const upper = b.asset.toUpperCase();
    const isStable = p.stables.has(upper);
    const tracked  = getOwned(p.exchangeId, upper);
    const compl    = resolveCompliance(b.asset, p.exchangeId as ExchangeId);
    const cachedRules = compl.ok
      ? pipelineCache.get<SymbolRules>(`rules:${p.exchangeId}:${compl.exchangeSymbol}`)
      : undefined;
    const verdict: ClassifyResult = classifyHolding({
      asset:     upper,
      available: b.available,
      hold:      b.hold,
      ...(typeof b.usdtValue === 'number' ? { usdtValue: b.usdtValue } : {}),
      exchange:  p.exchangeId,
      ...(cachedRules ? { symbolRules: cachedRules } : {}),
      trackedQty: tracked,
      isDustMarked: botDoctorStore.isDust(p.exchangeId, upper),
      isStable,
    });
    return { row: b, verdict };
  });

  const buckets: Record<PositionCategory, typeof classified> = {
    active_position: [], partial_position: [], dust_balance: [], wallet_holding: [], fully_closed: [],
  };
  for (const c of classified) buckets[c.verdict.category].push(c);

  const chipClass: Record<PositionCategory, string> = {
    active_position:  'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    partial_position: 'bg-amber-500/15  text-amber-300  border-amber-500/30',
    dust_balance:     'bg-zinc-700/50  text-zinc-300  border-zinc-600/40',
    wallet_holding:   'bg-blue-500/15  text-blue-300  border-blue-500/30',
    fully_closed:     'bg-zinc-800/60  text-zinc-500  border-zinc-700/40',
  };

  return (
    <div className="space-y-4">
      {POSITION_CATEGORY_ORDER.map(cat => {
        const items = buckets[cat];
        if (items.length === 0) return null;
        // Hide Fully Closed by default unless there's something interesting.
        const isOpen = open[cat];
        return (
          <div key={cat} className="border border-zinc-800/60 rounded-lg overflow-hidden bg-zinc-950/40">
            <button
              type="button"
              className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-zinc-900/60 transition-colors"
              onClick={() => setOpen(s => ({ ...s, [cat]: !s[cat] }))}
              data-testid={`button-toggle-section-${cat}`}
            >
              <div className="flex items-center gap-2">
                <ChevronDown
                  size={12}
                  className={`text-zinc-500 transition-transform ${isOpen ? '' : '-rotate-90'}`}
                />
                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-300">
                  {POSITION_CATEGORY_LABELS[cat]}
                </span>
                <Badge variant="outline" className={`text-[9px] ${chipClass[cat]}`}>{items.length}</Badge>
              </div>
              <span className="text-[10px] text-zinc-500">
                {cat === 'active_position'  && 'Open positions held by your bots'}
                {cat === 'partial_position' && 'Bot opened — qty has been reduced'}
                {cat === 'dust_balance'     && 'Below exchange minimums — cannot be closed'}
                {cat === 'wallet_holding'   && 'Wallet asset not opened by a bot'}
                {cat === 'fully_closed'     && 'Bot opened then flattened'}
              </span>
            </button>
            {isOpen && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 p-3">
                {items.map(({ row: b, verdict }) => {
                  const closing = p.closingPositions.has(b.asset);
                  return (
                    <Card key={b.asset} className="border-zinc-800/60">
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between mb-2">
                          <div className="font-bold text-sm">{b.asset}</div>
                          <Badge variant="outline" className={`text-[9px] ${chipClass[cat]}`}
                                 data-testid={`chip-status-${b.asset}`}>
                            {POSITION_CATEGORY_LABELS[cat]}
                          </Badge>
                        </div>
                        <div className="font-mono font-bold text-xl">{fmt(b.available, 6)}</div>
                        <div className="text-xs text-zinc-500 mt-1">Total: {fmt(b.total, 6)}</div>
                        <div className="text-xs text-zinc-500 mt-0.5">
                          {typeof b.usdtValue === 'number' ? `≈ $${fmt(b.usdtValue)} USDT` : '≈ — USDT'}
                        </div>
                        {b.hold > 0 && <div className="text-[10px] text-amber-400 mt-0.5">Locked: {fmt(b.hold, 6)}</div>}
                        <div className="text-[10px] text-zinc-400 mt-2 leading-snug" data-testid={`chip-reason-${b.asset}`}>
                          {verdict.detail}
                        </div>
                        {verdict.canClose ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="mt-3 w-full h-7 text-[10px] border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-300 gap-1"
                            disabled={closing}
                            onClick={() => p.onClose(b.asset)}
                            data-testid={`button-close-position-${b.asset}`}
                            title={`Submit a market SELL of ${b.asset} via the trading engine`}
                          >
                            {closing ? <RefreshCw size={11} className="animate-spin" /> : <X size={11} />}
                            {closing ? 'Closing…' : `Close ${b.asset} Position`}
                          </Button>
                        ) : null}
                        {p.progressMap[closeKey(b.asset)] && (
                          <OrderProgressPanel
                            p={p.progressMap[closeKey(b.asset)]!}
                            dense
                            testIdSuffix={`close-${b.asset}`}
                            onDismiss={() => p.onDismissProgress(closeKey(b.asset))}
                            onResume={() => p.onResumeProgress(closeKey(b.asset))}
                          />
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
