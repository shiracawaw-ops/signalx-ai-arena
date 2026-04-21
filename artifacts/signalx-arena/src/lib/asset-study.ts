// ─── Asset Study Engine (System #1) ───────────────────────────────────────────
// Per-bot deep-dive that combines:
//   • Compliance (can this bot's asset trade on the active exchange?)
//   • Indicator snapshot (RSI/MACD/VWAP) from the bot's chart
//   • Capital fit (does the bot's tradeAmountUSD beat exchange minNotional?)
//   • Recent performance (last 10 trades win-rate, avg P&L)
//   • Risk score & recommended action
//
// Designed to run BEFORE every autopilot tick so weak/non-tradable bots
// are surfaced immediately instead of producing invisible rejections.

import { computeAllIndicators, aggregateSignal, type Candle } from './indicators';
import { resolveCompliance, type ExchangeId } from './asset-compliance';
import { pipelineCache, TTL } from './pipeline-cache';
import type { Bot, Trade } from './storage';

export type StudyVerdict = 'ready' | 'warm-up' | 'blocked' | 'stalled' | 'risky';

export interface AssetStudy {
  botId:           string;
  botName:         string;
  arenaSymbol:     string;
  exchange:        ExchangeId;
  exchangeSymbol:  string;
  tradable:        boolean;
  blockedReason?:  string;
  signal:          'BUY' | 'SELL' | 'HOLD';
  signalScore:     number;            // -10 … +10
  rsi:             number;
  trend:           'up' | 'down' | 'flat';
  recentWinRate:   number;            // 0-100 over last 10 sells
  recentTrades:    number;
  avgPnl:          number;
  capitalFit:      'ok' | 'low' | 'unknown';
  estimatedQty:    number;
  notionalUSD:     number;
  verdict:         StudyVerdict;
  recommendation:  string;
  confidence:      number;            // 0-100
  studiedAt:       number;
}

export interface BotInputs {
  bot:        Bot;
  candles:    Candle[];
  trades:     Trade[];
  exchange:   ExchangeId;
  amountUSD:  number;
  minNotional?: number;   // when known from cache
}

export function studyBot(input: BotInputs): AssetStudy {
  const { bot, candles, trades, exchange, amountUSD, minNotional } = input;
  const cacheKey = `study:${bot.id}:${exchange}:${amountUSD}`;
  const cached = pipelineCache.get<AssetStudy>(cacheKey);
  if (cached) return cached;

  const compliance = resolveCompliance(bot.symbol, exchange);
  const last       = candles[candles.length - 1];
  const price      = last?.close ?? 0;

  const indicators = candles.length >= 26
    ? computeAllIndicators(candles)
    : null;
  const agg = indicators ? aggregateSignal(indicators) : { action: 'HOLD' as const, score: 0 };

  // Trend: compare last 5 closes to previous 5
  let trend: 'up' | 'down' | 'flat' = 'flat';
  if (candles.length >= 10) {
    const recent = candles.slice(-5).reduce((s, c) => s + c.close, 0) / 5;
    const prev   = candles.slice(-10, -5).reduce((s, c) => s + c.close, 0) / 5;
    if (recent > prev * 1.002)      trend = 'up';
    else if (recent < prev * 0.998) trend = 'down';
  }

  const botSells = trades.filter(t => t.botId === bot.id && t.type === 'SELL').slice(-10);
  const wins     = botSells.filter(t => t.pnl > 0).length;
  const recentWinRate = botSells.length > 0 ? (wins / botSells.length) * 100 : 0;
  const avgPnl   = botSells.length > 0 ? botSells.reduce((s, t) => s + t.pnl, 0) / botSells.length : 0;

  const estimatedQty = price > 0 ? amountUSD / price : 0;
  const notional     = estimatedQty * price;
  let capitalFit: AssetStudy['capitalFit'] = 'unknown';
  if (minNotional !== undefined) {
    capitalFit = notional >= minNotional ? 'ok' : 'low';
  }

  let verdict: StudyVerdict = 'ready';
  let recommendation = '';
  if (!compliance.ok) {
    verdict = 'blocked';
    recommendation = compliance.reason ?? `Symbol not tradable on ${exchange}`;
  } else if (capitalFit === 'low') {
    verdict = 'blocked';
    recommendation = `Trade amount $${amountUSD} below exchange minNotional $${minNotional}.`;
  } else if (candles.length < 26) {
    verdict = 'warm-up';
    recommendation = 'Collecting price data — needs at least 26 candles for indicators.';
  } else if (botSells.length >= 5 && recentWinRate < 30 && avgPnl < 0) {
    verdict = 'risky';
    recommendation = `Recent win rate ${recentWinRate.toFixed(0)}% and negative avg P&L — pause the bot.`;
  } else if (agg.action === 'HOLD' && trend === 'flat' && botSells.length === 0) {
    verdict = 'stalled';
    recommendation = 'Market flat & no entry signal — wait for momentum.';
  } else {
    verdict = 'ready';
    recommendation = `Indicators ${agg.action}, trend ${trend}. OK to execute on next signal.`;
  }

  const confidence = Math.min(100, Math.max(0,
    (verdict === 'ready' ? 70 : 40) +
    (recentWinRate / 4) +
    (trend === 'up' && agg.action === 'BUY' ? 15 : 0) -
    (verdict === 'blocked' ? 60 : 0) -
    (verdict === 'risky'   ? 30 : 0)
  ));

  const study: AssetStudy = {
    botId:          bot.id,
    botName:        bot.name,
    arenaSymbol:    bot.symbol,
    exchange,
    exchangeSymbol: compliance.exchangeSymbol,
    tradable:       compliance.ok,
    ...(compliance.ok ? {} : { blockedReason: compliance.reason }),
    signal:         agg.action,
    signalScore:    agg.score,
    rsi:            indicators?.rsi.value ?? 50,
    trend,
    recentWinRate,
    recentTrades:   botSells.length,
    avgPnl,
    capitalFit,
    estimatedQty,
    notionalUSD:    notional,
    verdict,
    recommendation,
    confidence,
    studiedAt:      Date.now(),
  };
  pipelineCache.set(cacheKey, study, TTL.STUDY, false);
  return study;
}

export function studyAll(inputs: BotInputs[]): AssetStudy[] {
  return inputs.map(studyBot);
}

export function studySummary(studies: AssetStudy[]) {
  return {
    total:     studies.length,
    ready:     studies.filter(s => s.verdict === 'ready').length,
    blocked:   studies.filter(s => s.verdict === 'blocked').length,
    risky:     studies.filter(s => s.verdict === 'risky').length,
    stalled:   studies.filter(s => s.verdict === 'stalled').length,
    warmUp:    studies.filter(s => s.verdict === 'warm-up').length,
    avgConfidence: studies.length > 0
      ? studies.reduce((s, x) => s + x.confidence, 0) / studies.length
      : 0,
  };
}
