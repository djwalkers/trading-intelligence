import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateSignal } from "@/lib/hermes-execution/signal-engine";
import { getDemoStrategy } from "@/lib/hermes-execution/demo-strategy";
import type { Candle, PaperPosition } from "@/lib/hermes-execution/types";

const FIXTURE_PATH = path.join(process.cwd(), "src", "hermes-execution", "fixtures", "demo-candles.json");

async function loadCandles(): Promise<Candle[]> {
  const text = await fs.readFile(FIXTURE_PATH, "utf-8");
  return JSON.parse(text) as Candle[];
}

describe("evaluateSignal — demo strategy against the fixture candle dataset", () => {
  it("produces NO_ACTION while there isn't enough history for the moving average", async () => {
    const strategy = getDemoStrategy(true);
    if (!strategy) throw new Error("demo strategy must be enabled for this test");
    const candles = await loadCandles();

    for (let i = 0; i < 5; i++) {
      const decision = evaluateSignal(strategy, candles.slice(0, i + 1), null);
      expect(decision.action).toBe("NO_ACTION");
    }
  });

  it("produces ENTER_LONG exactly at the candle where close crosses above the moving average", async () => {
    const strategy = getDemoStrategy(true);
    if (!strategy) throw new Error("demo strategy must be enabled for this test");
    const candles = await loadCandles();

    const decision = evaluateSignal(strategy, candles.slice(0, 6), null); // index 0..5
    expect(decision.action).toBe("ENTER_LONG");
    expect(decision.strategyId).toBe(strategy.strategyId);
    expect(decision.instrument).toBe("DEMO-USD");
    expect(decision.evaluatedValues.close).toBe(103);
  });

  it("produces EXIT_POSITION via take-profit once the close reaches the take-profit level", async () => {
    const strategy = getDemoStrategy(true);
    if (!strategy) throw new Error("demo strategy must be enabled for this test");
    const candles = await loadCandles();

    const openPosition: PaperPosition = {
      positionId: "position-test",
      strategyId: strategy.strategyId,
      strategyVersion: strategy.version,
      sourceType: strategy.sourceType,
      instrument: strategy.instrument,
      side: "BUY",
      quantity: 4,
      entryPrice: 103,
      entryTimestamp: candles[5]?.timestamp ?? "",
      entryOrderId: "order-test",
    };

    // index 6 and 7: holding, no exit yet
    expect(evaluateSignal(strategy, candles.slice(0, 7), openPosition).action).toBe("NO_ACTION");
    expect(evaluateSignal(strategy, candles.slice(0, 8), openPosition).action).toBe("NO_ACTION");

    // index 8: close 105.5 >= take-profit (103 * 1.02 = 105.06)
    const exitDecision = evaluateSignal(strategy, candles.slice(0, 9), openPosition);
    expect(exitDecision.action).toBe("EXIT_POSITION");
    expect(exitDecision.reason).toMatch(/take-profit/i);
  });

  it("does not produce ENTER_SHORT — no entry rule of that kind is supported", async () => {
    const strategy = getDemoStrategy(true);
    if (!strategy) throw new Error("demo strategy must be enabled for this test");
    const candles = await loadCandles();
    for (let i = 4; i < candles.length; i++) {
      const decision = evaluateSignal(strategy, candles.slice(0, i + 1), null);
      expect(decision.action).not.toBe("ENTER_SHORT");
    }
  });
});

describe("evaluateSignal — stop-loss exit", () => {
  it("exits via stop-loss when the close drops far enough below entry", () => {
    const strategy = getDemoStrategy(true);
    if (!strategy) throw new Error("demo strategy must be enabled for this test");

    const candles: Candle[] = [
      { symbol: "DEMO-USD", timestamp: "2026-01-01T00:00:00Z", open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { symbol: "DEMO-USD", timestamp: "2026-01-01T00:01:00Z", open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { symbol: "DEMO-USD", timestamp: "2026-01-01T00:02:00Z", open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { symbol: "DEMO-USD", timestamp: "2026-01-01T00:03:00Z", open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { symbol: "DEMO-USD", timestamp: "2026-01-01T00:04:00Z", open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { symbol: "DEMO-USD", timestamp: "2026-01-01T00:05:00Z", open: 100, high: 100, low: 100, close: 101, volume: 1 },
    ];
    const openPosition: PaperPosition = {
      positionId: "position-test",
      strategyId: strategy.strategyId,
      strategyVersion: strategy.version,
      sourceType: strategy.sourceType,
      instrument: strategy.instrument,
      side: "BUY",
      quantity: 1,
      entryPrice: 103, // stop-loss at 103 * 0.99 = 101.97
      entryTimestamp: "2026-01-01T00:00:00Z",
      entryOrderId: "order-test",
    };
    const decision = evaluateSignal(strategy, candles, openPosition); // close 101 <= 101.97
    expect(decision.action).toBe("EXIT_POSITION");
    expect(decision.reason).toMatch(/stop-loss/i);
  });
});
