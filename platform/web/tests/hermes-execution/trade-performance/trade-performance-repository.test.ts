import { describe, expect, it, vi } from "vitest";
import {
  InMemoryTradePerformanceRepository,
  SupabaseTradePerformanceRepository,
  TradePerformancePersistenceError,
  fromRow,
  toUpsertRow,
  type TradePerformanceRow,
} from "@/lib/hermes-execution/trade-performance/trade-performance-repository";
import type { TradePerformanceInput } from "@/lib/hermes-execution/trade-performance/types";

// Phase 4 — Trade Performance Engine. Mocks the Supabase client's own chainable query builder,
// the same lightweight-fake convention analysis-repository.test.ts / trade-candidate-repository.test.ts
// already established for this codebase.

function createQueryBuilder(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> & { then: PromiseLike<unknown>["then"] } = {
    select: vi.fn(() => builder),
    upsert: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    gte: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    single: vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

function makeFakeClient(result: { data: unknown; error: unknown }) {
  const builder = createQueryBuilder(result);
  const from = vi.fn(() => builder);
  return { client: { from } as never, builder, from };
}

const USER_ID = "user-1";

const BASE_INPUT: TradePerformanceInput = {
  tradeId: "trade-lifecycle-1",
  analysisRunId: "analysis-run-1",
  candidateId: "candidate-1",
  strategyId: "DEMO-0001",
  strategyVersion: 1,
  instrument: "BTC",
  side: "BUY",
  entryTime: "2026-01-01T00:00:00.000Z",
  entryPrice: 100,
  exitTime: "2026-01-01T01:00:00.000Z",
  exitPrice: 106,
  holdingTimeMs: 3_600_000,
  grossPnl: 60,
  fees: 0,
  netPnl: 60,
  returnPercent: 6,
  riskMultiple: 1.2,
  maxFavourableExcursion: 80,
  maxAdverseExcursion: -10,
  peakProfit: 80,
  maximumDrawdown: 20,
  winLoss: "WIN",
  exitReason: "market-decision-sell",
};

const SAMPLE_ROW: TradePerformanceRow = {
  id: "performance-1",
  user_id: USER_ID,
  created_at: "2026-01-01T01:00:00.000Z",
  updated_at: "2026-01-01T01:00:00.000Z",
  trade_id: "trade-lifecycle-1",
  analysis_run_id: "analysis-run-1",
  candidate_id: "candidate-1",
  strategy_id: "DEMO-0001",
  strategy_version: 1,
  instrument: "BTC",
  side: "BUY",
  entry_time: "2026-01-01T00:00:00.000Z",
  entry_price: "100",
  exit_time: "2026-01-01T01:00:00.000Z",
  exit_price: "106",
  holding_time_ms: "3600000",
  gross_pnl: "60",
  fees: "0",
  net_pnl: "60",
  return_percent: "6",
  risk_multiple: "1.2",
  max_favourable_excursion: "80",
  max_adverse_excursion: "-10",
  peak_profit: "80",
  maximum_drawdown: "20",
  win_loss: "WIN",
  exit_reason: "market-decision-sell",
};

describe("toUpsertRow / fromRow", () => {
  it("stamps the given userId onto the row", () => {
    const row = toUpsertRow(BASE_INPUT, USER_ID);
    expect(row.user_id).toBe(USER_ID);
    expect(row.trade_id).toBe("trade-lifecycle-1");
  });

  it("round-trips a row back into a TradePerformanceRecord with numeric fields coerced and null risk_multiple preserved as undefined", () => {
    const record = fromRow({ ...SAMPLE_ROW, risk_multiple: null });
    expect(record.netPnl).toBe(60);
    expect(record.riskMultiple).toBeUndefined();
  });
});

describe("SupabaseTradePerformanceRepository", () => {
  it("upsert() writes with onConflict user_id,trade_id — the idempotency/de-duplication guarantee", async () => {
    const { client, builder } = makeFakeClient({ data: SAMPLE_ROW, error: null });
    const repository = new SupabaseTradePerformanceRepository(client, USER_ID);

    await repository.upsert(BASE_INPUT);

    expect(builder.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: USER_ID, trade_id: "trade-lifecycle-1" }),
      { onConflict: "user_id,trade_id" },
    );
  });

  it("list() and getByTradeId() always scope by the constructed userId", async () => {
    const { client: listClient, builder: listBuilder } = makeFakeClient({ data: [SAMPLE_ROW], error: null });
    await new SupabaseTradePerformanceRepository(listClient, USER_ID).list({ strategyId: "DEMO-0001" });
    expect(listBuilder.eq).toHaveBeenCalledWith("user_id", USER_ID);
    expect(listBuilder.eq).toHaveBeenCalledWith("strategy_id", "DEMO-0001");

    const { client: getClient, builder: getBuilder } = makeFakeClient({ data: SAMPLE_ROW, error: null });
    await new SupabaseTradePerformanceRepository(getClient, USER_ID).getByTradeId("trade-lifecycle-1");
    expect(getBuilder.eq).toHaveBeenCalledWith("user_id", USER_ID);
    expect(getBuilder.eq).toHaveBeenCalledWith("trade_id", "trade-lifecycle-1");
  });

  it("throws TradePerformancePersistenceError (never a raw Supabase error) when the query errors", async () => {
    const { client } = makeFakeClient({ data: null, error: { message: "permission denied", code: "42501" } });
    const repository = new SupabaseTradePerformanceRepository(client, USER_ID);
    await expect(repository.upsert(BASE_INPUT)).rejects.toBeInstanceOf(TradePerformancePersistenceError);
  });
});

describe("InMemoryTradePerformanceRepository", () => {
  it("upsert() updates the existing row (same id, preserved createdAt) rather than creating a duplicate for the same trade_id", async () => {
    const repository = new InMemoryTradePerformanceRepository();
    const first = await repository.upsert(BASE_INPUT);
    const second = await repository.upsert({ ...BASE_INPUT, netPnl: 999 });

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.netPnl).toBe(999);
    expect(await repository.list()).toHaveLength(1);
  });

  it("getByTradeId() finds a record by its trade_id, not its own row id", async () => {
    const repository = new InMemoryTradePerformanceRepository();
    await repository.upsert(BASE_INPUT);
    const found = await repository.getByTradeId("trade-lifecycle-1");
    expect(found?.tradeId).toBe("trade-lifecycle-1");
  });
});
