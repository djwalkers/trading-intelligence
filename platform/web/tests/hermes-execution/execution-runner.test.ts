import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ExecutionRunner } from "@/lib/hermes-execution/execution-runner";
import { FixtureMarketDataProvider } from "@/lib/hermes-execution/fixture-market-data-provider";
import { LocalPaperBroker } from "@/lib/hermes-execution/paper-broker";
import { InMemoryPaperBrokerStore } from "@/lib/hermes-execution/paper-broker-store";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import { getDemoStrategy } from "@/lib/hermes-execution/demo-strategy";
import type { Candle } from "@/lib/hermes-execution/types";

const FIXTURE_PATH = path.join(process.cwd(), "src", "hermes-execution", "fixtures", "demo-candles.json");

async function loadFixtureCandles(): Promise<Candle[]> {
  return JSON.parse(await fs.readFile(FIXTURE_PATH, "utf-8")) as Candle[];
}

async function buildRunner(candles: Candle[]) {
  const strategy = getDemoStrategy(true);
  if (!strategy) throw new Error("demo strategy must be enabled for this test");

  const broker = await LocalPaperBroker.create(new InMemoryPaperBrokerStore(), 10_000, { resetState: true });
  const auditTrail = new InMemoryAuditTrail();
  const marketData = new FixtureMarketDataProvider(candles);

  const runner = new ExecutionRunner({
    strategies: [strategy],
    marketData,
    broker,
    auditTrail,
    riskConfig: { demoExecutionModeEnabled: true, strategyMaxOpenPositions: 5 },
    executionRunId: "test-run",
  });

  return { runner, broker, auditTrail };
}

describe("ExecutionRunner — full demo fixture replay", () => {
  it("produces exactly one completed trade with the expected realised P/L", async () => {
    const candles = await loadFixtureCandles();
    const { runner, broker } = await buildRunner(candles);

    const summary = await runner.run();

    expect(summary.candlesProcessed).toBe(11);
    expect(summary.entriesOpened).toBe(1);
    expect(summary.exitsClosed).toBe(1);
    expect(summary.riskRejections).toBe(0);

    const trades = broker.getCompletedTrades();
    expect(trades).toHaveLength(1);
    expect(trades[0]?.entryPrice).toBe(103);
    expect(trades[0]?.exitPrice).toBe(105.5);
    expect(trades[0]?.realisedPnl).toBeCloseTo(10, 10);

    expect(broker.getOpenPositions()).toEqual([]);
    expect(broker.getAccount().cashBalance).toBeCloseTo(10_010, 10);
  });

  it("records the full audit trail lifecycle: loaded strategy events plus one of each execution stage", async () => {
    const candles = await loadFixtureCandles();
    const { runner, auditTrail } = await buildRunner(candles);
    await runner.run();

    const events = await auditTrail.getEvents();
    const types = events.map((e) => e.eventType);

    expect(types).toContain("CANDLE_PROCESSED");
    expect(types).toContain("SIGNAL_GENERATED");
    expect(types).toContain("RISK_APPROVED");
    expect(types).toContain("ORDER_SUBMITTED");
    expect(types).toContain("POSITION_OPENED");
    expect(types).toContain("POSITION_CLOSED");
    expect(types).toContain("REALISED_PNL");

    expect(types.filter((t) => t === "POSITION_OPENED")).toHaveLength(1);
    expect(types.filter((t) => t === "POSITION_CLOSED")).toHaveLength(1);
  });
});

describe("ExecutionRunner — duplicate processing guards", () => {
  it("does not reprocess a candle that appears twice in the same feed", async () => {
    const candles = await loadFixtureCandles();
    // Duplicate the entry-triggering candle (index 5) immediately after itself.
    const withDuplicate = [...candles.slice(0, 6), candles[5], ...candles.slice(6)];
    const { runner, broker } = await buildRunner(withDuplicate as Candle[]);

    const summary = await runner.run();

    // Only 11 distinct (instrument, timestamp) keys exist even though 12 candles were fed in.
    expect(summary.candlesProcessed).toBe(11);
    expect(summary.entriesOpened).toBe(1);
    expect(broker.getOpenPositions()).toHaveLength(0);
    expect(broker.getCompletedTrades()).toHaveLength(1);
  });

  it("running the same runner instance a second time creates no additional trades", async () => {
    const candles = await loadFixtureCandles();
    const { runner, broker } = await buildRunner(candles);

    await runner.run();
    expect(broker.getCompletedTrades()).toHaveLength(1);

    const secondSummary = await runner.run();
    expect(secondSummary.candlesProcessed).toBe(0);
    expect(secondSummary.entriesOpened).toBe(0);
    expect(secondSummary.exitsClosed).toBe(0);
    expect(broker.getCompletedTrades()).toHaveLength(1); // still exactly one — not two
  });
});
