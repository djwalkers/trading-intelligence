import { describe, expect, it, vi } from "vitest";
import {
  AnalysisPersistenceError,
  SupabaseAnalysisRepository,
  categorizeAnalysisPersistenceError,
  fromRunRow,
  toEventRow,
  toRunRow,
  type MarketAnalysisRunRow,
} from "@/lib/hermes-execution/analysis/analysis-repository";
import type { AnalysisRunInput } from "@/lib/hermes-execution/analysis/types";

// Phase 2B — Decision Intelligence: Historical Analysis Persistence. Mocks the Supabase client's
// own chainable query builder (from().select().eq()...) with a lightweight fake rather than a real
// Supabase instance — no live project is linked to this repo, matching persistence/
// supabase-paper-trade-store.ts's own established testing approach for this kind of file.

function createQueryBuilder(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> & { then: PromiseLike<unknown>["then"] } = {
    select: vi.fn(() => builder),
    insert: vi.fn(() => builder),
    update: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    gte: vi.fn(() => builder),
    lte: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    single: vi.fn(() => Promise.resolve(result)),
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

const BASE_INPUT: AnalysisRunInput = {
  runtimeMode: "demo",
  brokerProvider: "etoro-demo",
  marketProvider: "live",
  instrument: "BTC",
  timeframe: "1h",
  strategyId: "DEMO-0001",
  strategyVersion: 1,
  decision: "HOLD",
  executedTrade: false,
  validationOk: true,
  fallbackUsed: false,
  runtimeDurationMs: 100,
};

const SAMPLE_ROW: MarketAnalysisRunRow = {
  id: "run-1",
  user_id: USER_ID,
  created_at: "2026-01-01T00:00:00.000Z",
  runtime_mode: "demo",
  broker_provider: "etoro-demo",
  market_provider: "live",
  instrument: "BTC",
  timeframe: "1h",
  strategy_id: "DEMO-0001",
  strategy_version: 1,
  current_bid: "50095.5",
  current_ask: 50105,
  current_mid: null,
  last_close: null,
  ema20: "50080.25",
  ema50: 50020,
  rsi14: null,
  atr14: null,
  trend: "Bullish",
  confidence: "0.75",
  decision: "BUY",
  decision_reason: "EMA20 above EMA50",
  executed_trade: true,
  trade_id: "etoro-position-1",
  validation_ok: true,
  fallback_used: false,
  candle_count: 200,
  data_age_seconds: "30.5",
  runtime_duration_ms: "250",
  error_code: null,
  error_message: null,
  metadata: { trigger: "scheduled" },
};

describe("toRunRow / fromRunRow — row mapping", () => {
  it("maps a domain AnalysisRunInput into the snake_case DB row shape", () => {
    const row = toRunRow({ ...BASE_INPUT, ema20: 50_080, confidence: 0.6 }, USER_ID);
    expect(row.user_id).toBe(USER_ID);
    expect(row.ema20).toBe(50_080);
    expect(row.confidence).toBe(0.6);
    expect(row.runtime_mode).toBe("demo");
  });

  it("maps optional/undefined fields to null, never leaving them undefined in the row", () => {
    const row = toRunRow(BASE_INPUT, USER_ID);
    expect(row.ema20).toBeNull();
    expect(row.trade_id).toBeNull();
    expect(row.error_code).toBeNull();
    expect(row.metadata).toEqual({});
  });

  it("coerces numeric-string columns (as Postgres numeric often round-trips) back to real numbers", () => {
    const run = fromRunRow(SAMPLE_ROW);
    expect(run.currentBid).toBe(50_095.5);
    expect(run.currentAsk).toBe(50_105);
    expect(run.ema20).toBeCloseTo(50_080.25, 5);
    expect(run.confidence).toBe(0.75);
    expect(run.dataAgeSeconds).toBeCloseTo(30.5, 5);
    expect(run.runtimeDurationMs).toBe(250);
  });

  it("maps null DB columns to undefined domain fields, never to 0 or NaN", () => {
    const run = fromRunRow(SAMPLE_ROW);
    expect(run.currentMid).toBeUndefined();
    expect(run.lastClose).toBeUndefined();
    expect(run.rsi14).toBeUndefined();
    expect(run.errorCode).toBeUndefined();
  });

  it("round-trips id/createdAt/tradeId/metadata verbatim", () => {
    const run = fromRunRow(SAMPLE_ROW);
    expect(run.id).toBe("run-1");
    expect(run.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(run.tradeId).toBe("etoro-position-1");
    expect(run.metadata).toEqual({ trigger: "scheduled" });
  });
});

describe("toEventRow", () => {
  it("stamps the analysis_run_id and maps camelCase to snake_case", () => {
    const row = toEventRow("run-1", {
      timestamp: "2026-01-01T00:00:00.000Z",
      eventType: "DECISION_COMPLETED",
      severity: "info",
      message: "Decision: BUY",
      payload: { action: "BUY" },
    });
    expect(row).toEqual({
      analysis_run_id: "run-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      event_type: "DECISION_COMPLETED",
      severity: "info",
      message: "Decision: BUY",
      payload: { action: "BUY" },
    });
  });

  it("defaults payload to an empty object when omitted", () => {
    const row = toEventRow("run-1", { timestamp: "t", eventType: "ERROR", severity: "error", message: "boom" });
    expect(row.payload).toEqual({});
  });
});

describe("SupabaseAnalysisRepository.saveAnalysis", () => {
  it("inserts a row scoped to the injected userId and returns the new id", async () => {
    const { client, builder, from } = makeFakeClient({ data: { id: "run-42" }, error: null });
    const repository = new SupabaseAnalysisRepository(client, USER_ID);

    const id = await repository.saveAnalysis(BASE_INPUT);

    expect(id).toBe("run-42");
    expect(from).toHaveBeenCalledWith("market_analysis_runs");
    expect(builder.insert).toHaveBeenCalledWith(expect.objectContaining({ user_id: USER_ID, decision: "HOLD" }));
  });

  it("throws an AnalysisPersistenceError (preserving the Postgrest code) on a Supabase error response", async () => {
    const { client } = makeFakeClient({ data: null, error: { message: "insert failed", code: "42501" } });
    const repository = new SupabaseAnalysisRepository(client, USER_ID);
    const error = await repository.saveAnalysis(BASE_INPUT).catch((e) => e);
    expect(error).toBeInstanceOf(AnalysisPersistenceError);
    expect(error.message).toBe("insert failed");
    expect(error.code).toBe("42501");
  });
});

describe("SupabaseAnalysisRepository.saveEvents", () => {
  it("inserts every event, stamped with the given analysisRunId", async () => {
    const { client, builder, from } = makeFakeClient({ data: null, error: null });
    const repository = new SupabaseAnalysisRepository(client, USER_ID);

    await repository.saveEvents("run-1", [
      { timestamp: "t1", eventType: "CYCLE_STARTED", severity: "info", message: "start" },
      { timestamp: "t2", eventType: "DECISION_COMPLETED", severity: "info", message: "done" },
    ]);

    expect(from).toHaveBeenCalledWith("market_analysis_events");
    expect(builder.insert).toHaveBeenCalledWith([
      { analysis_run_id: "run-1", timestamp: "t1", event_type: "CYCLE_STARTED", severity: "info", message: "start", payload: {} },
      { analysis_run_id: "run-1", timestamp: "t2", event_type: "DECISION_COMPLETED", severity: "info", message: "done", payload: {} },
    ]);
  });

  it("inserts a multi-event batch as exactly ONE request — never one Supabase call per event", async () => {
    const { client, builder, from } = makeFakeClient({ data: null, error: null });
    const repository = new SupabaseAnalysisRepository(client, USER_ID);

    await repository.saveEvents("run-1", [
      { timestamp: "t1", eventType: "CYCLE_STARTED", severity: "info", message: "1" },
      { timestamp: "t2", eventType: "MARKET_DATA_FETCHED", severity: "info", message: "2" },
      { timestamp: "t3", eventType: "INDICATORS_CALCULATED", severity: "info", message: "3" },
      { timestamp: "t4", eventType: "DECISION_COMPLETED", severity: "info", message: "4" },
      { timestamp: "t5", eventType: "EXECUTION_SKIPPED", severity: "info", message: "5" },
    ]);

    // Exactly one from()/insert() call regardless of how many events — the array of 5 rows is
    // passed to a single insert() call, not five separate ones.
    expect(from).toHaveBeenCalledTimes(1);
    expect(builder.insert).toHaveBeenCalledTimes(1);
    expect((builder.insert as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toHaveLength(5);
  });

  it("never calls the database for an empty events array", async () => {
    const { client, from } = makeFakeClient({ data: null, error: null });
    const repository = new SupabaseAnalysisRepository(client, USER_ID);
    await repository.saveEvents("run-1", []);
    expect(from).not.toHaveBeenCalled();
  });
});

describe("SupabaseAnalysisRepository.markTradeExecuted", () => {
  it("updates executed_trade/trade_id, scoped by both id and userId", async () => {
    const { client, builder, from } = makeFakeClient({ data: null, error: null });
    const repository = new SupabaseAnalysisRepository(client, USER_ID);

    await repository.markTradeExecuted("run-1", "etoro-position-9");

    expect(from).toHaveBeenCalledWith("market_analysis_runs");
    expect(builder.update).toHaveBeenCalledWith({ executed_trade: true, trade_id: "etoro-position-9" });
    expect(builder.eq).toHaveBeenCalledWith("id", "run-1");
    expect(builder.eq).toHaveBeenCalledWith("user_id", USER_ID);
  });
});

describe("SupabaseAnalysisRepository.getRecentAnalyses", () => {
  it("always scopes by user_id and defaults to the DEFAULT_LIMIT", async () => {
    const { client, builder } = makeFakeClient({ data: [SAMPLE_ROW], error: null });
    const repository = new SupabaseAnalysisRepository(client, USER_ID);

    const runs = await repository.getRecentAnalyses();

    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe("run-1");
    expect(builder.eq).toHaveBeenCalledWith("user_id", USER_ID);
    expect(builder.limit).toHaveBeenCalledWith(100);
  });

  it("applies instrument/decision/strategyId/since/until filters", async () => {
    const { client, builder } = makeFakeClient({ data: [], error: null });
    const repository = new SupabaseAnalysisRepository(client, USER_ID);

    await repository.getRecentAnalyses({
      instrument: "BTC",
      decision: "BUY",
      strategyId: "DEMO-0001",
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-01-02T00:00:00.000Z",
    });

    expect(builder.eq).toHaveBeenCalledWith("instrument", "BTC");
    expect(builder.eq).toHaveBeenCalledWith("decision", "BUY");
    expect(builder.eq).toHaveBeenCalledWith("strategy_id", "DEMO-0001");
    expect(builder.gte).toHaveBeenCalledWith("created_at", "2026-01-01T00:00:00.000Z");
    expect(builder.lte).toHaveBeenCalledWith("created_at", "2026-01-02T00:00:00.000Z");
  });

  it("translates a retention window into a since filter when no explicit since is given", async () => {
    const { client, builder } = makeFakeClient({ data: [], error: null });
    const repository = new SupabaseAnalysisRepository(client, USER_ID);

    await repository.getRecentAnalyses({ retention: "30d" });

    expect(builder.gte).toHaveBeenCalledWith("created_at", expect.any(String));
  });

  it("retention:'all' applies no since filter at all", async () => {
    const { client, builder } = makeFakeClient({ data: [], error: null });
    const repository = new SupabaseAnalysisRepository(client, USER_ID);

    await repository.getRecentAnalyses({ retention: "all" });

    expect(builder.gte).not.toHaveBeenCalled();
  });

  it("caps an explicit limit at MAX_LIMIT (1000)", async () => {
    const { client, builder } = makeFakeClient({ data: [], error: null });
    const repository = new SupabaseAnalysisRepository(client, USER_ID);

    await repository.getRecentAnalyses({ limit: 5_000 });

    expect(builder.limit).toHaveBeenCalledWith(1_000);
  });

  it("throws a plain Error on a Supabase error response", async () => {
    const { client } = makeFakeClient({ data: null, error: { message: "query failed" } });
    const repository = new SupabaseAnalysisRepository(client, USER_ID);
    await expect(repository.getRecentAnalyses()).rejects.toThrow("query failed");
  });
});

describe("SupabaseAnalysisRepository.getStrategyPerformance", () => {
  it("fetches the filtered row set and returns a computed summary", async () => {
    const rows: MarketAnalysisRunRow[] = [
      { ...SAMPLE_ROW, id: "run-1", decision: "BUY" },
      { ...SAMPLE_ROW, id: "run-2", decision: "HOLD", executed_trade: false, trade_id: null },
    ];
    const { client, builder } = makeFakeClient({ data: rows, error: null });
    const repository = new SupabaseAnalysisRepository(client, USER_ID);

    const summary = await repository.getStrategyPerformance();

    expect(summary.totalRuns).toBe(2);
    expect(summary.buyPercent).toBe(50);
    expect(builder.eq).toHaveBeenCalledWith("user_id", USER_ID);
  });
});

describe("categorizeAnalysisPersistenceError", () => {
  it("prefers an AnalysisPersistenceError's own Postgrest code", () => {
    const error = new AnalysisPersistenceError("permission denied", "42501");
    expect(categorizeAnalysisPersistenceError(error)).toBe("42501");
  });

  it("falls back to the error's class name when there's no code", () => {
    expect(categorizeAnalysisPersistenceError(new AnalysisPersistenceError("timeout", undefined))).toBe(
      "AnalysisPersistenceError",
    );
    expect(categorizeAnalysisPersistenceError(new TypeError("boom"))).toBe("TypeError");
  });

  it("falls back to UNKNOWN for a non-Error throw", () => {
    expect(categorizeAnalysisPersistenceError("a plain string")).toBe("UNKNOWN");
    expect(categorizeAnalysisPersistenceError(null)).toBe("UNKNOWN");
  });
});
