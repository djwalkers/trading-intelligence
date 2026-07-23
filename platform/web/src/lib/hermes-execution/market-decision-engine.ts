import type { Candle, StrategySourceType } from "./types";
import type { MarketSession } from "./market-session";
import type { TrendClassification } from "./technical-indicators";
import type { StrategyRegistry } from "./strategies/strategy-registry";
import { defaultStrategyRegistry } from "./strategies/default-strategy-registry";

// Milestone 3 — Rich Market Context for the Market Decision Engine. MarketDecisionEngine remains a
// pure function: it only ever reads the MarketDecisionContext it's given and returns a decision —
// it never fetches candles, rates, or strategy documents itself (that's MarketIntelligenceBuilder's
// job, and the CLI/runner's job to invoke it beforehand). This is deliberately still not
// self-learning, not optimisation, and not AI reasoning — a simple, deterministic ruleset over the
// richer context. Named "Market Decision Engine", not "Hermes" — "Hermes" is reserved for the
// external Nous Hermes Agent (see the project constitution's naming resolution); this engine only
// ever applies its own fixed, internal ruleset and never claims to be Hermes deciding anything.
//
// Phase 3 — Strategy-Driven Decision Engine. This engine no longer contains any strategy-specific
// rule (no EMA/RSI thresholds, no BUY/SELL/HOLD branching live here any more). It is reduced to:
// look up `context.strategy.strategyId` in a StrategyRegistry, and delegate to that strategy's own
// `evaluate()`. The actual DEMO-0001 ruleset that used to live in this file moved, unchanged, to
// strategies/demo-0001-strategy.ts — see that file for the rule logic itself. Adding a new strategy
// means registering it in strategies/default-strategy-registry.ts; this file never needs to change
// for that (requirement 5).

export type MarketDecisionAction = "BUY" | "SELL" | "HOLD";

/** A trimmed view of the approved strategy authorising this evaluation — `strategyId` is also the
 * key MarketDecisionEngine looks up in its StrategyRegistry to select which strategy actually runs. */
export interface DecisionStrategyMetadata {
  strategyId: string;
  version: number;
  sourceType: StrategySourceType;
}

/** Everything a Strategy can consider for a decision. Assembled entirely by
 * MarketIntelligenceBuilder before any strategy ever sees it — every field here is a plain,
 * already-computed value, never a function or a promise. */
export interface MarketDecisionContext {
  instrument: string;
  bid: number;
  ask: number;
  spread: number;
  midPrice: number;
  timestamp: string;
  positionOpen: boolean;
  strategy: DecisionStrategyMetadata;

  /** The candle window the derived metrics below were computed from (most recent last) — carried
   * through for display/audit, not re-computed or re-read here. */
  recentCandles: Candle[];
  ema20: number;
  ema50: number;
  rsi14: number;
  atr14: number;
  volume: number;
  dailyHigh: number;
  dailyLow: number;
  /** Undefined when there wasn't enough candle history to compute a return series — see
   * calculateVolatility24h's own doc comment. */
  volatility24h: number | undefined;
  marketSession: MarketSession;
  trend: TrendClassification;
}

/** The decision itself — a strongly typed object, never free-form text. `reasoning` is a short
 * list of distinct factor statements (structured, not one prose paragraph) for the audit trail and
 * CLI display; nothing branches on its contents.
 *
 * The three `*CriteriaMet`/`validationNotes` fields are optional here (Phase 3): every strategy
 * this engine actually runs (strategies/strategy.ts's own `Decision` type) always populates them,
 * but they stay optional on this older, more widely-referenced type so no pre-existing code that
 * constructs a `MarketDecision` literal (tests, fixtures) needs to change. */
export interface MarketDecision {
  action: MarketDecisionAction;
  confidence: number;
  reasoning: string[];
  entryCriteriaMet?: boolean;
  exitCriteriaMet?: boolean;
  validationNotes?: string[];
}

export const MarketDecisionEngine = {
  /**
   * Looks up the strategy named by `context.strategy.strategyId` in `registry` (defaulting to the
   * runtime's own defaultStrategyRegistry) and delegates entirely to that strategy's `evaluate()`.
   * Throws UnknownStrategyError (from strategies/strategy-registry.ts) if no strategy is registered
   * under that id — propagates to the caller exactly like any other cycle failure; see
   * strategy-registry.ts's own doc comment on why that is "graceful" here, not a raw crash.
   */
  evaluate(context: MarketDecisionContext, registry: StrategyRegistry = defaultStrategyRegistry): MarketDecision {
    const strategy = registry.require(context.strategy.strategyId);
    return strategy.evaluate(context);
  },
};
