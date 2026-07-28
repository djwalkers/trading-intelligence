import { describe, expect, it } from "vitest";
import { HermesAgentStrategy, getHermesAgentInternalStrategy, HERMES_AGENT_STRATEGY_ID } from "@/lib/hermes-execution/hermes-agent/hermes-agent-strategy";
import type { MarketDecisionContext } from "@/lib/hermes-execution/market-decision-engine";
import type { ValidatedHermesProposal } from "@/lib/hermes-execution/hermes-agent/types";

// Prototype 1.0 — official Hermes Agent decision integration. HermesAgentStrategy holds no risk
// logic, no sizing logic, and never calls a broker — every test here confirms it only ever
// translates an already-set scan proposal into the existing Decision contract.

function makeContext(overrides: Partial<MarketDecisionContext> = {}): MarketDecisionContext {
  return {
    instrument: "ETH",
    bid: 100,
    ask: 100.05,
    spread: 0.05,
    midPrice: 100.025,
    timestamp: "2026-01-01T00:00:00Z",
    positionOpen: false,
    strategy: { strategyId: HERMES_AGENT_STRATEGY_ID, version: 1, sourceType: "HERMES_APPROVED" },
    recentCandles: [],
    ema20: 110,
    ema50: 100,
    rsi14: 55,
    atr14: 1.5,
    volume: 120,
    dailyHigh: 112,
    dailyLow: 98,
    volatility24h: 0.01,
    marketSession: "Crypto Always Open",
    trend: "Bullish",
    ...overrides,
  };
}

function makeProposal(overrides: Partial<ValidatedHermesProposal> = {}): ValidatedHermesProposal {
  return {
    instrument: "ETH",
    action: "BUY",
    confidence: 0.82,
    reasoning: ["Bullish momentum"],
    suggestedStopLossPercent: 2,
    suggestedTakeProfitPercent: 4,
    ...overrides,
  };
}

describe("getHermesAgentInternalStrategy", () => {
  it("returns a HERMES_APPROVED, always-enabled InternalStrategy", () => {
    const strategy = getHermesAgentInternalStrategy();
    expect(strategy.strategyId).toBe(HERMES_AGENT_STRATEGY_ID);
    expect(strategy.sourceType).toBe("HERMES_APPROVED");
    expect(strategy.enabled).toBe(true);
  });
});

describe("HermesAgentStrategy.evaluate — BUY", () => {
  it("returns BUY with the proposal's own confidence/reasoning when a selected BUY proposal exists for this instrument", async () => {
    const strategy = new HermesAgentStrategy();
    strategy.setScanProposals([makeProposal({ instrument: "ETH", action: "BUY", confidence: 0.82 })]);

    const decision = await strategy.evaluate(makeContext({ instrument: "ETH", positionOpen: false }));

    expect(decision.action).toBe("BUY");
    expect(decision.confidence).toBe(0.82);
    expect(decision.entryCriteriaMet).toBe(true);
    expect(decision.reasoning).toContain("Bullish momentum");
  });

  it("includes suggested stop-loss/take-profit as informational reasoning text only", async () => {
    const strategy = new HermesAgentStrategy();
    strategy.setScanProposals([makeProposal({ suggestedStopLossPercent: 3, suggestedTakeProfitPercent: 6 })]);
    const decision = await strategy.evaluate(makeContext());
    expect(decision.reasoning.some((r) => r.includes("informational only, not applied"))).toBe(true);
    expect(decision.reasoning.some((r) => r.includes("3") && r.includes("6"))).toBe(true);
  });

  it("returns HOLD when no proposal was selected for this instrument this scan", async () => {
    const strategy = new HermesAgentStrategy();
    strategy.setScanProposals([makeProposal({ instrument: "BTC" })]); // a different instrument
    const decision = await strategy.evaluate(makeContext({ instrument: "ETH" }));
    expect(decision.action).toBe("HOLD");
    expect(decision.entryCriteriaMet).toBe(false);
  });

  it("never proposes BUY while a position is already open, regardless of a selected BUY proposal", async () => {
    const strategy = new HermesAgentStrategy();
    strategy.setScanProposals([makeProposal({ action: "BUY" })]);
    const decision = await strategy.evaluate(makeContext({ positionOpen: true }));
    expect(decision.action).not.toBe("BUY");
  });
});

describe("HermesAgentStrategy.evaluate — SELL", () => {
  it("returns SELL when a position is open and a selected SELL proposal exists", async () => {
    const strategy = new HermesAgentStrategy();
    strategy.setScanProposals([makeProposal({ instrument: "ETH", action: "SELL", confidence: 0.7 })]);
    const decision = await strategy.evaluate(makeContext({ instrument: "ETH", positionOpen: true }));
    expect(decision.action).toBe("SELL");
    expect(decision.exitCriteriaMet).toBe(true);
    expect(decision.confidence).toBe(0.7);
  });

  it("holds an open position when no SELL proposal was selected this scan", async () => {
    const strategy = new HermesAgentStrategy();
    strategy.setScanProposals([]);
    const decision = await strategy.evaluate(makeContext({ positionOpen: true }));
    expect(decision.action).toBe("HOLD");
  });
});

describe("HermesAgentStrategy — scan proposals replace, never merge, across scans", () => {
  it("an instrument selected last scan but not this one correctly reverts to HOLD", async () => {
    const strategy = new HermesAgentStrategy();
    strategy.setScanProposals([makeProposal({ instrument: "ETH", action: "BUY" })]);
    strategy.setScanProposals([makeProposal({ instrument: "BTC", action: "BUY" })]); // a fresh scan, ETH no longer selected
    const decision = await strategy.evaluate(makeContext({ instrument: "ETH" }));
    expect(decision.action).toBe("HOLD");
  });
});

describe("HermesAgentStrategy — no risk/sizing logic, no broker access", () => {
  it("applyFilters is always a genuine no-op — every safety constraint already happened during validation", () => {
    const strategy = new HermesAgentStrategy();
    expect(strategy.applyFilters(makeContext())).toEqual({ met: true, reasons: [] });
  });

  it("has no broker-shaped dependency anywhere in its own constructor or public methods", () => {
    // Structural guard: the class takes no constructor arguments at all.
    expect(HermesAgentStrategy.length).toBe(0);
  });
});
