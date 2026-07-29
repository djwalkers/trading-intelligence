import { randomUUID } from "node:crypto";
import type { AuditTrail } from "../audit-trail";
import type { AuditEventType, OrderSide, OrderSizingMode } from "../types";
import type { MarketDataSnapshot } from "../market-data/market-data-provider";
import type { MarketDecision, MarketDecisionContext } from "../market-decision-engine";
import type { PortfolioRiskDecision } from "../portfolio-risk-engine";
import { calculateHoldingDurationMs, calculateRealisedPnl, calculateRealisedPnlPercent, updateExcursionValues } from "./calculations";
import { assertValidTransition, type TradeLifecycleError, type TradeLifecycleRecord, type TradeLifecycleStatus } from "./types";
import type { TradeLifecycleStore } from "./trade-lifecycle-store";

// Milestone 6 — Trade Lifecycle & Performance Tracking. The one place a TradeLifecycleRecord is
// ever created or mutated — everything upstream (the pipeline integration in
// trade-lifecycle-runner.ts) only ever calls these named methods, never constructs or edits a
// record directly. Every mutating method both persists (via the injected store) and emits exactly
// one audit event (via the existing, unmodified AuditTrail infrastructure) — the store holds the
// current/queryable state, the audit trail holds the append-only history of how it got there.

export interface CreateFromDecisionInput {
  strategyId: string;
  /** Restart-Resilient Autonomy Phase. Moved to a top-level, always-required field — see
   * TradeLifecycleRecord.strategyVersion's own doc comment for why. */
  strategyVersion: number;
  symbol: string;
  side: OrderSide;
  quantity: number;
  /** Broker Sizing Semantic Fix. Frozen onto the created record (see TradeLifecycleRecord's own
   * doc comment) — sourced by the caller from the broker's own declared sizing mode, never guessed
   * here. */
  sizingMode: OrderSizingMode;
  /** Restart-Resilient Autonomy Phase. Undefined when this record is adopted from an orphaned
   * broker position rather than created from an executed candidate — see TradeLifecycleRecord's own
   * doc comment. */
  candidateId?: string;
  /** Restart-Resilient Autonomy Phase. Always known at creation time from runtime configuration. */
  brokerProvider: string;
  /** Restart-Resilient Autonomy Phase. Frozen from the originating TradeCandidate when one exists —
   * undefined for an adopted orphaned position (genuinely unknown, never guessed). */
  stopLoss?: number;
  takeProfit?: number;
  decision: MarketDecision;
  marketDataSnapshot: MarketDataSnapshot;
  intelligenceSummary: MarketDecisionContext;
}

export interface RecordFailureInput {
  message: string;
  context?: Record<string, unknown>;
}

export interface RecordOpenedInput {
  entryPrice: number;
  brokerOrderId: string;
  /** Restart-Resilient Autonomy Phase. The broker's own durable position identifier (see
   * PaperPosition.brokerPositionId) — undefined only for a broker that doesn't expose one (out of
   * this phase's scope; EtoroDemoBroker always populates it). */
  brokerPositionId?: string;
  /** Injectable for deterministic tests; defaults to the service's own clock. */
  openedAt?: string;
}

export interface RecordClosedInput {
  exitPrice: number;
  exitReason: string;
  /** Injectable for deterministic tests; defaults to the service's own clock. */
  closedAt?: string;
}

export interface TradeLifecycleServiceDeps {
  store: TradeLifecycleStore;
  auditTrail: AuditTrail;
  executionRunId: string;
  /** Injectable clock — defaults to the real current time. Every timestamp this service writes
   * (createdAt/updatedAt/submittedAt/openedAt/closedAt/error.occurredAt, and every audit event's
   * own timestamp) is drawn from this, so tests can pin it exactly like
   * MarketIntelligenceBuilder's own `now?: Date` option. */
  now?: () => Date;
  /** Injectable id generator — defaults to an incrementing `trade-lifecycle-N` counter scoped to
   * this service instance, mirroring LocalPaperBroker's own `nextPositionSeq`-style counters. */
  idGenerator?: () => string;
}

export class TradeLifecycleService {
  private readonly now: () => Date;
  private readonly idGenerator: () => string;

  constructor(private readonly deps: TradeLifecycleServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    // Restart-Resilient Autonomy Phase: a real UUID (not the old sequential "trade-lifecycle-N"
    // counter) so ids stay globally unique across process restarts — required for durable (Supabase)
    // storage, where a fresh process's counter restarting at 1 would otherwise collide with a
    // still-open record a PRIOR process already persisted under the same id.
    this.idGenerator = deps.idGenerator ?? (() => randomUUID());
  }

  async createFromDecision(input: CreateFromDecisionInput): Promise<TradeLifecycleRecord> {
    const timestamp = this.now().toISOString();
    const record: TradeLifecycleRecord = {
      id: this.idGenerator(),
      candidateId: input.candidateId,
      brokerProvider: input.brokerProvider,
      strategyId: input.strategyId,
      strategyVersion: input.strategyVersion,
      symbol: input.symbol,
      side: input.side,
      quantity: input.quantity,
      sizingMode: input.sizingMode,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit,
      decision: input.decision.action,
      confidence: input.decision.confidence,
      decisionReasons: input.decision.reasoning,
      marketDataSnapshot: input.marketDataSnapshot,
      intelligenceSummary: input.intelligenceSummary,
      status: "DECISION_CREATED",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.deps.store.create(record);
    await this.audit("TRADE_LIFECYCLE_CREATED", record, {
      decision: record.decision,
      confidence: record.confidence,
      quantity: record.quantity,
    });
    return record;
  }

  async recordRiskRejected(
    record: TradeLifecycleRecord,
    portfolioRiskDecision: PortfolioRiskDecision & { permitted: false },
  ): Promise<TradeLifecycleRecord> {
    const updated = await this.transition(record, "RISK_REJECTED", { portfolioRiskDecision });
    await this.audit("TRADE_RISK_REJECTED", updated, { blockedReasons: portfolioRiskDecision.blockedReasons });
    return updated;
  }

  async recordApproved(
    record: TradeLifecycleRecord,
    portfolioRiskDecision: PortfolioRiskDecision & { permitted: true },
  ): Promise<TradeLifecycleRecord> {
    const updated = await this.transition(record, "APPROVED", { portfolioRiskDecision });
    await this.audit("TRADE_APPROVED", updated, {
      accountEquity: portfolioRiskDecision.accountEquity,
      portfolioExposure: portfolioRiskDecision.portfolioExposure,
    });
    return updated;
  }

  async recordExecutionSubmitted(record: TradeLifecycleRecord): Promise<TradeLifecycleRecord> {
    const submittedAt = this.now().toISOString();
    const updated = await this.transition(record, "EXECUTION_SUBMITTED", { submittedAt });
    await this.audit("TRADE_EXECUTION_SUBMITTED", updated, {});
    return updated;
  }

  async recordOpened(record: TradeLifecycleRecord, input: RecordOpenedInput): Promise<TradeLifecycleRecord> {
    const openedAt = input.openedAt ?? this.now().toISOString();
    const updated = await this.transition(record, "OPEN", {
      entryPrice: input.entryPrice,
      brokerOrderId: input.brokerOrderId,
      brokerPositionId: input.brokerPositionId,
      openedAt,
    });
    // Telegram alert refinement. Enriched (additive only — every existing consumer of this event's
    // details reads a field already present before this change) so the TRADE OPENED Telegram
    // template (telegram-alerting-audit-trail.ts) can be built entirely from this one audit event,
    // without needing the full TradeLifecycleRecord: side/quantity/sizingMode/stopLoss/takeProfit
    // are the record's own frozen values, never re-derived or guessed.
    await this.audit("TRADE_OPENED", updated, {
      entryPrice: input.entryPrice,
      brokerOrderId: input.brokerOrderId,
      brokerPositionId: input.brokerPositionId,
      side: updated.side,
      quantity: updated.quantity,
      sizingMode: updated.sizingMode,
      stopLoss: updated.stopLoss,
      takeProfit: updated.takeProfit,
      openedAt,
    });
    return updated;
  }

  async recordExecutionFailed(record: TradeLifecycleRecord, input: RecordFailureInput): Promise<TradeLifecycleRecord> {
    const error = this.buildError(input);
    const updated = await this.transition(record, "EXECUTION_FAILED", { error });
    await this.audit("TRADE_EXECUTION_FAILED", updated, { message: error.message });
    return updated;
  }

  async recordCloseRequested(record: TradeLifecycleRecord): Promise<TradeLifecycleRecord> {
    const updated = await this.transition(record, "CLOSE_REQUESTED", {});
    await this.audit("TRADE_CLOSE_REQUESTED", updated, {});
    return updated;
  }

  async recordClosed(record: TradeLifecycleRecord, input: RecordClosedInput): Promise<TradeLifecycleRecord> {
    if (record.entryPrice === undefined || record.openedAt === undefined) {
      throw new Error(
        `Cannot close TradeLifecycleRecord "${record.id}" — it was never opened (missing entryPrice/openedAt).`,
      );
    }
    const closedAt = input.closedAt ?? this.now().toISOString();
    const realisedPnl = calculateRealisedPnl(record.sizingMode, record.side, record.entryPrice, input.exitPrice, record.quantity);
    const realisedPnlPercent = calculateRealisedPnlPercent(
      record.sizingMode,
      record.side,
      record.entryPrice,
      input.exitPrice,
      record.quantity,
    );
    const holdingDurationMs = calculateHoldingDurationMs(record.openedAt, closedAt);

    const updated = await this.transition(record, "CLOSED", {
      exitPrice: input.exitPrice,
      exitReason: input.exitReason,
      closedAt,
      realisedPnl,
      realisedPnlPercent,
      holdingDurationMs,
    });
    // Telegram alert refinement. Enriched (additive only, same reasoning as recordOpened's own
    // comment above) so the TRADE CLOSED Telegram template can be built entirely from this one
    // audit event: entryPrice/brokerPositionId are the record's own frozen/broker-confirmed values.
    await this.audit("TRADE_CLOSED", updated, {
      entryPrice: record.entryPrice,
      exitPrice: input.exitPrice,
      exitReason: input.exitReason,
      realisedPnl,
      realisedPnlPercent,
      holdingDurationMs,
      brokerPositionId: updated.brokerPositionId,
      closedAt,
    });
    return updated;
  }

  async recordCloseFailed(record: TradeLifecycleRecord, input: RecordFailureInput): Promise<TradeLifecycleRecord> {
    const error = this.buildError(input);
    const updated = await this.transition(record, "CLOSE_FAILED", { error });
    await this.audit("TRADE_CLOSE_FAILED", updated, { message: error.message });
    return updated;
  }

  /**
   * Recomputes MFE/MAE against `currentPrice` for a still-live trade (OPEN or CLOSE_REQUESTED —
   * see TradeLifecycleStore.listOpen's own doc comment for why both count as "live"). A no-op
   * (no store write, no audit event — "avoid redundant events that add no diagnostic value") when
   * neither figure actually changes, e.g. a price that hasn't moved past either extreme yet.
   */
  async updateExcursion(record: TradeLifecycleRecord, currentPrice: number): Promise<TradeLifecycleRecord> {
    if (record.status !== "OPEN" && record.status !== "CLOSE_REQUESTED") {
      throw new Error(
        `Cannot update excursion for TradeLifecycleRecord "${record.id}" in status ${record.status} — its position is not live.`,
      );
    }
    if (record.entryPrice === undefined) {
      throw new Error(`Cannot update excursion for TradeLifecycleRecord "${record.id}" — missing entryPrice.`);
    }

    const previous = {
      maximumFavourableExcursion: record.maximumFavourableExcursion ?? 0,
      maximumAdverseExcursion: record.maximumAdverseExcursion ?? 0,
    };
    const next = updateExcursionValues(record.sizingMode, record.side, record.entryPrice, currentPrice, record.quantity, previous);

    if (
      next.maximumFavourableExcursion === previous.maximumFavourableExcursion &&
      next.maximumAdverseExcursion === previous.maximumAdverseExcursion
    ) {
      return record;
    }

    const updated: TradeLifecycleRecord = { ...record, ...next, updatedAt: this.now().toISOString() };
    await this.deps.store.update(updated);
    await this.audit("TRADE_EXCURSION_UPDATED", updated, {
      currentPrice,
      maximumFavourableExcursion: next.maximumFavourableExcursion,
      maximumAdverseExcursion: next.maximumAdverseExcursion,
    });
    return updated;
  }

  /** Convenience lookup built on top of the store's required listOpen() — not a store method
   * itself, since "find the live record for this strategy+symbol" is service-level orchestration
   * logic (used by trade-lifecycle-runner.ts to find the record a SELL decision should close),
   * not a persistence primitive. */
  async findOpenRecord(strategyId: string, symbol: string): Promise<TradeLifecycleRecord | undefined> {
    const open = await this.deps.store.listOpen();
    return open.find((record) => record.strategyId === strategyId && record.symbol === symbol);
  }

  private async transition(
    record: TradeLifecycleRecord,
    to: TradeLifecycleStatus,
    patch: Partial<TradeLifecycleRecord>,
  ): Promise<TradeLifecycleRecord> {
    assertValidTransition(record.status, to);
    const updated: TradeLifecycleRecord = { ...record, ...patch, status: to, updatedAt: this.now().toISOString() };
    await this.deps.store.update(updated);
    return updated;
  }

  private buildError(input: RecordFailureInput): TradeLifecycleError {
    return { message: input.message, occurredAt: this.now().toISOString(), context: input.context };
  }

  private async audit(eventType: AuditEventType, record: TradeLifecycleRecord, details: Record<string, unknown>): Promise<void> {
    await this.deps.auditTrail.record({
      timestamp: this.now().toISOString(),
      eventType,
      executionRunId: this.deps.executionRunId,
      strategyId: record.strategyId,
      instrument: record.symbol,
      details: { tradeLifecycleId: record.id, status: record.status, ...details },
    });
  }
}
