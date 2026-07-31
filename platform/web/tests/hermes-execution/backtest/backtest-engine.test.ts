import { describe, expect, it } from "vitest";
import { runBacktestSegment, validateCostConfig } from "@/lib/hermes-execution/backtest/backtest-engine";
import type { IndicatorDefinition, RuleNode, StrategyDefinitionDocument } from "@/lib/hermes-execution/strategy-definitions/strategy-definition";
import type { Candle } from "@/lib/hermes-execution/types";

// Phase 2 — Deterministic Backtesting Foundation. Execution model: long-only, one position per
// instrument, entry/exit at next-bar open, deterministic end-of-data close, fee/slippage cost
// application. No broker/execution/lifecycle import anywhere in this module or its target.

const HOUR_MS = 3_600_000;
const START = Date.parse("2026-01-01T00:00:00.000Z");

function candle(i: number, open: number, close: number = open): Candle {
  return { symbol: "BTC", timestamp: new Date(START + i * HOUR_MS).toISOString(), open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: 10 };
}

const ALWAYS_TRUE_ENTRY: RuleNode = { operator: "GREATER_THAN_OR_EQUAL", left: { kind: "MARKET_FIELD", field: "close" }, right: { kind: "CONSTANT", value: 0 } };
const EMA_INDICATOR: IndicatorDefinition = { id: "ema2", type: "EMA", sourceField: "close", parameters: { period: 2 }, outputAlias: "EMA2" };

function makeDocument(overrides: Partial<StrategyDefinitionDocument> = {}): StrategyDefinitionDocument {
  return {
    schemaVersion: 1,
    strategyId: "TEST_ENGINE",
    strategyVersion: "1.0.0",
    name: "test",
    description: "test",
    status: "APPROVED_FOR_BACKTEST",
    strategyFamily: "OTHER",
    assetClass: "crypto",
    supportedInstruments: ["BTC"],
    timeframe: "1h",
    dataRequirements: ["close"],
    indicators: [EMA_INDICATOR],
    entryRules: ALWAYS_TRUE_ENTRY,
    signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 2 }],
    parameters: {},
    eligibility: { requiresReadOnlyVerified: false, requiresStage4Verified: false, requiresConfiguredUniverse: false, notes: [] },
    backtestPolicy: { minHistoryBars: 1, warmupBars: 0, notes: [] },
    provenance: { author: "test", createdAt: "2026-01-01T00:00:00.000Z", notes: [] },
    limitations: [],
    ...overrides,
  };
}

const NO_COST_CONFIG = { feeBps: 0, slippageBps: 0, startingCapital: 10_000 };

describe("runBacktestSegment — next-bar execution", () => {
  it("an entry signal detected at bar i executes at bar i+1's OPEN, never bar i's own price", () => {
    // Entry condition is true from bar 0 onward (always-true rule) — the very first legitimate
    // signal bar is 0, so the entry must execute at bar 1's open, never bar 0's.
    const candles = [candle(0, 100), candle(1, 150), candle(2, 200), candle(3, 250)];
    const document = makeDocument();
    const result = runBacktestSegment(document, candles, NO_COST_CONFIG);
    expect(result.trades[0]!.entryBarIndex).toBe(1);
    expect(result.trades[0]!.entryPriceRaw).toBe(150); // bar 1's OPEN, not bar 0's close/open (100) or bar 1's close (undefined here, open===close)
  });

  it("a signal exit detected at bar i executes at bar i+1's OPEN", () => {
    const candles = [candle(0, 100), candle(1, 150), candle(2, 200), candle(3, 250), candle(4, 300)];
    const document = makeDocument({ signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 1 }] });
    const result = runBacktestSegment(document, candles, NO_COST_CONFIG);
    // Entry executes at bar 1. barsHeld reaches 1 at bar 2 (evaluated at bar 2), so the exit
    // executes at bar 3's open — never bar 2's.
    expect(result.trades[0]!.entryBarIndex).toBe(1);
    expect(result.trades[0]!.exitBarIndex).toBe(3);
    expect(result.trades[0]!.exitPriceRaw).toBe(250);
  });
});

describe("runBacktestSegment — one position per instrument, no pyramiding", () => {
  it("never opens a second position while one is already open, even though the entry rule is true every bar", () => {
    const candles = Array.from({ length: 10 }, (_, i) => candle(i, 100 + i * 10));
    const document = makeDocument({ signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 100 }] }); // never exits within this dataset
    const result = runBacktestSegment(document, candles, NO_COST_CONFIG);
    expect(result.trades).toHaveLength(1); // exactly one, resolved only by end-of-data
  });

  it("a new entry can only be actioned again after the previous position has fully closed", () => {
    const candles = Array.from({ length: 8 }, (_, i) => candle(i, 100 + i * 5));
    const document = makeDocument({ signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 1 }] });
    const result = runBacktestSegment(document, candles, NO_COST_CONFIG);
    expect(result.trades.length).toBeGreaterThan(1);
    for (let i = 1; i < result.trades.length; i++) {
      expect(result.trades[i]!.entryBarIndex).toBeGreaterThan(result.trades[i - 1]!.exitBarIndex);
    }
  });
});

describe("runBacktestSegment — deterministic end-of-data close policy", () => {
  it("closes a still-open position at the LAST bar's own close price, reason END_OF_DATA", () => {
    const candles = [candle(0, 100), candle(1, 100), candle(2, 100), candle(3, 100, 123.45)];
    const document = makeDocument({ signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 1000 }] }); // never signals an exit
    const result = runBacktestSegment(document, candles, NO_COST_CONFIG);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.exitReason).toBe("END_OF_DATA");
    expect(result.trades[0]!.exitBarIndex).toBe(3);
    expect(result.trades[0]!.exitPriceRaw).toBe(123.45); // the LAST bar's CLOSE, not its open
  });

  it("an entry signal on the very last bar is never actioned — there is no next bar to execute at", () => {
    // Entry becomes true ONLY on the last bar (close >= 101; every earlier bar is 50).
    const trueOnlyOnLastBar: RuleNode = { operator: "GREATER_THAN_OR_EQUAL", left: { kind: "MARKET_FIELD", field: "close" }, right: { kind: "CONSTANT", value: 101 } };
    const candles = [candle(0, 50), candle(1, 50), candle(2, 200)];
    const document = makeDocument({ entryRules: trueOnlyOnLastBar });
    const result = runBacktestSegment(document, candles, NO_COST_CONFIG);
    expect(result.trades).toHaveLength(0);
  });
});

describe("runBacktestSegment — fee and slippage cost application", () => {
  it("applies fee and slippage on BOTH entry and exit, and reports gross/net/fees/slippage consistently (netPnl = grossPnl - fees - slippageCost)", () => {
    const candles = [candle(0, 100), candle(1, 100), candle(2, 100), candle(3, 100)];
    const document = makeDocument({ signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 1 }] });
    const config = { feeBps: 10, slippageBps: 20, startingCapital: 10_000 }; // 0.10% fee, 0.20% slippage
    const result = runBacktestSegment(document, candles, config);
    const trade = result.trades[0]!;

    expect(trade.entryPriceExecuted).toBeCloseTo(trade.entryPriceRaw * 1.002, 6); // pays MORE on entry
    expect(trade.exitPriceExecuted).toBeCloseTo(trade.exitPriceRaw * 0.998, 6); // receives LESS on exit
    expect(trade.feesPaid).toBeGreaterThan(0);
    expect(trade.slippageCost).toBeGreaterThan(0);
    expect(trade.netPnl).toBeCloseTo(trade.grossPnl - trade.feesPaid - trade.slippageCost, 6);
  });

  it("zero fee/slippage config produces netPnl exactly equal to grossPnl", () => {
    const candles = [candle(0, 100), candle(1, 110), candle(2, 120), candle(3, 130)];
    const document = makeDocument({ signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 1 }] });
    const result = runBacktestSegment(document, candles, NO_COST_CONFIG);
    const trade = result.trades[0]!;
    expect(trade.netPnl).toBeCloseTo(trade.grossPnl, 9);
    expect(trade.feesPaid).toBe(0);
    expect(trade.slippageCost).toBe(0);
  });

  it("summed netPnl across all trades exactly reconciles startingCapital to endingCapital", () => {
    const candles = Array.from({ length: 12 }, (_, i) => candle(i, 100 + (i % 4) * 5));
    const document = makeDocument({ signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 1 }] });
    const config = { feeBps: 5, slippageBps: 5, startingCapital: 5_000 };
    const result = runBacktestSegment(document, candles, config);
    const summedNet = result.trades.reduce((sum, t) => sum + t.netPnl, 0);
    expect(result.endingCapital).toBeCloseTo(config.startingCapital + summedNet, 6);
    expect(result.netPnl).toBeCloseTo(summedNet, 9);
  });
});

describe("validateCostConfig", () => {
  it("accepts zero and positive finite values", () => {
    expect(validateCostConfig({ feeBps: 0, slippageBps: 0 }).ok).toBe(true);
    expect(validateCostConfig({ feeBps: 10, slippageBps: 25.5 }).ok).toBe(true);
  });

  it("rejects a negative feeBps", () => {
    expect(validateCostConfig({ feeBps: -1, slippageBps: 0 }).ok).toBe(false);
  });

  it("rejects a negative slippageBps", () => {
    expect(validateCostConfig({ feeBps: 0, slippageBps: -0.5 }).ok).toBe(false);
  });

  it("rejects a non-finite value", () => {
    expect(validateCostConfig({ feeBps: Number.NaN, slippageBps: 0 }).ok).toBe(false);
    expect(validateCostConfig({ feeBps: 0, slippageBps: Number.POSITIVE_INFINITY }).ok).toBe(false);
  });
});

describe("runBacktestSegment — cross-operator semantics via a real EMA cross", () => {
  it("CROSSES_ABOVE fires exactly once, on the bar the fast EMA first exceeds the slow EMA — never before, never repeatedly while it stays above", () => {
    const fast: IndicatorDefinition = { id: "fast", type: "EMA", sourceField: "close", parameters: { period: 2 }, outputAlias: "FAST" };
    const slow: IndicatorDefinition = { id: "slow", type: "EMA", sourceField: "close", parameters: { period: 5 }, outputAlias: "SLOW" };
    const crossRule: RuleNode = { operator: "CROSSES_ABOVE", left: { kind: "INDICATOR_ALIAS", alias: "FAST" }, right: { kind: "INDICATOR_ALIAS", alias: "SLOW" } };
    // A declining-then-rising price series so the fast EMA starts below the slow EMA and later
    // crosses above it exactly once.
    const prices = [100, 90, 80, 70, 60, 70, 90, 110, 130, 150, 150, 150];
    const candles = prices.map((p, i) => candle(i, p));
    const document = makeDocument({ indicators: [fast, slow], entryRules: crossRule, signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 1000 }] });
    const result = runBacktestSegment(document, candles, NO_COST_CONFIG);
    expect(result.trades).toHaveLength(1); // one position opened, held to end-of-data — never re-entered on a later bar merely because FAST stayed above SLOW
  });
});

describe("runBacktestSegment — MAX_BARS_HELD timing is exact, no off-by-one", () => {
  it("with maxBars=N, the exit signal is detected exactly N bars after entry and executes one bar later (N+1 bars after entry), never sooner", () => {
    const candles = Array.from({ length: 10 }, (_, i) => candle(i, 100 + i * 5));
    const document = makeDocument({ signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 3 }] });
    const result = runBacktestSegment(document, candles, NO_COST_CONFIG);
    const trade = result.trades[0]!;
    expect(trade.entryBarIndex).toBe(1); // always-true entry rule fires from bar 0, executes at bar 1
    // barsHeldSoFar reaches 3 when (evalBar - entryBar) >= 3, i.e. at evalBar 4 -> executes at bar 5.
    expect(trade.exitBarIndex).toBe(5);
    expect(trade.exitBarIndex - trade.entryBarIndex).toBe(4); // N + 1, consistent with every other signal type's own next-bar execution delay
    expect(trade.exitReason).toBe("MAX_BARS_HELD");
  });
});

describe("runBacktestSegment — capital, sizing and cost safety (pre-commit review)", () => {
  it("entry notional PLUS fee never exceeds available cash — no implicit leverage", () => {
    const candles = Array.from({ length: 5 }, (_, i) => candle(i, 100 + i));
    const document = makeDocument({ signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 1000 }] });
    const config = { feeBps: 250, slippageBps: 0, startingCapital: 10_000 }; // 2.5% fee — large enough to matter
    const result = runBacktestSegment(document, candles, config);
    const trade = result.trades[0]!;
    // feesPaid on the record includes BOTH entry and exit fees; isolate just the entry fee's own
    // contribution by recomputing it the same way the engine does.
    const entryFee = trade.entryPriceExecuted * trade.quantity * (config.feeBps / 10_000);
    const entryCommitted = trade.entryPriceExecuted * trade.quantity + entryFee;
    expect(entryCommitted).toBeLessThanOrEqual(config.startingCapital + 1e-9);
  });

  it("cash never goes negative at any point across a run with meaningful fees", () => {
    const candles = Array.from({ length: 20 }, (_, i) => candle(i, 100 + (i % 5) * 10));
    const document = makeDocument({ signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 1 }] });
    const config = { feeBps: 500, slippageBps: 200, startingCapital: 1_000 }; // 5% fee, 2% slippage — deliberately large
    const result = runBacktestSegment(document, candles, config);
    expect(result.endingCapital).toBeGreaterThanOrEqual(0);
    // Every individual trade's own implied entry commitment must also never have exceeded what was
    // available immediately beforehand.
    let cash = config.startingCapital;
    for (const trade of result.trades) {
      const entryFee = trade.entryPriceExecuted * trade.quantity * (config.feeBps / 10_000);
      expect(trade.entryPriceExecuted * trade.quantity + entryFee).toBeLessThanOrEqual(cash + 1e-6);
      cash += trade.netPnl;
    }
  });

  it("a very high but valid slippage/fee config never produces a negative or non-finite quantity or execution price", () => {
    const candles = Array.from({ length: 5 }, (_, i) => candle(i, 100 + i));
    const document = makeDocument({ signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 1000 }] });
    const config = { feeBps: 5_000, slippageBps: 9_999, startingCapital: 10_000 }; // 50% fee, 99.99% slippage — extreme but valid
    const result = runBacktestSegment(document, candles, config);
    for (const trade of result.trades) {
      expect(Number.isFinite(trade.quantity)).toBe(true);
      expect(trade.quantity).toBeGreaterThan(0);
      expect(Number.isFinite(trade.entryPriceExecuted)).toBe(true);
      expect(trade.entryPriceExecuted).toBeGreaterThan(0);
      expect(Number.isFinite(trade.exitPriceExecuted)).toBe(true);
      expect(trade.exitPriceExecuted).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("validateCostConfig — slippage upper bound (pre-commit review)", () => {
  it("rejects slippageBps at or above 10,000 (100%) — would make a sell execute at a zero or negative price", () => {
    expect(validateCostConfig({ feeBps: 0, slippageBps: 10_000 }).ok).toBe(false);
    expect(validateCostConfig({ feeBps: 0, slippageBps: 15_000 }).ok).toBe(false);
  });

  it("accepts slippageBps just below 10,000", () => {
    expect(validateCostConfig({ feeBps: 0, slippageBps: 9_999 }).ok).toBe(true);
  });
});

describe("runBacktestSegment — marked-to-market max drawdown (pre-commit review)", () => {
  it("captures an intra-trade drawdown that fully recovers by the time the position closes — a closed-trade-only calculation would report zero here", () => {
    // Enter at bar 1 (open=100), price collapses to 10 mid-trade (bar 3), then fully recovers and
    // exceeds the entry price by the time MAX_BARS_HELD closes it. A closed-trade-only drawdown
    // metric would see only "entered at 100, exited above 100" — a net winner, zero drawdown. The
    // TRUE mark-to-market equity curve must show the deep intra-trade dip.
    const candles = [
      candle(0, 100),
      candle(1, 100), // entry executes here (open=100)
      candle(2, 100, 10), // closes at 10 — deep unrealised loss while still open
      candle(3, 10, 10),
      candle(4, 10, 200), // recovers and closes well above entry
      candle(5, 200, 200),
    ];
    const document = makeDocument({ signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 3 }] });
    const result = runBacktestSegment(document, candles, NO_COST_CONFIG);
    expect(result.trades[0]!.netPnl).toBeGreaterThan(0); // the CLOSED trade is a net winner
    expect(result.maxDrawdown).toBeGreaterThan(0.5); // yet the mark-to-market curve shows a huge interim drawdown
  });

  it("is zero when the equity curve never declines from its own running peak, including while flat between trades", () => {
    const candles = Array.from({ length: 6 }, (_, i) => candle(i, 100 + i * 10)); // monotonically rising
    const document = makeDocument({ signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 1000 }] });
    const result = runBacktestSegment(document, candles, NO_COST_CONFIG);
    expect(result.maxDrawdown).toBe(0);
  });
});

describe("runBacktestSegment — win rate and profit factor are both computed on NET P&L (pre-commit review)", () => {
  it("a trade with positive gross P&L but negative net P&L (fees exceed the gross gain) counts as a LOSER, not a winner", () => {
    const candles = [candle(0, 100), candle(1, 100), candle(2, 100.5), candle(3, 100.5)]; // tiny gross gain
    const document = makeDocument({ signalExitRules: [{ kind: "MAX_BARS_HELD", maxBars: 1 }] });
    const config = { feeBps: 500, slippageBps: 0, startingCapital: 10_000 }; // 5% fee per leg — dwarfs the tiny gross gain
    const result = runBacktestSegment(document, candles, config);
    const trade = result.trades[0]!;
    expect(trade.grossPnl).toBeGreaterThan(0);
    expect(trade.netPnl).toBeLessThan(0);
    expect(result.winRate).toBe(0); // net-based: this trade does NOT count as a win
  });
});
