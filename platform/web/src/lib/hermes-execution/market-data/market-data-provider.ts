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
 * Repeated-Telegram-alert fix. Stable, structured facts about WHY a MarketDataProviderError was
 * thrown — deliberately separate from `message` (free text, safe for a human, never safe as a
 * dedup/identity key: two failures with the exact same underlying cause can still render slightly
 * different wording). Populated by candle-validation.ts's own `fail()` for every validation
 * failure; left `undefined` for a bare fetch failure a MarketDataProvider implementation
 * constructs itself without this detail (still safely handled — see
 * market-data-incident-tracker.ts's own fallback for an error with no structured detail at all).
 *
 * Deliberately excludes anything volatile or unbounded: no live bid/ask, no stack trace, no
 * request ID, no current-time-relative computation — only facts that identify WHICH gap/failure
 * this is, so the exact same missing-candle incident produces the exact same detail across cycles.
 */
export interface MarketDataFailureDetail {
  category:
    | "insufficient-candle-count"
    | "malformed-candle"
    | "duplicate-timestamp"
    | "missing-candles"
    | "stale-data"
    | "fetch-failed";
  /** The configured timeframe this validation ran against (e.g. "1h") — a string, not the branded
   * MarketTimeframe type, so this module never needs to depend on candle-validation.ts. */
  timeframe?: string;
  /** Only set for `category: "missing-candles"` — the exact boundary of the missing span, taken
   * directly from the two candle timestamps either side of the gap. Never a rolling/relative value
   * — the same underlying gap reports the same two timestamps on every cycle it remains present. */
  missingIntervalStartMs?: number;
  missingIntervalEndMs?: number;
}

/**
 * The one error type every MarketDataProvider implementation throws for both a failed fetch (a
 * live source unreachable or erroring) and malformed data (an implausible bid/ask/candle result) —
 * callers can distinguish "which" via `reason`, without needing to know which concrete provider
 * produced it.
 */
export class MarketDataProviderError extends Error {
  public readonly detail?: MarketDataFailureDetail;

  constructor(
    message: string,
    public readonly reason: "fetch-failed" | "malformed-data",
    options?: { cause?: unknown; detail?: MarketDataFailureDetail },
  ) {
    super(message, options);
    this.name = "MarketDataProviderError";
    this.detail = options?.detail;
  }
}
