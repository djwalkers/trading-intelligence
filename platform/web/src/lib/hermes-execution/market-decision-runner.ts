import { MarketDecisionEngine, type MarketDecision, type MarketDecisionContext } from "./market-decision-engine";
import { PortfolioRiskEngine, type PortfolioRiskConfig } from "./portfolio-risk-engine";
import type { PaperBroker } from "./paper-broker";
import type { AuditTrail } from "./audit-trail";
import type { CompletedTrade, OrderRequest, PaperPosition } from "./types";

/**
 * Milestone 2/3 — Market Decision Integration + Rich Market Context. Deliberately broker-agnostic:
 * everything here goes through the existing, unmodified `PaperBroker` interface
 * (`getOpenPositions`, `placeMarketOrder`, `closePosition`) — the same interface LocalPaperBroker,
 * HyperliquidTestnetBroker, Trading212DemoBroker, and EtoroDemoBroker already implement. Nothing in
 * this file knows or cares which concrete broker it was given.
 *
 * As of Milestone 3, this runner no longer builds the market context itself (it used to construct
 * a flat `{instrument, bid, ask, spread, positionOpen}` object inline) — assembling the full,
 * richer `MarketDecisionContext` is now MarketIntelligenceBuilder's job, done by the caller (the
 * CLI) before this function is ever invoked, matching the target pipeline: Market Data Provider ->
 * Market Intelligence Builder -> MarketDecisionContext -> MarketDecisionEngine ->
 * PortfolioRiskEngine -> (this runner) -> Broker.
 *
 * As of Milestone 4, a BUY decision is no longer executed unconditionally: PortfolioRiskEngine
 * evaluates it first (see portfolio-risk-engine.ts), and a blocked BUY is converted to a no-trade
 * outcome with `executed: false` and `blockedReasons` set, exactly like a HOLD except the decision
 * itself was still BUY. SELL decisions for an existing position are never risk-gated here — closing
 * a position always remains permitted, per the milestone's own requirement.
 */
export interface MarketDecisionCycleInput {
  broker: PaperBroker;
  auditTrail: AuditTrail;
  executionRunId: string;
  /** Fully assembled by MarketIntelligenceBuilder before this is called — this runner never
   * computes or fetches any of it, only reads `marketContext.instrument`/`bid`/`ask` to act on the
   * resulting decision. */
  marketContext: MarketDecisionContext;
  /** Order size (a share/unit count for equity-style brokers, a CFD notional amount for eToro —
   * whichever the concrete broker expects for `OrderRequest.quantity`). Sourcing this value is the
   * caller's responsibility; this runner never invents or defaults it. */
  amount: number;
  /** Portfolio-level governance inputs consulted only for a BUY decision (see
   * portfolio-risk-engine.ts) — dailyTradeCount/brokerAvailable are observed facts this runner
   * never computes itself, sourced by the caller. */
  portfolioRisk: {
    config: PortfolioRiskConfig;
    dailyTradeCount: number;
    brokerAvailable: boolean;
  };
  /** Injectable for deterministic tests; defaults to `marketContext.timestamp`. */
  timestamp?: string;
}

export interface MarketDecisionCycleResult {
  decision: MarketDecision;
  executed: boolean;
  position?: PaperPosition;
  trade?: CompletedTrade;
  orderId?: string;
  /** Set only when a BUY decision was blocked by PortfolioRiskEngine (converted to no-trade). */
  blockedReasons?: string[];
}

/**
 * Runs exactly one market decision cycle: ask MarketDecisionEngine for a decision from the
 * already-built market context, record it (plus the market-intelligence fields that drove it) to
 * the audit trail, then act on it (or don't) via the broker's own existing order-placement/close
 * methods — which continue to emit their own existing audit events (ORDER_SUBMITTED,
 * POSITION_OPENED, POSITION_CLOSED, ...) exactly as they already did; nothing here duplicates them.
 */
export async function runMarketDecisionCycle(
  input: MarketDecisionCycleInput,
): Promise<MarketDecisionCycleResult> {
  const { broker, auditTrail, executionRunId, marketContext, amount } = input;
  const timestamp = input.timestamp ?? marketContext.timestamp;
  const { instrument, strategy, ema20, ema50, rsi14, trend } = marketContext;

  const decision = MarketDecisionEngine.evaluate(marketContext);

  const emaRelationship = ema20 > ema50 ? "EMA20>EMA50" : ema20 < ema50 ? "EMA20<EMA50" : "EMA20=EMA50";

  await auditTrail.record({
    timestamp,
    eventType: "MARKET_DECISION_RECEIVED",
    executionRunId,
    strategyId: strategy.strategyId,
    strategyVersion: strategy.version,
    sourceType: strategy.sourceType,
    instrument,
    // Milestone 3: extended with the market-intelligence fields that drove this decision (trend,
    // RSI, EMA relationship) alongside the existing action/confidence/reasoning — no new event
    // type, this is still MARKET_DECISION_RECEIVED, just a richer details payload.
    details: {
      action: decision.action,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      trend,
      rsi14,
      emaRelationship,
    },
  });

  if (decision.action === "HOLD") {
    await auditTrail.record({
      timestamp,
      eventType: "EXECUTION_SKIPPED",
      executionRunId,
      strategyId: strategy.strategyId,
      instrument,
      details: { action: decision.action, reasoning: decision.reasoning },
    });
    return { decision, executed: false };
  }

  if (decision.action === "BUY") {
    const order: OrderRequest = {
      strategyId: strategy.strategyId,
      strategyVersion: strategy.version,
      sourceType: strategy.sourceType,
      instrument,
      side: "BUY",
      quantity: amount,
      price: marketContext.ask,
      timestamp,
    };

    await auditTrail.record({
      timestamp,
      eventType: "RISK_CHECK_STARTED",
      executionRunId,
      strategyId: strategy.strategyId,
      instrument,
      details: { action: decision.action },
    });

    const riskContext = PortfolioRiskEngine.evaluate({
      account: broker.getAccount(),
      openPositions: broker.getOpenPositions(),
      dailyTradeCount: input.portfolioRisk.dailyTradeCount,
      brokerAvailable: input.portfolioRisk.brokerAvailable,
      proposedOrder: order,
      config: input.portfolioRisk.config,
    });

    await auditTrail.record({
      timestamp,
      eventType: riskContext.permitted ? "RISK_CHECK_PASSED" : "RISK_CHECK_FAILED",
      executionRunId,
      strategyId: strategy.strategyId,
      instrument,
      details: riskContext.permitted
        ? {
            checks: riskContext.checks,
            accountEquity: riskContext.accountEquity,
            portfolioExposure: riskContext.portfolioExposure,
          }
        : {
            checks: riskContext.checks,
            accountEquity: riskContext.accountEquity,
            portfolioExposure: riskContext.portfolioExposure,
            blockedReasons: riskContext.blockedReasons,
          },
    });

    if (!riskContext.permitted) {
      await auditTrail.record({
        timestamp,
        eventType: "EXECUTION_SKIPPED",
        executionRunId,
        strategyId: strategy.strategyId,
        instrument,
        details: { action: "NO_TRADE", originalAction: decision.action, reasons: riskContext.blockedReasons },
      });
      return { decision, executed: false, blockedReasons: riskContext.blockedReasons };
    }

    await auditTrail.record({
      timestamp,
      eventType: "EXECUTION_TRIGGERED",
      executionRunId,
      strategyId: strategy.strategyId,
      instrument,
      details: { action: decision.action },
    });

    const result = await broker.placeMarketOrder(order);
    return { decision, executed: true, position: result.position, orderId: result.orderId };
  }

  // decision.action === "SELL". MarketDecisionEngine only ever returns SELL when positionOpen was
  // true moments earlier, so a missing position here would mean broker state changed out from
  // under this cycle — not expected in a single-shot run, but a clear failure beats a silent no-op
  // or a guess.
  const openPosition = broker.getOpenPositions().find((p) => p.instrument === instrument);
  if (!openPosition) {
    throw new Error(`Market decision engine decided SELL for ${instrument}, but no open position exists to close.`);
  }

  await auditTrail.record({
    timestamp,
    eventType: "EXECUTION_TRIGGERED",
    executionRunId,
    strategyId: strategy.strategyId,
    instrument,
    details: { action: decision.action, positionId: openPosition.positionId },
  });

  const result = await broker.closePosition(openPosition.positionId, marketContext.bid, timestamp, "market-decision-sell");
  return { decision, executed: true, trade: result.trade, orderId: result.orderId };
}
