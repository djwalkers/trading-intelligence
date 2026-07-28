import { HERMES_ALLOWED_ACTIONS } from "./types";
import type {
  HermesInstrumentSnapshot,
  HermesPortfolioContext,
  HermesRecentDecision,
  HermesUniverseInput,
} from "./types";
import type { ConfidenceBandPerformance } from "../trade-performance/compute-instrument-performance";

// Prototype 1.0 — official Hermes Agent decision integration. Pure assembly only — no I/O, no
// broker call, no market-data fetch. The universe scanner (runtime/universe-scanner.ts) is
// responsible for gathering every already-existing piece of data this function combines; this
// function's only job is shaping it into the strict HermesUniverseInput contract, and nothing
// here ever includes a credential, token, environment variable, or broker secret.

export interface BuildHermesUniverseInputParams {
  scanTimestamp: string;
  universe: readonly string[];
  instrumentSnapshots: readonly HermesInstrumentSnapshot[];
  portfolio: HermesPortfolioContext;
  performanceByConfidenceBand?: readonly ConfidenceBandPerformance[];
  recentDecisions?: readonly HermesRecentDecision[];
}

export function buildHermesUniverseInput(params: BuildHermesUniverseInputParams): HermesUniverseInput {
  return {
    scanTimestamp: params.scanTimestamp,
    universe: [...params.universe],
    instruments: [...params.instrumentSnapshots],
    portfolio: params.portfolio,
    allowedActions: HERMES_ALLOWED_ACTIONS,
    performanceByConfidenceBand: params.performanceByConfidenceBand ? [...params.performanceByConfidenceBand] : undefined,
    recentDecisions: params.recentDecisions ? [...params.recentDecisions] : undefined,
  };
}
