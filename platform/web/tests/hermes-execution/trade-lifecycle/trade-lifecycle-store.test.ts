import { describe, expect, it } from "vitest";
import { InMemoryTradeLifecycleStore, TradeLifecycleUniqueConstraintViolationError } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-store";
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
    strategyVersion: 1,
    brokerProvider: "etoro-demo",
    symbol: "BTC",
    side: "BUY",
    quantity: 10,
    sizingMode: "UNITS",
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
    // Distinct instruments: DECISION_CREATED and OPEN are both "active" statuses, and this test's
    // own point is "list() returns everything regardless of status," not strategy+instrument
    // uniqueness — see the dedicated "active-record uniqueness invariants" describe block below
    // for that.
    await store.create(makeRecord("a", "DECISION_CREATED", { symbol: "BTC" }));
    await store.create(makeRecord("b", "OPEN", { symbol: "ETH" }));
    await store.create(makeRecord("c", "CLOSED", { symbol: "BTC" }));
    const all = await store.list();
    expect(all.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("listOpen() returns OPEN and CLOSE_REQUESTED records only", async () => {
    const store = new InMemoryTradeLifecycleStore();
    await store.create(makeRecord("a", "DECISION_CREATED", { symbol: "BTC" }));
    await store.create(makeRecord("b", "OPEN", { symbol: "ETH" }));
    await store.create(makeRecord("c", "CLOSE_REQUESTED", { symbol: "SOL" }));
    await store.create(makeRecord("d", "CLOSED", { symbol: "BTC" }));
    await store.create(makeRecord("e", "RISK_REJECTED", { symbol: "BTC" }));
    const open = await store.listOpen();
    expect(open.map((r) => r.id).sort()).toEqual(["b", "c"]);
  });

  it("listClosed() returns CLOSED records only", async () => {
    const store = new InMemoryTradeLifecycleStore();
    await store.create(makeRecord("a", "OPEN", { symbol: "BTC" }));
    await store.create(makeRecord("b", "CLOSED", { symbol: "BTC" }));
    await store.create(makeRecord("c", "CLOSE_FAILED", { symbol: "ETH" }));
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

  it("listOpen()/listClosed() never include CLOSED_UNRECONCILED — it has no confirmed exit economics", async () => {
    const store = new InMemoryTradeLifecycleStore();
    await store.create(makeRecord("a", "CLOSED_UNRECONCILED"));
    expect(await store.listOpen()).toEqual([]);
    expect(await store.listClosed()).toEqual([]);
    expect((await store.list()).map((r) => r.id)).toEqual(["a"]);
  });

  // Missing-financial-data fix. Realised P/L must never fold an unreconciled closure in as if it
  // were a confirmed $0 trade — but the count of how many were excluded still matters, so
  // listUnreconciled() exists as its own, explicit query rather than a byproduct of list().
  it("listUnreconciled() returns CLOSED_UNRECONCILED records only", async () => {
    const store = new InMemoryTradeLifecycleStore();
    await store.create(makeRecord("a", "OPEN", { symbol: "BTC" }));
    await store.create(makeRecord("b", "CLOSED", { symbol: "ETH" }));
    await store.create(makeRecord("c", "CLOSED_UNRECONCILED", { symbol: "SOL" }));
    await store.create(makeRecord("d", "EXECUTION_ABANDONED", { symbol: "XRP" }));
    const unreconciled = await store.listUnreconciled();
    expect(unreconciled.map((r) => r.id)).toEqual(["c"]);
  });

  it("listUnreconciled() returns an empty array when there are none", async () => {
    const store = new InMemoryTradeLifecycleStore();
    await store.create(makeRecord("a", "CLOSED"));
    expect(await store.listUnreconciled()).toEqual([]);
  });
});

// Restart-Resilient Autonomy Phase — reconciliation hardening. Mirrors migration 0026's own two
// partial unique indexes so dev/tests exercise the exact same invariant Supabase enforces in
// production — see trade-lifecycle-store.ts's own TradeLifecycleUniqueConstraintViolationError doc
// comment.
describe("InMemoryTradeLifecycleStore — active-record uniqueness invariants", () => {
  it("refuses a second active record for the same broker_provider + broker_position_id", async () => {
    const store = new InMemoryTradeLifecycleStore();
    await store.create(makeRecord("a", "OPEN", { brokerPositionId: "555" }));
    await expect(store.create(makeRecord("b", "OPEN", { brokerPositionId: "555" }))).rejects.toThrow(
      TradeLifecycleUniqueConstraintViolationError,
    );
  });

  it("CLOSE_FAILED counts as active for the broker-position invariant too", async () => {
    const store = new InMemoryTradeLifecycleStore();
    await store.create(makeRecord("a", "CLOSE_FAILED", { brokerPositionId: "555" }));
    await expect(store.create(makeRecord("b", "OPEN", { brokerPositionId: "555" }))).rejects.toThrow(
      TradeLifecycleUniqueConstraintViolationError,
    );
  });

  it("allows a second record for the same broker_position_id once the first is CLOSED (terminal, frees the slot)", async () => {
    const store = new InMemoryTradeLifecycleStore();
    await store.create(makeRecord("a", "CLOSED", { brokerPositionId: "555" }));
    await expect(store.create(makeRecord("b", "OPEN", { brokerPositionId: "555" }))).resolves.toBeUndefined();
  });

  it("null broker_position_id never collides with itself (NULLs are never duplicates)", async () => {
    const store = new InMemoryTradeLifecycleStore();
    // Distinct instruments here specifically to isolate the broker-position-id axis from the
    // separate strategy+instrument invariant (covered by its own tests below).
    await store.create(makeRecord("a", "OPEN", { symbol: "BTC" }));
    await expect(store.create(makeRecord("b", "OPEN", { symbol: "ETH" }))).resolves.toBeUndefined();
  });

  it("refuses a second active record for the same strategy_id + instrument", async () => {
    const store = new InMemoryTradeLifecycleStore();
    await store.create(makeRecord("a", "APPROVED"));
    await expect(store.create(makeRecord("b", "DECISION_CREATED"))).rejects.toThrow(TradeLifecycleUniqueConstraintViolationError);
  });

  it("allows a second record for the same strategy+instrument once the first is a terminal outcome (RISK_REJECTED)", async () => {
    const store = new InMemoryTradeLifecycleStore();
    await store.create(makeRecord("a", "RISK_REJECTED"));
    await expect(store.create(makeRecord("b", "DECISION_CREATED"))).resolves.toBeUndefined();
  });

  it("update() enforces the same invariant (a transition INTO the active set can still collide)", async () => {
    const store = new InMemoryTradeLifecycleStore();
    // Distinct instruments so "a" and "b" don't also collide on the separate strategy+instrument
    // invariant — isolates the broker-position-id axis specifically.
    await store.create(makeRecord("a", "OPEN", { symbol: "BTC", brokerPositionId: "555" }));
    await store.create(makeRecord("b", "CLOSE_FAILED", { symbol: "ETH", brokerPositionId: "999" }));
    await expect(store.update(makeRecord("b", "OPEN", { symbol: "ETH", brokerPositionId: "555" }))).rejects.toThrow(
      TradeLifecycleUniqueConstraintViolationError,
    );
  });

  it("update() excludes the record's own prior row from the clash check (a no-op status re-write is never a self-collision)", async () => {
    const store = new InMemoryTradeLifecycleStore();
    await store.create(makeRecord("a", "OPEN", { brokerPositionId: "555" }));
    await expect(store.update(makeRecord("a", "OPEN", { brokerPositionId: "555", confidence: 0.9 }))).resolves.toBeUndefined();
  });
});

// Egress-containment fix. InMemoryTradeLifecycleStore has no egress cost of its own, but its new
// bounded methods must still reproduce the SAME filtering semantics SupabaseTradeLifecycleStore's
// server-side queries express — these tests pin that contract so both implementations stay
// interchangeable for callers (trading-runtime.ts, market-decide.ts, lifecycle-recovery.ts, ...).
describe("InMemoryTradeLifecycleStore — egress-containment bounded methods", () => {
  describe("countConfirmedEntriesForUtcDay", () => {
    it("counts confirmed-OPEN-today entries for the scoped strategy within [startInclusive, endExclusive)", async () => {
      const store = new InMemoryTradeLifecycleStore();
      await store.create(makeRecord("a", "OPEN", { openedAt: "2026-01-05T09:00:00.000Z" }));
      await store.create(makeRecord("b", "CLOSED", { symbol: "ETH", openedAt: "2026-01-04T23:00:00.000Z", closedAt: "2026-01-05T01:00:00.000Z" }));
      await store.create(makeRecord("c", "DECISION_CREATED", { symbol: "SOL", openedAt: undefined }));

      const count = await store.countConfirmedEntriesForUtcDay({
        strategyId: "STRAT-0001",
        startInclusive: "2026-01-05T00:00:00.000Z",
        endExclusive: "2026-01-06T00:00:00.000Z",
      });
      expect(count).toBe(1); // "a" only — "b" opened yesterday, "c" never reached OPEN.
    });

    it("scopes by strategyId — a confirmed-open record for a different strategy never counts", async () => {
      const store = new InMemoryTradeLifecycleStore();
      await store.create(makeRecord("a", "OPEN", { strategyId: "STRAT-OTHER", openedAt: "2026-01-05T09:00:00.000Z" }));

      const count = await store.countConfirmedEntriesForUtcDay({
        strategyId: "STRAT-0001",
        startInclusive: "2026-01-05T00:00:00.000Z",
        endExclusive: "2026-01-06T00:00:00.000Z",
      });
      expect(count).toBe(0);
    });

    it("fails closed for a record whose status proves OPEN but has no openedAt", async () => {
      const store = new InMemoryTradeLifecycleStore();
      // Bypasses create()'s own active-uniqueness clash check via update() semantics is unnecessary
      // here — a single directly-created corrupt row is enough to exercise the guard.
      await store.create(makeRecord("a", "CLOSED", { openedAt: undefined, closedAt: "2026-01-05T10:00:00.000Z", exitPrice: 100, exitReason: "tp", realisedPnl: 5 }));

      await expect(
        store.countConfirmedEntriesForUtcDay({
          strategyId: "STRAT-0001",
          startInclusive: "2026-01-05T00:00:00.000Z",
          endExclusive: "2026-01-06T00:00:00.000Z",
        }),
      ).rejects.toThrow(/cannot safely compute/);
    });
  });

  describe("listActiveLifecycleRecords", () => {
    it("returns only records matching strategyId + instrument + one of the given statuses", async () => {
      const store = new InMemoryTradeLifecycleStore();
      await store.create(makeRecord("a", "OPEN", { symbol: "BTC" }));
      await store.create(makeRecord("b", "OPEN", { symbol: "ETH" })); // different instrument
      await store.create(makeRecord("c", "RISK_REJECTED", { symbol: "BTC" })); // not in the requested status set — different strategy+instrument slot anyway (RISK_REJECTED is terminal)

      const results = await store.listActiveLifecycleRecords({
        strategyId: "STRAT-0001",
        instrument: "BTC",
        statuses: ["OPEN", "CLOSE_REQUESTED", "CLOSE_FAILED", "EXECUTION_RECONCILIATION_REQUIRED"],
      });
      expect(results.map((r) => r.id)).toEqual(["a"]);
    });

    it("returns an empty array when nothing matches", async () => {
      const store = new InMemoryTradeLifecycleStore();
      const results = await store.listActiveLifecycleRecords({ strategyId: "STRAT-0001", instrument: "BTC", statuses: ["OPEN"] });
      expect(results).toEqual([]);
    });
  });

  describe("listRecoverableLifecycleRecords", () => {
    it("returns only records matching strategyId + instrument + status + updatedAt at or before updatedBefore", async () => {
      const store = new InMemoryTradeLifecycleStore();
      await store.create(makeRecord("stale", "APPROVED", { updatedAt: "2026-01-05T09:00:00.000Z" }));

      const recoverable = await store.listRecoverableLifecycleRecords({
        strategyId: "STRAT-0001",
        instrument: "BTC",
        statuses: ["DECISION_CREATED", "APPROVED", "EXECUTION_SUBMITTED", "EXECUTION_RECONCILIATION_REQUIRED"],
        updatedBefore: "2026-01-05T09:00:00.000Z", // exactly equal — must be included (matches the original >= threshold semantics)
      });
      expect(recoverable.map((r) => r.id)).toEqual(["stale"]);
    });

    it("excludes a record updated AFTER updatedBefore — not stale enough yet", async () => {
      const store = new InMemoryTradeLifecycleStore();
      await store.create(makeRecord("fresh", "APPROVED", { updatedAt: "2026-01-05T09:00:01.000Z" }));

      const recoverable = await store.listRecoverableLifecycleRecords({
        strategyId: "STRAT-0001",
        instrument: "BTC",
        statuses: ["APPROVED"],
        updatedBefore: "2026-01-05T09:00:00.000Z",
      });
      expect(recoverable).toEqual([]);
    });
  });

  describe("findLifecycleRecordsByBrokerPositionId", () => {
    it("returns every record carrying the given brokerPositionId, regardless of strategy/instrument", async () => {
      const store = new InMemoryTradeLifecycleStore();
      await store.create(makeRecord("a", "OPEN", { symbol: "BTC", brokerPositionId: "555" }));
      await store.create(makeRecord("b", "CLOSED", { symbol: "ETH", brokerPositionId: "999" }));

      const results = await store.findLifecycleRecordsByBrokerPositionId("555");
      expect(results.map((r) => r.id)).toEqual(["a"]);
    });

    it("returns an empty array when no record carries that brokerPositionId", async () => {
      const store = new InMemoryTradeLifecycleStore();
      expect(await store.findLifecycleRecordsByBrokerPositionId("does-not-exist")).toEqual([]);
    });
  });

  describe("sumRealisedPnlForClosedTrades / countUnreconciledClosedTrades", () => {
    it("sums realisedPnl across CLOSED records and counts CLOSED_UNRECONCILED separately", async () => {
      const store = new InMemoryTradeLifecycleStore();
      await store.create(makeRecord("a", "CLOSED", { symbol: "BTC", closedAt: "2026-01-05T10:00:00.000Z", exitPrice: 100, exitReason: "tp", realisedPnl: 40 }));
      await store.create(makeRecord("b", "CLOSED", { symbol: "ETH", closedAt: "2026-01-05T10:00:00.000Z", exitPrice: 100, exitReason: "tp", realisedPnl: 60 }));
      await store.create(makeRecord("c", "CLOSED_UNRECONCILED", { symbol: "SOL", closedAt: "2026-01-05T10:00:00.000Z", exitReason: "reconciled-absent" }));

      expect(await store.sumRealisedPnlForClosedTrades()).toEqual({ realisedPnl: 100, realisedTradeCount: 2 });
      expect(await store.countUnreconciledClosedTrades()).toBe(1);
    });

    it("returns zero/empty for a store with no closed trades", async () => {
      const store = new InMemoryTradeLifecycleStore();
      expect(await store.sumRealisedPnlForClosedTrades()).toEqual({ realisedPnl: 0, realisedTradeCount: 0 });
      expect(await store.countUnreconciledClosedTrades()).toBe(0);
    });
  });
});
