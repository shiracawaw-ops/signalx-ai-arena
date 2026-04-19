# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM (api-server); localStorage (signalx-arena)
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

### SignalX AI Arena (`artifacts/signalx-arena`)
- **Type**: React + Vite web app (multi-page with AppShell sidebar)
- **Preview path**: `/`
- **Purpose**: Premium local-first virtual trading simulator with AI bots
- **Storage**: localStorage only — no backend, no database, no paid APIs
- **Routing**: wouter with `AppShell` sidebar wrapping all pages

### Architecture — Key libs
- `src/lib/indicators.ts` — RSI, MACD, VWAP, Bollinger Bands, SMA20/50, Breakout Scanner
- `src/lib/engine.ts` — bot trading engine, tick logic
- `src/lib/storage.ts` — localStorage persistence, ASSET_MAP (38 assets)
- `src/lib/platform.ts` — user session, fees (0.1%), risk config, alerts
- `src/lib/diagnostics.ts` — bot health scoring, issue detection, BotDiagnostic
- `src/lib/exchange.ts` — MockBinanceAdapter, ExchangeOrder, permission checker
- `src/lib/exchange-mode.ts` — Unified Demo/Live singleton (ExchangeModeManager), armed state, readiness report
- `src/lib/execution-engine.ts` — Signal-to-execution engine (demo/live separation, armed check, API call)
- `src/lib/risk-manager.ts` — Pre-execution risk validation (balance, min size, cooldown, daily limit, duplicate)
- `src/lib/execution-log.ts` — Execution log (CRUD, 500-entry cap, localStorage, reject reasons)
- `src/lib/trade-config.ts` — Per-exchange trade settings (amount, stops, cooldown, allowed symbols, emergency stop)
- `src/lib/api-client.ts` — Frontend HTTP client to backend exchange proxy (keys masked in logs)
- `src/lib/wallet.ts` — transaction ledger, deposit/withdrawal
- `src/context/arena-context.tsx` — SHARED state (ArenaContext + ArenaProvider) — all pages use this
- `src/hooks/use-arena.ts` — re-exports `useArena` from context (thin wrapper)
- `src/lib/seed.ts` — `generateBots(count, startingBalance)` supports 1–500 bots dynamically

### Components
- `src/components/signalx-logo.tsx` — animated X logo (framer-motion rotateY horizontal rotation + red glow)
- `src/components/app-shell.tsx` — collapsible sidebar layout, top bar, user panel

### User System
- `src/lib/user-store.ts` — localStorage-based multi-user accounts, signup/login, Google OAuth, password reset
- `src/context/user-context.tsx` — React context exposing: login, signup, googleLogin, logout, forgotPassword, doResetPassword
- `src/pages/auth/login.tsx` — Sign-in page with "Forgot password?" link and optional Google button
- `src/pages/auth/signup.tsx` — Signup page with optional Google sign-up
- `src/pages/auth/forgot-password.tsx` — Forgot password: generates 6-digit recovery code (15-min expiry)
- `src/pages/auth/reset-password.tsx` — Reset password: email + code + new password
- `src/components/google-sign-in-button.tsx` — Google OAuth button (hidden if no VITE_GOOGLE_CLIENT_ID set)
- **Authentication flow**: unauthenticated → redirect to /login; wouter-based route guard in App.tsx
- **Demo accounts**: demo@signalx.ai / demo123 (Pro), admin@signalx.ai / admin123 (Admin)
- **User plans**: free, pro, admin (subscription structure ready)
- **Google OAuth**: Set `VITE_GOOGLE_CLIENT_ID` env secret to enable; uses @react-oauth/google + token API
- **Password reset**: token stored in `sx_reset_tokens` (localStorage); 6-digit code, 15-minute expiry
- **localStorage keys**: `sx_user_accounts`, `sx_session_v2`, `sx_reset_tokens`
- **User avatar**: shown in sidebar if Google profile picture is available

### PWA (Progressive Web App)
- `vite-plugin-pwa` configured in `vite.config.ts` with autoUpdate service worker
- `public/pwa-192.png` and `public/pwa-512.png` — app icons for install prompt
- `index.html` — theme-color meta, apple-mobile-web-app tags, apple-touch-icon
- **Offline behavior**: app shell + trading simulation run fully offline (no network needed)
- **Offline indicator**: amber banner in app shell when `navigator.onLine` is false
- **Service worker**: caches all JS/CSS/HTML/PNG/SVG assets; Google Fonts cached (CacheFirst 1yr); OAuth routes NetworkOnly
- **Install**: browser shows "Add to Home Screen" / "Install" prompt automatically on production build

### Pages (routes)
- `/`                AutoPilot — main decision engine (primary page after login)
- `/arena`           AI Arena — up to 500 AI bots, 38 assets, live stats bar, filters
- `/doctor`          Bot Doctor — health rings, issue cards, real actions (pause/reset/replace via context)
- `/reports`         Reports — fee-adjusted rankings, charts, daily summary (reads from shared context)
- `/exchange`        Exchange — Binance mock adapter, balances, order history
- `/wallet`          Wallet — virtual ledger + Arena Funds tab (live from context), deposit/withdraw
- `/risk`            Risk Engine — live gauges from shared bot state, kill switch, configurable limits
- `/profile`         Profile — user settings, API keys, subscription plan
- `/status`          System Status — component health, activity log, trust layer, disclaimer
- `/admin`           Admin — Bot Config tab, emergency stop (admin role only)
- `/login`           Login — authentication gate (unauthenticated only)
- `/signup`          Signup — new account creation (unauthenticated only)
- `/forgot-password` Forgot Password — generate recovery code
- `/reset-password`  Reset Password — use code to set new password

### AutoPilot Engine (primary feature)
- `src/lib/autopilot.ts` — decision engine: scores bots on PnL(35%), win rate(25%), momentum(20%), stability(15%), activity(5%)
- `src/pages/autopilot.tsx` — main page: best bot, BUY/SELL/HOLD signal, confidence bar, risk meter, decision log, standby pool
- Evaluates all bots every 5 seconds; auto-pauses engine on DANGER risk level
- Shows gross P&L AND net P&L after fees (0.1% per trade) with fee display
- Paper Trading badge + risk disclaimer always visible
- User greeting (Welcome, [name]) in header
- Decision log tracks bot selections and risk level changes

### Features
- 1–500 AI bots across 38 symbols (Crypto + Stocks + Metals + Forex)
- 7 strategies: RSI, MACD, VWAP, Bollinger, SMA Cross, Breakout, Multi-Signal
- Configurable starting balance: $100–$1,000,000 per bot
- Configurable bot count: 10/25/50/100/200/500 presets + any value
- Tick rate: 800ms (<= 100 bots), 1200ms (> 100 bots) for performance
- Reset All: re-seeds arena with current bot count + balance (no stale state)
- Platform fee calculation (0.1% taker, 0.05% maker)
- Bot health scoring (0–100), issue detection (Critical/Warning/Info)
- Risk engine with drawdown limits, exposure gauges, emergency kill switch
- Unified Trading Execution Engine: 12 real exchange adapters + backend CORS proxy + demo/live separation
- Safety arming system: Trading Armed toggle + 5-condition readiness check before any live order
- Risk management: min qty/notional, step size, cooldown, daily limit, duplicate signal prevention
- Execution log: pending/executed/rejected/failed entries with reject reasons, exchange responses, timestamps
- Trade Config tab: per-exchange settings (trade amount, stops, cooldown, allowed symbols, emergency stop)
- Live Status tab: real-time readiness dashboard + arm/disarm toggle
- Backend exchange proxy: 12 adapters (Binance, OKX, Bybit, KuCoin, Kraken, Coinbase, Bitfinex, MEXC, Gate.io, HTX, Bitget, Deribit)
- Wallet with deposit/withdrawal, full tx ledger, and arena capital view
- System Status page: component statuses, activity log, trust/transparency info
- Full risk disclaimer on all critical pages

### Self-Healing Engine (arena-context.tsx)
- **Default**: 30 bots — ALL 30 active from tick 1, plus 10 standby pool bots
- **IMMEDIATE replacement**: detect weak bots EVERY tick (not every N ticks); grace period = 15 ticks after engine start
- **Weak bot criteria**: PnL < -25% of starting capital OR 7+ consecutive losing sell trades (live-engine trades only, not warm-up)
- **Replacement flow**: pause weak bot (reset balance) → activate best standby → refill standby pool if < 3
- **Configurable to 500**: when user sets count to N → N active bots + 10 standby = N+10 total
- **No load shedding**: FPS quality only adjusts tick rate; never forcefully pauses user-configured bots
- **Watchdog timer (5s)**: if `lastTickAt` > 7.5s old while running → restart tick interval automatically
- **Throttled localStorage saves**: every 5 ticks (not every tick) to reduce I/O
- **Reset All**: clears ALL arena keys (`signalx_bots`, `signalx_trades`, `signalx_risk_config`, `signalx_wallet_*`, heal log) then re-seeds fresh
- **HealEvent log**: stored in `signalx_heal_log`, shown in Bot Doctor + Admin → System
- **Seed version**: `v9-{count}-{balance}` — bump to force fresh defaults
- **Bot Doctor**: Standby Pool tab (10 bots), Heal All button, self-healing log at bottom
- **Warm-up**: 10–25 ticks (reduced from 80 to avoid PnL skew that triggers false healing)

### CI / Windows EXE build (GitHub Actions)
- Live workflow: `.github/workflows/main.yml` runs `Build Windows EXE` job on `windows-latest` for every push to main; uploads `SignalX-AI-Arena-Windows` artifact (~159 MB: NSIS installer + portable EXE).
- `electron-builder.yml` outputs to `dist-electron/` (matches the upload-artifact path). Electron entry point is in `package.json`'s `main` field, NOT in this YAML.
- `pnpm-workspace.yaml` keeps all `win32-x64` native binaries enabled (rollup/lightningcss/oxide/esbuild) — Linux installs auto-skip them via os/cpu fields. `minimumReleaseAge: 1440` is a 1-day supply-chain defense — DO NOT DISABLE.
- **`vite-plugin-pwa` is intentionally OFF in `vite.electron.config.ts`** — Service Worker registration throws under `file://` and produces a blank window. PWA stays ON in `vite.config.ts` (web build).
- **Hash routing in Electron build only** (`src/App.tsx`): under `file://` the renderer's `pathname` is the absolute path of `index.html`, which never matches `/login`/`/`/etc., so wouter renders nothing and the window appears blank. The Electron build (detected via `VITE_IS_ELECTRON === "true"` or `protocol === "file:"`) wraps routes with `WouterRouter hook={useHashLocation} base=""`. The web build keeps its existing `BASE_URL`-driven path-based routing untouched.
- **NoRouteFallback diagnostic**: when `<Switch>` falls through under Electron, a visible red panel renders showing `href`/`pathname`/`hash`/wouter location — prevents future "blank window with no error" regressions.
- **Renderer error overlay**: `src/main.tsx` wraps `createRoot()` and adds global `onerror`/`unhandledrejection` listeners that paint a red panel into `#root`. This catches JS crashes only — a blank window can ALSO be caused by a no-route-matched render (no JS error), which is now handled by the `NoRouteFallback` diagnostic above. When debugging a blank window check both: (a) any red overlay from `main.tsx`, (b) the `NoRouteFallback` panel, (c) launch with `SIGNALX_DEBUG=1` for DevTools.
- **Debug DevTools**: launch the EXE with `SIGNALX_DEBUG=1` env var or `--debug` CLI arg to auto-open detached DevTools.
- **Packaged-asset CI check**: `Verify packaged frontend assets` step in `.github/workflows/main.yml` asserts `resources/frontend/index.html` + `assets/index-*.js` exist in the unpacked installer and that no service-worker registration leaked back in. Build fails before upload if any check fails.
- `artifacts/api-server/vitest.config.ts` excludes `src/exchanges/**` from coverage (adapter tests deferred — task #22). Threshold 60% passes on routes (100%) + lib (94%).

### Critical notes (localStorage keys)
- `signalx_bot_count` — selected bot count (default **30**)
- `signalx_demo_balance` — starting balance per bot (default 1000)
- `signalx_spend_pct` — spend % per trade (default 0.3)
- `signalx_seed_ver` — seed version `v7-{count}-{balance}` — changes trigger re-seed
- `signalx_heal_log` — self-healing event log (last 100 events)
- framer-motion for small UI animations (stat pills, warnings); recharts for charts
- CSS-only GPU animations for X logo (rotate), glow, badge pulse, shimmer, ticker
- Trade storage capped at 2000 (saveTrades has 3-level fallback)
- In-memory trades capped at 3000 in context tick
- `DEFAULT_ACTIVE_ON_START = 6` in seed.ts — first 6 bots active, rest standby
