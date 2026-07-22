import { logger } from "@/lib/logger/logger";
import { generateSyntheticCandles, type CandleBias } from "../mock-candle-generator";
import { MarketDataProviderError, type MarketDataProvider, type MarketDataSnapshot } from "./market-data-provider";

// Milestone 5 — Live Market Data Integration. Wraps the existing, unmodified
// generateSyntheticCandles() (mock-candle-generator.ts, first introduced in Milestone 3) behind the
// MarketDataProvider interface — this is the "keep the existing mock implementation, renamed
// appropriately" half of this milestone. Nothing about the deterministic seeded-PRNG candle
// generation itself changes; only its call site moves from being inlined directly in the CLI
// (market-decide.ts's old buildContext) to living behind this class, so swapping to
// LiveMarketDataProvider is a configuration change, not a code change.

export interface MockMarketDataProviderOptions {
  /** Defaults to "sideways" — a neutral default when the caller has no reason to force a
   * direction. market-decide.ts's demo overrides this per cycle to force BUY-then-SELL. */
  bias?: CandleBias;
  count?: number;
  intervalMinutes?: number;
  /** Any integer seeds the same deterministic series every time — see generateSyntheticCandles. */
  seed?: number;
  startPrice?: number;
  /** Fraction of the latest close used as a synthetic bid/ask spread around it. Defaults to
   * 0.0005 (5 bps) — a small, plausible spread, not a claim about any real instrument's actual
   * spread. */
  spreadRatio?: number;
  /** The timestamp of the last (most recent) candle — passed through to generateSyntheticCandles'
   * own `endTimestamp`. Defaults to the real current time if omitted, same as
   * generateSyntheticCandles' own default — but that means two calls without an explicit `now`
   * produce different timestamps even with the same seed. Injectable so callers that need true
   * byte-for-byte determinism (tests, reproducible demos) can pin it. */
  now?: Date;
}

const DEFAULT_SPREAD_RATIO = 0.0005;

export class MockMarketDataProvider implements MarketDataProvider {
  constructor(private readonly options: MockMarketDataProviderOptions = {}) {}

  async getMarketData(instrument: string): Promise<MarketDataSnapshot> {
    const candles = generateSyntheticCandles({
      instrument,
      bias: this.options.bias ?? "sideways",
      count: this.options.count,
      intervalMinutes: this.options.intervalMinutes,
      seed: this.options.seed,
      startPrice: this.options.startPrice,
      endTimestamp: this.options.now,
    });

    const latest = candles[candles.length - 1];
    if (!latest) {
      // Not reachable via any public option today (generateSyntheticCandles' own DEFAULT_COUNT is
      // 60 and `count` is never forced to 0 by this class) — kept as an explicit, clear failure
      // rather than letting a future zero-count option silently produce an unusable snapshot.
      throw new MarketDataProviderError(
        `MockMarketDataProvider produced no candles for "${instrument}".`,
        "malformed-data",
      );
    }

    const spreadRatio = this.options.spreadRatio ?? DEFAULT_SPREAD_RATIO;
    const halfSpread = (latest.close * spreadRatio) / 2;
    const bid = latest.close - halfSpread;
    const ask = latest.close + halfSpread;

    // Milestone 5 follow-up — Live Market Data Observability. Mirrors LiveMarketDataProvider's own
    // log line (same field shape, provider: "mock") so a VPS log stream makes it immediately
    // obvious if a deployment believed to be running HERMES_MARKET_DATA_PROVIDER=live is actually
    // serving mock quotes — this provider is only ever selected by explicit configuration
    // (market-data-provider-factory.ts fails closed on anything else), never as a silent fallback
    // from "live", so `fallbackOccurred` is always false here too.
    logger.info("Mock market data quote generated", {
      component: "market-data",
      provider: "mock",
      instrument,
      quoteTimestamp: latest.timestamp,
      latestPrice: latest.close,
      candleCount: candles.length,
      fallbackOccurred: false,
    });

    return {
      instrument,
      timestamp: latest.timestamp,
      candles,
      bid,
      ask,
      spread: ask - bid,
      latestPrice: latest.close,
      volume: latest.volume,
    };
  }
}
