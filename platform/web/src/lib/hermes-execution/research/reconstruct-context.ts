import { resolveMarketSession } from "../market-session";
import type { AnalysisRun } from "../analysis/types";
import type { MarketDecisionContext } from "../market-decision-engine";

// Phase 5 — Strategy Research Laboratory. Pure, side-effect-free: reshapes an already-persisted
// AnalysisRun (Phase 2B) into a MarketDecisionContext a Strategy's own evaluate() can run against.
// market_analysis_runs does not retain every field MarketDecisionContext defines (no raw candles,
// no volume/dailyHigh/dailyLow/volatility24h) — see this function's own field-by-field notes below.
// None of the DEMO-0001-family strategies' entry/exit/confidence LOGIC reads any of the approximated
// fields (only the BUY reasoning STRING's own display text does) — this is verified directly by
// reconstruct-context.test.ts's own "produces identical decisions to the original context" case,
// not merely asserted here.

/** A row missing any of these means the cycle that produced it never reached a real decision (an
 * ERROR row, or one written before Phase 2A's real-candle indicators existed) — not usable for
 * replay. Returns undefined rather than guessing a value for a genuinely-missing required field. */
export function canReconstructContext(run: AnalysisRun): boolean {
  return (
    run.currentBid !== undefined &&
    run.currentAsk !== undefined &&
    run.ema20 !== undefined &&
    run.ema50 !== undefined &&
    run.rsi14 !== undefined &&
    run.atr14 !== undefined &&
    run.trend !== undefined
  );
}

export interface ReconstructContextOptions {
  /** The CANDIDATE strategy under research, not the strategy that originally produced this row —
   * two different strategies compared over the identical historical window each see their own
   * identity here, purely for the cosmetic strategyRef() text in a Strategy's own reasoning
   * strings; no strategy's entry/exit/confidence logic branches on this field. */
  strategyId: string;
  strategyVersion: number;
  /** Set by the simulator per decision point, reflecting THIS run's own simulated position state
   * — never the originally-recorded outcome (see run-strategy-research.ts). */
  positionOpen: boolean;
}

export function reconstructContext(run: AnalysisRun, options: ReconstructContextOptions): MarketDecisionContext {
  if (!canReconstructContext(run)) {
    throw new Error(`AnalysisRun "${run.id}" is missing required fields for context reconstruction.`);
  }
  const bid = run.currentBid!;
  const ask = run.currentAsk!;

  return {
    instrument: run.instrument,
    bid,
    ask,
    spread: ask - bid,
    midPrice: run.currentMid ?? (bid + ask) / 2,
    timestamp: run.createdAt,
    positionOpen: options.positionOpen,
    strategy: { strategyId: options.strategyId, version: options.strategyVersion, sourceType: "DEMO_ONLY" },
    // Not retained by market_analysis_runs — no DEMO-0001-family strategy's entry/exit/confidence
    // logic reads recentCandles directly (only MarketIntelligenceBuilder does, upstream of where
    // this context is ever built live); always empty here.
    recentCandles: [],
    ema20: run.ema20!,
    ema50: run.ema50!,
    rsi14: run.rsi14!,
    atr14: run.atr14!,
    // volume/dailyHigh/dailyLow are not retained either — approximated from the one real price
    // observation this row does have (bid/ask), since no strategy's decision LOGIC branches on
    // them (Demo0001Strategy's own BUY reasoning string is the only reader, cosmetic only).
    volume: 0,
    dailyHigh: ask,
    dailyLow: bid,
    volatility24h: undefined,
    marketSession: resolveMarketSession(run.instrument, new Date(run.createdAt)),
    trend: run.trend!,
  };
}
