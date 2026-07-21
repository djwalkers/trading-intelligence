import type { Candle } from "./types";

// Milestone 3 — Rich Market Context for the Market Decision Engine. This is explicitly mock data
// (per this milestone's own "may initially come from mock data or an existing provider" allowance)
// — a small, self-contained, seeded synthetic OHLCV generator, not a real market-data feed. It
// exists so both `npm run market:decide` and the test suite can produce a deterministic, repeatable
// candle history with a controllable directional bias, without a new fixture file or dependency.

export type CandleBias = "bullish" | "bearish" | "sideways";

export interface GenerateSyntheticCandlesOptions {
  instrument: string;
  bias: CandleBias;
  /** Number of candles to generate, oldest first. Defaults to 60 — comfortably more than the
   * longest indicator period this milestone uses (EMA50). */
  count?: number;
  intervalMinutes?: number;
  startPrice?: number;
  /** Any integer seeds the same deterministic series every time — required for repeatable tests
   * and a stable CLI demo. */
  seed?: number;
  /** The timestamp of the LAST (most recent) candle; earlier candles are spaced backwards from
   * this. Defaults to now. */
  endTimestamp?: Date;
}

const DEFAULT_COUNT = 60;
const DEFAULT_INTERVAL_MINUTES = 60;
const DEFAULT_START_PRICE = 100;
const DEFAULT_SEED = 42;

// Calibrated so a 60-candle "bullish" series lands EMA20 clearly above EMA50 (a confident Bullish
// classification) while RSI14 settles in the 45-65 healthy band rather than saturating toward 100
// — a strong-but-not-overbought uptrend, which is what actually exercises the BUY rule. Symmetric
// for "bearish"; "sideways" carries no drift at all.
const BIAS_DRIFT: Record<CandleBias, number> = {
  bullish: 0.0002,
  bearish: -0.0002,
  sideways: 0,
};
const NOISE_SCALE = 0.005;

/** A tiny, dependency-free deterministic PRNG (mulberry32) — the same seed always produces the
 * same sequence, which is all this generator needs; it is not used for anything security-sensitive. */
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

/** Generates a deterministic, chronologically-ordered (oldest first) synthetic candle series with
 * a controllable directional bias — the "Market Data Provider" stand-in for this milestone. */
export function generateSyntheticCandles(options: GenerateSyntheticCandlesOptions): Candle[] {
  const { instrument, bias } = options;
  const count = options.count ?? DEFAULT_COUNT;
  const intervalMinutes = options.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
  const seed = options.seed ?? DEFAULT_SEED;
  const end = options.endTimestamp ?? new Date();

  const random = mulberry32(seed);
  const drift = BIAS_DRIFT[bias];

  const candles: Candle[] = [];
  let price = options.startPrice ?? DEFAULT_START_PRICE;

  for (let i = 0; i < count; i++) {
    const timestamp = new Date(end.getTime() - (count - 1 - i) * intervalMinutes * 60_000).toISOString();
    const open = price;
    const change = drift + (random() - 0.5) * NOISE_SCALE;
    const close = Math.max(0.0001, open * (1 + change));
    const high = Math.max(open, close) * (1 + random() * 0.001);
    const low = Math.min(open, close) * (1 - random() * 0.001);
    const volume = 100 + random() * 50;

    candles.push({ symbol: instrument, timestamp, open, high, low, close, volume });
    price = close;
  }

  return candles;
}
