// Restart-Resilient Autonomy Phase — Phase 2 (Durable trade lifecycle persistence). Same
// dual-purpose convention as trade-candidate-repository.ts's own SupabaseTradeCandidateRepository:
// used server-side by the standalone Hermes trading-runtime process (service-role client + an
// explicit HERMES_SUPABASE_USER_ID). Row shape (snake_case, matching
// supabase/migrations/0026_trade_lifecycle_records.sql) is hand-written — same "no live Supabase
// project to codegen against" convention every other repository in this pipeline already documents.
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertOrderSizingMode } from "../order-sizing";
import type { MarketDataSnapshot } from "../market-data/market-data-provider";
import type { MarketDecision, MarketDecisionAction, MarketDecisionContext } from "../market-decision-engine";
import type { PortfolioRiskDecision } from "../portfolio-risk-engine";
import type { OrderSide } from "../types";
import {
  TradeLifecycleUniqueConstraintViolationError,
  type ClosedTradeRealisedPnlAggregate,
  type LifecycleRecordsByStrategyInstrumentScope,
  type RecoverableLifecycleRecordsScope,
  type TradeLifecycleStore,
} from "./trade-lifecycle-store";
import { EVER_REACHED_OPEN_STATUSES, type ConfirmedEntryCountRangeScope } from "./confirmed-entry-count";
import type { TradeLifecycleError, TradeLifecycleRecord, TradeLifecycleStatus } from "./types";
import { withQueryTelemetry } from "./query-telemetry";

const TABLE_NAME = "trade_lifecycle_records";

export interface TradeLifecycleRecordRow {
  id: string;
  user_id: string;
  candidate_id: string | null;
  strategy_id: string;
  strategy_version: number;
  instrument: string;
  broker_provider: string;
  broker_position_id: string | null;
  broker_order_id: string | null;
  side: string;
  sizing_mode: string;
  quantity: number | string;
  status: string;
  entry_price: number | string | null;
  stop_loss: number | string | null;
  take_profit: number | string | null;
  opened_at: string | null;
  closed_at: string | null;
  exit_price: number | string | null;
  exit_reason: string | null;
  realised_pnl: number | string | null;
  detail: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Everything TradeLifecycleRecord carries beyond the first-class columns above — see the
 * migration's own top-of-file comment for why this is one schemaless blob, not more columns. */
interface TradeLifecycleRecordDetail {
  decision?: MarketDecisionAction;
  confidence?: number;
  decisionReasons?: string[];
  marketDataSnapshot?: MarketDataSnapshot;
  intelligenceSummary?: MarketDecisionContext;
  portfolioRiskDecision?: PortfolioRiskDecision;
  realisedPnlPercent?: number;
  holdingDurationMs?: number;
  maximumFavourableExcursion?: number;
  maximumAdverseExcursion?: number;
  error?: TradeLifecycleError;
}

export class TradeLifecyclePersistenceError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
  ) {
    super(message);
    this.name = "TradeLifecyclePersistenceError";
  }
}

/** Postgres's own SQLSTATE for "unique_violation" — the code a violation of either of migration
 * 0026's two partial unique indexes (trade_lifecycle_records_active_broker_position_uidx /
 * trade_lifecycle_records_active_strategy_instrument_uidx) surfaces as. Translated to the same
 * TradeLifecycleUniqueConstraintViolationError the in-memory store throws for its own equivalent
 * check, so callers (position-reconciliation.ts) can react to "this collided with the
 * one-active-record invariant" without needing to know which store implementation is in use. */
const POSTGRES_UNIQUE_VIOLATION_CODE = "23505";

function toPersistenceError(error: { message: string; code?: string }): Error {
  if (error.code === POSTGRES_UNIQUE_VIOLATION_CODE) {
    return new TradeLifecycleUniqueConstraintViolationError(error.message);
  }
  return new TradeLifecyclePersistenceError(error.message, error.code);
}

/** Thrown by fromRow() for a persisted row that is missing a field TradeLifecycleRecord requires,
 * or carries a value outside its known enum — "unknown or incomplete persisted records fail
 * closed": this store never silently defaults a corrupted/incomplete row into a plausible-looking
 * record. */
export class TradeLifecycleRecordCorruptionError extends Error {
  constructor(id: string, reason: string) {
    super(`Trade lifecycle record "${id}" is corrupted or incomplete: ${reason}`);
    this.name = "TradeLifecycleRecordCorruptionError";
  }
}

const VALID_SIDES: readonly OrderSide[] = ["BUY", "SELL"];
const VALID_STATUSES: readonly TradeLifecycleStatus[] = [
  "DECISION_CREATED",
  "RISK_REJECTED",
  "APPROVED",
  "EXECUTION_SUBMITTED",
  "OPEN",
  "CLOSE_REQUESTED",
  "CLOSED",
  "EXECUTION_FAILED",
  "CLOSE_FAILED",
  "CLOSED_UNRECONCILED",
  "EXECUTION_ABANDONED",
  "EXECUTION_RECONCILIATION_REQUIRED",
];
const VALID_DECISIONS: readonly MarketDecisionAction[] = ["BUY", "SELL", "HOLD"];

function toNumber(value: number | string | null): number | undefined {
  if (value === null) return undefined;
  return typeof value === "number" ? value : Number(value);
}

function requireNumber(value: number | string, id: string, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new TradeLifecycleRecordCorruptionError(id, `"${field}" is not a finite number.`);
  return parsed;
}

export function toRow(record: TradeLifecycleRecord, userId: string): Omit<TradeLifecycleRecordRow, "created_at" | "updated_at"> {
  const detail: TradeLifecycleRecordDetail = {
    decision: record.decision,
    confidence: record.confidence,
    decisionReasons: record.decisionReasons,
    marketDataSnapshot: record.marketDataSnapshot,
    intelligenceSummary: record.intelligenceSummary,
    portfolioRiskDecision: record.portfolioRiskDecision,
    realisedPnlPercent: record.realisedPnlPercent,
    holdingDurationMs: record.holdingDurationMs,
    maximumFavourableExcursion: record.maximumFavourableExcursion,
    maximumAdverseExcursion: record.maximumAdverseExcursion,
    error: record.error,
  };
  return {
    id: record.id,
    user_id: userId,
    candidate_id: record.candidateId ?? null,
    strategy_id: record.strategyId,
    strategy_version: record.strategyVersion,
    instrument: record.symbol,
    broker_provider: record.brokerProvider,
    broker_position_id: record.brokerPositionId ?? null,
    broker_order_id: record.brokerOrderId ?? null,
    side: record.side,
    sizing_mode: record.sizingMode,
    quantity: record.quantity,
    status: record.status,
    entry_price: record.entryPrice ?? null,
    stop_loss: record.stopLoss ?? null,
    take_profit: record.takeProfit ?? null,
    opened_at: record.openedAt ?? null,
    closed_at: record.closedAt ?? null,
    exit_price: record.exitPrice ?? null,
    exit_reason: record.exitReason ?? null,
    realised_pnl: record.realisedPnl ?? null,
    detail: detail as unknown as Record<string, unknown>,
  };
}

/** Fails closed (throws TradeLifecycleRecordCorruptionError) rather than defaulting any field this
 * pipeline treats as always-required on a fresh record (side, sizingMode, status, decision,
 * confidence, decisionReasons) — a row missing one of these did not come from this store's own
 * toRow(), and must never be silently reinterpreted. `marketDataSnapshot`/`intelligenceSummary`/
 * `portfolioRiskDecision`/MFE-MAE/`error` remain genuinely optional (undefined is a legitimate,
 * expected state — see TradeLifecycleRecord's own doc comments). */
export function fromRow(row: TradeLifecycleRecordRow): TradeLifecycleRecord {
  const detail = (row.detail ?? {}) as TradeLifecycleRecordDetail;

  if (!(VALID_SIDES as readonly string[]).includes(row.side)) {
    throw new TradeLifecycleRecordCorruptionError(row.id, `side "${row.side}" is not one of ${VALID_SIDES.join(", ")}.`);
  }
  if (!(VALID_STATUSES as readonly string[]).includes(row.status)) {
    throw new TradeLifecycleRecordCorruptionError(row.id, `status "${row.status}" is not a recognised TradeLifecycleStatus.`);
  }
  const sizingMode = assertOrderSizingMode(row.sizing_mode, `trade lifecycle record "${row.id}"`);
  if (detail.decision === undefined || !(VALID_DECISIONS as readonly string[]).includes(detail.decision)) {
    throw new TradeLifecycleRecordCorruptionError(row.id, `detail.decision is missing or not a recognised MarketDecisionAction.`);
  }
  if (typeof detail.confidence !== "number" || !Number.isFinite(detail.confidence)) {
    throw new TradeLifecycleRecordCorruptionError(row.id, `detail.confidence is missing or not a finite number.`);
  }
  if (!Array.isArray(detail.decisionReasons)) {
    throw new TradeLifecycleRecordCorruptionError(row.id, `detail.decisionReasons is missing or not an array.`);
  }

  return {
    id: row.id,
    candidateId: row.candidate_id ?? undefined,
    brokerProvider: row.broker_provider,
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    symbol: row.instrument,
    side: row.side as OrderSide,
    quantity: requireNumber(row.quantity, row.id, "quantity"),
    sizingMode,
    decision: detail.decision,
    confidence: detail.confidence,
    decisionReasons: detail.decisionReasons,
    marketDataSnapshot: detail.marketDataSnapshot,
    intelligenceSummary: detail.intelligenceSummary,
    portfolioRiskDecision: detail.portfolioRiskDecision,
    status: row.status as TradeLifecycleStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    openedAt: row.opened_at ?? undefined,
    closedAt: row.closed_at ?? undefined,
    entryPrice: toNumber(row.entry_price),
    stopLoss: toNumber(row.stop_loss),
    takeProfit: toNumber(row.take_profit),
    exitPrice: toNumber(row.exit_price),
    brokerOrderId: row.broker_order_id ?? undefined,
    brokerPositionId: row.broker_position_id ?? undefined,
    exitReason: row.exit_reason ?? undefined,
    realisedPnl: toNumber(row.realised_pnl),
    realisedPnlPercent: detail.realisedPnlPercent,
    holdingDurationMs: detail.holdingDurationMs,
    maximumFavourableExcursion: detail.maximumFavourableExcursion,
    maximumAdverseExcursion: detail.maximumAdverseExcursion,
    error: detail.error,
  };
}

const OPEN_STATUSES = ["OPEN", "CLOSE_REQUESTED"] as const;

export class SupabaseTradeLifecycleStore implements TradeLifecycleStore {
  constructor(
    private readonly client: SupabaseClient,
    private readonly userId: string,
  ) {}

  async create(record: TradeLifecycleRecord): Promise<void> {
    const { error } = await this.client.from(TABLE_NAME).insert(toRow(record, this.userId));
    if (error) throw toPersistenceError(error);
  }

  async getById(id: string): Promise<TradeLifecycleRecord | null> {
    const { data, error } = await this.client
      .from(TABLE_NAME)
      .select("*")
      .eq("id", id)
      .eq("user_id", this.userId)
      .maybeSingle();
    if (error) throw toPersistenceError(error);
    return data ? fromRow(data as TradeLifecycleRecordRow) : null;
  }

  async update(record: TradeLifecycleRecord): Promise<void> {
    const row = toRow(record, this.userId);
    const { error, count } = await this.client
      .from(TABLE_NAME)
      .update({ ...row, updated_at: new Date().toISOString() }, { count: "exact" })
      .eq("id", record.id)
      .eq("user_id", this.userId);
    if (error) throw toPersistenceError(error);
    if (count === 0) {
      throw new Error(`Cannot update unknown trade lifecycle record "${record.id}" — call create() first.`);
    }
  }

  async list(): Promise<TradeLifecycleRecord[]> {
    const { data, error } = await this.client.from(TABLE_NAME).select("*").eq("user_id", this.userId);
    if (error) throw toPersistenceError(error);
    return ((data ?? []) as TradeLifecycleRecordRow[]).map(fromRow);
  }

  async listOpen(): Promise<TradeLifecycleRecord[]> {
    const { data, error } = await this.client
      .from(TABLE_NAME)
      .select("*")
      .eq("user_id", this.userId)
      .in("status", OPEN_STATUSES as unknown as string[]);
    if (error) throw toPersistenceError(error);
    return ((data ?? []) as TradeLifecycleRecordRow[]).map(fromRow);
  }

  async listClosed(): Promise<TradeLifecycleRecord[]> {
    const { data, error } = await this.client.from(TABLE_NAME).select("*").eq("user_id", this.userId).eq("status", "CLOSED");
    if (error) throw toPersistenceError(error);
    return ((data ?? []) as TradeLifecycleRecordRow[]).map(fromRow);
  }

  async listUnreconciled(): Promise<TradeLifecycleRecord[]> {
    const { data, error } = await this.client
      .from(TABLE_NAME)
      .select("*")
      .eq("user_id", this.userId)
      .eq("status", "CLOSED_UNRECONCILED");
    if (error) throw toPersistenceError(error);
    return ((data ?? []) as TradeLifecycleRecordRow[]).map(fromRow);
  }

  // --- Egress-containment fix — bounded, server-side-filtered queries -------------------------
  // Production incident: Supabase egress ~800% over the Free-plan quota, traced to
  // list()/listOpen()-shaped full-table `select("*")` calls (JSONB `detail` blob — full OHLCV candle
  // arrays, market/decision snapshots — included) running unconditionally every runtime cycle. Every
  // method below is scoped by an indexed WHERE clause so its result size no longer grows with total
  // table size, only with genuinely in-scope rows (by construction of migration 0026's own active-
  // uniqueness indexes, at most a handful for the strategy+instrument/broker-position-id methods).

  async countConfirmedEntriesForUtcDay(scope: ConfirmedEntryCountRangeScope): Promise<number> {
    return withQueryTelemetry({ operation: "countConfirmedEntriesForUtcDay", table: TABLE_NAME, countOnly: true }, async () => {
      // Fail-closed corruption guard, bounded to a handful of ids (never the full table): a record
      // for this strategy whose status proves it reached a confirmed OPEN position but has no
      // opened_at recorded can't be safely excluded from today's count — see
      // confirmed-entry-count.ts's own doc comment for the semantics this must preserve exactly.
      const { data: corrupted, error: corruptionError } = await this.client
        .from(TABLE_NAME)
        .select("id")
        .eq("user_id", this.userId)
        .eq("strategy_id", scope.strategyId)
        .in("status", EVER_REACHED_OPEN_STATUSES as unknown as string[])
        .is("opened_at", null)
        .limit(5);
      if (corruptionError) throw toPersistenceError(corruptionError);
      if (corrupted && corrupted.length > 0) {
        const first = corrupted[0] as { id: string };
        throw new TradeLifecycleRecordCorruptionError(
          first.id,
          `has a status requiring a confirmed OPEN position but no opened_at — cannot safely compute today's confirmed-entry ` +
            `count for strategy "${scope.strategyId}". Refusing to silently under-count.`,
        );
      }

      // The count itself: Postgres performs the filtering AND the counting — head:true means no
      // matching rows are ever transferred, only the count.
      const { count, error } = await this.client
        .from(TABLE_NAME)
        .select("id", { count: "exact", head: true })
        .eq("user_id", this.userId)
        .eq("strategy_id", scope.strategyId)
        .gte("opened_at", scope.startInclusive)
        .lt("opened_at", scope.endExclusive);
      if (error) throw toPersistenceError(error);
      return { result: count ?? 0, rowCount: count ?? 0 };
    });
  }

  async listActiveLifecycleRecords(scope: LifecycleRecordsByStrategyInstrumentScope): Promise<TradeLifecycleRecord[]> {
    return withQueryTelemetry({ operation: "listActiveLifecycleRecords", table: TABLE_NAME }, async () => {
      const { data, error } = await this.client
        .from(TABLE_NAME)
        .select("*")
        .eq("user_id", this.userId)
        .eq("strategy_id", scope.strategyId)
        .eq("instrument", scope.instrument)
        .in("status", scope.statuses as unknown as string[]);
      if (error) throw toPersistenceError(error);
      const records = ((data ?? []) as TradeLifecycleRecordRow[]).map(fromRow);
      return { result: records, rowCount: records.length };
    });
  }

  async listRecoverableLifecycleRecords(scope: RecoverableLifecycleRecordsScope): Promise<TradeLifecycleRecord[]> {
    return withQueryTelemetry({ operation: "listRecoverableLifecycleRecords", table: TABLE_NAME }, async () => {
      const { data, error } = await this.client
        .from(TABLE_NAME)
        .select("*")
        .eq("user_id", this.userId)
        .eq("strategy_id", scope.strategyId)
        .eq("instrument", scope.instrument)
        .in("status", scope.statuses as unknown as string[])
        .lte("updated_at", scope.updatedBefore);
      if (error) throw toPersistenceError(error);
      const records = ((data ?? []) as TradeLifecycleRecordRow[]).map(fromRow);
      return { result: records, rowCount: records.length };
    });
  }

  async findLifecycleRecordsByBrokerPositionId(brokerPositionId: string): Promise<TradeLifecycleRecord[]> {
    return withQueryTelemetry({ operation: "findLifecycleRecordsByBrokerPositionId", table: TABLE_NAME }, async () => {
      const { data, error } = await this.client
        .from(TABLE_NAME)
        .select("*")
        .eq("user_id", this.userId)
        .eq("broker_position_id", brokerPositionId);
      if (error) throw toPersistenceError(error);
      const records = ((data ?? []) as TradeLifecycleRecordRow[]).map(fromRow);
      return { result: records, rowCount: records.length };
    });
  }

  async sumRealisedPnlForClosedTrades(): Promise<ClosedTradeRealisedPnlAggregate> {
    return withQueryTelemetry({ operation: "sumRealisedPnlForClosedTrades", table: TABLE_NAME }, async () => {
      // Only the realised_pnl column — never the JSONB detail blob select("*") would also pull in.
      const { data, error } = await this.client.from(TABLE_NAME).select("realised_pnl").eq("user_id", this.userId).eq("status", "CLOSED");
      if (error) throw toPersistenceError(error);
      const rows = (data ?? []) as { realised_pnl: number | string | null }[];
      let realisedPnl = 0;
      let realisedTradeCount = 0;
      for (const row of rows) {
        // Defensive only — migration 0026's own trade_lifecycle_records_closed_requires_exit_fields
        // constraint guarantees a CLOSED row always has realised_pnl, but this never fabricates a
        // figure for a row that, unexpectedly, does not.
        if (row.realised_pnl === null) continue;
        realisedPnl += typeof row.realised_pnl === "number" ? row.realised_pnl : Number(row.realised_pnl);
        realisedTradeCount += 1;
      }
      return { result: { realisedPnl, realisedTradeCount }, rowCount: rows.length };
    });
  }

  async countUnreconciledClosedTrades(): Promise<number> {
    return withQueryTelemetry({ operation: "countUnreconciledClosedTrades", table: TABLE_NAME, countOnly: true }, async () => {
      const { count, error } = await this.client
        .from(TABLE_NAME)
        .select("id", { count: "exact", head: true })
        .eq("user_id", this.userId)
        .eq("status", "CLOSED_UNRECONCILED");
      if (error) throw toPersistenceError(error);
      return { result: count ?? 0, rowCount: count ?? 0 };
    });
  }
}
