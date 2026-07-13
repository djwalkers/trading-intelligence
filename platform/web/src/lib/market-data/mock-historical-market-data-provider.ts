import { getInstrumentBySymbol } from "@/lib/mock/instruments";
import type { HistoricalFetchResult, OHLCVCandle } from "@/lib/types";
import type { HistoricalMarketDataProvider } from "./historical-market-data-provider";

// Daily volatility and intraday high/low spread, both tuned to produce believable-looking mock
// candles — not calibrated against any real instrument, just plausible enough for the Strategy
// Engine's indicators to have real texture to work with instead of a flat line.
const DAILY_VOLATILITY_PERCENT = 1.6;
const INTRADAY_RANGE_PERCENT = 0.8;
const VOLUME_MULTIPLIER_MIN = 0.6;
const VOLUME_MULTIPLIER_RANGE = 0.8;
const DAY_MS = 24 * 60 * 60 * 1000;

// A small, dependency-free, deterministic PRNG (mulberry32) seeded from a string hash — same seed
// in, same sequence out, every time, on every machine. Used instead of Math.random() so the mock
// historical candles are reproducible across builds/sessions, per the mission's "deterministic
// output" requirement — genuinely important here, unlike most of this app's other mock data,
// because indicator calculations need a stable series to test and reason about, not a fresh random
// one every run.
function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A roughly-normal random daily return (Box-Muller), scaled to DAILY_VOLATILITY_PERCENT and seeded
// per instrument so the whole 90-day walk is reproducible.
function generateSeededDailyReturns(symbol: string, days: number): number[] {
  const random = mulberry32(hashString(`${symbol}-returns`));
  const returns: number[] = [];
  for (let i = 0; i < days; i++) {
    const u1 = random() || 1e-9;
    const u2 = random();
    const gaussian = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    returns.push((gaussian * DAILY_VOLATILITY_PERCENT) / 100);
  }
  return returns;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Deterministic OHLCV history for this prototype's fixed 5-instrument universe, generated (not
// fetched) so the app runs with zero configuration — the same default posture as
// MockMarketDataProvider for live quotes. The walk is built as an unscaled compounding sequence
// starting at an arbitrary base of 100, then rescaled so the final candle's close lands exactly on
// the instrument's current mock snapshot price (src/lib/mock/instruments.ts) — this keeps the
// historical series coherent with the price the rest of the app already shows for "today," rather
// than two unrelated numbers for the same instrument.
export class MockHistoricalMarketDataProvider implements HistoricalMarketDataProvider {
  async getHistoricalCandles(symbols: string[], days: number): Promise<OHLCVCandle[]> {
    return symbols.flatMap((symbol) => this.buildCandles(symbol, days));
  }

  // A raw Mock provider called directly (never wrapped by Resilient) has no concept of "standing
  // in for a failure" — that concept belongs only to the Resilient wrapper, which is the only
  // caller that ever falls back to this provider. Called directly, generating deterministic mock
  // candles is simply the intended behaviour, so usedFallback is always false here.
  async getHistoricalCandlesWithTelemetry(symbols: string[], days: number): Promise<HistoricalFetchResult> {
    const candles = await this.getHistoricalCandles(symbols, days);
    return {
      candles,
      telemetry: {
        symbolsRequested: symbols,
        symbolsServedExternally: [],
        symbolsServedFromFallback: symbols,
        symbolsFailed: [],
        usedFallback: false,
        source: "Mock",
        provider: "Sample data",
      },
    };
  }

  private buildCandles(symbol: string, days: number): OHLCVCandle[] {
    const instrument = getInstrumentBySymbol(symbol);
    if (!instrument || days <= 0) return [];

    const returns = generateSeededDailyReturns(symbol, days);

    // First pass: a plain running product (no array indexing) to find where the unscaled walk
    // ends up, so the scale factor can be derived before building any candles.
    let unscaledFinal = 100;
    for (const dailyReturn of returns) unscaledFinal *= 1 + dailyReturn;
    const scale = unscaledFinal === 0 ? 1 : instrument.price / unscaledFinal;

    // Second pass: walk the same return sequence again, this time compounding a running *scaled*
    // close (previousClose -> close) so every candle is derived from the last without ever
    // indexing back into an intermediate array.
    const volumeRandom = mulberry32(hashString(`${symbol}-volume`));
    const now = Date.now();
    const candles: OHLCVCandle[] = [];
    let previousClose = round2(100 * scale);
    let dayIndex = 0;

    for (const dailyReturn of returns) {
      dayIndex += 1;
      const close = round2(previousClose * (1 + dailyReturn));
      const dayRandom = mulberry32(hashString(`${symbol}-day-${dayIndex}`));
      const intraday = INTRADAY_RANGE_PERCENT / 100;
      const high = round2(Math.max(close, previousClose) * (1 + dayRandom() * intraday));
      const low = round2(Math.min(close, previousClose) * (1 - dayRandom() * intraday));
      const volumeMultiplier = VOLUME_MULTIPLIER_MIN + volumeRandom() * VOLUME_MULTIPLIER_RANGE;
      const volume = Math.round(instrument.volume * volumeMultiplier);
      const daysAgo = days - dayIndex;
      const timestamp = new Date(now - daysAgo * DAY_MS).toISOString();

      candles.push({
        symbol,
        timestamp,
        open: previousClose,
        high,
        low,
        close,
        volume,
      });

      previousClose = close;
    }

    return candles;
  }
}
