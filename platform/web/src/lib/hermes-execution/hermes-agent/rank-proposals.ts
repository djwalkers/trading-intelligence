import type { ValidatedHermesProposal } from "./types";

// Prototype 1.0 — official Hermes Agent decision integration. Pure, deterministic ranking — takes
// an already-validated proposal list (validate-hermes-response.ts's own output) and selects at
// most `maxProposals` of them to actually turn into trade candidates. HOLD proposals are never
// eligible for selection (there is nothing to act on); only BUY/SELL proposals are ranked.

/** Confidence descending, alphabetical instrument ascending as the deterministic tie-break — the
 * same result for the same input every time, never dependent on array/object iteration order. */
export function rankEligibleProposals(proposals: readonly ValidatedHermesProposal[]): ValidatedHermesProposal[] {
  const eligible = proposals.filter((p) => p.action === "BUY" || p.action === "SELL");
  return [...eligible].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.instrument.localeCompare(b.instrument);
  });
}

/** Ranks, then takes the top `maxProposals` — the only place a "how many can we act on this scan"
 * ceiling is enforced for Hermes-originated proposals specifically (separate from, and upstream
 * of, PortfolioRiskEngine's own portfolio-wide limits, which are still enforced later at execution
 * time). */
export function selectTopProposals(proposals: readonly ValidatedHermesProposal[], maxProposals: number): ValidatedHermesProposal[] {
  return rankEligibleProposals(proposals).slice(0, Math.max(0, maxProposals));
}
