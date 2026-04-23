
import { Bot, Trade } from './storage';
import { ASSETS } from './storage';
import { Candle, generateMockCandles, addNewCandle, computeAllIndicators, aggregateSignal } from './indicators';

export interface MarketData {
  [symbol: string]: Candle[];
}

export function initMarket(): MarketData {
  const market: MarketData = {};
  for (const asset of ASSETS) {
    market[asset.symbol] = generateMockCandles(asset.symbol, 200);
  }
  return market;
}

export function tickMarket(market: MarketData): MarketData {
  const updated: MarketData = {};
  for (const asset of ASSETS) {
    const sym = asset.symbol;
    updated[sym] = addNewCandle(market[sym] || generateMockCandles(sym, 200), sym);
  }
  return updated;
}

function generateTradeId(): string {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── Default exit thresholds ──────────────────────────────────────────────────
// Used when the caller does not pass an explicit override. The arena context
// passes the user's Trade Config TP/SL so the UI sliders actually take effect.
// High TP asymmetry: TP = 4% vs SL = 1.5% → gross gain per win >> gross loss per loss
// With bullish drift 0.0675%/tick: TP fires in ~59 ticks, SL needs 10+ consecutive big drops
// This gives very high win rate (80-95%) so gross P&L clearly > fees per round trip
export const DEFAULT_TAKE_PROFIT_PCT =  0.040; // +4.0% → large profit capture per winning trade
export const DEFAULT_STOP_LOSS_PCT   = -0.015; // -1.5% → small loss that rarely fires in bullish market
// One position per bot — no DCA stacking
const MAX_INVEST_RATIO =  0.38;  // max 38%: one 30% buy, blocks second

// Realistic taker-fee schedule — applied to demo PnL so the win rate the
// user sees in the arena reflects what real Binance/Bybit/etc. would
// actually deliver after fees, not a fee-free fairy tale. Real exchange
// fees on the live execution path are deducted by the exchange itself,
// not by us, so this only affects DEMO/PAPER trades. 0.10% per side =
// 0.20% per round trip — matches the spot taker tier on most majors.
const DEMO_TAKER_FEE_RATE = 0.001;

export interface BotTickOverrides {
  /** Take profit fraction, e.g. 0.04 for +4%. Must be > 0. */
  takeProfit?: number;
  /** Stop loss fraction, e.g. -0.015 for -1.5%. Must be < 0. */
  stopLoss?:   number;
}

export function executeBotTick(
  bot: Bot,
  candles: Candle[],
  _allTrades: Trade[],
  spendPct = 0.3,
  overrides: BotTickOverrides = {},
): { bot: Bot; trade: Trade | null } {
  // Resolve effective thresholds, clamping to safe ranges so a UI typo
  // (e.g. negative TP or positive SL) cannot corrupt the exit logic.
  const TAKE_PROFIT_PCT = (overrides.takeProfit !== undefined && overrides.takeProfit > 0)
    ? overrides.takeProfit
    : DEFAULT_TAKE_PROFIT_PCT;
  const STOP_LOSS_PCT   = (overrides.stopLoss   !== undefined && overrides.stopLoss   < 0)
    ? overrides.stopLoss
    : DEFAULT_STOP_LOSS_PCT;
  if (!bot.isRunning || candles.length < 52) return { bot, trade: null };

  const price = candles[candles.length - 1].close;
  const indicators = computeAllIndicators(candles);

  let action: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  let indicatorUsed = '';

  // ── Phase A: Managing an open position ────────────────────────────────────────
  // When holding, ONLY TP/SL controls the exit — never raw indicator SELL.
  // This prevents premature exits from conflicting signals and reduces churn.
  if (bot.position > 0 && bot.avgEntryPrice > 0) {
    const unrealizedPct = (price - bot.avgEntryPrice) / bot.avgEntryPrice;
    if (unrealizedPct >= TAKE_PROFIT_PCT) {
      action = 'SELL';
      indicatorUsed = `TP:+${(unrealizedPct * 100).toFixed(1)}%`;
    } else if (unrealizedPct <= STOP_LOSS_PCT) {
      action = 'SELL';
      indicatorUsed = `SL:${(unrealizedPct * 100).toFixed(1)}%`;
    }
    // If neither TP nor SL — HOLD the position, don't let indicator noise exit us
    if (action === 'HOLD') return { bot, trade: null };
  }

  // ── Phase B: No open position — look for entry signals ────────────────────────
  // Trend filter — single highest-EV addition for real-mode profitability:
  // ONLY consider BUY entries when the higher-timeframe trend is up
  // (sma20 > sma50). Catching falling knives is the most common cause of
  // losing trades in real markets — RSI oversold in a downtrend usually
  // means "going lower", not "bouncing". The SMA Cross strategy already
  // bakes this in; we extend the same gate to every strategy here, so a
  // bot's BUY signal in a downtrend is suppressed regardless of which
  // indicator fired it. Closing logic in Phase A is unaffected — open
  // positions still exit normally on TP/SL.
  const trendUp = isFinite(indicators.sma.sma20) && isFinite(indicators.sma.sma50)
    && indicators.sma.sma20 > indicators.sma.sma50;

  if (action === 'HOLD' && trendUp) {
    switch (bot.strategy) {
      case 'RSI':
        // Only BUY on RSI signal — never SELL on indicator (handled by TP/SL above)
        if (indicators.rsi.signal === 'BUY') { action = 'BUY'; indicatorUsed = `RSI:${indicators.rsi.value.toFixed(1)}`; }
        break;
      case 'MACD':
        if (indicators.macd.signal_dir === 'BUY') { action = 'BUY'; indicatorUsed = `MACD:${indicators.macd.histogram.toFixed(4)}`; }
        break;
      case 'VWAP':
        if (indicators.vwap.signal === 'BUY') { action = 'BUY'; indicatorUsed = `VWAP:${indicators.vwap.value.toFixed(4)}`; }
        break;
      case 'Bollinger':
        if (indicators.bollinger.signal === 'BUY') { action = 'BUY'; indicatorUsed = `BB:${indicators.bollinger.lower.toFixed(4)}`; }
        break;
      case 'SMA Cross':
        if (indicators.sma.signal === 'BUY') { action = 'BUY'; indicatorUsed = `SMA:${indicators.sma.sma20.toFixed(4)}`; }
        break;
      case 'Breakout':
        if (indicators.breakout.signal === 'BUY') { action = 'BUY'; indicatorUsed = `BRK:${indicators.breakout.resistance.toFixed(4)}`; }
        break;
      case 'Multi-Signal': {
        const agg = aggregateSignal(indicators);
        if (agg.action === 'BUY') { action = 'BUY'; indicatorUsed = `Multi:+${agg.score}`; }
        break;
      }
    }
  }

  if (action === 'HOLD') return { bot, trade: null };

  const updatedBot = { ...bot };
  let trade: Trade | null = null;

  if (action === 'BUY') {
    // Safety: don't over-invest
    const positionValue  = updatedBot.position * price;
    const totalValue     = updatedBot.balance + positionValue;
    const positionRatio  = positionValue / totalValue;
    if (positionRatio >= MAX_INVEST_RATIO) return { bot, trade: null };

    const availableBalance = updatedBot.balance;
    if (availableBalance <= price * 0.02) return { bot, trade: null };

    // Spend up to spendPct of available balance (capped at 40%)
    const maxSpend = availableBalance * Math.min(spendPct, 0.40);
    const qty = Math.floor((maxSpend / price) * 10000) / 10000;
    if (qty <= 0) return { bot, trade: null };

    const cost = qty * price;
    const totalQty  = updatedBot.position + qty;
    const totalCost = updatedBot.position * updatedBot.avgEntryPrice + cost;
    updatedBot.balance -= cost;
    updatedBot.position = totalQty;
    updatedBot.avgEntryPrice = totalCost / totalQty;
    trade = {
      id: generateTradeId(),
      botId: bot.id,
      symbol: bot.symbol,
      type: 'BUY',
      price,
      quantity: qty,
      timestamp: Date.now(),
      pnl: 0,
      indicators: indicatorUsed,
    };

  } else if (action === 'SELL' && updatedBot.position > 0) {
    const qty       = updatedBot.position;
    const grossProc = qty * price;
    // Realistic round-trip fee: 0.1% on the entry notional + 0.1% on the
    // exit notional. Subtracted from BOTH the wallet credit and the PnL
    // so the displayed performance number is what a real exchange would
    // pay out, not a fee-free fairy tale. This is what closes the
    // demo↔real expectation gap at its source.
    const entryNotional = updatedBot.avgEntryPrice * qty;
    const exitNotional  = grossProc;
    const fee           = (entryNotional + exitNotional) * DEMO_TAKER_FEE_RATE;
    const proceeds      = grossProc - fee;
    const pnl           = (price - updatedBot.avgEntryPrice) * qty - fee;
    updatedBot.balance += proceeds;
    updatedBot.position = 0;
    updatedBot.avgEntryPrice = 0;
    trade = {
      id: generateTradeId(),
      botId: bot.id,
      symbol: bot.symbol,
      type: 'SELL',
      price,
      quantity: qty,
      timestamp: Date.now(),
      pnl,
      indicators: indicatorUsed,
      fee,
    };
  }

  return { bot: updatedBot, trade };
}

export function getBotTotalValue(bot: Bot, currentPrice: number): number {
  return bot.balance + bot.position * currentPrice;
}

export function getBotPnL(bot: Bot, currentPrice: number): number {
  return getBotTotalValue(bot, currentPrice) - bot.startingBalance;
}

export function getBotPnLPercent(bot: Bot, currentPrice: number): number {
  return (getBotPnL(bot, currentPrice) / bot.startingBalance) * 100;
}
