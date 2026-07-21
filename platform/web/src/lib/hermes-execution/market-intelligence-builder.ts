import type { Candle, StrategySourceType } from "./types";
import type { MarketDecisionContext } from "./market-decision-engine";
import { calculateAtr, calculateEma, calculateRsi, calculateVolatility24h, classifyTrend } from "./technical-indicators";
import { resolveMarketSession } from "./market-session";

// Milestone 3 — Rich Market Context for the Market Decision Engine. The one place responsible for
// turning raw inputs (a candle history from a Market Data Provider, a current bid/ask, current
// position state, and the authorising strategy's identity) into the single, complete
// MarketDecisionContext object MarketDecisionEngine consumes. MarketDecisionEngine itself never
// calculates any of this and never reaches out to fetch it — this builder is the only place that
// happens.

const EMA_SHORT_PERIOD = 20;
const EMA_LONG_PERIOD = 50;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;
/** How many of the most recent candles are attached to the context for display/audit purposes —
 * a display window, not the full history the indicators above were computed from. */
const RECENT_CANDLES_WINDOW = 20;
/** How many of the most recent candles count as "daily" for the high/low/volume fields, assuming
 * roughly hourly candles (this milestone's own mock data uses that interval) — same window
 * calculateVolatility24h uses for the same reason. */
const DAILY_WINDOW = 24;

export interface BuildMarketContextInput {
  instrument: string;
  bid: number;
  ask: number;
  positionOpen: boolean;
  strategyId: string;
  strategyVersion: number;
  strategySourceType: StrategySourceType;
  /** Chronological, oldest first — as returned by a MarketDataProvider's getCandles(). */
  candles: Candle[];
  /** Injectable for deterministic tests; defaults to the real time. */
  now?: Date;
}

export const MarketIntelligenceBuilder = {
  build(input: BuildMarketContextInput): MarketDecisionContext {
    const { instrument, bid, ask, positionOpen, candles } = input;
    const now = input.now ?? new Date();
    const closes = candles.map((c) => c.close);

    const ema20 = calculateEma(closes, EMA_SHORT_PERIOD);
    const ema50 = calculateEma(closes, EMA_LONG_PERIOD);
    const rsi14 = calculateRsi(closes, RSI_PERIOD);
    const atr14 = calculateAtr(candles, ATR_PERIOD);
    const volatility24h = calculateVolatility24h(candles);
    const trend = classifyTrend(ema20, ema50);
    const marketSession = resolveMarketSession(instrument, now);

    const latestCandle = candles[candles.length - 1];
    const dailyWindow = candles.slice(-DAILY_WINDOW);
    const dailyHigh = dailyWindow.length > 0 ? Math.max(...dailyWindow.map((c) => c.high)) : Math.max(bid, ask);
    const dailyLow = dailyWindow.length > 0 ? Math.min(...dailyWindow.map((c) => c.low)) : Math.min(bid, ask);
    const volume = latestCandle?.volume ?? 0;

    return {
      instrument,
      bid,
      ask,
      spread: ask - bid,
      midPrice: (bid + ask) / 2,
      timestamp: now.toISOString(),
      positionOpen,
      strategy: {
        strategyId: input.strategyId,
        version: input.strategyVersion,
        sourceType: input.strategySourceType,
      },
      recentCandles: candles.slice(-RECENT_CANDLES_WINDOW),
      ema20,
      ema50,
      rsi14,
      atr14,
      volume,
      dailyHigh,
      dailyLow,
      volatility24h,
      marketSession,
      trend,
    };
  },
};
