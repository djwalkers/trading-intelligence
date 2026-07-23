// Deliberately NOT "server-only" — dual-purpose exactly like trade-candidate-repository.ts's own
// SupabaseTradeCandidateRepository: written server-side by the standalone Hermes trading-runtime
// process (service-role client + HERMES_SUPABASE_USER_ID), read server- or client-side by this
// app's own Performance Analytics page (anon-key client + the signed-in user's session, RLS-scoped).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TradePerformanceInput, TradePerformanceRecord, WinLoss } from "./types";

export interface TradePerformanceFilter {
  strategyId?: string;
  instrument?: string;
  winLoss?: WinLoss;
  since?: string;
  limit?: number;
}

export interface TradePerformanceRepository {
  /** Idempotent: writes are keyed on (user_id, trade_id) — calling this twice for the same closed
   * trade updates the existing row rather than creating a duplicate. This is what makes it safe to
   * call from a best-effort, "never throws" runtime hook that could in principle observe the same
   * closed candidate more than once. */
  upsert(input: TradePerformanceInput): Promise<TradePerformanceRecord>;
  list(filter?: TradePerformanceFilter): Promise<TradePerformanceRecord[]>;
  getByTradeId(tradeId: string): Promise<TradePerformanceRecord | undefined>;
}

export class TradePerformancePersistenceError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
  ) {
    super(message);
    this.name = "TradePerformancePersistenceError";
  }
}

function toPersistenceError(error: { message: string; code?: string }): TradePerformancePersistenceError {
  return new TradePerformancePersistenceError(error.message, error.code);
}

// --- Row shape (snake_case, matching supabase/migrations/0025_trade_performance.sql).

export interface TradePerformanceRow {
  id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
  trade_id: string;
  analysis_run_id: string | null;
  candidate_id: string | null;
  strategy_id: string;
  strategy_version: number;
  instrument: string;
  side: string;
  entry_time: string;
  entry_price: number | string;
  exit_time: string;
  exit_price: number | string;
  holding_time_ms: number | string;
  gross_pnl: number | string;
  fees: number | string;
  net_pnl: number | string;
  return_percent: number | string;
  risk_multiple: number | string | null;
  max_favourable_excursion: number | string;
  max_adverse_excursion: number | string;
  peak_profit: number | string;
  maximum_drawdown: number | string;
  win_loss: string;
  exit_reason: string | null;
}

function toNumber(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}
function toOptionalNumber(value: number | string | null): number | undefined {
  return value === null ? undefined : toNumber(value);
}

export function toUpsertRow(input: TradePerformanceInput, userId: string): Omit<TradePerformanceRow, "id" | "created_at" | "updated_at"> {
  return {
    user_id: userId,
    trade_id: input.tradeId,
    analysis_run_id: input.analysisRunId ?? null,
    candidate_id: input.candidateId ?? null,
    strategy_id: input.strategyId,
    strategy_version: input.strategyVersion,
    instrument: input.instrument,
    side: input.side,
    entry_time: input.entryTime,
    entry_price: input.entryPrice,
    exit_time: input.exitTime,
    exit_price: input.exitPrice,
    holding_time_ms: input.holdingTimeMs,
    gross_pnl: input.grossPnl,
    fees: input.fees,
    net_pnl: input.netPnl,
    return_percent: input.returnPercent,
    risk_multiple: input.riskMultiple ?? null,
    max_favourable_excursion: input.maxFavourableExcursion,
    max_adverse_excursion: input.maxAdverseExcursion,
    peak_profit: input.peakProfit,
    maximum_drawdown: input.maximumDrawdown,
    win_loss: input.winLoss,
    exit_reason: input.exitReason ?? null,
  };
}

export function fromRow(row: TradePerformanceRow): TradePerformanceRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tradeId: row.trade_id,
    analysisRunId: row.analysis_run_id ?? undefined,
    candidateId: row.candidate_id ?? undefined,
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    instrument: row.instrument,
    side: row.side as TradePerformanceRecord["side"],
    entryTime: row.entry_time,
    entryPrice: toNumber(row.entry_price),
    exitTime: row.exit_time,
    exitPrice: toNumber(row.exit_price),
    holdingTimeMs: toNumber(row.holding_time_ms),
    grossPnl: toNumber(row.gross_pnl),
    fees: toNumber(row.fees),
    netPnl: toNumber(row.net_pnl),
    returnPercent: toNumber(row.return_percent),
    riskMultiple: toOptionalNumber(row.risk_multiple),
    maxFavourableExcursion: toNumber(row.max_favourable_excursion),
    maxAdverseExcursion: toNumber(row.max_adverse_excursion),
    peakProfit: toNumber(row.peak_profit),
    maximumDrawdown: toNumber(row.maximum_drawdown),
    winLoss: row.win_loss as WinLoss,
    exitReason: row.exit_reason ?? undefined,
  };
}

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

export class SupabaseTradePerformanceRepository implements TradePerformanceRepository {
  constructor(
    private readonly client: SupabaseClient,
    private readonly userId: string,
  ) {}

  async upsert(input: TradePerformanceInput): Promise<TradePerformanceRecord> {
    const { data, error } = await this.client
      .from("trade_performance")
      .upsert(
        { ...toUpsertRow(input, this.userId), updated_at: new Date().toISOString() },
        { onConflict: "user_id,trade_id" },
      )
      .select("*")
      .single();
    if (error) throw toPersistenceError(error);
    return fromRow(data as TradePerformanceRow);
  }

  async getByTradeId(tradeId: string): Promise<TradePerformanceRecord | undefined> {
    const { data, error } = await this.client
      .from("trade_performance")
      .select("*")
      .eq("user_id", this.userId)
      .eq("trade_id", tradeId)
      .maybeSingle();
    if (error) throw toPersistenceError(error);
    return data ? fromRow(data as TradePerformanceRow) : undefined;
  }

  async list(filter: TradePerformanceFilter = {}): Promise<TradePerformanceRecord[]> {
    const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    let query = this.client
      .from("trade_performance")
      .select("*")
      .eq("user_id", this.userId)
      .order("exit_time", { ascending: false })
      .limit(limit);

    if (filter.strategyId) query = query.eq("strategy_id", filter.strategyId);
    if (filter.instrument) query = query.eq("instrument", filter.instrument);
    if (filter.winLoss) query = query.eq("win_loss", filter.winLoss);
    if (filter.since) query = query.gte("exit_time", filter.since);

    const { data, error } = await query;
    if (error) throw toPersistenceError(error);
    return ((data ?? []) as TradePerformanceRow[]).map(fromRow);
  }
}

/** Test double only — no in-memory implementation is used in production. */
export class InMemoryTradePerformanceRepository implements TradePerformanceRepository {
  private readonly rows = new Map<string, TradePerformanceRecord>();
  private nextId = 1;

  async upsert(input: TradePerformanceInput): Promise<TradePerformanceRecord> {
    const existing = [...this.rows.values()].find((r) => r.tradeId === input.tradeId);
    const now = new Date().toISOString();
    const record: TradePerformanceRecord = {
      ...input,
      id: existing?.id ?? `performance-${this.nextId++}`,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(record.id, record);
    return record;
  }

  async getByTradeId(tradeId: string): Promise<TradePerformanceRecord | undefined> {
    return [...this.rows.values()].find((r) => r.tradeId === tradeId);
  }

  async list(filter: TradePerformanceFilter = {}): Promise<TradePerformanceRecord[]> {
    let results = [...this.rows.values()].sort((a, b) => b.exitTime.localeCompare(a.exitTime));
    if (filter.strategyId) results = results.filter((r) => r.strategyId === filter.strategyId);
    if (filter.instrument) results = results.filter((r) => r.instrument === filter.instrument);
    if (filter.winLoss) results = results.filter((r) => r.winLoss === filter.winLoss);
    if (filter.since) results = results.filter((r) => r.exitTime >= filter.since!);
    if (filter.limit) results = results.slice(0, filter.limit);
    return results;
  }
}
