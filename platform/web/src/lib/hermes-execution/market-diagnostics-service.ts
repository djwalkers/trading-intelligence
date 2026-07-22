import "server-only";
import { ConfigError } from "@/lib/config/env";
import { getHermesExecutionConfig, type BrokerProvider, type MarketDataProviderType } from "./config";
import { BrokerFactory } from "./broker-factory";
import { EtoroDemoBroker } from "./etoro/etoro-demo-broker";
import { InMemoryAuditTrail } from "./audit-trail";
import { MarketDataProviderFactory } from "./market-data/market-data-provider-factory";
import { MarketDataProviderError, type MarketDataSnapshot } from "./market-data/market-data-provider";
import { MarketIntelligenceBuilder } from "./market-intelligence-builder";
import { calculateEma, calculateRsi, type TrendClassification } from "./technical-indicators";
import type { Candle } from "./types";

// Phase 2A.1 — Internal Market Diagnostics UI. THE one shared, read-only diagnostics service —
// both `npm run market:diagnostics` (src/hermes-execution/market-diagnostics.ts) and
// `GET /api/hermes/market-diagnostics` call this same function, so indicator calculations are
// never duplicated between the CLI and the UI. This file only ever reads market data (getRate,
// getHistoricalCandles, MockMarketDataProvider) and computes indicators over it — it never
// constructs an OrderRequest, never calls placeMarketOrder/closePosition, never touches the
// strategy registry, risk engine, portfolio, or scheduler. EMA/RSI/ATR/trend are always computed
// by calling technical-indicators.ts's own existing, unmodified functions — this file only decides
// *how many times* to call them (once for the latest value, once per index for a chartable
// series), never reimplements or tweaks the formulas themselves.
//
// Provider selection is config-driven (HERMES_MARKET_DATA_PROVIDER / BROKER_PROVIDER), unlike the
// original CLI script this replaces (which always forced a live eToro connection regardless of
// config, matching market-decide.ts's own "deliberate safety/determinism choice" for a one-off
// smoke test). That doesn't fit an operational diagnostics tool whose whole job is to show
// truthfully whether the *currently configured* pipeline is live or mock — so this service asks
// MarketDataProviderFactory for whatever config.marketDataProvider actually says, exactly as
// runtime-dependency-factory.ts does for the real continuous runtime.

export interface MarketDiagnosticsQuote {
  bid: number;
  ask: number;
  mid: number;
}

/** The minimum candle fields a candlestick/RSI chart needs — deliberately narrower than the full
 * Candle type (no `symbol`, no `volume`; see MarketDiagnosticsResult.lastClosedCandle for the one
 * place volume is reported). */
export interface MarketDiagnosticsCandle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface MarketDiagnosticsLastClosedCandle extends MarketDiagnosticsCandle {
  /** Undefined when eToro didn't report a usable volume for this candle — never fabricated. See
   * Candle.volume's own doc comment (types.ts) for the confirmed-live nullability this reflects. */
  volume?: number;
}

export interface MarketDiagnosticsIndicators {
  ema20: number;
  ema50: number;
  rsi14: number;
  atr14: number;
  trend: TrendClassification;
}

/** Per-candle indicator values, aligned index-for-index with `candles` — the chart's own data
 * source for the EMA20/EMA50 overlay and the RSI14 panel. The LAST element of each array always
 * equals the corresponding field in `indicators` above (both are derived from the same underlying
 * close-price history), even when `candles`/`series` were truncated to the most recent
 * CHART_CANDLE_LIMIT for payload size — truncation happens only after the full series is computed,
 * never before, so the visible chart never disagrees with the indicator cards at its own rightmost
 * point. Computed by calling calculateEma/calculateRsi (technical-indicators.ts) once per index —
 * the same, unmodified formula the single "current value" already uses, never reimplemented. */
export interface MarketDiagnosticsSeries {
  timestamps: string[];
  ema20: number[];
  ema50: number[];
  rsi14: number[];
}

export interface MarketDiagnosticsValidation {
  /** Always false — no fallback path exists anywhere in this pipeline (see
   * live-market-data-provider.ts's own doc comments); a failed fetch always throws
   * MarketDiagnosticsError instead of reaching this field with a different value. */
  fallbackOccurred: false;
  /** Seconds between `fetchedAt` and `lastCandleTimestamp` — how old the most recent closed candle
   * is. Always <= maxCandleAgeSeconds below on a successful result — see this interface's own
   * *ValidationPassed fields' doc comment for why a candle history that failed this check never
   * reaches a MarketDiagnosticsResult at all. */
  dataAgeSeconds: number;
  /** The configured threshold `dataAgeSeconds` was checked against (config.marketData.
   * maxCandleAgeSeconds) — surfaced so the UI can show *how much* margin the current data has, not
   * just that it passed. */
  maxCandleAgeSeconds: number;
  /** True only when the last closed candle reported a defined volume — never implies missing
   * volume is any kind of failure (see lastClosedCandle.volume's own doc comment). */
  volumeAvailable: boolean;
  /** These three are always true on a successful MarketDiagnosticsResult: candle-validation.ts
   * (called, unmodified, inside LiveMarketDataProvider.getMarketData — see candle-validation.ts's
   * own MIN_REQUIRED_CANDLES/duplicate/gap/OHLC/stale checks) is a gate, not a per-check scorer — a
   * violation of any one of these throws a MarketDataProviderError before this service ever
   * produces a result at all, surfacing instead as a MarketDiagnosticsError (see
   * getMarketDiagnostics's own error-code mapping). A result existing at all already proves every
   * one of these passed. */
  duplicateTimestampsPassed: true;
  ohlcValidationPassed: true;
  staleDataValidationPassed: true;
}

export interface MarketDiagnosticsResult {
  instrument: string;
  provider: MarketDataProviderType;
  brokerProvider: BrokerProvider;
  timeframe: string;
  requestedCandleCount: number;
  /** The full validated candle set's own length — independent of how many are actually returned
   * in `candles`/`series` below (see CHART_CANDLE_LIMIT). */
  receivedCandleCount: number;
  fetchedAt: string;
  /** Describe the full validated candle set, not the (possibly shorter) charted slice. */
  firstCandleTimestamp: string;
  lastCandleTimestamp: string;
  currentQuote: MarketDiagnosticsQuote;
  lastClosedCandle: MarketDiagnosticsLastClosedCandle;
  indicators: MarketDiagnosticsIndicators;
  series: MarketDiagnosticsSeries;
  validation: MarketDiagnosticsValidation;
  /** Truncated to the most recent CHART_CANDLE_LIMIT candles — "only the minimum candle fields the
   * chart needs," not the full receivedCandleCount history. */
  candles: MarketDiagnosticsCandle[];
}

export class MarketDiagnosticsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MarketDiagnosticsError";
  }
}

/** "Approximately the most recent 100-200 candles" per this phase's own chart spec — also bounds
 * response payload size regardless of how large HERMES_MARKET_CANDLE_COUNT is configured. */
const CHART_CANDLE_LIMIT = 200;

// Mirrors market-intelligence-builder.ts's own EMA_SHORT_PERIOD/EMA_LONG_PERIOD/RSI_PERIOD
// constants — duplicated as plain numbers rather than imported, matching candle-validation.ts's
// own MIN_REQUIRED_CANDLES precedent for "a small, documented constant is simpler than a coupling
// this module doesn't otherwise need." Values must stay in sync with market-intelligence-builder.ts
// by inspection; both are Phase 2A/2A.1 constants unlikely to change independently.
const EMA_SHORT_PERIOD = 20;
const EMA_LONG_PERIOD = 50;
const RSI_PERIOD = 14;

// A diagnostics-only placeholder identity — MarketIntelligenceBuilder.build() requires a strategy
// identity to stamp onto its output, but this result is never handed to MarketDecisionEngine or
// any execution path, so nothing downstream can mistake it for a real strategy evaluation.
// sourceType "DEMO_ONLY" (never "HERMES_APPROVED") keeps that unmissable even out of context.
const DIAGNOSTICS_STRATEGY_IDENTITY = {
  strategyId: "MARKET-DIAGNOSTICS",
  strategyVersion: 0,
  strategySourceType: "DEMO_ONLY" as const,
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Calls calculateEma/calculateRsi once per index, over the growing prefix of `candles` ending at
 * that index — the same, unmodified functions technical-indicators.ts already exports, called
 * repeatedly rather than reimplemented. O(n^2) for n candles (at most a few hundred here), which is
 * fine for a manually-refreshed diagnostics endpoint. */
function computeIndicatorSeries(candles: Candle[]): MarketDiagnosticsSeries {
  const closes = candles.map((c) => c.close);
  const timestamps: string[] = [];
  const ema20: number[] = [];
  const ema50: number[] = [];
  const rsi14: number[] = [];

  for (let i = 0; i < candles.length; i++) {
    const windowCloses = closes.slice(0, i + 1);
    timestamps.push(candles[i]!.timestamp);
    ema20.push(calculateEma(windowCloses, EMA_SHORT_PERIOD));
    ema50.push(calculateEma(windowCloses, EMA_LONG_PERIOD));
    rsi14.push(calculateRsi(windowCloses, RSI_PERIOD));
  }

  return { timestamps, ema20, ema50, rsi14 };
}

function toChartCandle(candle: Candle): MarketDiagnosticsCandle {
  return { timestamp: candle.timestamp, open: candle.open, high: candle.high, low: candle.low, close: candle.close };
}

function buildResult(args: {
  instrument: string;
  timeframe: string;
  requestedCandleCount: number;
  maxCandleAgeSeconds: number;
  provider: MarketDataProviderType;
  brokerProvider: BrokerProvider;
  snapshot: MarketDataSnapshot;
}): MarketDiagnosticsResult {
  const { instrument, timeframe, requestedCandleCount, maxCandleAgeSeconds, provider, brokerProvider, snapshot } = args;
  const fullCandles = snapshot.candles; // already chronological, oldest-first (see MarketDataProvider's own contract)
  const now = new Date();

  const context = MarketIntelligenceBuilder.build({
    instrument,
    bid: snapshot.bid,
    ask: snapshot.ask,
    positionOpen: false,
    ...DIAGNOSTICS_STRATEGY_IDENTITY,
    candles: fullCandles,
  });

  // Series computed over the FULL candle set first, sliced to the chart limit only afterward — so
  // the series' own last point always matches `indicators` above exactly, even when
  // requestedCandleCount exceeds CHART_CANDLE_LIMIT.
  const fullSeries = computeIndicatorSeries(fullCandles);
  const chartCandles = fullCandles.slice(-CHART_CANDLE_LIMIT);
  const series: MarketDiagnosticsSeries = {
    timestamps: fullSeries.timestamps.slice(-CHART_CANDLE_LIMIT),
    ema20: fullSeries.ema20.slice(-CHART_CANDLE_LIMIT),
    ema50: fullSeries.ema50.slice(-CHART_CANDLE_LIMIT),
    rsi14: fullSeries.rsi14.slice(-CHART_CANDLE_LIMIT),
  };

  const firstCandle = fullCandles[0]!;
  const lastCandle = fullCandles[fullCandles.length - 1]!;
  const dataAgeSeconds = Math.max(0, (now.getTime() - Date.parse(lastCandle.timestamp)) / 1000);

  return {
    instrument,
    provider,
    brokerProvider,
    timeframe,
    requestedCandleCount,
    receivedCandleCount: fullCandles.length,
    fetchedAt: now.toISOString(),
    firstCandleTimestamp: firstCandle.timestamp,
    lastCandleTimestamp: lastCandle.timestamp,
    currentQuote: { bid: snapshot.bid, ask: snapshot.ask, mid: context.midPrice },
    lastClosedCandle: {
      timestamp: lastCandle.timestamp,
      open: lastCandle.open,
      high: lastCandle.high,
      low: lastCandle.low,
      close: lastCandle.close,
      volume: lastCandle.volume,
    },
    indicators: {
      ema20: context.ema20,
      ema50: context.ema50,
      rsi14: context.rsi14,
      atr14: context.atr14,
      trend: context.trend,
    },
    series,
    validation: {
      fallbackOccurred: false,
      dataAgeSeconds,
      maxCandleAgeSeconds,
      volumeAvailable: lastCandle.volume !== undefined,
      duplicateTimestampsPassed: true,
      ohlcValidationPassed: true,
      staleDataValidationPassed: true,
    },
    candles: chartCandles.map(toChartCandle),
  };
}

export interface GetMarketDiagnosticsOptions {
  /** Defaults to config.runtimeTrading.symbol — the same instrument the real runtime trades. */
  instrument?: string;
}

/**
 * The one place this diagnostics feature reads market data. Config-driven: mirrors whatever
 * HERMES_MARKET_DATA_PROVIDER/BROKER_PROVIDER the runtime is actually configured with, using the
 * exact same, unmodified BrokerFactory/MarketDataProviderFactory/LiveMarketDataProvider/
 * MockMarketDataProvider/candle-validation.ts machinery the real trading runtime uses — this
 * function only ever calls existing factories and read-only broker methods (getRate,
 * getHistoricalCandles, resolveInstrument), never placeMarketOrder/closePosition/anything
 * execution-shaped. Always throws MarketDiagnosticsError (never returns a partial/fallback
 * result) on any failure — see each catch block below for the specific `.code`.
 */
export async function getMarketDiagnostics(options: GetMarketDiagnosticsOptions = {}): Promise<MarketDiagnosticsResult> {
  let config;
  try {
    config = getHermesExecutionConfig();
  } catch (error) {
    throw new MarketDiagnosticsError(
      "CONFIG_ERROR",
      error instanceof ConfigError ? error.message : `Hermes execution configuration is invalid: ${toErrorMessage(error)}`,
      { cause: error },
    );
  }

  const instrument = options.instrument ?? config.runtimeTrading.symbol;

  if (config.marketDataProvider === "mock") {
    let snapshot: MarketDataSnapshot;
    try {
      const provider = MarketDataProviderFactory.create("mock", { mock: { count: config.marketData.candleCount } });
      snapshot = await provider.getMarketData(instrument);
    } catch (error) {
      throw new MarketDiagnosticsError("CANDLE_FETCH_FAILED", `Mock market data fetch failed: ${toErrorMessage(error)}`, {
        cause: error,
      });
    }
    return buildResult({
      instrument,
      timeframe: config.marketData.timeframe,
      requestedCandleCount: config.marketData.candleCount,
      maxCandleAgeSeconds: config.marketData.maxCandleAgeSeconds,
      provider: "mock",
      brokerProvider: config.brokerProvider,
      snapshot,
    });
  }

  // config.marketDataProvider === "live" from here — mirrors checkMarketDataCompatibility's own
  // real-runtime rule (runtime-config/compatibility.ts): live market data requires a broker that
  // can actually supply it. Only EtoroDemoBroker can today (broker-capabilities.ts's own
  // canSupplyLiveRates) — surfaced here as a clear, specific error rather than silently forcing
  // etoro-demo regardless of BROKER_PROVIDER (the original CLI script's behaviour, which this
  // service deliberately does not preserve — see this file's own top-of-file note).
  if (config.brokerProvider !== "etoro-demo") {
    throw new MarketDiagnosticsError(
      "UNSUPPORTED_BROKER",
      `HERMES_MARKET_DATA_PROVIDER=live requires BROKER_PROVIDER=etoro-demo — the only broker that can supply live rates and historical candles today. Current BROKER_PROVIDER is "${config.brokerProvider}".`,
    );
  }
  if (config.etoro.env !== "demo" || !config.etoro.apiKey || !config.etoro.userKey) {
    throw new MarketDiagnosticsError(
      "BROKER_NOT_CONFIGURED",
      "eToro demo credentials are not fully configured — ETORO_ENV=demo, ETORO_API_KEY, and ETORO_USER_KEY must all be set.",
    );
  }

  const auditTrail = new InMemoryAuditTrail(); // discarded on return — this service persists no audit trail of its own
  let broker: EtoroDemoBroker;
  try {
    broker = (await BrokerFactory.create(config, auditTrail, `market-diagnostics-${Date.now()}`, {
      provider: "etoro-demo",
    })) as EtoroDemoBroker;
  } catch (error) {
    throw new MarketDiagnosticsError("BROKER_CONNECTION_FAILED", `Failed to connect to eToro: ${toErrorMessage(error)}`, {
      cause: error,
    });
  }

  try {
    await broker.resolveInstrument(instrument);
  } catch (error) {
    throw new MarketDiagnosticsError(
      "INSTRUMENT_RESOLUTION_FAILED",
      `Failed to resolve instrument "${instrument}" on eToro: ${toErrorMessage(error)}`,
      { cause: error },
    );
  }

  const provider = MarketDataProviderFactory.create("live", {
    live: {
      rateSource: broker,
      timeframe: config.marketData.timeframe,
      candleCount: config.marketData.candleCount,
      maxCandleAgeSeconds: config.marketData.maxCandleAgeSeconds,
    },
  });

  let snapshot: MarketDataSnapshot;
  try {
    snapshot = await provider.getMarketData(instrument);
  } catch (error) {
    const code = error instanceof MarketDataProviderError && error.reason === "fetch-failed" ? "CANDLE_FETCH_FAILED" : "CANDLE_VALIDATION_FAILED";
    throw new MarketDiagnosticsError(code, toErrorMessage(error), { cause: error });
  }

  return buildResult({
    instrument,
    timeframe: config.marketData.timeframe,
    requestedCandleCount: config.marketData.candleCount,
    maxCandleAgeSeconds: config.marketData.maxCandleAgeSeconds,
    provider: "live",
    brokerProvider: "etoro-demo",
    snapshot,
  });
}
