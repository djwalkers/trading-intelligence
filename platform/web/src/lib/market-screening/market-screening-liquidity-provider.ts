// Sprint 295 — the narrow, provider-neutral contract this deterministic market-screening service's
// shortlist resolution depends on. Deliberately names no vendor (Sprint 293 blocked adoption of
// every researched candidate pending licensing clarification) — a real implementation, once one is
// approved, only ever needs to satisfy this one method.
//
// Not to be confused with Hermes Agent (the platform's AI reasoning/planning layer, per the Project
// Constitution v2.0) — this module is a deterministic candidate-narrowing service Hermes Agent may
// call in future, not an AI agent itself, and will not evolve into one.
export interface MarketScreeningLiquiditySnapshotUnavailable {
  status: "unavailable";
  reason: string;
}

// Deliberately no "available" variant yet — the actual snapshot shape (which fields, which symbols)
// is a ranking-design decision explicitly deferred past this sprint (Sprint 291 §4, Sprint 294).
// Adding an "available" arm later is additive to this union, not a breaking change to this contract.
export type MarketScreeningLiquiditySnapshotResult = MarketScreeningLiquiditySnapshotUnavailable;

export interface MarketScreeningLiquidityProvider {
  getDailyLiquiditySnapshot(): Promise<MarketScreeningLiquiditySnapshotResult>;
}
