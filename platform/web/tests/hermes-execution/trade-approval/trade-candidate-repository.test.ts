import { describe, expect, it, vi } from "vitest";
import {
  InMemoryTradeCandidateRepository,
  SupabaseTradeCandidateRepository,
  TradeCandidatePersistenceError,
  fromRow,
  toInsertRow,
  type TradeCandidateRow,
} from "@/lib/hermes-execution/trade-approval/trade-candidate-repository";
import type { TradeCandidateInput } from "@/lib/hermes-execution/trade-approval/types";

// Phase 3.5 — Trade Review & Approval. Mocks the Supabase client's own chainable query builder,
// same lightweight-fake convention analysis-repository.test.ts already established for this
// codebase (no live Supabase project to test against). The tests below focus specifically on
// PERMISSION: every single method this repository exposes must scope its query by `user_id` —
// that `.eq("user_id", ...)` call, combined with trade_candidates' own RLS policies
// (supabase/migrations/0024_trade_candidates.sql, `auth.uid() = user_id`), is the actual,
// database-enforced boundary that makes one signed-in user unable to read, approve, reject, or
// otherwise touch another user's trade candidates — there is no separate bearer-token or server
// action layer to test here because none exists (see TradeApprovalView.tsx's own doc comment for
// why: this repository is used directly from the browser, exactly like
// SupabaseDecisionHistoryStore/SupabaseAnalysisRepository already are).

function createQueryBuilder(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> & { then: PromiseLike<unknown>["then"] } = {
    select: vi.fn(() => builder),
    insert: vi.fn(() => builder),
    update: vi.fn(() => builder),
    eq: vi.fn(() => builder),
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
const OTHER_USER_ID = "user-2";

const BASE_INPUT: TradeCandidateInput = {
  analysisRunId: "analysis-run-1",
  strategyId: "DEMO-0001",
  strategyVersion: 1,
  instrument: "BTC",
  direction: "BUY",
  confidence: 0.75,
  entryPrice: 100.05,
  stopLoss: 97.5,
  takeProfit: 105,
  riskReward: 2,
  reasoning: ["EMA20 above EMA50"],
  validationNotes: [],
  expiresAt: "2026-01-01T00:20:00.000Z",
  execution: {
    amount: 10,
    marketContext: {
      instrument: "BTC",
      bid: 100,
      ask: 100.05,
      spread: 0.05,
      midPrice: 100.025,
      timestamp: "2026-01-01T00:00:00.000Z",
      positionOpen: false,
      strategy: { strategyId: "DEMO-0001", version: 1, sourceType: "HERMES_APPROVED" },
      recentCandles: [],
      ema20: 110,
      ema50: 100,
      rsi14: 55,
      atr14: 1.5,
      volume: 120,
      dailyHigh: 112,
      dailyLow: 98,
      volatility24h: 0.01,
      marketSession: "Crypto Always Open",
      trend: "Bullish",
    },
    marketDataSnapshot: {
      instrument: "BTC",
      timestamp: "2026-01-01T00:00:00.000Z",
      candles: [],
      bid: 100,
      ask: 100.05,
      spread: 0.05,
      latestPrice: 100.025,
      volume: 120,
    },
  },
};

const SAMPLE_ROW: TradeCandidateRow = {
  id: "candidate-1",
  user_id: USER_ID,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  analysis_run_id: "analysis-run-1",
  strategy_id: "DEMO-0001",
  strategy_version: 1,
  instrument: "BTC",
  direction: "BUY",
  confidence: "0.75",
  entry_price: "100.05",
  stop_loss: "97.5",
  take_profit: "105",
  risk_reward: "2",
  reasoning: ["EMA20 above EMA50"],
  validation_notes: [],
  execution_snapshot: BASE_INPUT.execution as unknown as Record<string, unknown>,
  expires_at: "2026-01-01T00:20:00.000Z",
  status: "PENDING",
  approved_at: null,
  approved_by_user_id: null,
  rejected_at: null,
  rejected_by_user_id: null,
  rejection_reason: null,
  executed_at: null,
  lifecycle_record_id: null,
  broker_order_id: null,
  failure_reason: null,
};

describe("toInsertRow / fromRow", () => {
  it("stamps the given userId onto the insert row and defaults status to PENDING", () => {
    const row = toInsertRow(BASE_INPUT, USER_ID);
    expect(row.user_id).toBe(USER_ID);
    expect(row.status).toBe("PENDING");
  });

  it("round-trips a row back into a TradeCandidate with numeric fields coerced", () => {
    const candidate = fromRow(SAMPLE_ROW);
    expect(candidate.id).toBe("candidate-1");
    expect(candidate.confidence).toBe(0.75);
    expect(candidate.entryPrice).toBe(100.05);
    expect(candidate.status).toBe("PENDING");
  });
});

describe("SupabaseTradeCandidateRepository — permission (user_id scoping)", () => {
  it("create() stamps the constructed userId onto the inserted row, never a caller-supplied one", async () => {
    const { client, builder, from } = makeFakeClient({ data: SAMPLE_ROW, error: null });
    const repository = new SupabaseTradeCandidateRepository(client, USER_ID);

    await repository.create(BASE_INPUT);

    expect(from).toHaveBeenCalledWith("trade_candidates");
    expect(builder.insert).toHaveBeenCalledWith(expect.objectContaining({ user_id: USER_ID, status: "PENDING" }));
  });

  it("getById() scopes by both id and the constructed userId — never returns another user's row", async () => {
    const { client, builder } = makeFakeClient({ data: SAMPLE_ROW, error: null });
    const repository = new SupabaseTradeCandidateRepository(client, USER_ID);

    await repository.getById("candidate-1");

    expect(builder.eq).toHaveBeenCalledWith("id", "candidate-1");
    expect(builder.eq).toHaveBeenCalledWith("user_id", USER_ID);
  });

  it("list() always scopes by the constructed userId regardless of filter", async () => {
    const { client, builder } = makeFakeClient({ data: [SAMPLE_ROW], error: null });
    const repository = new SupabaseTradeCandidateRepository(client, USER_ID);

    await repository.list({ status: "PENDING" });

    expect(builder.eq).toHaveBeenCalledWith("user_id", USER_ID);
    expect(builder.eq).toHaveBeenCalledWith("status", "PENDING");
  });

  it("transition() scopes the update by id, userId, AND the expected `from` status — a repository constructed with a different userId can never approve/reject a row it doesn't own, even if it somehow knew the row's id", async () => {
    const { client: ownerClient, builder: ownerBuilder } = makeFakeClient({ data: { ...SAMPLE_ROW, status: "APPROVED" }, error: null });
    const ownerRepo = new SupabaseTradeCandidateRepository(ownerClient, USER_ID);
    await ownerRepo.transition("candidate-1", "PENDING", { status: "APPROVED", approvedAt: "2026-01-01T00:05:00.000Z", approvedByUserId: USER_ID });

    expect(ownerBuilder.eq).toHaveBeenCalledWith("id", "candidate-1");
    expect(ownerBuilder.eq).toHaveBeenCalledWith("user_id", USER_ID);
    expect(ownerBuilder.eq).toHaveBeenCalledWith("status", "PENDING");

    // A repository constructed for a DIFFERENT user issues a query scoped to THAT user's id — on a
    // real Supabase connection (RLS: auth.uid() = user_id) this can never match another user's row
    // regardless of the id supplied; here we confirm the app-level query is scoped identically for
    // any constructed userId, which is the defense-in-depth half of that guarantee.
    const { client: otherClient, builder: otherBuilder } = makeFakeClient({ data: null, error: null });
    const otherRepo = new SupabaseTradeCandidateRepository(otherClient, OTHER_USER_ID);
    const result = await otherRepo.transition("candidate-1", "PENDING", { status: "APPROVED", approvedAt: "x", approvedByUserId: OTHER_USER_ID });

    expect(otherBuilder.eq).toHaveBeenCalledWith("user_id", OTHER_USER_ID);
    expect(result).toBeUndefined(); // no row matched (Postgres/RLS would return zero rows for a foreign id)
  });

  it("throws TradeCandidatePersistenceError (never a raw Supabase error) when the query errors", async () => {
    const { client } = makeFakeClient({ data: null, error: { message: "permission denied", code: "42501" } });
    const repository = new SupabaseTradeCandidateRepository(client, USER_ID);

    await expect(repository.create(BASE_INPUT)).rejects.toBeInstanceOf(TradeCandidatePersistenceError);
  });
});

describe("InMemoryTradeCandidateRepository — transition semantics (test double parity)", () => {
  it("transition() only applies when the current status matches `from`, mirroring the Supabase repository's atomic guard", async () => {
    const repository = new InMemoryTradeCandidateRepository();
    const candidate = await repository.create(BASE_INPUT);

    const approved = await repository.transition(candidate.id, "PENDING", { status: "APPROVED", approvedAt: "x", approvedByUserId: USER_ID });
    expect(approved?.status).toBe("APPROVED");

    // Second attempt from the same stale "PENDING" assumption fails safely — the row is already
    // APPROVED, so this conditional transition matches nothing.
    const duplicate = await repository.transition(candidate.id, "PENDING", { status: "APPROVED", approvedAt: "y", approvedByUserId: USER_ID });
    expect(duplicate).toBeUndefined();
  });
});
