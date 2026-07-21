import { describe, expect, it } from "vitest";
import { InMemoryTradeLifecycleStore } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-store";
import type { TradeLifecycleRecord, TradeLifecycleStatus } from "@/lib/hermes-execution/trade-lifecycle/types";
import type { MarketDataSnapshot } from "@/lib/hermes-execution/market-data/market-data-provider";
import type { MarketDecisionContext } from "@/lib/hermes-execution/market-decision-engine";

const MARKET_DATA_SNAPSHOT: MarketDataSnapshot = {
  instrument: "BTC",
  timestamp: "2026-01-01T00:00:00.000Z",
  candles: [],
  bid: 100,
  ask: 100.1,
  spread: 0.1,
  latestPrice: 100.05,
  volume: 10,
};

const INTELLIGENCE_SUMMARY: MarketDecisionContext = {
  instrument: "BTC",
  bid: 100,
  ask: 100.1,
  spread: 0.1,
  midPrice: 100.05,
  timestamp: "2026-01-01T00:00:00.000Z",
  positionOpen: false,
  strategy: { strategyId: "STRAT-0001", version: 1, sourceType: "HERMES_APPROVED" },
  recentCandles: [],
  ema20: 101,
  ema50: 99,
  rsi14: 55,
  atr14: 1,
  volume: 10,
  dailyHigh: 102,
  dailyLow: 98,
  volatility24h: 0.01,
  marketSession: "Crypto Always Open",
  trend: "Bullish",
};

function makeRecord(id: string, status: TradeLifecycleStatus, overrides: Partial<TradeLifecycleRecord> = {}): TradeLifecycleRecord {
  return {
    id,
    strategyId: "STRAT-0001",
    symbol: "BTC",
    side: "BUY",
    quantity: 10,
    decision: "BUY",
    confidence: 0.7,
    decisionReasons: ["EMA20 above EMA50"],
    marketDataSnapshot: MARKET_DATA_SNAPSHOT,
    intelligenceSummary: INTELLIGENCE_SUMMARY,
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("InMemoryTradeLifecycleStore — create/getById", () => {
  it("returns null for an id that was never created", async () => {
    const store = new InMemoryTradeLifecycleStore();
    expect(await store.getById("missing")).toBeNull();
  });

  it("creates and retrieves a record by id", async () => {
    const store = new InMemoryTradeLifecycleStore();
    const record = makeRecord("trade-1", "DECISION_CREATED");
    await store.create(record);
    expect(await store.getById("trade-1")).toEqual(record);
  });

  it("refuses to create a duplicate id", async () => {
    const store = new InMemoryTradeLifecycleStore();
    await store.create(makeRecord("trade-1", "DECISION_CREATED"));
    await expect(store.create(makeRecord("trade-1", "DECISION_CREATED"))).rejects.toThrow(/already exists/);
  });

  it("returned records are copies — mutating one does not affect the store's internal state", async () => {
    const store = new InMemoryTradeLifecycleStore();
    await store.create(makeRecord("trade-1", "DECISION_CREATED"));
    const fetched = await store.getById("trade-1");
    fetched!.status = "CLOSED";
    expect((await store.getById("trade-1"))!.status).toBe("DECISION_CREATED");
  });
});

describe("InMemoryTradeLifecycleStore — update", () => {
  it("updates an existing record to a new status", async () => {
    const store = new InMemoryTradeLifecycleStore();
    await store.create(makeRecord("trade-1", "DECISION_CREATED"));
    await store.update(makeRecord("trade-1", "APPROVED"));
    expect((await store.getById("trade-1"))!.status).toBe("APPROVED");
  });

  it("refuses to update an id that was never created", async () => {
    const store = new InMemoryTradeLifecycleStore();
    await expect(store.update(makeRecord("ghost", "APPROVED"))).rejects.toThrow(/Cannot update unknown/);
  });

  it("preserves fields not part of the update call's own object (full-record replace semantics)", async () => {
    const store = new InMemoryTradeLifecycleStore();
    await store.create(makeRecord("trade-1", "DECISION_CREATED", { confidence: 0.42 }));
    await store.update(makeRecord("trade-1", "APPROVED", { confidence: 0.42 }));
    expect((await store.getById("trade-1"))!.confidence).toBe(0.42);
  });
});

describe("InMemoryTradeLifecycleStore — list/listOpen/listClosed", () => {
  it("list() returns every record regardless of status", async () => {
    const store = new InMemoryTradeLifecycleStore();
    await store.create(makeRecord("a", "DECISION_CREATED"));
    await store.create(makeRecord("b", "OPEN"));
    await store.create(makeRecord("c", "CLOSED"));
    const all = await store.list();
    expect(all.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("listOpen() returns OPEN and CLOSE_REQUESTED records only", async () => {
    const store = new InMemoryTradeLifecycleStore();
    await store.create(makeRecord("a", "DECISION_CREATED"));
    await store.create(makeRecord("b", "OPEN"));
    await store.create(makeRecord("c", "CLOSE_REQUESTED"));
    await store.create(makeRecord("d", "CLOSED"));
    await store.create(makeRecord("e", "RISK_REJECTED"));
    const open = await store.listOpen();
    expect(open.map((r) => r.id).sort()).toEqual(["b", "c"]);
  });

  it("listClosed() returns CLOSED records only", async () => {
    const store = new InMemoryTradeLifecycleStore();
    await store.create(makeRecord("a", "OPEN"));
    await store.create(makeRecord("b", "CLOSED"));
    await store.create(makeRecord("c", "CLOSE_FAILED"));
    const closed = await store.listClosed();
    expect(closed.map((r) => r.id)).toEqual(["b"]);
  });

  it("a record moves from listOpen() to listClosed() once its status becomes CLOSED", async () => {
    const store = new InMemoryTradeLifecycleStore();
    await store.create(makeRecord("a", "OPEN"));
    expect((await store.listOpen()).map((r) => r.id)).toEqual(["a"]);
    expect(await store.listClosed()).toEqual([]);

    await store.update(makeRecord("a", "CLOSED"));
    expect(await store.listOpen()).toEqual([]);
    expect((await store.listClosed()).map((r) => r.id)).toEqual(["a"]);
  });

  it("list()/listOpen()/listClosed() all return empty arrays for an empty store", async () => {
    const store = new InMemoryTradeLifecycleStore();
    expect(await store.list()).toEqual([]);
    expect(await store.listOpen()).toEqual([]);
    expect(await store.listClosed()).toEqual([]);
  });
});
