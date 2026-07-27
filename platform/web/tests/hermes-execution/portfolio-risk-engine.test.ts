import { describe, expect, it } from "vitest";
import { PortfolioRiskEngine, type PortfolioRiskConfig, type PortfolioRiskInput } from "@/lib/hermes-execution/portfolio-risk-engine";
import type { Account, OrderRequest, PaperPosition } from "@/lib/hermes-execution/types";

const CONFIG: PortfolioRiskConfig = {
  portfolioMaxOpenPositions: 3,
  maxDailyTrades: 5,
  maxPortfolioExposure: 5000,
};

function makeAccount(overrides: Partial<Account> = {}): Account {
  return { cashBalance: 1000, startingCashBalance: 1000, ...overrides };
}

function makeOrder(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    strategyId: "STRAT-0001",
    strategyVersion: 1,
    sourceType: "HERMES_APPROVED",
    instrument: "BTC",
    side: "BUY",
    quantity: 5,
    price: 100,
    timestamp: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makePosition(overrides: Partial<PaperPosition> = {}): PaperPosition {
  return {
    positionId: "position-1",
    strategyId: "STRAT-0001",
    strategyVersion: 1,
    sourceType: "HERMES_APPROVED",
    instrument: "ETH",
    side: "BUY",
    quantity: 2,
    entryPrice: 100,
    entryTimestamp: "2026-01-01T00:00:00Z",
    entryOrderId: "order-1",
    ...overrides,
  };
}

function makeInput(overrides: Partial<PortfolioRiskInput> = {}): PortfolioRiskInput {
  return {
    account: makeAccount(),
    openPositions: [],
    dailyTradeCount: 0,
    brokerAvailable: true,
    proposedOrder: makeOrder(),
    config: CONFIG,
    sizingMode: "UNITS",
    ...overrides,
  };
}

describe("PortfolioRiskEngine.evaluate — BUY approved", () => {
  it("permits a BUY order that is within every configured limit", () => {
    const context = PortfolioRiskEngine.evaluate(makeInput());
    expect(context.permitted).toBe(true);
    expect(context.checks.every((c) => c.passed)).toBe(true);
    expect(context.accountEquity).toBe(1000);
    expect(context.portfolioExposure).toBe(0);
  });
});

describe("PortfolioRiskEngine.evaluate — blocked by open position limit", () => {
  it("blocks a BUY once open positions are already at the configured maximum", () => {
    const openPositions = [
      makePosition({ positionId: "p1", instrument: "ETH" }),
      makePosition({ positionId: "p2", instrument: "SOL" }),
      makePosition({ positionId: "p3", instrument: "ADA" }),
    ];
    const context = PortfolioRiskEngine.evaluate(makeInput({ openPositions }));
    expect(context.permitted).toBe(false);
    if (!context.permitted) {
      expect(context.blockedReasons.some((r) => /open position/i.test(r))).toBe(true);
    }
    const check = context.checks.find((c) => c.name === "max-open-positions");
    expect(check?.passed).toBe(false);
  });
});

describe("PortfolioRiskEngine.evaluate — blocked by insufficient cash", () => {
  it("blocks a BUY whose order value exceeds available cash", () => {
    const context = PortfolioRiskEngine.evaluate(
      makeInput({ account: makeAccount({ cashBalance: 50 }), proposedOrder: makeOrder({ quantity: 5, price: 100 }) }),
    );
    expect(context.permitted).toBe(false);
    if (!context.permitted) {
      expect(context.blockedReasons.some((r) => /exceeds available cash/i.test(r))).toBe(true);
    }
    const check = context.checks.find((c) => c.name === "sufficient-cash");
    expect(check?.passed).toBe(false);
  });
});

describe("PortfolioRiskEngine.evaluate — blocked by daily trade limit", () => {
  it("blocks a BUY once today's trade count is already at the configured maximum", () => {
    const context = PortfolioRiskEngine.evaluate(makeInput({ dailyTradeCount: 5 }));
    expect(context.permitted).toBe(false);
    const check = context.checks.find((c) => c.name === "max-daily-trades");
    expect(check?.passed).toBe(false);
  });
});

describe("PortfolioRiskEngine.evaluate — blocked by portfolio exposure limit", () => {
  it("blocks a BUY that would push total exposure over the configured maximum", () => {
    const openPositions = [makePosition({ quantity: 40, entryPrice: 100 })]; // 4000 existing exposure
    const context = PortfolioRiskEngine.evaluate(
      makeInput({ openPositions, proposedOrder: makeOrder({ quantity: 20, price: 100 }) }), // +2000 => 6000 > 5000
    );
    expect(context.permitted).toBe(false);
    const check = context.checks.find((c) => c.name === "max-portfolio-exposure");
    expect(check?.passed).toBe(false);
    expect(context.portfolioExposure).toBe(4000);
  });
});

describe("PortfolioRiskEngine.evaluate — blocked by broker unavailable", () => {
  it("blocks a BUY when the broker is reported unavailable, independent of every other check", () => {
    const context = PortfolioRiskEngine.evaluate(makeInput({ brokerAvailable: false }));
    expect(context.permitted).toBe(false);
    const check = context.checks.find((c) => c.name === "broker-available");
    expect(check?.passed).toBe(false);
  });
});

describe("PortfolioRiskEngine.evaluate — reports every failed check at once", () => {
  it("does not short-circuit: a BUY failing two checks reports both reasons", () => {
    const context = PortfolioRiskEngine.evaluate(
      makeInput({ account: makeAccount({ cashBalance: 0 }), brokerAvailable: false }),
    );
    expect(context.permitted).toBe(false);
    if (!context.permitted) {
      expect(context.blockedReasons.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// Broker Sizing Semantic Fix — the eToro demo broker's `quantity` is an invested notional amount,
// not a BTC/asset unit count (see order-sizing.ts's own OrderSizingMode doc comment). These prove
// PortfolioRiskEngine treats a NOTIONAL order/position as its own quantity, never quantity x price —
// the exact bug this fix addresses: a `quantity: 10` BTC order at ~65,114 was previously assessed as
// an order worth ~651,140 instead of the correct eToro CFD notional of 10.
describe("PortfolioRiskEngine.evaluate — NOTIONAL sizing mode (eToro-style CFD amount)", () => {
  it("computes order notional as exactly `quantity`, ignoring price, for a NOTIONAL order", () => {
    // quantity 10 @ BTC price 65,000 must be assessed as order value 10, not 650,000.
    const context = PortfolioRiskEngine.evaluate(
      makeInput({
        sizingMode: "NOTIONAL",
        account: makeAccount({ cashBalance: 15 }),
        proposedOrder: makeOrder({ quantity: 10, price: 65_000 }),
      }),
    );
    const cashCheck = context.checks.find((c) => c.name === "sufficient-cash");
    expect(cashCheck?.passed).toBe(true);
    expect(cashCheck?.detail).toContain("10.00");
  });

  it("contributes exactly `quantity` (not quantity x entryPrice) to existing portfolio exposure", () => {
    const openPositions = [makePosition({ quantity: 10, entryPrice: 65_000 })];
    const context = PortfolioRiskEngine.evaluate(
      makeInput({ sizingMode: "NOTIONAL", openPositions, proposedOrder: makeOrder({ quantity: 0.01, price: 65_000 }) }),
    );
    expect(context.portfolioExposure).toBe(10);
  });

  it("permits a NOTIONAL BUY once cash and max exposure both comfortably exceed the order's own notional", () => {
    const context = PortfolioRiskEngine.evaluate(
      makeInput({
        sizingMode: "NOTIONAL",
        account: makeAccount({ cashBalance: 100 }),
        config: { ...CONFIG, maxPortfolioExposure: 100 },
        proposedOrder: makeOrder({ quantity: 10, price: 65_000 }),
      }),
    );
    expect(context.permitted).toBe(true);
    expect(context.checks.every((c) => c.passed)).toBe(true);
  });

  it("still rejects a NOTIONAL BUY whose own notional exceeds available cash", () => {
    const context = PortfolioRiskEngine.evaluate(
      makeInput({
        sizingMode: "NOTIONAL",
        account: makeAccount({ cashBalance: 5 }), // order notional is 10 > 5 available
        proposedOrder: makeOrder({ quantity: 10, price: 65_000 }),
      }),
    );
    expect(context.permitted).toBe(false);
    const check = context.checks.find((c) => c.name === "sufficient-cash");
    expect(check?.passed).toBe(false);
  });

  it("still rejects a NOTIONAL BUY whose own notional exceeds the configured maximum portfolio exposure", () => {
    const context = PortfolioRiskEngine.evaluate(
      makeInput({
        sizingMode: "NOTIONAL",
        account: makeAccount({ cashBalance: 1000 }),
        config: { ...CONFIG, maxPortfolioExposure: 5 }, // order notional is 10 > 5 max
        proposedOrder: makeOrder({ quantity: 10, price: 65_000 }),
      }),
    );
    expect(context.permitted).toBe(false);
    const check = context.checks.find((c) => c.name === "max-portfolio-exposure");
    expect(check?.passed).toBe(false);
  });
});

describe("PortfolioRiskEngine.evaluate — UNITS sizing mode still multiplies by price", () => {
  it("computes order notional as quantity x price for a UNITS order", () => {
    // quantity 2 @ price 100 must be assessed as order value 200, matching pre-existing behaviour.
    const context = PortfolioRiskEngine.evaluate(
      makeInput({ sizingMode: "UNITS", proposedOrder: makeOrder({ quantity: 2, price: 100 }) }),
    );
    const cashCheck = context.checks.find((c) => c.name === "sufficient-cash");
    expect(cashCheck?.detail).toContain("200.00");
  });

  it("contributes quantity x entryPrice to existing portfolio exposure", () => {
    const openPositions = [makePosition({ quantity: 2, entryPrice: 100 })];
    const context = PortfolioRiskEngine.evaluate(makeInput({ sizingMode: "UNITS", openPositions }));
    expect(context.portfolioExposure).toBe(200);
  });
});
