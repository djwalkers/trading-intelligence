import type { Strategy } from "./strategy";

// Phase 3 — Strategy-Driven Decision Engine. "Adding Strategy B should require no changes to the
// decision engine" (this phase's own requirement 5) — the registry is what makes that true:
// MarketDecisionEngine only ever calls `registry.require(strategyId)`, never anything specific to
// one strategy's own id. Registering a new strategy means calling `.register()` somewhere (see
// default-strategy-registry.ts) — market-decision-engine.ts itself never needs to change.

/** Thrown by `require()` when no strategy is registered under the requested id. Propagates through
 * the existing, already-tested pipeline exactly like any other MarketDataProviderError/
 * EtoroApiError — caught by TradingRuntime.runCycleBody(), recorded as TRADING_CYCLE_FAILED and (as
 * of Phase 2B) a market_analysis_runs row with decision:'ERROR' — never a silent fallback to a
 * different strategy, never a raw/unhandled crash. This is what "unknown strategy IDs are handled
 * gracefully" means here: a clear, typed, already-observable failure, not a guess. */
export class UnknownStrategyError extends Error {
  constructor(public readonly strategyId: string) {
    super(`No strategy registered for id "${strategyId}".`);
    this.name = "UnknownStrategyError";
  }
}

/** Thrown by `register()` when a strategy object doesn't satisfy the Strategy interface's own
 * minimum shape — malformed strategies fail at registration time (module load / registry setup),
 * never silently accepted and only discovered mid-cycle. */
export class InvalidStrategyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStrategyError";
  }
}

export interface StrategyRegistry {
  register(strategy: Strategy): void;
  get(strategyId: string): Strategy | undefined;
  /** Like `get()`, but throws UnknownStrategyError instead of returning undefined — the form
   * MarketDecisionEngine.evaluate() actually uses, since a cycle with no resolvable strategy has
   * nothing useful to do but fail clearly. */
  require(strategyId: string): Strategy;
  has(strategyId: string): boolean;
  list(): Strategy[];
}

const REQUIRED_METHODS = [
  "checkEntryConditions",
  "checkExitConditions",
  "applyFilters",
  "calculateEntryConfidence",
  "calculateExitConfidence",
  "explainHold",
  "evaluate",
] as const satisfies readonly (keyof Strategy)[];

function assertValidStrategy(strategy: Strategy): void {
  if (!strategy || typeof strategy.id !== "string" || strategy.id.trim().length === 0) {
    throw new InvalidStrategyError("A strategy must have a non-empty string `id`.");
  }
  if (!Number.isInteger(strategy.version) || strategy.version < 1) {
    throw new InvalidStrategyError(`Strategy "${strategy.id}" must have a positive integer \`version\`.`);
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof strategy[method] !== "function") {
      throw new InvalidStrategyError(`Strategy "${strategy.id}" is missing required method "${method}".`);
    }
  }
}

/** A plain in-memory map — no persistence, no I/O. Strategies are registered once, at module load
 * (see default-strategy-registry.ts), not read from a database or the filesystem; this is
 * deliberately not the same thing as the Hermes Strategy Registry (registry-client.ts's own
 * RawRegistryStrategy documents) — see this file's own top-of-file note on the three other,
 * unrelated "Strategy" concepts already in this codebase. */
export class InMemoryStrategyRegistry implements StrategyRegistry {
  private readonly strategies = new Map<string, Strategy>();

  register(strategy: Strategy): void {
    assertValidStrategy(strategy);
    this.strategies.set(strategy.id, strategy);
  }

  get(strategyId: string): Strategy | undefined {
    return this.strategies.get(strategyId);
  }

  require(strategyId: string): Strategy {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) throw new UnknownStrategyError(strategyId);
    return strategy;
  }

  has(strategyId: string): boolean {
    return this.strategies.has(strategyId);
  }

  list(): Strategy[] {
    return [...this.strategies.values()];
  }
}
