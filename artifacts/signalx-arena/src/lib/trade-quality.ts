// ─── Composite Trade Quality Score (Phase 2/3) ───────────────────────────────
// A pre-entry gate that turns the previously binary "compliance pass/fail"
// preflight into a graded quality score. The goal of the brief is real net
// profitability — fewer but better trades — so this module rejects entries
// where the *expected* economics already look bad before we touch the wire:
//
//   • notional buffer above the exchange minimum  (room to exit cleanly)
//   • signal price freshness                     (stale = wider real spread)
//   • fee headroom                               (will the exit notional, after
//                                                 round-trip taker fees, still
//                                                 clear the exchange minimum?)
//   • cooldown penalty                           (recent rejects on this symbol)
//   • optional caller-supplied confidence (0..100)
//   • optional caller-supplied expectedEdgeBps   (signal's estimated edge)
//
// The module is **pure**: callers feed it everything it needs. That keeps it
// trivially unit-testable and lets the rejection-shield call it without any
// extra network I/O.
//
// Closing-sells must NEVER pass through this gate — exits are a different
// economic decision and have their own dedicated upfront SELL gate in the
// execution engine. This module is for entries (buys) only.

export interface SymbolRulesLike {
  minQty?:      number;
  minNotional?: number;
  stepSize?:    number;
  tickSize?:    number;
}

export interface TradeQualityInput {
  notional:        number;            // planned trade size in quote (USDT)
  refPrice:        number;            // signal price
  signalAgeMs:     number;            // (now - signal.ts), already computed by caller
  rules?:          SymbolRulesLike;   // cached symbol rules; may be undefined
  recentFails?:    number;            // shield rejection memory for this symbol (0..N)
  expectedEdgeBps?: number;           // optional caller-supplied edge in bps (1bp = 0.01%)
  confidence?:     number;            // optional caller-supplied confidence 0..100
  exchange?:       string;            // venue id, used to pick taker-fee assumption
  spreadPct?:      number;            // optional live spread percentage
  volatilityPct?:  number;            // optional recent volatility percentage
  momentumScore?:  number;            // optional normalized momentum score 0..1
  volumeRatio?:    number;            // optional ratio currentVol / avgVol
}

export interface TradeQualityComponent {
  id:    string;
  score: number;       // 0..1
  weight: number;      // weight inside the composite
  detail: string;
}

export interface TradeQualityVerdict {
  /** Composite quality score in 0..1. */
  score:      number;
  /** True iff score >= floor AND no veto component fired. */
  pass:       boolean;
  /** Threshold this verdict was evaluated against. */
  floor:      number;
  /** Vetoes are hard fails that bypass the composite — e.g. exit-notional
   *  under fees would not clear the exchange minimum, so the trade can never
   *  exit cleanly no matter how high the rest of the score is. */
  vetoes:     string[];
  /** Per-component breakdown for diagnostics + tests. */
  components: TradeQualityComponent[];
  /** Short, operator-readable summary. */
  reason:     string;
}

// Per-side taker fee assumption in basis points. 1bp = 0.01%.
// Bybit & Binance spot take ~10bps. Round-trip = ~20bps (entry + exit).
// Round-trip "real cost" budget also includes a small spread allowance.
function takerBpsPerSide(exchange?: string): number {
  const ex = (exchange ?? '').toLowerCase();
  if (ex === 'binance' || ex === 'bybit') return 10;
  return 12; // conservative default for unknown venues
}

/** Round-trip *cost* in basis points (both legs + spread allowance). */
export function roundTripCostBps(exchange?: string): number {
  const perSide = takerBpsPerSide(exchange);
  // 5bp spread allowance per side covers the common bid/ask penalty for
  // market orders on the listed exchanges.
  return perSide * 2 + 10;
}

/** Default minimum acceptable composite score for a new entry. */
export const QUALITY_FLOOR = 0.55;

const MAX_SIGNAL_AGE_MS = 30_000;        // matches engine STALE_PRICE_MS
const FRESH_SIGNAL_AGE_MS = 5_000;
const COOLDOWN_FAIL_CEILING = 2;          // matches rejection-shield FAIL_THRESHOLD

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }

// Map a value linearly: returns 1 at `good`, 0 at `bad`, clamped.
function ramp(value: number, good: number, bad: number): number {
  if (good === bad) return value >= good ? 1 : 0;
  if (good > bad) return clamp01((value - bad) / (good - bad));
  return clamp01((bad - value) / (bad - good));
}

export function scoreTradeQuality(input: TradeQualityInput): TradeQualityVerdict {
  const components: TradeQualityComponent[] = [];
  const vetoes: string[] = [];

  const minNotional = input.rules?.minNotional ?? 0;
  const notional    = Number.isFinite(input.notional) ? Math.max(0, input.notional) : 0;

  // 1. Notional buffer above exchange minimum.
  // 1.0 when notional >= 4× minNotional. 0 at minNotional. If we don't know
  // the minimum (no rules) we assume neutral 0.6 so the gate doesn't punish
  // demo/paper or unknown venues.
  let bufferScore = 0.6;
  let bufferDetail = 'No symbol rules cached; neutral score assumed.';
  if (minNotional > 0) {
    bufferScore = ramp(notional, minNotional * 4, minNotional);
    bufferDetail = `notional $${notional.toFixed(2)} vs minNotional $${minNotional.toFixed(2)} ` +
                   `(target ≥ $${(minNotional * 4).toFixed(2)})`;
  }
  components.push({ id: 'notional_buffer', score: bufferScore, weight: 0.25, detail: bufferDetail });

  // 2. Signal freshness.
  const ageMs = Math.max(0, Number.isFinite(input.signalAgeMs) ? input.signalAgeMs : 0);
  const freshScore = ramp(ageMs, FRESH_SIGNAL_AGE_MS, MAX_SIGNAL_AGE_MS);
  components.push({
    id: 'price_freshness',
    score: freshScore,
    weight: 0.15,
    detail: `signal age ${(ageMs / 1000).toFixed(1)}s (fresh ≤ ${FRESH_SIGNAL_AGE_MS / 1000}s, stale ≥ ${MAX_SIGNAL_AGE_MS / 1000}s)`,
  });

  // 3. Fee headroom — after a buy + sell round-trip the residual notional
  // must still clear the exchange minimum, otherwise the eventual exit will
  // be either dust or rejected.  This is the core "real profitability"
  // protection: it directly stops trades that *cannot* exit cleanly.
  const rtBps   = roundTripCostBps(input.exchange);
  const exitNotional = notional * (1 - rtBps / 10_000);
  let feeScore = 1;
  let feeDetail = `round-trip cost ~${rtBps}bps; no minNotional to enforce against.`;
  if (minNotional > 0) {
    // Veto if even a no-loss exit (gross == cost) wouldn't clear the minimum
    // by 10%. Otherwise score by the headroom over min × 1.1.
    const required = minNotional * 1.1;
    feeScore = ramp(exitNotional, minNotional * 2, required);
    feeDetail = `exit notional after fees $${exitNotional.toFixed(2)} vs minNotional×1.1 $${required.toFixed(2)} (rt cost ${rtBps}bps)`;
    if (exitNotional < required) {
      vetoes.push(`Exit notional $${exitNotional.toFixed(2)} after ${rtBps}bps round-trip would not clear minNotional×1.1 $${required.toFixed(2)}.`);
    }
  }
  components.push({ id: 'fee_headroom', score: feeScore, weight: 0.30, detail: feeDetail });

  // 4. Cooldown / recent-fail penalty.
  const fails = Math.max(0, input.recentFails ?? 0);
  const cooldownScore = ramp(fails, 0, COOLDOWN_FAIL_CEILING);
  components.push({
    id: 'cooldown_penalty',
    score: cooldownScore,
    weight: 0.10,
    detail: `${fails} recent reject(s) on this symbol (penalty caps at ${COOLDOWN_FAIL_CEILING})`,
  });

  // 5. Optional caller-supplied confidence (0..100). If not provided we use
  // a neutral 0.7 so signals without confidence info don't get punished.
  const confRaw = input.confidence;
  const confScore = (confRaw === undefined || !Number.isFinite(confRaw))
    ? 0.7
    : clamp01(confRaw / 100);
  components.push({
    id: 'confidence',
    score: confScore,
    weight: 0.10,
    detail: confRaw === undefined ? 'no confidence supplied; neutral 0.7' : `confidence ${confRaw}`,
  });

  // 6. Optional expected-edge guard (bps). If supplied and edge is below
  // round-trip cost × 2 we veto — there's no realistic profit after fees.
  const edge = input.expectedEdgeBps;
  let edgeScore = 1;
  let edgeDetail = 'no expected edge supplied; neutral 1.0';
  if (edge !== undefined && Number.isFinite(edge)) {
    const minEdge = rtBps;             // need to at least cover round-trip
    const goodEdge = rtBps * 3;        // 3× round-trip = strong setup
    edgeScore = ramp(edge, goodEdge, minEdge);
    edgeDetail = `expected edge ${edge}bps vs round-trip cost ${rtBps}bps (target ≥ ${goodEdge}bps)`;
    if (edge < minEdge) {
      vetoes.push(`Expected edge ${edge}bps does not cover round-trip cost ${rtBps}bps.`);
    }
  }
  components.push({ id: 'edge_after_fees', score: edgeScore, weight: 0.10, detail: edgeDetail });

  // 7. Spread quality — tighter spread is better for scalping entries.
  const spreadPct = Number.isFinite(input.spreadPct) ? Math.max(0, input.spreadPct ?? 0) : undefined;
  const spreadScore = spreadPct === undefined ? 0.7 : ramp(spreadPct, 0.05, 0.40);
  components.push({
    id: 'spread_quality',
    score: spreadScore,
    weight: 0.08,
    detail: spreadPct === undefined
      ? 'no spread snapshot supplied; neutral 0.7'
      : `spread ${spreadPct.toFixed(3)}% (target ≤ 0.05%, hard-fail near 0.40%)`,
  });
  if (spreadPct !== undefined && spreadPct > 0.60) {
    vetoes.push(`Spread ${spreadPct.toFixed(3)}% is too high for scalping.`);
  }

  // 8. Volatility sanity — reject extreme spikes, penalize dead-flat noise.
  const volPct = Number.isFinite(input.volatilityPct) ? Math.max(0, input.volatilityPct ?? 0) : undefined;
  const volatilityScore = volPct === undefined
    ? 0.7
    : clamp01(1 - Math.abs(volPct - 0.45) / 0.55);
  components.push({
    id: 'volatility_sanity',
    score: volatilityScore,
    weight: 0.06,
    detail: volPct === undefined
      ? 'no volatility snapshot supplied; neutral 0.7'
      : `volatility ${volPct.toFixed(3)}% (sweet-spot around 0.45%)`,
  });
  if (volPct !== undefined && volPct > 2.5) {
    vetoes.push(`Volatility spike ${volPct.toFixed(2)}% exceeds scalper ceiling.`);
  }

  // 9. Momentum + volume confirmation (optional, from smart-scalper precheck).
  const momentumScore = Number.isFinite(input.momentumScore) ? clamp01(input.momentumScore ?? 0) : 0.7;
  components.push({
    id: 'momentum_confirmation',
    score: momentumScore,
    weight: 0.08,
    detail: Number.isFinite(input.momentumScore)
      ? `momentum score ${(momentumScore * 100).toFixed(0)}%`
      : 'no momentum score supplied; neutral 0.7',
  });
  const volumeRatio = Number.isFinite(input.volumeRatio) ? Math.max(0, input.volumeRatio ?? 0) : undefined;
  const volumeScore = volumeRatio === undefined ? 0.7 : ramp(volumeRatio, 1.6, 0.7);
  components.push({
    id: 'volume_confirmation',
    score: volumeScore,
    weight: 0.08,
    detail: volumeRatio === undefined
      ? 'no volume ratio supplied; neutral 0.7'
      : `volume ratio ${volumeRatio.toFixed(2)}x vs baseline`,
  });

  // ── Composite ────────────────────────────────────────────────────────────
  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  const score = totalWeight > 0
    ? components.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight
    : 0;

  const pass = vetoes.length === 0 && score >= QUALITY_FLOOR;

  let reason: string;
  if (vetoes.length > 0) {
    reason = vetoes[0]!;
  } else if (!pass) {
    const weakest = [...components].sort((a, b) => a.score - b.score)[0];
    reason = `Quality ${score.toFixed(2)} below floor ${QUALITY_FLOOR}` +
             (weakest ? ` (weakest: ${weakest.id} = ${weakest.score.toFixed(2)})` : '');
  } else {
    reason = `Quality ${score.toFixed(2)} ≥ floor ${QUALITY_FLOOR}.`;
  }

  return { score, pass, floor: QUALITY_FLOOR, vetoes, components, reason };
}
