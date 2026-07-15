// Sprint 294 §7 — more than a boolean, since "observe without trading" (Shadow) must be a distinct,
// reversible state from "trade with it" (Staged/Full). Sprint 295 wires only the "off" path — every
// other stage is a named placeholder, not yet implemented (see resolve-market-screening-shortlist.ts).
export type MarketScreeningRolloutStage = "off" | "shadow" | "staged" | "full";

export const MARKET_SCREENING_ROLLOUT_STAGES: readonly MarketScreeningRolloutStage[] = [
  "off",
  "shadow",
  "staged",
  "full",
];
