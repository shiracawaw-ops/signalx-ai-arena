# PROFIT_REFACTOR_REPORT

**Scope:** end-to-end re-audit and surgical refactor of `artifacts/signalx-arena` for one purpose only — disciplined real-trading quality, lower silent-rejection rate, fee-aware execution, and cleaner decision flow.

**Honesty disclaimer (per the brief):** no system, regardless of design, can guarantee profit in real markets. The brief itself forbids that promise. The work below removes hidden friction and raises decision quality; it does **not** promise any specific result percentage.

---

## AUDIT SUMMARY

* The execution chain is already tightly engineered. The earlier inventory turned up **one concrete wiring gap** that materially harms trade selection: AutoPilot computes a per-bot composite **confidence (0..95)** from realized PnL + win rate + drawdown + recency, but **does not pass it to the engine**, so the trade-quality preflight evaluates every AutoPilot signal at the neutral default 0.7 — a 92%-confidence bot is graded the same as a 35%-confidence one. This is the highest-impact, lowest-risk fix.
* Cooldown was already neutralized in v1.5.4 (default 0, migration in place, gated in `risk-manager`).
* Credential / readiness path was already fixed in v1.5.4 (lazy hydrate from `credentialStore`, missing-creds vs gates-not-green disambiguation).
* `rejection-shield` thresholds previously flagged for "deeper investigation" are, on review, **safely tuned**: 90s memory cooldown (down from 5min), 10min memory TTL, closing-sell bypass everywhere, neutral defaults when symbol rules are unknown. **No threshold change is justified** without live A/B data. Touching them would create more silent harm than it removes.
* `bot-doctor-store` benches already auto-expire (30min default, 15min for `high_reject_rate`). The `manual` code is the only permanent bench. **No TTL change needed.**
* `risk-manager` already does side-aware balance, fee buffer (1% on BUY notional), 5% min-notional drift buffer on BUY, dust detection on SELL, and ledger-fallback for fresh fills the exchange hasn't surfaced yet.
* No "harmful blocker" was found that silently suppresses valid trades. The only previously suspicious surfaces (`low_trade_quality`, `edge_below_fees`) are **opt-in** — they only veto when caller passes `expectedEdgeBps` below round-trip cost, or when minNotional×1.1 isn't reachable post-fees. Both vetoes are economically correct.
* Cosmetic / dashboard-only modules (`pages/wallet`, `pages/status`, `pages/pipeline`, `pipeline-diagnostics`, MockExchangeAdapter, `exchange-events`) **do not touch real execution** and are not consuming engine budget. Removing them is not a profit-impacting change; it's only a code-tidiness change with non-zero risk of breaking imports we didn't trace. **Deferred** to a separate cleanup pass.

**Net change applied this turn:** one targeted wiring fix, zero deletions, zero behavioural inversions. Tests: 224/224 pass; tsc clean.

---

## CRITICAL SYSTEMS KEPT

* `live-execution-bridge.ts` — single funnel (3 entry points: AutoPilot, arena bot bridge, manual). Fleet-gate first, latch-dedupe per (botId, action), explicit unsupported-asset rejection logged once.
* `execution-engine.executeSignal` — 22 ordered rejection points; sole real-mode chokepoint.
* `risk-manager.validateRisk` — side-aware balance, fee + drift buffers, dust detection.
* `rejection-shield.preflight` — compliance + cached symbol rules + balance peek + composite trade-quality gate (entries only); closing-sells bypass everywhere.
* `trade-quality.scoreTradeQuality` — composite 0..1 with neutral defaults; vetoes only on real economic failures (exit notional below minNotional×1.1 after fees, or supplied edge below round-trip cost).
* `bot-allocation.checkBotAllocation` — per-bot capital cap; closing-SELLs not gated.
* `exchange-mode` — sole readiness state machine (`setConnectionState` lines 222-292).
* `credential-store` — in-memory by design; lazy-hydrated by engine.
* `bot-doctor-store` — auto-expiring bench (15-30min) + dust marks; auto-bench rules tuned to avoid false positives (≥3 attempts, ≥0.5 reject rate for cooldown spam; ≥5 attempts, ≥0.6 for generic high-reject).
* `bot-fleet` — real-bot allow-list intersected with bench set on every selection pass.
* `trade-config` — sole config source of truth; cooldown default 0 + 60→0 migration.
* `pipeline-cache` — TTL cache for symbol rules (used by both shield and engine).
* `asset-compliance` — symbol unification + min-notional / step / lot rules across the 12 supported exchanges.

## SYSTEMS SIMPLIFIED OR MERGED

* None this turn.
* Honest reason: the previous inventory tagged several modules ("simplify or merge") as Phase-2 candidates contingent on tracing all importers. Doing those merges blind without that trace is **negative-EV**: the risk of breaking a working real-trade path outweighs the cosmetic gain. They are listed under "Remaining risks" so a follow-up turn can do them with evidence.

## SYSTEMS REMOVED OR DISABLED

* None this turn.
* Honest reason: same as above — the brief explicitly forbids removing things that genuinely help, and the inventory's "likely cosmetic" candidates have **not been verified to be 100% off the live execution path**. Removing them now risks silently breaking a UI consumer that is genuinely useful for diagnosis (e.g. `pages/status` is read-only but it is the user's only consolidated readiness dashboard).

## HARMFUL LOGIC FIXED

* `live-execution-bridge.ts` `dispatchAutoPilotLiveSignal` — the constructed `Signal` did not include `confidence`, so `execution-engine` had nothing to forward to `preflight()`, so `trade-quality.scoreTradeQuality` always used the neutral default `0.7` for the `confidence` component (10% weight). Effect on real trading: AutoPilot's per-bot scoring (which is the entire point of the AutoPilot system) was being **discarded at the quality gate**. High-confidence bots and low-confidence bots were graded identically. Fix: pass `d.selectedBot.confidence` through to the Signal. The composite-quality gate now actually rewards stronger bots and penalises weaker ones in the only place it matters — pre-flight veto.

## FILES CHANGED

* `artifacts/signalx-arena/src/lib/live-execution-bridge.ts` (one signal-construction site, lines ~297-314)
* `artifacts/signalx-arena/PROFIT_REFACTOR_REPORT.md` (new)

## EXPECTED IMPROVEMENTS

* AutoPilot signals from genuinely high-quality bots will now produce a higher composite quality score and pass the floor more readily.
* AutoPilot signals from low-quality bots that previously slipped through the neutral 0.7 default will now be more likely to be filtered at preflight, reducing noisy losing entries.
* No change to closing sells (still bypass quality gate, as intended).
* No change to manual trades from the Exchange page (no per-signal confidence available there; behaviour unchanged).
* No change to arena sim-driven bot trades bridged to live (engine has no per-trade confidence for those; behaviour unchanged).
* No change to rejection or success rate when AutoPilot is not active.

## REMAINING RISKS

* `confidence` is a relative measure inside AutoPilot's own scoring (max 95). It is not absolute "probability of profit". The trade-quality gate weights it at 10%, which is moderate and intentional — do not reinterpret as a market-edge probability.
* The previously-flagged "likely cosmetic" surfaces (`pages/wallet`, `pages/status`, `pages/pipeline`, `pipeline-diagnostics`, `MockExchangeAdapter`, `exchange-events`) are still present. They do **not** harm execution but they remain as code-tidiness debt. A follow-up turn should trace each one's importers carefully before deletion.
* `credentialStore` is still in-memory only (security choice). Page reload still requires re-paste.
* `exchangeMode.armed` is still session-only by design. Reload requires re-arming.
* `trade-config` 60→0 cooldown migration overwrites users who intentionally chose 60s. One-time cost.
* No change was made to threshold values in `rejection-shield` or `trade-quality`. If real users report excessive `low_trade_quality` rejects after this fix, the most likely cause is that bots with low AutoPilot confidence are now being correctly filtered — that's the intended effect, not a regression.

## HOW TO VERIFY

* Pull the latest commit, install, run `pnpm test` — expect 224/224 pass.
* Run `pnpm tsc -p tsconfig.json --noEmit` — expect zero errors.
* Open the app, go to Exchange, connect with valid Bybit credentials, arm trading.
* Open AutoPilot. Watch the in-page log: when a high-confidence bot's BUY signal fires, the engine result should be a successful order id. When a low-confidence bot's BUY signal fires (e.g. a fresh bot with no realized PnL, confidence ~10-20), the result should now more frequently say `Pre-flight: Trade quality: Quality 0.XX below floor 0.55`. That is the wired-through confidence doing its job.
* Closing sells (where the asset is already owned) must continue to bypass the quality gate. Verify by manually closing a small position from the Exchange page — there should be no `low_trade_quality` reject.
* Cooldown must remain disabled at default 0. Verify by checking Risk Engine page — `cooldown_between_trades_seconds` should display 0; AutoPilot rapid-fire signals should not produce `cooldown_active` rejects.
* Verify the previous v1.5.4 fixes still hold:
  * AutoPilot with valid credentials but unarmed → `BOT_NOT_ARMED`.
  * AutoPilot with no credentials saved → `MISSING_CREDENTIALS` (clear single message, not "5 missing flags").
  * Page reload landing on `/arena` does not strand a saved credential — engine still finds it via `credentialStore.get(exchange)`.
