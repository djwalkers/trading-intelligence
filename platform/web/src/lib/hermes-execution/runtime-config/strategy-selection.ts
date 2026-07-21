import type { InternalStrategy } from "../types";

// Milestone 8 — Deployment-Ready Runtime Configuration. Pure — takes an already-loaded strategy
// list (loadEnabledStrategies' own output, unchanged) and a configured id, never touches the
// registry itself. Does not alter strategy calculations or rules — this only ever picks *which*
// already-mapped InternalStrategy the runtime evaluates, the same InternalStrategy
// internal-strategy-mapper.ts already produced.

export type StrategySelectionResult =
  | { found: true; strategy: InternalStrategy }
  | { found: false; reason: string };

/**
 * `strategyId` undefined preserves this pipeline's pre-Milestone-8 behaviour exactly: prefer the
 * first HERMES_APPROVED strategy, falling back to the first DEMO_ONLY (today, at most one of each
 * can ever be loaded, but this reads as "first" for forward compatibility, not "the only one").
 *
 * `strategyId` set selects by exact id match among the loaded (already-enabled) set only — an id
 * that doesn't appear there is reported as unknown-or-disabled without distinguishing further
 * (whether it doesn't exist in the registry at all, was rejected during loading/mapping, isn't
 * "active", or IS loaded but has `enabled: false` — every InternalStrategy the current loaders
 * produce has enabled: true, so that last case is not reachable via FileSystemRegistryClient/
 * demo-strategy.ts today, but this function still honours the field for any future producer that
 * might set it false, and reports it with its own distinct, more specific message).
 */
export function selectStrategy(strategies: InternalStrategy[], strategyId: string | undefined): StrategySelectionResult {
  if (strategyId === undefined) {
    const preferred =
      strategies.find((s) => s.sourceType === "HERMES_APPROVED") ?? strategies.find((s) => s.sourceType === "DEMO_ONLY");
    if (!preferred) {
      return {
        found: false,
        reason:
          "No strategy is available to evaluate. Set DEMO_EXECUTION_MODE=true to use the DEMO_ONLY strategy, " +
          "add a real strategy to the Hermes Strategy Registry, or set HERMES_STRATEGY_ID explicitly.",
      };
    }
    return { found: true, strategy: preferred };
  }

  const match = strategies.find((s) => s.strategyId === strategyId);
  if (!match) {
    return {
      found: false,
      reason: `HERMES_STRATEGY_ID "${strategyId}" does not match any currently loaded, enabled strategy.`,
    };
  }
  if (!match.enabled) {
    return { found: false, reason: `HERMES_STRATEGY_ID "${strategyId}" matches a strategy that is disabled.` };
  }
  return { found: true, strategy: match };
}
