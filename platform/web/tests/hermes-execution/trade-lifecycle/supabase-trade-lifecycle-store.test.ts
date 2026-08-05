import { describe, expect, it, vi } from "vitest";
import {
  SupabaseTradeLifecycleStore,
  TradeLifecycleRecordCorruptionError,
  TradeLifecyclePersistenceError,
  fromRow,
  toRow,
  type TradeLifecycleRecordRow,
} from "@/lib/hermes-execution/trade-lifecycle/supabase-trade-lifecycle-store";
import { TradeLifecycleUniqueConstraintViolationError } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-store";
import type { TradeLifecycleRecord } from "@/lib/hermes-execution/trade-lifecycle/types";

// Restart-Resilient Autonomy Phase — Phase 2 (Durable trade lifecycle persistence). Same
// lightweight fake-Supabase-client convention trade-candidate-repository.test.ts already
// establishes — no live Supabase project to test against.

function createQueryBuilder(result: { data: unknown; error: unknown; count?: number }) {
  const builder: Record<string, unknown> & { then: PromiseLike<unknown>["then"] } = {
    select: vi.fn(() => builder),
    insert: vi.fn(() => builder),
    update: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    in: vi.fn(() => builder),
    is: vi.fn(() => builder),
    gte: vi.fn(() => builder),
    lt: vi.fn(() => builder),
    lte: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

function makeFakeClient(result: { data: unknown; error: unknown; count?: number }) {
  const builder = createQueryBuilder(result);
  const from = vi.fn(() => builder);
  return { client: { from } as never, builder, from };
}

/** Egress-containment fix — for store methods that issue MORE THAN ONE sequential Supabase query
 * (e.g. countConfirmedEntriesForUtcDay's corruption-check query followed by its count query): each
 * successive `.from()` call gets its OWN builder/result, taken from `results` in order, rather than
 * every call sharing one builder/result the way single-query methods' tests can. */
function makeSequencedFakeClient(results: Array<{ data: unknown; error: unknown; count?: number }>) {
  const builders = results.map((result) => createQueryBuilder(result));
  let callIndex = 0;
  const from = vi.fn(() => {
    const builder = builders[callIndex] ?? builders[builders.length - 1]!;
    callIndex += 1;
    return builder;
  });
  return { client: { from } as never, builders, from };
}

const USER_ID = "user-1";

function makeRecord(overrides: Partial<TradeLifecycleRecord> = {}): TradeLifecycleRecord {
  return {
    id: "lifecycle-1",
    brokerProvider: "etoro-demo",
    strategyId: "DEMO-0001",
    strategyVersion: 1,
    symbol: "BTC",
    side: "BUY",
    quantity: 10,
    sizingMode: "NOTIONAL",
    decision: "BUY",
    confidence: 0.8,
    decisionReasons: ["seed"],
    status: "OPEN",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    openedAt: "2026-01-01T00:00:00.000Z",
    entryPrice: 64_948.33,
    stopLoss: 64_000,
    takeProfit: 66_000,
    brokerPositionId: "3568040809",
    brokerOrderId: "369015901",
    ...overrides,
  };
}

function makeRow(overrides: Partial<TradeLifecycleRecordRow> = {}): TradeLifecycleRecordRow {
  return {
    id: "lifecycle-1",
    user_id: USER_ID,
    candidate_id: null,
    strategy_id: "DEMO-0001",
    strategy_version: 1,
    instrument: "BTC",
    broker_provider: "etoro-demo",
    broker_position_id: "3568040809",
    broker_order_id: "369015901",
    side: "BUY",
    sizing_mode: "NOTIONAL",
    quantity: "10",
    status: "OPEN",
    entry_price: "64948.33",
    stop_loss: "64000",
    take_profit: "66000",
    opened_at: "2026-01-01T00:00:00.000Z",
    closed_at: null,
    exit_price: null,
    exit_reason: null,
    realised_pnl: null,
    detail: { decision: "BUY", confidence: 0.8, decisionReasons: ["seed"] },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("toRow / fromRow — round trip", () => {
  it("round-trips a record through toRow -> fromRow with numeric/detail fields intact", () => {
    const record = makeRecord();
    const row = { ...toRow(record, USER_ID), created_at: record.createdAt, updated_at: record.updatedAt };
    const restored = fromRow(row as TradeLifecycleRecordRow);

    expect(restored.id).toBe(record.id);
    expect(restored.brokerPositionId).toBe("3568040809");
    expect(restored.sizingMode).toBe("NOTIONAL");
    expect(restored.stopLoss).toBe(64_000);
    expect(restored.takeProfit).toBe(66_000);
    expect(restored.quantity).toBe(10);
    expect(restored.decision).toBe("BUY");
    expect(restored.confidence).toBe(0.8);
  });

  it("preserves genuinely undefined stopLoss/takeProfit for an adopted orphaned position (never coerced to 0)", () => {
    const record = makeRecord({ stopLoss: undefined, takeProfit: undefined, candidateId: undefined });
    const row = { ...toRow(record, USER_ID), created_at: record.createdAt, updated_at: record.updatedAt };
    const restored = fromRow(row as TradeLifecycleRecordRow);
    expect(restored.stopLoss).toBeUndefined();
    expect(restored.takeProfit).toBeUndefined();
    expect(restored.candidateId).toBeUndefined();
  });
});

describe("fromRow — fails closed on corrupted/incomplete rows", () => {
  it("throws for an unrecognised sizing_mode", () => {
    expect(() => fromRow(makeRow({ sizing_mode: "units" }))).toThrow(); // lowercase — not a recognised OrderSizingMode
  });

  it("throws for an unrecognised side", () => {
    expect(() => fromRow(makeRow({ side: "LONG" }))).toThrow(TradeLifecycleRecordCorruptionError);
  });

  it("throws for an unrecognised status", () => {
    expect(() => fromRow(makeRow({ status: "SOMETHING_ELSE" }))).toThrow(TradeLifecycleRecordCorruptionError);
  });

  it("throws when detail.decision is missing", () => {
    expect(() => fromRow(makeRow({ detail: { confidence: 0.8, decisionReasons: [] } }))).toThrow(TradeLifecycleRecordCorruptionError);
  });

  it("throws when detail.confidence is missing or not a number", () => {
    expect(() => fromRow(makeRow({ detail: { decision: "BUY", decisionReasons: [] } }))).toThrow(TradeLifecycleRecordCorruptionError);
  });

  it("throws when detail.decisionReasons is not an array", () => {
    expect(() => fromRow(makeRow({ detail: { decision: "BUY", confidence: 0.8 } }))).toThrow(TradeLifecycleRecordCorruptionError);
  });

  it("throws when quantity is not a finite number", () => {
    expect(() => fromRow(makeRow({ quantity: "not-a-number" }))).toThrow(TradeLifecycleRecordCorruptionError);
  });
});

describe("SupabaseTradeLifecycleStore — user scoping and persistence", () => {
  it("create() stamps the constructed userId onto the inserted row", async () => {
    const { client, builder, from } = makeFakeClient({ data: null, error: null });
    const store = new SupabaseTradeLifecycleStore(client, USER_ID);

    await store.create(makeRecord());

    expect(from).toHaveBeenCalledWith("trade_lifecycle_records");
    expect(builder.insert).toHaveBeenCalledWith(expect.objectContaining({ user_id: USER_ID, id: "lifecycle-1" }));
  });

  it("getById() scopes by both id and userId, returning null when nothing matches", async () => {
    const { client, builder } = makeFakeClient({ data: null, error: null });
    const store = new SupabaseTradeLifecycleStore(client, USER_ID);

    const result = await store.getById("lifecycle-1");

    expect(builder.eq).toHaveBeenCalledWith("id", "lifecycle-1");
    expect(builder.eq).toHaveBeenCalledWith("user_id", USER_ID);
    expect(result).toBeNull();
  });

  it("getById() returns the parsed record when a row matches", async () => {
    const { client } = makeFakeClient({ data: makeRow(), error: null });
    const store = new SupabaseTradeLifecycleStore(client, USER_ID);

    const result = await store.getById("lifecycle-1");
    expect(result?.id).toBe("lifecycle-1");
    expect(result?.brokerPositionId).toBe("3568040809");
  });

  it("listOpen() filters by status in (OPEN, CLOSE_REQUESTED) scoped to the userId", async () => {
    const { client, builder } = makeFakeClient({ data: [makeRow()], error: null });
    const store = new SupabaseTradeLifecycleStore(client, USER_ID);

    const results = await store.listOpen();

    expect(builder.eq).toHaveBeenCalledWith("user_id", USER_ID);
    expect(builder.in).toHaveBeenCalledWith("status", ["OPEN", "CLOSE_REQUESTED"]);
    expect(results).toHaveLength(1);
  });

  it("listClosed() filters by status = CLOSED scoped to the userId", async () => {
    const { client, builder } = makeFakeClient({ data: [makeRow({ status: "CLOSED" })], error: null });
    const store = new SupabaseTradeLifecycleStore(client, USER_ID);

    await store.listClosed();

    expect(builder.eq).toHaveBeenCalledWith("status", "CLOSED");
  });

  // Missing-financial-data fix. Realised P/L aggregation (GET /api/hermes/portfolio) must be able
  // to count unreconciled closures separately from confirmed-closed ones — never conflating the two.
  it("listUnreconciled() filters by status = CLOSED_UNRECONCILED scoped to the userId", async () => {
    const { client, builder } = makeFakeClient({ data: [makeRow({ status: "CLOSED_UNRECONCILED" })], error: null });
    const store = new SupabaseTradeLifecycleStore(client, USER_ID);

    const results = await store.listUnreconciled();

    expect(builder.eq).toHaveBeenCalledWith("user_id", USER_ID);
    expect(builder.eq).toHaveBeenCalledWith("status", "CLOSED_UNRECONCILED");
    expect(results).toHaveLength(1);
  });

  it("update() throws when no row was updated (unknown record, fails closed rather than silently no-op-ing)", async () => {
    const { client } = makeFakeClient({ data: null, error: null, count: 0 });
    const store = new SupabaseTradeLifecycleStore(client, USER_ID);

    await expect(store.update(makeRecord())).rejects.toThrow(/unknown trade lifecycle record/);
  });

  it("throws TradeLifecyclePersistenceError when the underlying query errors", async () => {
    const { client } = makeFakeClient({ data: null, error: { message: "connection reset", code: "08006" } });
    const store = new SupabaseTradeLifecycleStore(client, USER_ID);

    await expect(store.create(makeRecord())).rejects.toThrow(TradeLifecyclePersistenceError);
  });

  // Restart-Resilient Autonomy Phase — reconciliation hardening. Postgres's own unique_violation
  // SQLSTATE (23505) — the code either of migration 0026's two partial unique indexes surfaces as
  // — must translate to the SAME TradeLifecycleUniqueConstraintViolationError the in-memory store
  // throws for its own equivalent check, so position-reconciliation.ts can react to it identically
  // regardless of which store implementation is in use.
  it("translates a Postgres unique_violation (23505) into TradeLifecycleUniqueConstraintViolationError on create()", async () => {
    const { client } = makeFakeClient({
      data: null,
      error: { message: 'duplicate key value violates unique constraint "trade_lifecycle_records_active_broker_position_uidx"', code: "23505" },
    });
    const store = new SupabaseTradeLifecycleStore(client, USER_ID);

    await expect(store.create(makeRecord())).rejects.toThrow(TradeLifecycleUniqueConstraintViolationError);
  });

  it("translates a Postgres unique_violation (23505) into TradeLifecycleUniqueConstraintViolationError on update() too", async () => {
    const { client } = makeFakeClient({
      data: null,
      error: { message: 'duplicate key value violates unique constraint "trade_lifecycle_records_active_strategy_instrument_uidx"', code: "23505" },
      count: 0,
    });
    const store = new SupabaseTradeLifecycleStore(client, USER_ID);

    await expect(store.update(makeRecord())).rejects.toThrow(TradeLifecycleUniqueConstraintViolationError);
  });

  it("a non-23505 error code still throws the generic TradeLifecyclePersistenceError, never mistaken for a uniqueness violation", async () => {
    const { client } = makeFakeClient({ data: null, error: { message: "permission denied", code: "42501" } });
    const store = new SupabaseTradeLifecycleStore(client, USER_ID);

    await expect(store.create(makeRecord())).rejects.toThrow(TradeLifecyclePersistenceError);
    await expect(store.create(makeRecord())).rejects.not.toThrow(TradeLifecycleUniqueConstraintViolationError);
  });
});

describe("toRow / fromRow — CLOSED_UNRECONCILED (reconciliation hardening)", () => {
  it("round-trips a CLOSED_UNRECONCILED record with null exit_price/realised_pnl intact", () => {
    const record = makeRecord({
      status: "CLOSED_UNRECONCILED",
      closedAt: "2026-01-02T00:00:00.000Z",
      exitReason: "reconciled-broker-position-absent",
      exitPrice: undefined,
      realisedPnl: undefined,
    });
    const row = { ...toRow(record, USER_ID), created_at: record.createdAt, updated_at: record.updatedAt };
    expect(row.status).toBe("CLOSED_UNRECONCILED");
    expect(row.exit_price).toBeNull();
    expect(row.realised_pnl).toBeNull();

    const restored = fromRow(row);
    expect(restored.status).toBe("CLOSED_UNRECONCILED");
    expect(restored.exitPrice).toBeUndefined();
    expect(restored.realisedPnl).toBeUndefined();
    expect(restored.closedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(restored.exitReason).toBe("reconciled-broker-position-absent");
  });
});

// Egress-containment fix (production incident: Supabase egress ~800% over the Free-plan quota,
// traced to full-table select("*") calls — JSONB `detail` blob, full OHLCV candle arrays included —
// running unconditionally on every runtime cycle). Every method below must filter server-side rather
// than downloading the whole table and filtering client-side — asserted here via the exact
// eq/in/gte/lt/lte/select arguments the fake query builder recorded, never by inspecting row counts
// alone (a mock always returns exactly what it's told to, regardless of whether the store applied a
// bounded filter — the filter *arguments* are the only real evidence of boundedness).
describe("SupabaseTradeLifecycleStore — egress-containment bounded queries", () => {
  describe("countConfirmedEntriesForUtcDay", () => {
    const SCOPE = { strategyId: "DEMO-0001", startInclusive: "2026-01-05T00:00:00.000Z", endExclusive: "2026-01-06T00:00:00.000Z" };

    it("performs a count-only (head: true) query, never downloading matching rows", async () => {
      const { client, builders } = makeSequencedFakeClient([
        { data: [], error: null }, // corruption-check query — none found
        { data: null, error: null, count: 3 }, // the actual count query
      ]);
      const store = new SupabaseTradeLifecycleStore(client, USER_ID);

      const count = await store.countConfirmedEntriesForUtcDay(SCOPE);

      expect(count).toBe(3);
      const countQueryBuilder = builders[1]!;
      expect(countQueryBuilder.select).toHaveBeenCalledWith("id", { count: "exact", head: true });
      expect(countQueryBuilder.eq).toHaveBeenCalledWith("user_id", USER_ID);
      expect(countQueryBuilder.eq).toHaveBeenCalledWith("strategy_id", SCOPE.strategyId);
      expect(countQueryBuilder.gte).toHaveBeenCalledWith("opened_at", SCOPE.startInclusive);
      expect(countQueryBuilder.lt).toHaveBeenCalledWith("opened_at", SCOPE.endExclusive);
    });

    it("never selects '*' — no JSONB detail blob is ever requested for this operation", async () => {
      const { client, builders } = makeSequencedFakeClient([
        { data: [], error: null },
        { data: null, error: null, count: 0 },
      ]);
      const store = new SupabaseTradeLifecycleStore(client, USER_ID);

      await store.countConfirmedEntriesForUtcDay(SCOPE);

      for (const builder of builders) {
        expect(builder.select).not.toHaveBeenCalledWith("*");
      }
    });

    it("bounds the fail-closed corruption guard to a handful of ids (limit 5), scoped by strategy + status + null opened_at", async () => {
      const { client, builders } = makeSequencedFakeClient([
        { data: [], error: null },
        { data: null, error: null, count: 0 },
      ]);
      const store = new SupabaseTradeLifecycleStore(client, USER_ID);

      await store.countConfirmedEntriesForUtcDay(SCOPE);

      const corruptionQueryBuilder = builders[0]!;
      expect(corruptionQueryBuilder.select).toHaveBeenCalledWith("id");
      expect(corruptionQueryBuilder.eq).toHaveBeenCalledWith("strategy_id", SCOPE.strategyId);
      expect(corruptionQueryBuilder.in).toHaveBeenCalledWith(
        "status",
        expect.arrayContaining(["OPEN", "CLOSE_REQUESTED", "CLOSED", "CLOSE_FAILED", "CLOSED_UNRECONCILED"]),
      );
      expect(corruptionQueryBuilder.is).toHaveBeenCalledWith("opened_at", null);
      expect(corruptionQueryBuilder.limit).toHaveBeenCalledWith(5);
    });

    it("fails closed (throws) when a record proves it reached OPEN but has no opened_at, without ever downloading the full table", async () => {
      const { client } = makeSequencedFakeClient([{ data: [{ id: "lifecycle-corrupt-1" }], error: null }]);
      const store = new SupabaseTradeLifecycleStore(client, USER_ID);

      await expect(store.countConfirmedEntriesForUtcDay(SCOPE)).rejects.toThrow(TradeLifecycleRecordCorruptionError);
    });

    it("propagates a persistence error from the count query", async () => {
      const { client } = makeSequencedFakeClient([
        { data: [], error: null },
        { data: null, error: { message: "connection reset", code: "08006" } },
      ]);
      const store = new SupabaseTradeLifecycleStore(client, USER_ID);

      await expect(store.countConfirmedEntriesForUtcDay(SCOPE)).rejects.toThrow(TradeLifecyclePersistenceError);
    });
  });

  describe("listActiveLifecycleRecords", () => {
    it("filters by user_id + strategy_id + instrument + status IN — never the whole table", async () => {
      const { client, builder } = makeFakeClient({ data: [makeRow({ status: "OPEN" })], error: null });
      const store = new SupabaseTradeLifecycleStore(client, USER_ID);

      const results = await store.listActiveLifecycleRecords({
        strategyId: "DEMO-0001",
        instrument: "BTC",
        statuses: ["OPEN", "CLOSE_REQUESTED", "CLOSE_FAILED", "EXECUTION_RECONCILIATION_REQUIRED"],
      });

      expect(builder.eq).toHaveBeenCalledWith("user_id", USER_ID);
      expect(builder.eq).toHaveBeenCalledWith("strategy_id", "DEMO-0001");
      expect(builder.eq).toHaveBeenCalledWith("instrument", "BTC");
      expect(builder.in).toHaveBeenCalledWith("status", ["OPEN", "CLOSE_REQUESTED", "CLOSE_FAILED", "EXECUTION_RECONCILIATION_REQUIRED"]);
      expect(results).toHaveLength(1);
    });
  });

  describe("listRecoverableLifecycleRecords", () => {
    it("filters by user_id + strategy_id + instrument + status IN + updated_at <= updatedBefore", async () => {
      const { client, builder } = makeFakeClient({ data: [makeRow({ status: "APPROVED" })], error: null });
      const store = new SupabaseTradeLifecycleStore(client, USER_ID);

      await store.listRecoverableLifecycleRecords({
        strategyId: "DEMO-0001",
        instrument: "BTC",
        statuses: ["DECISION_CREATED", "APPROVED", "EXECUTION_SUBMITTED", "EXECUTION_RECONCILIATION_REQUIRED"],
        updatedBefore: "2026-01-05T00:00:00.000Z",
      });

      expect(builder.eq).toHaveBeenCalledWith("strategy_id", "DEMO-0001");
      expect(builder.eq).toHaveBeenCalledWith("instrument", "BTC");
      expect(builder.in).toHaveBeenCalledWith("status", ["DECISION_CREATED", "APPROVED", "EXECUTION_SUBMITTED", "EXECUTION_RECONCILIATION_REQUIRED"]);
      expect(builder.lte).toHaveBeenCalledWith("updated_at", "2026-01-05T00:00:00.000Z");
    });
  });

  describe("findLifecycleRecordsByBrokerPositionId", () => {
    it("filters by user_id + broker_position_id — never the whole table", async () => {
      const { client, builder } = makeFakeClient({ data: [makeRow()], error: null });
      const store = new SupabaseTradeLifecycleStore(client, USER_ID);

      const results = await store.findLifecycleRecordsByBrokerPositionId("3568040809");

      expect(builder.eq).toHaveBeenCalledWith("user_id", USER_ID);
      expect(builder.eq).toHaveBeenCalledWith("broker_position_id", "3568040809");
      expect(results).toHaveLength(1);
    });
  });

  describe("sumRealisedPnlForClosedTrades", () => {
    it("selects only realised_pnl (never '*' / the JSONB detail blob) and sums across CLOSED rows", async () => {
      const { client, builder } = makeFakeClient({
        data: [{ realised_pnl: "120.5" }, { realised_pnl: 79.5 }],
        error: null,
      });
      const store = new SupabaseTradeLifecycleStore(client, USER_ID);

      const result = await store.sumRealisedPnlForClosedTrades();

      expect(builder.select).toHaveBeenCalledWith("realised_pnl");
      expect(builder.select).not.toHaveBeenCalledWith("*");
      expect(builder.eq).toHaveBeenCalledWith("status", "CLOSED");
      expect(result).toEqual({ realisedPnl: 200, realisedTradeCount: 2 });
    });

    it("never fabricates a figure for a CLOSED row unexpectedly missing realised_pnl", async () => {
      const { client } = makeFakeClient({ data: [{ realised_pnl: 100 }, { realised_pnl: null }], error: null });
      const store = new SupabaseTradeLifecycleStore(client, USER_ID);

      const result = await store.sumRealisedPnlForClosedTrades();

      expect(result).toEqual({ realisedPnl: 100, realisedTradeCount: 1 });
    });
  });

  describe("countUnreconciledClosedTrades", () => {
    it("performs a count-only (head: true) query filtered to CLOSED_UNRECONCILED — no rows transferred", async () => {
      const { client, builder } = makeFakeClient({ data: null, error: null, count: 2 });
      const store = new SupabaseTradeLifecycleStore(client, USER_ID);

      const count = await store.countUnreconciledClosedTrades();

      expect(count).toBe(2);
      expect(builder.select).toHaveBeenCalledWith("id", { count: "exact", head: true });
      expect(builder.eq).toHaveBeenCalledWith("status", "CLOSED_UNRECONCILED");
    });
  });
});
