// Hermes Execution MVP Phase 1 — shared types for the isolated Strategy Registry -> paper
// trading pipeline. Deliberately separate from src/lib/types/strategy.ts and
// src/lib/strategy-engine/strategy.ts (two unrelated existing "Strategy" concepts) — nothing here
// is wired into either of them.

/**
 * HERMES_APPROVED strategies originate from the Hermes Strategy Registry (a strategy the registry
 * itself marked ELIGIBLE, per its own promotion framework). DEMO_ONLY strategies exist purely to
 * exercise this execution pipeline and must never be mistaken for research-backed evidence — see
 * demo-strategy.ts.
 */
export type StrategySourceType = "HERMES_APPROVED" | "DEMO_ONLY";

// The smallest closed rule vocabulary this phase supports. Anything a registry strategy asks for
// outside this set is a clear, logged rejection (internal-strategy-mapper.ts) — never silently
// ignored or approximated.
export type EntryRule = { type: "CROSSES_ABOVE_MA"; period: number };

export type ExitRule =
  | { type: "TAKE_PROFIT"; percent: number }
  | { type: "STOP_LOSS"; percent: number }
  | { type: "CROSSES_BELOW_MA"; period: number };

export interface RiskRules {
  /** Per-strategy notional cap for a single position, enforced by the risk engine. */
  maxPositionValue: number;
}

/** The execution engine's own strategy representation — registry documents are translated into
 * this shape once, at load time, so nothing downstream needs to know the Hermes JSON schema. */
export interface InternalStrategy {
  strategyId: string;
  version: number;
  sourceType: StrategySourceType;
  enabled: boolean;
  instrument: string;
  timeframe: string;
  entryRules: EntryRule[];
  exitRules: ExitRule[];
  riskRules: RiskRules;
  /** Set only for DEMO_ONLY strategies — an unmissable label, never present on a real strategy. */
  demoLabel?: string;
}

export interface Candle {
  symbol: string;
  timestamp: string; // ISO 8601
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type SignalAction = "NO_ACTION" | "ENTER_LONG" | "ENTER_SHORT" | "EXIT_POSITION";

export interface SignalDecision {
  strategyId: string;
  strategyVersion: number;
  instrument: string;
  timestamp: string;
  action: SignalAction;
  reason: string;
  evaluatedValues: Record<string, number | string | boolean>;
}

export type OrderSide = "BUY" | "SELL";

export interface OrderRequest {
  strategyId: string;
  strategyVersion: number;
  sourceType: StrategySourceType;
  instrument: string;
  side: OrderSide;
  quantity: number;
  price: number;
  timestamp: string;
  takeProfitPercent?: number;
  stopLossPercent?: number;
}

export interface RiskCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export type RiskDecision =
  | { decision: "APPROVED"; checks: RiskCheck[] }
  | { decision: "REJECTED"; checks: RiskCheck[]; reasons: string[] };

export interface Account {
  cashBalance: number;
  startingCashBalance: number;
}

export interface PaperPosition {
  positionId: string;
  strategyId: string;
  strategyVersion: number;
  sourceType: StrategySourceType;
  instrument: string;
  side: OrderSide;
  quantity: number;
  entryPrice: number;
  entryTimestamp: string;
  entryOrderId: string;
  takeProfitPercent?: number;
  stopLossPercent?: number;
}

export interface CompletedTrade {
  tradeId: string;
  positionId: string;
  strategyId: string;
  strategyVersion: number;
  sourceType: StrategySourceType;
  instrument: string;
  side: OrderSide;
  quantity: number;
  entryPrice: number;
  entryTimestamp: string;
  entryOrderId: string;
  exitPrice: number;
  exitTimestamp: string;
  exitOrderId: string;
  realisedPnl: number;
  closeReason: string;
}

export type AuditEventType =
  | "STRATEGY_LOADED"
  | "STRATEGY_REJECTED"
  | "CANDLE_PROCESSED"
  | "SIGNAL_GENERATED"
  | "RISK_APPROVED"
  | "RISK_REJECTED"
  | "ORDER_SUBMITTED"
  | "POSITION_OPENED"
  | "POSITION_CLOSED"
  | "REALISED_PNL"
  // Hyperliquid Testnet Adapter Phase 1 — broker/order lifecycle events. ORDER_SUBMITTED and
  // POSITION_CLOSED above are reused as-is (their meaning is identical here); only genuinely new
  // concepts get a new event type.
  | "BROKER_CONNECTION_ATTEMPTED"
  | "BROKER_CONNECTION_SUCCEEDED"
  | "BROKER_CONNECTION_FAILED"
  | "ORDER_ACKNOWLEDGED"
  | "ORDER_FILLED"
  | "ORDER_CANCELLED"
  | "SMOKE_TEST_COMPLETED"
  | "SMOKE_TEST_FAILED"
  // Distinct from SMOKE_TEST_FAILED: an order stuck in NEW because the market is closed
  // (Trading212 queues market orders until the exchange reopens — documented, expected behaviour)
  // is not a broker/adapter failure, so it gets its own event type rather than being conflated
  // with a genuine failure.
  | "SMOKE_TEST_INCONCLUSIVE"
  // eToro Demo Adapter Phase 1 — genuinely new concepts only; everything reusable (ORDER_SUBMITTED,
  // ORDER_ACKNOWLEDGED, ORDER_FILLED, POSITION_OPENED, POSITION_CLOSED, ORDER_CANCELLED,
  // BROKER_CONNECTION_*, SMOKE_TEST_*) is reused as-is, same convention as the Hyperliquid/
  // Trading212 phases above.
  //
  // POSITION_CONFIRMED: eToro's API gives no single authoritative "this order became this
  // position" response — the adapter re-fetches the demo portfolio and matches the new position
  // by the order response's own identifier. This event marks that independent confirmation,
  // distinct from POSITION_OPENED (which fires as soon as the broker maps the order response,
  // before that confirmation happens).
  | "POSITION_CONFIRMED"
  // POSITION_CLOSE_SUBMITTED: distinct from POSITION_CLOSED (which means the close was confirmed)
  // — eToro's close call and its confirmation are two separate steps (submit, then re-fetch the
  // portfolio to confirm), unlike Hyperliquid/Trading212 where a single call's response is the
  // fill.
  | "POSITION_CLOSE_SUBMITTED"
  // Distinct from SMOKE_TEST_FAILED/SMOKE_TEST_INCONCLUSIVE: an order or position may still be
  // active and the script could not safely confirm cleanup — this demands manual follow-up, not
  // just "the test didn't pass."
  | "SMOKE_TEST_CLEANUP_REQUIRED"
  // eToro order reconciliation — confirmed live that a plain market order's response never
  // includes positionId, only { orderId, token }, so reconciling it into a concrete position means
  // polling the demo portfolio for a position whose own orderID matches. POSITION_CONFIRMED
  // (above) already covers "reconciliation succeeded" — these three cover the other observable
  // states of that polling process, not duplicated elsewhere.
  | "RECONCILIATION_STARTED"
  | "RECONCILIATION_PENDING"
  | "RECONCILIATION_TIMED_OUT"
  // eToro close verification — confirmed live that a position can still appear open on the very
  // first portfolio read right after closeDemoPosition() resolves, then disappear a few seconds
  // later (the same eventual-consistency behaviour as order reconciliation, applied symmetrically
  // to closing). POSITION_CLOSED (existing) already covers "close verified" once this polling
  // succeeds — not duplicated here.
  | "CLOSE_VERIFICATION_STARTED"
  | "CLOSE_VERIFICATION_PENDING"
  | "CLOSE_VERIFICATION_TIMED_OUT";

export interface AuditEvent {
  timestamp: string;
  eventType: AuditEventType;
  executionRunId: string;
  strategyId?: string;
  strategyVersion?: number;
  sourceType?: StrategySourceType;
  instrument?: string;
  details: Record<string, unknown>;
}

// --- Registry consumer types -------------------------------------------------------------------

/** The Hermes strategy-registry document shape this phase understands (schemaVersion "1.0.0").
 * Deliberately a partial, defensive view — only the fields this pipeline actually reads. */
export interface RawRegistryStrategy {
  schemaVersion: string;
  strategyId: string;
  version: number;
  status: string;
  sourceHypothesisId: string;
  supportingResearchRuns: string[];
  promotionStatus: {
    decision: string;
    evaluatedAt: string;
    reasoning: string;
    evaluatedAgainstGovernanceVersion: string;
  };
  supportedMarkets: string[];
  timeframe: string;
  entryDefinition: { rule: string; parameters?: Record<string, unknown> };
  exitDefinition: { rule: string; parameters?: Record<string, unknown> };
  riskDefinition: {
    maxPositionSize: number | null;
    maxDrawdownHalt: number | null;
    notes?: string;
  };
  confidence: { level: string; reasoning: string };
  createdAt: string;
  lastReviewedAt: string;
}

export interface RegistryRejection {
  /** The file path or identifier of the offending document, for diagnostics. */
  source: string;
  reason: string;
}

export interface RegistryLoadResult {
  strategies: RawRegistryStrategy[];
  rejected: RegistryRejection[];
}

export interface MappingRejection {
  strategyId: string;
  reason: string;
}
