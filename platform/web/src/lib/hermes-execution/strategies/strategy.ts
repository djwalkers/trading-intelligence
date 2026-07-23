import type { MarketDecisionAction, MarketDecisionContext } from "../market-decision-engine";

// Phase 3 — Strategy-Driven Decision Engine. The interface that makes a strategy the actual
// source of trading behaviour, instead of metadata MarketDecisionEngine merely labels its own
// fixed ruleset with. Named `Strategy` (not `InternalStrategy`, `RawRegistryStrategy`, or the
// unrelated `src/lib/types/strategy.ts`/`src/lib/strategy-engine/strategy.ts` — three other,
// pre-existing, unrelated "Strategy" concepts in this codebase) — always import this one from
// `strategies/strategy.ts` explicitly rather than a bare `Strategy` re-export, to keep which one a
// given file means unambiguous.
//
// A capability-decomposed design (checkEntryConditions/checkExitConditions/applyFilters/
// calculateEntryConfidence/calculateExitConfidence/explainHold), not just one opaque evaluate()
// method — this is deliberate: `evaluate()` is still the one method MarketDecisionEngine actually
// calls, but a strategy author composes it FROM these named building blocks (see
// demo-0001-strategy.ts), so "why did this strategy decide X" is answerable by reading a specific,
// narrowly-scoped method rather than one large branching function. The engine itself never calls
// these sub-methods directly and never assumes a strategy's own evaluate() is built from them —
// only that evaluate() returns a well-formed Decision.

/** The outcome of one strategy-defined check (an entry condition, an exit condition, or a filter)
 * — `met` is the pass/fail verdict, `reasons` is why (always populated, even when `met` is true,
 * so a strategy can explain a met exit condition just as clearly as an unmet entry condition — see
 * demo-0001-strategy.ts's own checkExitConditions for an example of the met-with-reasons case). */
export interface StrategyConditionResult {
  met: boolean;
  reasons: string[];
}

/** The complete decision a Strategy.evaluate() call always returns. Structurally compatible with
 * (assignable to) MarketDecisionEngine's own MarketDecision type — see that type's own doc comment
 * for why its three newest fields are optional there but required here: every strategy this engine
 * actually runs produces a fully-populated Decision; MarketDecision only keeps them optional for
 * backward-compatible typing against decision literals written before Phase 3 existed. */
export interface Decision {
  action: MarketDecisionAction;
  confidence: number;
  reasoning: string[];
  /** Whether this strategy's own entry conditions (checkEntryConditions) were met this cycle —
   * independent of whether a filter subsequently blocked the trade, or whether a position was
   * already open and entry was never even evaluated (false in that case — see
   * demo-0001-strategy.ts's own evaluate()). */
  entryCriteriaMet: boolean;
  /** Whether this strategy's own exit conditions (checkExitConditions) were met this cycle —
   * always false when no position was open (exit is never evaluated in that case). */
  exitCriteriaMet: boolean;
  /** Non-error diagnostic notes about this decision's own reliability or caveats — e.g. a filter
   * that blocked an otherwise-valid entry. Distinct from `reasoning` (why THIS action was chosen)
   * and from a thrown error (a genuinely invalid strategy/context — see strategy-registry.ts).
   * Always present, empty when there's nothing to note. */
  validationNotes: string[];
}

/**
 * Implemented once per tradable strategy (DEMO-0001 today — see demo-0001-strategy.ts) and
 * registered with a StrategyRegistry (strategy-registry.ts). MarketDecisionEngine.evaluate() only
 * ever calls `evaluate()` — every other method exists for the strategy's own internal composition
 * and for direct, focused unit testing of one capability at a time.
 */
export interface Strategy {
  /** Matches InternalStrategy.strategyId / MarketDecisionContext.strategy.strategyId — the key a
   * StrategyRegistry looks this strategy up by. */
  readonly id: string;
  readonly version: number;

  /** Whether this strategy's own entry conditions are satisfied by `context`, independent of
   * current position state — the strategy's own evaluate() decides how (and whether) to combine
   * this with `context.positionOpen`. */
  checkEntryConditions(context: MarketDecisionContext): StrategyConditionResult;

  /** Whether this strategy's own exit conditions are satisfied by `context`. */
  checkExitConditions(context: MarketDecisionContext): StrategyConditionResult;

  /** Additional pass/fail filters beyond entry/exit conditions (e.g. a session, spread, or volume
   * gate). A strategy with no extra filters returns `{ met: true, reasons: [] }` unconditionally —
   * a genuine no-op, never a new rejection path, so registering a filter-free strategy can never by
   * itself change trading frequency. */
  applyFilters(context: MarketDecisionContext): StrategyConditionResult;

  /** Confidence in [0, 1] for a prospective BUY. Only ever called when entry conditions (and
   * filters) already passed — never asked to score a rejected entry. */
  calculateEntryConfidence(context: MarketDecisionContext): number;

  /** Confidence in [0, 1] for a prospective SELL. Only ever called when exit conditions already
   * passed. */
  calculateExitConfidence(context: MarketDecisionContext): number;

  /** Human-readable explanation lines for a HOLD outcome — no entry or exit signal this cycle. */
  explainHold(context: MarketDecisionContext): string[];

  /**
   * The single entry point MarketDecisionEngine calls. Combines every capability above into one
   * final Decision. The engine never inspects HOW this arrives at its answer — only that the
   * returned Decision is well-formed — so a strategy is free to compose these methods however it
   * needs to (demo-0001-strategy.ts's own evaluate() calls each of the above at least once).
   */
  evaluate(context: MarketDecisionContext): Decision;
}
