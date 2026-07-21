import type { BrokerProvider, MarketDataProviderType, RuntimeMode } from "../config";
import type { InternalStrategy } from "../types";
import { checkMarketDataCompatibility, checkModeCompatibility, type CompatibilityProblem } from "./compatibility";
import { selectStrategy } from "./strategy-selection";

// Milestone 8 — Deployment-Ready Runtime Configuration. "Collect multiple independent
// configuration problems into a useful startup report where practical, rather than failing one
// variable at a time." Per-field env parsing/format validation (symbol characters, quantity
// range, session time format, ...) remains config.ts's own fail-fast job, unchanged — by the time
// a HermesExecutionConfig value exists at all, every one of those has already passed. What this
// aggregator adds is the layer config.ts structurally cannot do on its own: cross-field semantic
// checks (does this broker support this mode? this market-data provider? does this strategy id
// actually exist among what the registry just loaded?) — checks that only make sense together, so
// they are collected together into one report instead of surfacing as separate crashes.

export interface StartupValidationProblem {
  field: string;
  message: string;
}

export type StartupValidationResult =
  | { valid: true; problems: []; strategy: InternalStrategy }
  | { valid: false; problems: StartupValidationProblem[]; strategy?: undefined };

export interface StartupValidationInput {
  runtimeMode: RuntimeMode;
  brokerProvider: BrokerProvider;
  marketDataProvider: MarketDataProviderType;
  strategyId: string | undefined;
  /** Already loaded by the caller (loadEnabledStrategies) — this function performs no I/O. */
  availableStrategies: InternalStrategy[];
}

/** Every check here is static — no broker connection, no network call, no registry read (the
 * caller already did that). Anything that genuinely requires connecting to a broker (eToro's own
 * resolveInstrument() symbol check) happens one step later, in runtime-dependency-factory.ts, and
 * is folded into the same problem-reporting shape there rather than duplicated here. */
export function validateStartup(input: StartupValidationInput): StartupValidationResult {
  const problems: StartupValidationProblem[] = [];

  const modeProblem = checkModeCompatibility(input.brokerProvider, input.runtimeMode);
  if (modeProblem) problems.push(modeProblem);

  const marketDataProblem = checkMarketDataCompatibility(input.brokerProvider, input.marketDataProvider);
  if (marketDataProblem) problems.push(marketDataProblem);

  const strategyResult = selectStrategy(input.availableStrategies, input.strategyId);
  if (!strategyResult.found) {
    problems.push({ field: "strategyId", message: strategyResult.reason });
  }

  if (problems.length > 0) {
    return { valid: false, problems };
  }
  // strategyResult.found is guaranteed true here (the only way problems stayed empty), but
  // TypeScript can't see that across the two independent checks above — narrow explicitly rather
  // than casting.
  if (!strategyResult.found) {
    return { valid: false, problems: [{ field: "strategyId", message: "Unreachable: strategy selection failed silently." }] };
  }
  return { valid: true, problems: [], strategy: strategyResult.strategy };
}

export type { CompatibilityProblem };
