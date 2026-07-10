import type {
  AgreementLevel,
  Instrument,
  OHLCVCandle,
  Recommendation,
  StrategyResult,
  StrategyScore,
  StrategySignal,
} from "@/lib/types";
import { buildStrategyContext, buildStrategyContextFromHistory } from "./build-context";
import { movingAverageCrossoverStrategy } from "./strategies/moving-average-crossover";
import { rsiReversalStrategy } from "./strategies/rsi-reversal";
import { momentumStrategy } from "./strategies/momentum";
import type { Strategy } from "./strategy";
import { getHistoricalMarketDataProvider } from "@/lib/market-data/get-historical-market-data-provider";

// How many days of history evaluateAllWithHistory() requests per scan — comfortably above
// MIN_CANDLES_FOR_HISTORY (build-context.ts) so every registered indicator's lookback window has
// enough data, and matching the mission's "90 daily candles minimum" mock requirement.
const HISTORY_LOOKBACK_DAYS = 90;

const REGISTERED_STRATEGIES: Strategy[] = [
  movingAverageCrossoverStrategy,
  rsiReversalStrategy,
  momentumStrategy,
];

// Threshold above which a unanimous BUY becomes "Strong Buy" rather than "Buy" — see
// mapToRecommendation. SELL has no equivalent tier: the existing Recommendation type (Build
// 0.3.0) only has one sell level, "Strong Sell", so every overall SELL maps to it regardless of
// confidence — a pre-existing asymmetry this build doesn't change.
const STRONG_BUY_CONFIDENCE_THRESHOLD = 75;

// evaluateInstrument()/evaluateAll() below have no configuration, no network calls, no failure
// mode — every strategy is a pure function over already-in-memory mock data, so this synchronous
// path has nothing to be "resilient" against; it either runs or the process itself is broken.
// evaluateInstrumentWithHistory()/evaluateAllWithHistory() (Mission 9) are the exception: they
// call the historical market data provider, which — like MarketDataProvider — can be configured,
// can fail, and does have a resilient fallback (to buildStrategyContext()'s snapshot proxies, the
// same values the synchronous path always used).
export class StrategyEngine {
  constructor(private readonly strategies: Strategy[] = REGISTERED_STRATEGIES) {}

  get strategyCount(): number {
    return this.strategies.length;
  }

  evaluateInstrument(instrument: Instrument): StrategyScore {
    const context = buildStrategyContext(instrument);
    const results = this.strategies.map((strategy) => strategy.evaluate(context));
    return aggregateResults(instrument, results);
  }

  evaluateAll(instruments: Instrument[]): StrategyScore[] {
    return instruments.map((instrument) => this.evaluateInstrument(instrument));
  }

  // Timing lives here, not in the caller — components must stay pure (no direct
  // performance.now()/Date.now() calls in a render body), so this is the one place that measures
  // it, returning a plain number the caller can just read.
  evaluateAllWithTiming(instruments: Instrument[]): {
    scores: StrategyScore[];
    evaluationTimeMs: number;
  } {
    const start = performance.now();
    const scores = this.evaluateAll(instruments);
    const evaluationTimeMs = performance.now() - start;
    return { scores, evaluationTimeMs };
  }

  // One instrument, given its own candles already fetched — falls back to the snapshot-proxy
  // context (buildStrategyContext) whenever there isn't enough history for that symbol yet
  // (MIN_CANDLES_FOR_HISTORY, build-context.ts), so a single thin symbol never turns the whole
  // scan into a failure. The three strategies themselves are never called differently either way
  // — they only ever read StrategyContext fields, never know which path produced them.
  evaluateInstrumentWithHistory(instrument: Instrument, candles: OHLCVCandle[]): StrategyScore {
    const context = buildStrategyContextFromHistory(instrument, candles) ?? buildStrategyContext(instrument);
    const results = this.strategies.map((strategy) => strategy.evaluate(context));
    return aggregateResults(instrument, results);
  }

  // The history-aware entry point Bot Runner uses (src/lib/bot/bot-runner.ts) — fetches candles
  // for the whole batch in one call (same "batched, not per-symbol" convention getQuotes() and
  // getHistoricalCandles() already follow), then evaluates each instrument against its own slice.
  // Never throws on missing history for an individual symbol; only a provider-level failure
  // ResilientHistoricalMarketDataProvider itself can't recover from would propagate.
  async evaluateAllWithHistory(instruments: Instrument[]): Promise<StrategyScore[]> {
    const symbols = instruments.map((instrument) => instrument.symbol);
    const candles = await getHistoricalMarketDataProvider().getHistoricalCandles(
      symbols,
      HISTORY_LOOKBACK_DAYS,
    );

    const candlesBySymbol = new Map<string, OHLCVCandle[]>();
    for (const candle of candles) {
      const existing = candlesBySymbol.get(candle.symbol);
      if (existing) existing.push(candle);
      else candlesBySymbol.set(candle.symbol, [candle]);
    }

    return instruments.map((instrument) =>
      this.evaluateInstrumentWithHistory(instrument, candlesBySymbol.get(instrument.symbol) ?? []),
    );
  }
}

let engine: StrategyEngine | null = null;

// Cached at module scope like every other provider/store singleton in this app — one instance,
// shared by every server component that calls it in the same request.
export function getStrategyEngine(): StrategyEngine {
  if (!engine) engine = new StrategyEngine();
  return engine;
}

function aggregateResults(instrument: Instrument, results: StrategyResult[]): StrategyScore {
  const counts: Record<StrategySignal, number> = { BUY: 0, SELL: 0, HOLD: 0 };
  for (const result of results) counts[result.signal] += 1;

  const maxCount = Math.max(counts.BUY, counts.SELL, counts.HOLD);
  const leadingSignals = (Object.keys(counts) as StrategySignal[]).filter(
    (signal) => counts[signal] === maxCount,
  );

  let overallSignal: StrategySignal;
  let agreement: AgreementLevel;
  let agreementExplanation: string;

  // This logic assumes exactly 3 registered strategies (as built) — a majority of 2 always
  // means exactly one dissenter, and a max count of 1 always means all three signals differ.
  // Registering a 4th strategy would need this re-derived, not just re-used.
  if (maxCount === results.length) {
    overallSignal = leadingSignals[0] ?? "HOLD";
    agreement = "Strong Agreement";
    agreementExplanation = `All ${results.length} strategies agree on ${overallSignal}.`;
  } else if (maxCount === 2) {
    overallSignal = leadingSignals[0] ?? "HOLD";
    const dissenter = results.find((result) => result.signal !== overallSignal);
    const isOppositeDirection =
      dissenter !== undefined &&
      ((overallSignal === "BUY" && dissenter.signal === "SELL") ||
        (overallSignal === "SELL" && dissenter.signal === "BUY"));

    if (isOppositeDirection && dissenter) {
      agreement = "Mixed Signals";
      agreementExplanation = `${counts[overallSignal]} of ${results.length} strategies favour ${overallSignal}, but ${dissenter.strategyName} signals the opposite (${dissenter.signal}) — real disagreement, not just caution.`;
    } else {
      agreement = "Moderate Agreement";
      agreementExplanation = dissenter
        ? `${counts[overallSignal]} of ${results.length} strategies favour ${overallSignal}; ${dissenter.strategyName} is neutral (HOLD) rather than opposed.`
        : `${counts[overallSignal]} of ${results.length} strategies favour ${overallSignal}.`;
    }
  } else {
    // Every strategy reached a different signal — no majority exists at all.
    overallSignal = "HOLD";
    agreement = "Conflict";
    agreementExplanation = `Each strategy reached a different conclusion (${results
      .map((result) => `${result.strategyName}: ${result.signal}`)
      .join(", ")}) — no majority exists, so the safest reading is to avoid acting until the picture clarifies.`;
  }

  const agreeingResults = results.filter((result) => result.signal === overallSignal);
  const confidenceSource = agreeingResults.length > 0 ? agreeingResults : results;
  const overallConfidence = Math.round(
    confidenceSource.reduce((sum, result) => sum + result.confidence, 0) / confidenceSource.length,
  );

  const primaryResult = results.reduce((best, result) =>
    result.confidence > best.confidence ? result : best,
  );

  return {
    instrumentSymbol: instrument.symbol,
    instrumentName: instrument.name,
    results,
    overallSignal,
    overallRecommendation: mapToRecommendation(overallSignal, agreement, overallConfidence),
    overallConfidence,
    agreement,
    agreementExplanation,
    primaryStrategyName: primaryResult.strategyName,
    evaluatedAt: new Date().toISOString(),
  };
}

function mapToRecommendation(
  signal: StrategySignal,
  agreement: AgreementLevel,
  confidence: number,
): Recommendation {
  if (agreement === "Conflict") return "Avoid";
  if (signal === "HOLD") return "Hold";
  if (signal === "SELL") return "Strong Sell";
  return agreement === "Strong Agreement" && confidence >= STRONG_BUY_CONFIDENCE_THRESHOLD
    ? "Strong Buy"
    : "Buy";
}

// Share of the combined confidence this one result represents among all of an instrument's
// results — used by the Strategy Breakdown UI's "Contribution" column.
export function computeContributionPercent(
  result: StrategyResult,
  allResults: StrategyResult[],
): number {
  const total = allResults.reduce((sum, item) => sum + item.confidence, 0);
  if (total === 0) return 0;
  return Math.round((result.confidence / total) * 100);
}
