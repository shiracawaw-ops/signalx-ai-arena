# SignalX AI Arena — Repair Report

Date: 2026-04-23
Version: 1.5.4
Scope: Bybit credential / adapter readiness wiring + cooldown end-to-end repair.
Constraint: existing-files-only, no UI redesign, no rewrite.

---

## files changed

* artifacts/signalx-arena/src/lib/trade-config.ts
* artifacts/signalx-arena/src/lib/risk-manager.ts
* artifacts/signalx-arena/src/lib/execution-engine.ts

---

## critical fixes applied

* Default `cooldownSeconds` lowered from 60 → 0 (single source of truth: `trade_config`).
* One-shot migration on load: any persisted exchange config still on the legacy 60s default (including current Bybit) is silently rewritten to 0 and re-saved, so the UI shows 0 immediately on first reload — no manual edit required.
* `cooldownSeconds === 0` is now an explicit short-circuit in the risk gate: no cooldown check runs, no `cooldown_active` reject row is emitted, no per-symbol/per-bot block is applied. Positive values keep the original throttle behavior.
* `adapter_not_ready` now distinguishes two root causes and surfaces each as actionable copy:
  * **No saved credentials** → `missing_credentials` reject with the specific instruction "Open the Exchange page, paste your API key + secret, then click Connect to validate." (replaces the cryptic 5-flag dump).
  * **Credentials saved but gates not green** → `adapter_not_ready` with the named exchange and the missing flags (so the user can re-Connect to re-run validation).
* `executeSignal` now lazy-hydrates credentials from the singleton `credentialStore` for the active exchange before failing the credentials gate. A page reload that lands on /arena no longer strands a perfectly good saved key.
* Credential persistence path is unchanged and verified: `exchange.tsx` connect flow → `credentialStore.set(exchange, creds)` → `setCredentials(creds)` → `apiClient.validate(exchange, creds)` → `exMode.update({ networkUp, apiValidated, permissions })` → `setConnectionState('connected'|'balance_loaded')` flips all readiness gates.

---

## where Bybit credential/adaptor wiring was fixed

* `artifacts/signalx-arena/src/lib/execution-engine.ts`: imports + `executeSignal` § "1b. REAL-mode strict gate" — distinguishes missing-creds from gates-not-green and quotes the exchange id explicitly.
* `artifacts/signalx-arena/src/lib/execution-engine.ts`: `executeSignal` § "5. Credentials injected" — lazy-loads from `credentialStore.get(exchange)` so the in-memory `credentials` variable is hydrated from the saved Bybit config when available, instead of failing with a stale empty state.
* `artifacts/signalx-arena/src/pages/exchange.tsx` (verified, unchanged): `handleConnect` already saves to `credentialStore.set` BEFORE validation, calls `apiClient.validate(selectedEx.id, creds)`, then on success flips `networkUp`, `apiValidated`, `permissions`, and triggers `setConnectionState('connected')` which the singleton uses to keep the readiness booleans synchronized.

---

## where cooldown logic was removed or bypassed

* `artifacts/signalx-arena/src/lib/trade-config.ts`: `defaultConfig()` — `cooldownSeconds: DEFAULT_COOLDOWN_SECONDS` (= 0).
* `artifacts/signalx-arena/src/lib/trade-config.ts`: `TradeConfigManager.load()` — legacy 60s default migrated to 0 and persisted, so existing saved Bybit config is corrected on next load.
* `artifacts/signalx-arena/src/lib/risk-manager.ts`: `validateRisk()` cooldown block — wrapped in `if (config.cooldownSeconds > 0) { … }`. When 0, no `Date.now()` math runs, no `REJECT.COOLDOWN_ACTIVE` is returned, and nothing is logged.

Note: the per-symbol failure circuit-breaker in `rejection-shield.ts` and the Bot-Doctor's `cooldown_spam` heuristic are independent safety mechanisms (they fire only after repeated failures, not on a fixed timer) and are intentionally left untouched.

---

## how 0 is now interpreted

* 0 means cooldown fully disabled across all execution paths
* no cooldown blocking
* no cooldown_active logging

---

## how to verify

* save valid Bybit credentials (Exchange page → paste API key + secret → Connect)
* confirm adapter is no longer stuck on adapter_not_ready
* confirm readiness gates become true after validation (Live Status panel: networkUp, apiValidated, balanceFetched, tradePermission, tradingArmed)
* set cooldown_between_trades_seconds to 0 in Trade Config (already migrated automatically; verify the input shows 0)
* save config
* run real mode / AutoPilot
* execute repeated eligible trades
* confirm no cooldown block occurs
* confirm logs do not contain cooldown_active
