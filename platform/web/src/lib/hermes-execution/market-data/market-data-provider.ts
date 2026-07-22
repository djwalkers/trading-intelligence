import type { Candle } from "../types";

// Milestone 5 — Live Market Data Integration. The abstraction the Milestone 2-4 pipeline (Market
// Intelligence Builder -> Market Decision Engine -> Portfolio Risk Engine -> runner -> Broker) sits
// behind: Market Data Provider -> Market Intelligence Builder -> ... Nothing downstream of a
// MarketDataProvider is aware of, or cares, whether a concrete implementation is deterministic mock
// data or a real, connected quote source — MarketIntelligenceBuilder.build() (unchanged by this
// milestone) only ever receives plain candles/bid/ask, never a provider reference itself.
//
// Deliberately a *different* interface from fixture-market-data-provider.ts's own
// `MarketDataProvider` (the Execution MVP Phase 1 pipeline's synchronous, candles-only
// `getCandles(symbol)`/`getKnownSymbols()` shape, used by the older ExecutionRunner/signal-engine
// pipeline via `FixtureMarketDataProvider` — untouched by this milestone). Same domain concept
// ("where do candles come from"), two different scopes/consumers/shapes — this one is async, and
// bundles bid/ask/spread/volume/timestamp alongside the candle history because the Milestone 2-4
// pipeline's MarketIntelligenceBuilder needs all of that in one self-consistent snapshot, not just
// candles.

/**
 * A single, internally-consistent read of everything MarketIntelligenceBuilder needs for one
 * instrument at one moment: OHLCV candle history, current bid/ask/spread, the latest price, the
 * latest volume, and a timestamp all drawn from the same provider call — never assembled by
 * combining two separately-timed reads.
 */
export interface MarketDataSnapshot {
  instrument: string;
  /** ISO 8601. The single point in time every other field in this snapshot is consistent with. */
  timestamp: string;
  /** Chronological, oldest first. */
  candles: Candle[];
  bid: number;
  ask: number;
  /** ask - bid. Always computable from bid/ask, so never optional here — a provider with no
   * genuine spread signal (e.g. a last-trade-only feed) should set bid === ask rather than
   * omitting either. */
  spread: number;
  /** The provider's own notion of "current price" — typically the latest candle's close or the
   * bid/ask midpoint; each implementation documents which. */
  latestPrice: number;
  /** Phase 2A follow-up — Volume Nullability. Optional for the same reason Candle.volume is
   * (../types.ts) — undefined means genuinely unknown, never fabricated as 0. */
  volume?: number;
}

export interface MarketDataProvider {
  /** Fetches a fresh MarketDataSnapshot for `instrument`. May reject — see MarketDataProviderError. */
  getMarketData(instrument: string): Promise<MarketDataSnapshot>;
}

/**
 * The one error type every MarketDataProvider implementation throws for both a failed fetch (a
 * live source unreachable or erroring) and malformed data (an implausible bid/ask/candle result) —
 * callers can distinguish "which" via `reason`, without needing to know which concrete provider
 * produced it.
 */
export class MarketDataProviderError extends Error {
  constructor(
    message: string,
    public readonly reason: "fetch-failed" | "malformed-data",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MarketDataProviderError";
  }
}
