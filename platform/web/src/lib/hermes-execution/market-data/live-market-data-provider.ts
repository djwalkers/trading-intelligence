import { logger } from "@/lib/logger/logger";
import type { Candle } from "../types";
import { validateHistoricalCandles, type MarketTimeframe } from "./candle-validation";
import { MarketDataProviderError, type MarketDataProvider, type MarketDataSnapshot } from "./market-data-provider";

// Milestone 5 — Live Market Data Integration. The "second implementation suitable for live data"
// this milestone calls for. Deliberately depends only on the narrow RateSource/CandleHistorySource
// shapes below, never on a concrete broker class — EtoroDemoBroker.getRate/getHistoricalCandles
// already satisfy these shapes structurally (TypeScript structural typing needs no explicit
// "implements"), so this file never imports EtoroDemoBroker or any other broker at all. Any future
// real quote/candle source (a public market-data API client, a different broker) can be substituted
// purely by passing a different source, without touching this class.
//
// Phase 2A — Real Historical Candles for Live Market Data. Previously (Milestone 5) the OHLCV
// candle *history* was a synthetic series anchored to the live mid-price — a stated, deliberate
// limitation (MarketIntelligenceBuilder's EMA/RSI/trend indicators were computed over synthetic
// data even though bid/ask was real). That limitation is now removed: candles come from the same
// connected source's own getHistoricalCandles(), validated (candle-validation.ts) before use.
// `latestPrice` still comes from getRate() alone, per this phase's own instruction — the OHLCV
// history and "the current executable price" remain two independently-sourced reads from the same
// underlying connection, never merged or cross-derived.

/** The minimal live-quote capability this provider needs — small enough that a broker's own
 * getRate(), or a standalone public API client, can satisfy it without adapting anything. */
export interface RateSource {
  getRate(instrument: string): Promise<{ bid: number; ask: number }>;
}

/** The minimal historical-candle capability this provider needs. `timeframe` is this pipeline's
 * own generic MarketTimeframe (candle-validation.ts) — a concrete source (EtoroDemoBroker) is
 * responsible for translating it into its own API's interval vocabulary, exactly as it already
 * translates a human-readable symbol into its own instrumentId for getRate(). Returned candles
 * need not be pre-sorted or pre-validated — this provider sorts defensively and always validates
 * (see getMarketData) regardless of what the source returns. */
export interface CandleHistorySource {
  getHistoricalCandles(instrument: string, timeframe: MarketTimeframe, count: number): Promise<Candle[]>;
}

export interface LiveMarketDataProviderOptions {
  timeframe?: MarketTimeframe;
  candleCount?: number;
  maxCandleAgeSeconds?: number;
}

// Defensive fallbacks only — production wiring (runtime-dependency-factory.ts, market-decide.ts)
// always supplies these three explicitly from HermesExecutionConfig.marketData, which has its own,
// independently-documented defaults (config.ts). Mirrors config.ts's own DEFAULT_MARKET_TIMEFRAME/
// DEFAULT_MARKET_CANDLE_COUNT/derived-max-age-for-1h so a direct construction without options
// (tests, ad hoc scripts) still behaves sensibly.
const DEFAULT_TIMEFRAME: MarketTimeframe = "1h";
const DEFAULT_CANDLE_COUNT = 200;
const DEFAULT_MAX_CANDLE_AGE_SECONDS = 7_200;

function isValidPrice(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LiveMarketDataProvider implements MarketDataProvider {
  constructor(
    private readonly source: RateSource & CandleHistorySource,
    private readonly options: LiveMarketDataProviderOptions = {},
  ) {}

  async getMarketData(instrument: string): Promise<MarketDataSnapshot> {
    const timeframe = this.options.timeframe ?? DEFAULT_TIMEFRAME;
    const candleCount = this.options.candleCount ?? DEFAULT_CANDLE_COUNT;
    const maxCandleAgeSeconds = this.options.maxCandleAgeSeconds ?? DEFAULT_MAX_CANDLE_AGE_SECONDS;

    let rate: { bid: number; ask: number };
    try {
      rate = await this.source.getRate(instrument);
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
        reason: toErrorMessage(error),
      });
      throw new MarketDataProviderError(
        `LiveMarketDataProvider failed to fetch a rate for "${instrument}": ${toErrorMessage(error)}`,
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
    const midPrice = (rate.bid + rate.ask) / 2;

    let candles: Candle[];
    try {
      candles = await this.source.getHistoricalCandles(instrument, timeframe, candleCount);
    } catch (error) {
      logger.error("Live historical candle fetch failed — no fallback attempted", {
        component: "market-data",
        provider: "live",
        instrument,
        timeframe,
        fallbackOccurred: false,
        reason: toErrorMessage(error),
      });
      // A MarketDataProviderError from a source's own validation (unlikely today — sources fetch
      // and translate, candle-validation.ts below is where validation actually happens — but never
      // assumed impossible) is re-thrown as-is rather than double-wrapped.
      if (error instanceof MarketDataProviderError) throw error;
      throw new MarketDataProviderError(
        `LiveMarketDataProvider failed to fetch historical candles for "${instrument}": ${toErrorMessage(error)}`,
        "fetch-failed",
        { cause: error },
      );
    }

    try {
      validateHistoricalCandles(candles, instrument, { timeframe, maxCandleAgeSeconds });
    } catch (error) {
      logger.error("Live historical candle validation failed — no fallback attempted", {
        component: "market-data",
        provider: "live",
        instrument,
        timeframe,
        candleCount: candles.length,
        fallbackOccurred: false,
        reason: toErrorMessage(error),
      });
      throw error;
    }

    // Chronological, oldest-first, regardless of what order the source returned — the same
    // defensive sort candle-validation.ts's own gap/staleness checks already rely on internally,
    // applied here too since MarketIntelligenceBuilder (the actual indicator consumer) depends on
    // this exact ordering.
    const sorted = [...candles].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const now = new Date();

    // Phase 2A — Real Historical Candles for Live Market Data. Every successful fetch logs the
    // full shape needed to prove, from a VPS log stream alone, that real historical candles (not
    // synthetic ones) were fetched and used: provider, instrument, timeframe, candleCount, the
    // real candle range (first/lastTimestamp), the last closed candle's own price
    // (latestClosedPrice), and the independently-fetched live executable price (brokerMidPrice) —
    // deliberately two distinct price fields, never merged, so a log reader can see both sourced
    // from the same connection without conflating "closed candle" with "current tradable price".
    // Never logs the raw rate object, credentials, or headers.
    logger.info("Live market data quote fetched", {
      component: "market-data",
      provider: "live",
      instrument,
      timeframe,
      candleCount: sorted.length,
      firstTimestamp: first.timestamp,
      lastTimestamp: last.timestamp,
      latestClosedPrice: last.close,
      brokerMidPrice: midPrice,
      fallbackOccurred: false,
    });

    return {
      instrument,
      timestamp: now.toISOString(),
      candles: sorted,
      bid: rate.bid,
      ask: rate.ask,
      spread: rate.ask - rate.bid,
      latestPrice: midPrice,
      volume: last.volume,
    };
  }
}
