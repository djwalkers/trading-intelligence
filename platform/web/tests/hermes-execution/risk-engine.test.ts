import { describe, expect, it } from "vitest";
import { evaluateRisk, type RiskEngineConfig } from "@/lib/hermes-execution/risk-engine";
import { getDemoStrategy } from "@/lib/hermes-execution/demo-strategy";
import type { Account, OrderRequest, PaperPosition } from "@/lib/hermes-execution/types";

const strategy = getDemoStrategy(true)!;
const account: Account = { cashBalance: 10_000, startingCashBalance: 10_000 };
const config: RiskEngineConfig = { demoExecutionModeEnabled: true, maxOpenPositions: 5 };

function makeOrder(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    strategyId: strategy.strategyId,
    strategyVersion: strategy.version,
    sourceType: strategy.sourceType,
    instrument: strategy.instrument,
    side: "BUY",
    quantity: 4,
    price: 103,
    timestamp: "2026-01-01T00:05:00Z",
    takeProfitPercent: 2,
    stopLossPercent: 1,
    ...overrides,
  };
}

describe("evaluateRisk", () => {
  it("approves a well-formed order with no conflicts", () => {
    const decision = evaluateRisk(strategy, makeOrder(), account, [], config);
    expect(decision.decision).toBe("APPROVED");
  });

  it("rejects when a duplicate position already exists for the same strategy + instrument", () => {
    const existingPosition: PaperPosition = {
      positionId: "position-1",
      strategyId: strategy.strategyId,
      strategyVersion: strategy.version,
      sourceType: strategy.sourceType,
      instrument: strategy.instrument,
      side: "BUY",
      quantity: 4,
      entryPrice: 100,
      entryTimestamp: "2026-01-01T00:00:00Z",
      entryOrderId: "order-0",
    };
    const decision = evaluateRisk(strategy, makeOrder(), account, [existingPosition], config);
    expect(decision.decision).toBe("REJECTED");
    if (decision.decision === "REJECTED") {
      expect(decision.reasons.some((r) => /already has an open position/i.test(r))).toBe(true);
    }
  });

  it("rejects a DEMO_ONLY strategy when demo mode is disabled", () => {
    const decision = evaluateRisk(strategy, makeOrder(), account, [], { ...config, demoExecutionModeEnabled: false });
    expect(decision.decision).toBe("REJECTED");
    if (decision.decision === "REJECTED") {
      expect(decision.reasons.some((r) => /not permitted unless DEMO_EXECUTION_MODE/i.test(r))).toBe(true);
    }
  });

  it("rejects a non-positive quantity", () => {
    const decision = evaluateRisk(strategy, makeOrder({ quantity: 0 }), account, [], config);
    expect(decision.decision).toBe("REJECTED");
  });

  it("rejects when the order value exceeds available cash", () => {
    const poorAccount: Account = { cashBalance: 100, startingCashBalance: 100 };
    const decision = evaluateRisk(strategy, makeOrder(), poorAccount, [], config);
    expect(decision.decision).toBe("REJECTED");
    if (decision.decision === "REJECTED") {
      expect(decision.reasons.some((r) => /exceeds available cash/i.test(r))).toBe(true);
    }
  });

  it("rejects when the order value exceeds the strategy's max position value", () => {
    const decision = evaluateRisk(strategy, makeOrder({ quantity: 100 }), account, [], config); // 100*103=10300 > 500
    expect(decision.decision).toBe("REJECTED");
    if (decision.decision === "REJECTED") {
      expect(decision.reasons.some((r) => /max position value/i.test(r))).toBe(true);
    }
  });

  it("rejects when the maximum number of open positions is already reached", () => {
    const fullPositions: PaperPosition[] = Array.from({ length: 5 }, (_, i) => ({
      positionId: `position-${i}`,
      strategyId: `OTHER-${i}`,
      strategyVersion: 1,
      sourceType: "DEMO_ONLY",
      instrument: "OTHER-USD",
      side: "BUY",
      quantity: 1,
      entryPrice: 1,
      entryTimestamp: "2026-01-01T00:00:00Z",
      entryOrderId: `order-${i}`,
    }));
    const decision = evaluateRisk(strategy, makeOrder(), account, fullPositions, config);
    expect(decision.decision).toBe("REJECTED");
    if (decision.decision === "REJECTED") {
      expect(decision.reasons.some((r) => /maximum of 5/i.test(r))).toBe(true);
    }
  });

  it("rejects an invalid take-profit/stop-loss percentage", () => {
    const decision = evaluateRisk(strategy, makeOrder({ takeProfitPercent: -5 }), account, [], config);
    expect(decision.decision).toBe("REJECTED");
  });

  it("rejects a disabled strategy", () => {
    const decision = evaluateRisk({ ...strategy, enabled: false }, makeOrder(), account, [], config);
    expect(decision.decision).toBe("REJECTED");
  });
});
