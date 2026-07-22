// Deliberately NOT "server-only": SupabaseAnalysisRepository is dual-purpose, exactly like
// persistence/supabase-paper-trade-store.ts — used server-side with the service-role client (the
// Hermes trading-runtime process, GET /api/hermes/analysis) AND client-side with the anon-key
// client (the browser's own Decision Intelligence page, scoped by the signed-in user's session +
// RLS). Only the two purely-server-side pieces (analysis-persistence-config.ts, which reads
// process.env, and the service-role client itself) are marked "server-only".
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AnalysisDecision,
  AnalysisEventInput,
  AnalysisFilter,
  AnalysisRetentionWindow,
  AnalysisRun,
  AnalysisRunInput,
  StrategyPerformanceSummary,
} from "./types";
import { computeStrategyPerformance } from "./analysis-analytics";
import type { TrendClassification } from "../technical-indicators";

// Phase 2B — Decision Intelligence: Historical Analysis Persistence. THE one place SQL (via the
// Supabase client) is issued for this feature — "no SQL inside business logic" per this phase's
// own requirement. Written by the standalone Hermes trading-runtime process (service-role client +
// an explicit userId from HERMES_SUPABASE_USER_ID — the runtime has no browser session of its
// own), read by GET /api/hermes/analysis (same) and the browser's own Decision Intelligence page
// (anon-key client + the signed-in user's own session id). Only the injected client/userId differ
// between callers — mirrors src/lib/decision-intelligence/server-decision-history-store.ts's own
// established "same row mapping, different auth" precedent exactly.

// --- Row shapes (snake_case, matching supabase/migrations/0022_market_analysis_runs.sql and
// 0023_market_analysis_events.sql) — hand-written, mirroring persistence/supabase-paper-trade-
// store.ts's own convention: "no live Supabase project is linked to this repo to codegen against."

export interface MarketAnalysisRunRow {
  id: string;
  user_id: string;
  created_at: string;
  runtime_mode: string;
  broker_provider: string;
  market_provider: string;
  instrument: string;
  timeframe: string;
  strategy_id: string;
  strategy_version: number;
  current_bid: number | string | null;
  current_ask: number | string | null;
  current_mid: number | string | null;
  last_close: number | string | null;
  ema20: number | string | null;
  ema50: number | string | null;
  rsi14: number | string | null;
  atr14: number | string | null;
  trend: string | null;
  confidence: number | string | null;
  decision: string;
  decision_reason: string | null;
  executed_trade: boolean;
  trade_id: string | null;
  validation_ok: boolean;
  fallback_used: boolean;
  candle_count: number | null;
  data_age_seconds: number | string | null;
  runtime_duration_ms: number | string | null;
  error_code: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
}

export interface MarketAnalysisEventRow {
  id: string;
  analysis_run_id: string;
  timestamp: string;
  event_type: string;
  severity: string;
  message: string;
  payload: Record<string, unknown>;
}

function toNumber(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === "number" ? value : Number(value);
}

export function toRunRow(input: AnalysisRunInput, userId: string): Omit<MarketAnalysisRunRow, "id" | "created_at"> {
  return {
    user_id: userId,
    runtime_mode: input.runtimeMode,
    broker_provider: input.brokerProvider,
    market_provider: input.marketProvider,
    instrument: input.instrument,
    timeframe: input.timeframe,
    strategy_id: input.strategyId,
    strategy_version: input.strategyVersion,
    current_bid: input.currentBid ?? null,
    current_ask: input.currentAsk ?? null,
    current_mid: input.currentMid ?? null,
    last_close: input.lastClose ?? null,
    ema20: input.ema20 ?? null,
    ema50: input.ema50 ?? null,
    rsi14: input.rsi14 ?? null,
    atr14: input.atr14 ?? null,
    trend: input.trend ?? null,
    confidence: input.confidence ?? null,
    decision: input.decision,
    decision_reason: input.decisionReason ?? null,
    executed_trade: input.executedTrade,
    trade_id: input.tradeId ?? null,
    validation_ok: input.validationOk,
    fallback_used: input.fallbackUsed,
    candle_count: input.candleCount ?? null,
    data_age_seconds: input.dataAgeSeconds ?? null,
    runtime_duration_ms: input.runtimeDurationMs,
    error_code: input.errorCode ?? null,
    error_message: input.errorMessage ?? null,
    metadata: input.metadata ?? {},
  };
}

export function fromRunRow(row: MarketAnalysisRunRow): AnalysisRun {
  return {
    id: row.id,
    createdAt: row.created_at,
    runtimeMode: row.runtime_mode as AnalysisRun["runtimeMode"],
    brokerProvider: row.broker_provider as AnalysisRun["brokerProvider"],
    marketProvider: row.market_provider as AnalysisRun["marketProvider"],
    instrument: row.instrument,
    timeframe: row.timeframe,
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    currentBid: toNumber(row.current_bid),
    currentAsk: toNumber(row.current_ask),
    currentMid: toNumber(row.current_mid),
    lastClose: toNumber(row.last_close),
    ema20: toNumber(row.ema20),
    ema50: toNumber(row.ema50),
    rsi14: toNumber(row.rsi14),
    atr14: toNumber(row.atr14),
    trend: (row.trend as TrendClassification | null) ?? undefined,
    confidence: toNumber(row.confidence),
    decision: row.decision as AnalysisDecision,
    decisionReason: row.decision_reason ?? undefined,
    executedTrade: row.executed_trade,
    tradeId: row.trade_id ?? undefined,
    validationOk: row.validation_ok,
    fallbackUsed: row.fallback_used,
    candleCount: row.candle_count ?? undefined,
    dataAgeSeconds: toNumber(row.data_age_seconds),
    runtimeDurationMs: toNumber(row.runtime_duration_ms) ?? 0,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    metadata: row.metadata ?? {},
  };
}

export function toEventRow(analysisRunId: string, input: AnalysisEventInput): Omit<MarketAnalysisEventRow, "id"> {
  return {
    analysis_run_id: analysisRunId,
    timestamp: input.timestamp,
    event_type: input.eventType,
    severity: input.severity,
    message: input.message,
    payload: input.payload ?? {},
  };
}

function retentionToSince(retention: AnalysisRetentionWindow | undefined, now: Date = new Date()): string | undefined {
  switch (retention) {
    case "30d":
      return new Date(now.getTime() - 30 * 86_400_000).toISOString();
    case "90d":
      return new Date(now.getTime() - 90 * 86_400_000).toISOString();
    case "365d":
      return new Date(now.getTime() - 365 * 86_400_000).toISOString();
    case "all":
    case undefined:
      return undefined;
  }
}

/**
 * Thrown by every SupabaseAnalysisRepository method on a Supabase error response. Preserves the
 * underlying Postgrest/Postgres error `code` (e.g. "42501" for an RLS denial, "23505" for a unique
 * violation) — a plain `new Error(error.message)` would silently discard it — so a caller (see
 * trading-runtime.ts's own persistAnalysis) can log a genuine error *category* rather than just an
 * opaque message. Never carries the raw Supabase error object, `.details`, or `.hint` — only
 * `.message` and `.code`, matching this codebase's own EtoroApiError precedent of "safe fields
 * only, never the full response body."
 */
export class AnalysisPersistenceError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
  ) {
    super(message);
    this.name = "AnalysisPersistenceError";
  }
}

function toPersistenceError(error: { message: string; code?: string }): AnalysisPersistenceError {
  return new AnalysisPersistenceError(error.message, error.code);
}

/** A short, log-safe category for any error a persistence attempt might throw — prefers
 * AnalysisPersistenceError's own Postgrest/Postgres code (the most specific signal available),
 * falls back to the error's own class name, then a generic default. Never returns anything
 * containing a message, header, or credential — see this function's own callers for the "never log
 * Supabase keys, tokens, raw headers, or full database responses" requirement. */
export function categorizeAnalysisPersistenceError(error: unknown): string {
  if (error instanceof AnalysisPersistenceError && error.code) return error.code;
  if (error instanceof Error) return error.name;
  return "UNKNOWN";
}

export interface AnalysisRepository {
  saveAnalysis(input: AnalysisRunInput): Promise<string>;
  saveEvents(analysisRunId: string, events: AnalysisEventInput[]): Promise<void>;
  markTradeExecuted(analysisRunId: string, tradeId: string): Promise<void>;
  getRecentAnalyses(filter?: AnalysisFilter): Promise<AnalysisRun[]>;
  getStrategyPerformance(filter?: AnalysisFilter): Promise<StrategyPerformanceSummary>;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * The one implementation of AnalysisRepository. `saveAnalysis`/`saveEvents`/`markTradeExecuted`
 * are only ever called by the Hermes trading-runtime process; `getRecentAnalyses`/
 * `getStrategyPerformance` are called by all three consumers (runtime diagnostics, the API route,
 * the browser page) — whoever constructs this class decides which SupabaseClient (anon+session vs.
 * service-role+explicit id) and userId to inject; this class itself is agnostic to which.
 */
export class SupabaseAnalysisRepository implements AnalysisRepository {
  constructor(
    private readonly client: SupabaseClient,
    private readonly userId: string,
  ) {}

  async saveAnalysis(input: AnalysisRunInput): Promise<string> {
    const { data, error } = await this.client
      .from("market_analysis_runs")
      .insert(toRunRow(input, this.userId))
      .select("id")
      .single();

    if (error) throw toPersistenceError(error);
    return data.id as string;
  }

  /** Inserts every event in `events` as ONE batch request — `.insert(rows)` below is called once
   * with the full array, never once per event in a loop. Supabase/PostgREST accepts an array
   * directly and issues it as a single multi-row INSERT statement; a per-cycle batch of a handful
   * of events is one round-trip, not N. See analysis-repository.test.ts's own
   * "inserts every event... one batch request" coverage for the assertion that pins this. */
  async saveEvents(analysisRunId: string, events: AnalysisEventInput[]): Promise<void> {
    if (events.length === 0) return;
    const rows = events.map((event) => toEventRow(analysisRunId, event));
    const { error } = await this.client.from("market_analysis_events").insert(rows);
    if (error) throw toPersistenceError(error);
  }

  /** Available for a future async reconciliation step — the current runtime integration already
   * knows the execution outcome synchronously before its one saveAnalysis() call (see
   * trading-runtime.ts), so it never needs to call this today; kept as a genuine, tested
   * capability per this phase's own required method list rather than a stub. */
  async markTradeExecuted(analysisRunId: string, tradeId: string): Promise<void> {
    const { error } = await this.client
      .from("market_analysis_runs")
      .update({ executed_trade: true, trade_id: tradeId })
      .eq("id", analysisRunId)
      .eq("user_id", this.userId);
    if (error) throw toPersistenceError(error);
  }

  async getRecentAnalyses(filter: AnalysisFilter = {}): Promise<AnalysisRun[]> {
    const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const since = filter.since ?? retentionToSince(filter.retention);

    let query = this.client
      .from("market_analysis_runs")
      .select("*")
      .eq("user_id", this.userId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (filter.instrument) query = query.eq("instrument", filter.instrument);
    if (filter.decision) query = query.eq("decision", filter.decision);
    if (filter.strategyId) query = query.eq("strategy_id", filter.strategyId);
    if (since) query = query.gte("created_at", since);
    if (filter.until) query = query.lte("created_at", filter.until);

    const { data, error } = await query;
    if (error) throw toPersistenceError(error);
    return ((data ?? []) as MarketAnalysisRunRow[]).map(fromRunRow);
  }

  async getStrategyPerformance(filter: AnalysisFilter = {}): Promise<StrategyPerformanceSummary> {
    // No SQL-level aggregation — reads the same filtered row set getRecentAnalyses would (up to a
    // defensive ceiling) and delegates every percentage/average calculation to
    // computeStrategyPerformance (analysis-analytics.ts), a pure function independently unit-
    // tested without a database at all.
    const since = filter.since ?? retentionToSince(filter.retention);

    let query = this.client
      .from("market_analysis_runs")
      .select("*")
      .eq("user_id", this.userId)
      .order("created_at", { ascending: false })
      .limit(MAX_LIMIT);

    if (filter.instrument) query = query.eq("instrument", filter.instrument);
    if (filter.decision) query = query.eq("decision", filter.decision);
    if (filter.strategyId) query = query.eq("strategy_id", filter.strategyId);
    if (since) query = query.gte("created_at", since);
    if (filter.until) query = query.lte("created_at", filter.until);

    const { data, error } = await query;
    if (error) throw toPersistenceError(error);
    const runs = ((data ?? []) as MarketAnalysisRunRow[]).map(fromRunRow);
    return computeStrategyPerformance(runs);
  }
}
