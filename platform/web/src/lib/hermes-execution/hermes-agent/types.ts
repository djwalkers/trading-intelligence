import type { MarketDecisionAction } from "../market-decision-engine";

// Prototype 1.0 — official Hermes Agent decision integration. Strict, hand-written contract
// between Trading Intelligence and the official Nous Research Hermes Agent CLI (installed
// separately, invoked as a subprocess — see hermes-agent-adapter.ts). Every type here is either
// something THIS app builds from its own already-existing data (HermesUniverseInput), or something
// that must be validated at runtime before it is trusted (HermesRawProposal / the parsed JSON),
// never assumed correct just because it type-checks. Nothing here imports or depends on the
// official Hermes Agent's own source — it is a black box invoked over its documented one-shot CLI
// surface (`hermes -z "<prompt>"`), never reimplemented.

/** One instrument's structured context for a single universe scan — assembled entirely from
 * existing pipeline data (MarketIntelligenceBuilder's indicators, the broker's own positions, the
 * configured market-hours policy for this instrument's asset class). Never includes credentials,
 * tokens, environment variables, or broker secrets. */
export interface HermesInstrumentSnapshot {
  instrument: string;
  assetClass: "crypto" | "equity";
  marketHoursEligible: boolean;
  quote: { bid: number; ask: number; spread: number; midPrice: number };
  /** Undefined when this instrument could not be safely evaluated this scan (a market-data fetch
   * failure) — the instrument is still listed (so Hermes knows it exists and why it was skipped)
   * but carries no indicators/candles and is never eligible for a proposal this scan. */
  unavailableReason?: string;
  recentCandles?: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }>;
  indicators?: { ema20: number; ema50: number; rsi14: number; atr14: number; trend: string };
  /** This runtime's own current position in this instrument, if any — never guessed, sourced
   * directly from the broker's own reconciled position state. */
  currentPosition: { side: "BUY" | "SELL"; quantity: number; entryPrice: number } | undefined;
  /** Recent per-instrument performance, when history exists — see
   * trade-performance/compute-instrument-performance.ts. Undefined means insufficient history, not
   * zero performance. */
  recentPerformance?: HermesInstrumentPerformanceContext;
}

export interface HermesInstrumentPerformanceContext {
  completedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  averageReturnPercent: number;
  realisedPnl: number;
  averageHoldingTimeMs: number;
  stopLossExits: number;
  takeProfitExits: number;
}

/** Shared, portfolio-wide context — never instrument-specific, built once per scan. */
export interface HermesPortfolioContext {
  availableCash: number;
  totalInvestedExposure: number;
  openPositionCount: number;
  maxOpenPositions: number;
  maxOpenPositionsPerInstrument: number;
  recentDrawdown: number;
}

/** One prior Hermes decision, kept only for context ("what did I decide last time and why") — never
 * used to bypass fresh validation of a new response. */
export interface HermesRecentDecision {
  timestamp: string;
  instrument: string;
  action: MarketDecisionAction;
  confidence: number;
}

export interface HermesUniverseInput {
  scanTimestamp: string;
  universe: string[];
  instruments: HermesInstrumentSnapshot[];
  portfolio: HermesPortfolioContext;
  allowedActions: readonly MarketDecisionAction[];
  /** Performance-by-confidence-band, computed across the whole universe (not per-instrument) when
   * enough history exists — see build-hermes-performance-context.ts. */
  performanceByConfidenceBand?: Array<{ band: string; trades: number; winRate: number; averageReturnPercent: number }>;
  recentDecisions?: HermesRecentDecision[];
}

/** The untrusted shape parsed straight out of Hermes's own stdout JSON — every field `unknown`/
 * loosely typed on purpose, since nothing here has been validated yet. See
 * validate-hermes-response.ts, which is the ONLY place this type is ever consumed. */
export interface HermesRawProposal {
  instrument?: unknown;
  action?: unknown;
  confidence?: unknown;
  reasoning?: unknown;
  suggestedStopLossPercent?: unknown;
  suggestedTakeProfitPercent?: unknown;
  // Deliberately allows (and ignores) anything else Hermes might include — quantity, notional,
  // leverage, broker, execution instructions — see validate-hermes-response.ts's own allow-list
  // extraction, which never spreads or passes this object through.
  [key: string]: unknown;
}

export interface HermesRawResponse {
  proposals?: unknown;
  [key: string]: unknown;
}

/** The ONLY shape ever handed to HermesAgentStrategy / the universe scanner — every field has
 * already been validated (finite, in-range, from the configured universe, bounded length) by
 * validate-hermes-response.ts. Deliberately has NO quantity/notional/leverage/broker field — those
 * are never extracted from Hermes's output at all, regardless of what it returns. */
export interface ValidatedHermesProposal {
  instrument: string;
  action: MarketDecisionAction;
  confidence: number;
  reasoning: string[];
  suggestedStopLossPercent: number | undefined;
  suggestedTakeProfitPercent: number | undefined;
}

export type HermesUniverseDecisionResult =
  | { ok: true; proposals: ValidatedHermesProposal[]; rawStdout: string }
  | { ok: false; reason: string; stage: "invocation" | "validation"; rawStdout?: string };

/** Bounds enforced by validate-hermes-response.ts — kept as named constants so the adapter, the
 * strategy, and tests all agree on exactly one definition of "safe." */
export const HERMES_VALIDATION_LIMITS = {
  minConfidence: 0,
  maxConfidence: 1,
  /** A stop-loss/take-profit percentage outside this range is rejected outright as unsafe — see
   * the mission's own "reject unsafe or excessive stop-loss/take-profit values" requirement. */
  maxStopLossPercent: 20,
  maxTakeProfitPercent: 50,
  maxReasoningItems: 10,
  maxReasoningItemLength: 240,
} as const;

export const HERMES_ALLOWED_ACTIONS: readonly MarketDecisionAction[] = ["BUY", "SELL", "HOLD"];
