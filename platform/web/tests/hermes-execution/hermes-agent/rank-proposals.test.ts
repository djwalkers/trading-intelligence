import { describe, expect, it } from "vitest";
import { rankEligibleProposals, selectTopProposals } from "@/lib/hermes-execution/hermes-agent/rank-proposals";
import type { ValidatedHermesProposal } from "@/lib/hermes-execution/hermes-agent/types";

function makeProposal(overrides: Partial<ValidatedHermesProposal>): ValidatedHermesProposal {
  return {
    instrument: "BTC",
    action: "BUY",
    confidence: 0.5,
    reasoning: ["ok"],
    suggestedStopLossPercent: undefined,
    suggestedTakeProfitPercent: undefined,
    ...overrides,
  };
}

describe("rankEligibleProposals", () => {
  it("sorts by confidence descending", () => {
    const proposals = [
      makeProposal({ instrument: "BTC", confidence: 0.5 }),
      makeProposal({ instrument: "ETH", confidence: 0.9 }),
      makeProposal({ instrument: "SOL", confidence: 0.7 }),
    ];
    expect(rankEligibleProposals(proposals).map((p) => p.instrument)).toEqual(["ETH", "SOL", "BTC"]);
  });

  it("breaks exact confidence ties alphabetically by instrument, deterministically", () => {
    const proposals = [
      makeProposal({ instrument: "NVDA", confidence: 0.8 }),
      makeProposal({ instrument: "AAPL", confidence: 0.8 }),
      makeProposal({ instrument: "MSFT", confidence: 0.8 }),
    ];
    // Run twice — the result must be identical regardless of input array order or iteration.
    expect(rankEligibleProposals(proposals).map((p) => p.instrument)).toEqual(["AAPL", "MSFT", "NVDA"]);
    expect(rankEligibleProposals([...proposals].reverse()).map((p) => p.instrument)).toEqual(["AAPL", "MSFT", "NVDA"]);
  });

  it("excludes HOLD proposals from ranking — nothing to act on", () => {
    const proposals = [makeProposal({ instrument: "BTC", action: "HOLD", confidence: 0.99 }), makeProposal({ instrument: "ETH", confidence: 0.5 })];
    expect(rankEligibleProposals(proposals).map((p) => p.instrument)).toEqual(["ETH"]);
  });

  it("never mutates the input array", () => {
    const proposals = [makeProposal({ instrument: "BTC", confidence: 0.5 }), makeProposal({ instrument: "ETH", confidence: 0.9 })];
    const original = [...proposals];
    rankEligibleProposals(proposals);
    expect(proposals).toEqual(original);
  });
});

describe("selectTopProposals", () => {
  it("respects the configured maximum, regardless of how many eligible proposals exist", () => {
    const proposals = [
      makeProposal({ instrument: "BTC", confidence: 0.9 }),
      makeProposal({ instrument: "ETH", confidence: 0.8 }),
      makeProposal({ instrument: "SOL", confidence: 0.7 }),
    ];
    expect(selectTopProposals(proposals, 2).map((p) => p.instrument)).toEqual(["BTC", "ETH"]);
  });

  it("returns an empty array when maxProposals is 0", () => {
    const proposals = [makeProposal({ instrument: "BTC", confidence: 0.9 })];
    expect(selectTopProposals(proposals, 0)).toEqual([]);
  });

  it("returns every eligible proposal when fewer exist than the maximum", () => {
    const proposals = [makeProposal({ instrument: "BTC", confidence: 0.9 })];
    expect(selectTopProposals(proposals, 5)).toHaveLength(1);
  });
});
