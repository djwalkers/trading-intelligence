// Deliberately NOT "server-only" — dual-purpose exactly like analysis-repository.ts's own
// SupabaseAnalysisRepository: used server-side by the standalone Hermes trading-runtime process
// (service-role client + HERMES_SUPABASE_USER_ID, no browser session of its own) to create
// candidates and execute approved ones, AND server-side by this app's own Trade Approval page
// Server Actions (anon-key client + the signed-in user's session, RLS-scoped) to list/approve/
// reject. Only the injected client/userId differ between callers.
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertValidCandidateTransition,
  type TradeCandidate,
  type TradeCandidateInput,
  type TradeCandidateStatus,
} from "./types";

export interface TradeCandidateFilter {
  status?: TradeCandidateStatus;
  strategyId?: string;
  instrument?: string;
  limit?: number;
}

/** Every field a status transition might set — deliberately a flat, optional bag rather than one
 * shape per transition, since the repository layer's own job is just "persist this patch
 * atomically," not enforce which fields belong to which transition (trade-candidate-service.ts
 * owns that). */
export interface TradeCandidateTransitionPatch {
  status: TradeCandidateStatus;
  approvedAt?: string;
  approvedByUserId?: string;
  rejectedAt?: string;
  rejectedByUserId?: string;
  rejectionReason?: string;
  executedAt?: string;
  lifecycleRecordId?: string;
  brokerOrderId?: string;
  failureReason?: string;
}

export interface TradeCandidateRepository {
  create(input: TradeCandidateInput): Promise<TradeCandidate>;
  getById(id: string): Promise<TradeCandidate | undefined>;
  list(filter?: TradeCandidateFilter): Promise<TradeCandidate[]>;
  /**
   * Atomic, conditional: only applies `patch` when the row's CURRENT status still equals `from` —
   * the one mechanism that makes "duplicate approval" (or a rejection racing an expiry sweep, or
   * two runtime cycles both trying to execute the same APPROVED candidate) safe without a separate
   * lock. Returns undefined — not an error — when the row's status had already moved on; the
   * caller (trade-candidate-service.ts) treats that as "someone else already handled this," never
   * as a transient failure to retry.
   */
  transition(id: string, from: TradeCandidateStatus, patch: TradeCandidateTransitionPatch): Promise<TradeCandidate | undefined>;
}

export class TradeCandidatePersistenceError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
  ) {
    super(message);
    this.name = "TradeCandidatePersistenceError";
  }
}

function toPersistenceError(error: { message: string; code?: string }): TradeCandidatePersistenceError {
  return new TradeCandidatePersistenceError(error.message, error.code);
}

// --- Row shape (snake_case, matching supabase/migrations/0024_trade_candidates.sql) — hand-written,
// same "no live Supabase project to codegen against" convention analysis-repository.ts documents.

export interface TradeCandidateRow {
  id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
  analysis_run_id: string | null;
  strategy_id: string;
  strategy_version: number;
  instrument: string;
  direction: string;
  confidence: number | string;
  entry_price: number | string;
  stop_loss: number | string;
  take_profit: number | string;
  risk_reward: number | string;
  reasoning: string[];
  validation_notes: string[];
  execution_snapshot: Record<string, unknown>;
  expires_at: string;
  status: string;
  approved_at: string | null;
  approved_by_user_id: string | null;
  rejected_at: string | null;
  rejected_by_user_id: string | null;
  rejection_reason: string | null;
  executed_at: string | null;
  lifecycle_record_id: string | null;
  broker_order_id: string | null;
  failure_reason: string | null;
}

function toNumber(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

export function toInsertRow(input: TradeCandidateInput, userId: string): Omit<TradeCandidateRow, "id" | "created_at" | "updated_at"> {
  return {
    user_id: userId,
    analysis_run_id: input.analysisRunId ?? null,
    strategy_id: input.strategyId,
    strategy_version: input.strategyVersion,
    instrument: input.instrument,
    direction: input.direction,
    confidence: input.confidence,
    entry_price: input.entryPrice,
    stop_loss: input.stopLoss,
    take_profit: input.takeProfit,
    risk_reward: input.riskReward,
    reasoning: input.reasoning,
    validation_notes: input.validationNotes,
    execution_snapshot: input.execution as unknown as Record<string, unknown>,
    expires_at: input.expiresAt,
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
}

export function fromRow(row: TradeCandidateRow): TradeCandidate {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    analysisRunId: row.analysis_run_id ?? undefined,
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    instrument: row.instrument,
    direction: row.direction as TradeCandidate["direction"],
    confidence: toNumber(row.confidence),
    entryPrice: toNumber(row.entry_price),
    stopLoss: toNumber(row.stop_loss),
    takeProfit: toNumber(row.take_profit),
    riskReward: toNumber(row.risk_reward),
    reasoning: row.reasoning,
    validationNotes: row.validation_notes,
    execution: row.execution_snapshot as unknown as TradeCandidate["execution"],
    expiresAt: row.expires_at,
    status: row.status as TradeCandidateStatus,
    approvedAt: row.approved_at ?? undefined,
    approvedByUserId: row.approved_by_user_id ?? undefined,
    rejectedAt: row.rejected_at ?? undefined,
    rejectedByUserId: row.rejected_by_user_id ?? undefined,
    rejectionReason: row.rejection_reason ?? undefined,
    executedAt: row.executed_at ?? undefined,
    lifecycleRecordId: row.lifecycle_record_id ?? undefined,
    brokerOrderId: row.broker_order_id ?? undefined,
    failureReason: row.failure_reason ?? undefined,
  };
}

function toPatchRow(patch: TradeCandidateTransitionPatch): Record<string, unknown> {
  return {
    status: patch.status,
    approved_at: patch.approvedAt ?? null,
    approved_by_user_id: patch.approvedByUserId ?? null,
    rejected_at: patch.rejectedAt ?? null,
    rejected_by_user_id: patch.rejectedByUserId ?? null,
    rejection_reason: patch.rejectionReason ?? null,
    executed_at: patch.executedAt ?? null,
    lifecycle_record_id: patch.lifecycleRecordId ?? null,
    broker_order_id: patch.brokerOrderId ?? null,
    failure_reason: patch.failureReason ?? null,
  };
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export class SupabaseTradeCandidateRepository implements TradeCandidateRepository {
  constructor(
    private readonly client: SupabaseClient,
    private readonly userId: string,
  ) {}

  async create(input: TradeCandidateInput): Promise<TradeCandidate> {
    const { data, error } = await this.client
      .from("trade_candidates")
      .insert(toInsertRow(input, this.userId))
      .select("*")
      .single();
    if (error) throw toPersistenceError(error);
    return fromRow(data as TradeCandidateRow);
  }

  async getById(id: string): Promise<TradeCandidate | undefined> {
    const { data, error } = await this.client.from("trade_candidates").select("*").eq("id", id).eq("user_id", this.userId).maybeSingle();
    if (error) throw toPersistenceError(error);
    return data ? fromRow(data as TradeCandidateRow) : undefined;
  }

  async list(filter: TradeCandidateFilter = {}): Promise<TradeCandidate[]> {
    const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    let query = this.client
      .from("trade_candidates")
      .select("*")
      .eq("user_id", this.userId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (filter.status) query = query.eq("status", filter.status);
    if (filter.strategyId) query = query.eq("strategy_id", filter.strategyId);
    if (filter.instrument) query = query.eq("instrument", filter.instrument);

    const { data, error } = await query;
    if (error) throw toPersistenceError(error);
    return ((data ?? []) as TradeCandidateRow[]).map(fromRow);
  }

  async transition(
    id: string,
    from: TradeCandidateStatus,
    patch: TradeCandidateTransitionPatch,
  ): Promise<TradeCandidate | undefined> {
    assertValidCandidateTransition(from, patch.status);
    const { data, error } = await this.client
      .from("trade_candidates")
      .update({ ...toPatchRow(patch), updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", this.userId)
      .eq("status", from)
      .select("*")
      .maybeSingle();
    if (error) throw toPersistenceError(error);
    return data ? fromRow(data as TradeCandidateRow) : undefined;
  }
}

/** Test double only — no in-memory implementation is used in production (mirrors
 * InMemoryTradeLifecycleStore's own "the one non-Supabase implementation, for tests" role), except
 * that unlike that store, a genuine SupabaseTradeCandidateRepository DOES exist above; this class
 * exists purely so trade-candidate-service.ts's own unit tests don't need a live database. */
export class InMemoryTradeCandidateRepository implements TradeCandidateRepository {
  private readonly rows = new Map<string, TradeCandidate>();
  private nextId = 1;

  async create(input: TradeCandidateInput): Promise<TradeCandidate> {
    const now = new Date().toISOString();
    const candidate: TradeCandidate = {
      ...input,
      id: `candidate-${this.nextId++}`,
      status: "PENDING",
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(candidate.id, candidate);
    return candidate;
  }

  async getById(id: string): Promise<TradeCandidate | undefined> {
    return this.rows.get(id);
  }

  async list(filter: TradeCandidateFilter = {}): Promise<TradeCandidate[]> {
    let results = [...this.rows.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (filter.status) results = results.filter((c) => c.status === filter.status);
    if (filter.strategyId) results = results.filter((c) => c.strategyId === filter.strategyId);
    if (filter.instrument) results = results.filter((c) => c.instrument === filter.instrument);
    if (filter.limit) results = results.slice(0, filter.limit);
    return results;
  }

  async transition(
    id: string,
    from: TradeCandidateStatus,
    patch: TradeCandidateTransitionPatch,
  ): Promise<TradeCandidate | undefined> {
    assertValidCandidateTransition(from, patch.status);
    const existing = this.rows.get(id);
    if (!existing || existing.status !== from) return undefined;

    const updated: TradeCandidate = {
      ...existing,
      status: patch.status,
      updatedAt: new Date().toISOString(),
      approvedAt: patch.approvedAt ?? existing.approvedAt,
      approvedByUserId: patch.approvedByUserId ?? existing.approvedByUserId,
      rejectedAt: patch.rejectedAt ?? existing.rejectedAt,
      rejectedByUserId: patch.rejectedByUserId ?? existing.rejectedByUserId,
      rejectionReason: patch.rejectionReason ?? existing.rejectionReason,
      executedAt: patch.executedAt ?? existing.executedAt,
      lifecycleRecordId: patch.lifecycleRecordId ?? existing.lifecycleRecordId,
      brokerOrderId: patch.brokerOrderId ?? existing.brokerOrderId,
      failureReason: patch.failureReason ?? existing.failureReason,
    };
    this.rows.set(id, updated);
    return updated;
  }
}
