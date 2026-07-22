import { logger } from "@/lib/logger/logger";
import { generateSyntheticCandles } from "../mock-candle-generator";
import { MarketDataProviderError, type MarketDataProvider, type MarketDataSnapshot } from "./market-data-provider";

// Milestone 5 — Live Market Data Integration. The "second implementation suitable for live data"
// this milestone calls for. Deliberately depends only on the narrow `RateSource` shape below, never
// on a concrete broker class — EtoroDemoBroker.getRate already satisfies this shape structurally
// (TypeScript structural typing needs no explicit "implements"), so this file never imports
// EtoroDemoBroker or any other broker at all. Any future real quote source (a public market-data
// API client, a different broker) can be substituted purely by passing a different RateSource,
// without touching this class.

/** The minimal live-quote capability this provider needs — small enough that a broker's own
 * getRate(), or a standalone public API client, can satisfy it without adapting anything. */
export interface RateSource {
  getRate(instrument: string): Promise<{ bid: number; ask: number }>;
}

export interface LiveMarketDataProviderOptions {
  candleCount?: number;
  candleIntervalMinutes?: number;
}

const DEFAULT_CANDLE_COUNT = 60;
const DEFAULT_CANDLE_INTERVAL_MINUTES = 60;

function isValidPrice(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Live bid/ask/spread/latestPrice/volume are sourced from a real, connected RateSource on every
 * call — nothing here is cached across calls, so each getMarketData() reflects the market at the
 * moment it was called. The OHLCV candle *history* remains a synthetic series anchored to the live
 * mid-price (the same technique market-decide.ts's old buildContext did inline) — no real
 * historical OHLCV feed is wired up yet. This is a real limitation, stated plainly rather than
 * disguised: MarketIntelligenceBuilder's EMA/RSI/trend indicators are computed over that anchored-
 * synthetic history, not genuine historical price action, even though the current bid/ask driving
 * entry/exit decisions is real. A future revision can replace just the candle-generation line below
 * with a real historical-candle fetch without changing this class's public shape at all.
 */
export class LiveMarketDataProvider implements MarketDataProvider {
  constructor(
    private readonly rateSource: RateSource,
    private readonly options: LiveMarketDataProviderOptions = {},
  ) {}

  async getMarketData(instrument: string): Promise<MarketDataSnapshot> {
    let rate: { bid: number; ask: number };
    try {
      rate = await this.rateSource.getRate(instrument);
    } catch (error) {
      // No fallback to a mock/synthetic quote happens here or anywhere upstream — a failed live
      // fetch always surfaces as a thrown MarketDataProviderError, never a silently-substituted
      // value (see this class's own doc comment and market-data-provider-factory.ts). Logged at
      // "error" specifically so a VPS log stream shows a real quote-fetch failure distinctly from
      // the routine "info" line below, without needing to parse exception text.
      logger.error("Live market data quote fetch failed — no fallback attempted", {
        component: "market-data",
        provider: "live",
        instrument,
        fallbackOccurred: false,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw new MarketDataProviderError(
        `LiveMarketDataProvider failed to fetch a rate for "${instrument}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        "fetch-failed",
        { cause: error },
      );
    }

    if (!isValidPrice(rate.bid) || !isValidPrice(rate.ask)) {
      throw new MarketDataProviderError(
        `LiveMarketDataProvider received a malformed rate for "${instrument}": bid=${rate.bid}, ask=${rate.ask}.`,
        "malformed-data",
      );
    }
    if (rate.ask < rate.bid) {
      throw new MarketDataProviderError(
        `LiveMarketDataProvider received an inverted rate for "${instrument}": ask=${rate.ask} is below bid=${rate.bid}.`,
        "malformed-data",
      );
    }

    const now = new Date();
    const midPrice = (rate.bid + rate.ask) / 2;
    const candles = generateSyntheticCandles({
      instrument,
      bias: "sideways",
      count: this.options.candleCount ?? DEFAULT_CANDLE_COUNT,
      intervalMinutes: this.options.candleIntervalMinutes ?? DEFAULT_CANDLE_INTERVAL_MINUTES,
      startPrice: midPrice,
      endTimestamp: now,
    });
    const latest = candles[candles.length - 1];
    const timestamp = now.toISOString();

    // Milestone 5 follow-up — Live Market Data Observability. The one structured log line that
    // proves a real eToro quote was fetched and used this cycle, distinct from the synthetic
    // candle-history caveat documented on this class above. Never logs `rate`/headers/credentials —
    // only the already-public-facing snapshot fields also returned below.
    logger.info("Live market data quote fetched", {
      component: "market-data",
      provider: "live",
      instrument,
      quoteTimestamp: timestamp,
      latestPrice: midPrice,
      candleCount: candles.length,
      fallbackOccurred: false,
    });

    return {
      instrument,
      timestamp,
      candles,
      bid: rate.bid,
      ask: rate.ask,
      spread: rate.ask - rate.bid,
      latestPrice: midPrice,
      volume: latest?.volume ?? 0,
    };
  }
}
