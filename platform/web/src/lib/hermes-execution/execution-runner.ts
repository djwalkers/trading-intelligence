import { at } from "./array-utils";
import { evaluateSignal } from "./signal-engine";
import { evaluateRisk, type RiskEngineConfig } from "./risk-engine";
import type { AuditTrail } from "./audit-trail";
import type { MarketDataProvider } from "./fixture-market-data-provider";
import type { PaperBroker } from "./paper-broker";
import type { Candle, InternalStrategy, OrderRequest } from "./types";

export interface ExecutionRunnerDeps {
  strategies: InternalStrategy[];
  marketData: MarketDataProvider;
  broker: PaperBroker;
  auditTrail: AuditTrail;
  riskConfig: RiskEngineConfig;
  executionRunId: string;
}

export interface ExecutionSummary {
  candlesProcessed: number;
  entriesOpened: number;
  exitsClosed: number;
  riskRejections: number;
}

function extractPercent(strategy: InternalStrategy, ruleType: "TAKE_PROFIT" | "STOP_LOSS"): number | undefined {
  const rule = strategy.exitRules.find((r) => r.type === ruleType);
  return rule && "percent" in rule ? rule.percent : undefined;
}

/**
 * Coordinates: load enabled strategies (done by the caller, passed in already-loaded) -> receive
 * the next market candle -> evaluate entry/exit -> risk check -> execute via PaperBroker -> record
 * the outcome. Guards, all enforced structurally rather than by convention:
 *   - duplicate candle processing: a Set of `${instrument}-${timestamp}` keys already seen
 *   - duplicate orders from the same signal / repeated positions: re-checked against the broker's
 *     live open-position list immediately before submitting an entry (on top of the risk engine's
 *     own duplicate-position check and the broker's own duplicate-position guard — three
 *     independent layers, not one)
 *   - exiting a position more than once: an exit is only attempted when an open position for that
 *     strategy+instrument still exists in the broker's live list; PaperBroker.closePosition also
 *     throws clearly if the position id is already gone
 */
export class ExecutionRunner {
  private readonly processedCandleKeys = new Set<string>();

  constructor(private readonly deps: ExecutionRunnerDeps) {}

  async run(): Promise<ExecutionSummary> {
    const summary: ExecutionSummary = {
      candlesProcessed: 0,
      entriesOpened: 0,
      exitsClosed: 0,
      riskRejections: 0,
    };

    const strategiesByInstrument = new Map<string, InternalStrategy[]>();
    for (const strategy of this.deps.strategies) {
      if (!strategy.enabled) continue;
      const list = strategiesByInstrument.get(strategy.instrument) ?? [];
      list.push(strategy);
      strategiesByInstrument.set(strategy.instrument, list);
    }

    for (const [instrument, strategies] of strategiesByInstrument) {
      const candles = this.deps.marketData.getCandles(instrument);

      for (let i = 0; i < candles.length; i++) {
        const candle = at(candles, i);
        const candleKey = `${instrument}-${candle.timestamp}`;
        if (this.processedCandleKeys.has(candleKey)) continue;
        this.processedCandleKeys.add(candleKey);

        const window = candles.slice(0, i + 1);
        summary.candlesProcessed += 1;

        await this.deps.auditTrail.record({
          timestamp: candle.timestamp,
          eventType: "CANDLE_PROCESSED",
          executionRunId: this.deps.executionRunId,
          instrument,
          details: { close: candle.close, index: i },
        });

        for (const strategy of strategies) {
          await this.evaluateStrategyOnCandle(strategy, window, summary);
        }
      }
    }

    return summary;
  }

  private async evaluateStrategyOnCandle(
    strategy: InternalStrategy,
    window: Candle[],
    summary: ExecutionSummary,
  ): Promise<void> {
    const current = at(window, window.length - 1);
    const openPositions = this.deps.broker.getOpenPositions();
    const existingPosition =
      openPositions.find(
        (p) => p.strategyId === strategy.strategyId && p.instrument === strategy.instrument,
      ) ?? null;

    const signal = evaluateSignal(strategy, window, existingPosition);

    await this.deps.auditTrail.record({
      timestamp: signal.timestamp,
      eventType: "SIGNAL_GENERATED",
      executionRunId: this.deps.executionRunId,
      strategyId: strategy.strategyId,
      strategyVersion: strategy.version,
      sourceType: strategy.sourceType,
      instrument: strategy.instrument,
      details: { action: signal.action, reason: signal.reason, evaluatedValues: signal.evaluatedValues },
    });

    if (signal.action === "NO_ACTION") return;

    if (signal.action === "ENTER_LONG") {
      if (existingPosition) return; // duplicate-entry guard

      const quantity = Math.floor(strategy.riskRules.maxPositionValue / current.close);
      const order: OrderRequest = {
        strategyId: strategy.strategyId,
        strategyVersion: strategy.version,
        sourceType: strategy.sourceType,
        instrument: strategy.instrument,
        side: "BUY",
        quantity,
        price: current.close,
        timestamp: current.timestamp,
        takeProfitPercent: extractPercent(strategy, "TAKE_PROFIT"),
        stopLossPercent: extractPercent(strategy, "STOP_LOSS"),
      };

      const account = this.deps.broker.getAccount();
      const riskDecision = evaluateRisk(strategy, order, account, openPositions, this.deps.riskConfig);

      await this.deps.auditTrail.record({
        timestamp: current.timestamp,
        eventType: riskDecision.decision === "APPROVED" ? "RISK_APPROVED" : "RISK_REJECTED",
        executionRunId: this.deps.executionRunId,
        strategyId: strategy.strategyId,
        strategyVersion: strategy.version,
        sourceType: strategy.sourceType,
        instrument: strategy.instrument,
        details:
          riskDecision.decision === "APPROVED"
            ? { checks: riskDecision.checks }
            : { checks: riskDecision.checks, reasons: riskDecision.reasons },
      });

      if (riskDecision.decision === "REJECTED") {
        summary.riskRejections += 1;
        return;
      }

      await this.deps.auditTrail.record({
        timestamp: current.timestamp,
        eventType: "ORDER_SUBMITTED",
        executionRunId: this.deps.executionRunId,
        strategyId: strategy.strategyId,
        strategyVersion: strategy.version,
        sourceType: strategy.sourceType,
        instrument: strategy.instrument,
        details: { side: order.side, quantity: order.quantity, price: order.price },
      });

      const { position, orderId } = await this.deps.broker.placeMarketOrder(order);

      await this.deps.auditTrail.record({
        timestamp: current.timestamp,
        eventType: "POSITION_OPENED",
        executionRunId: this.deps.executionRunId,
        strategyId: strategy.strategyId,
        strategyVersion: strategy.version,
        sourceType: strategy.sourceType,
        instrument: strategy.instrument,
        details: {
          positionId: position.positionId,
          orderId,
          entryPrice: position.entryPrice,
          quantity: position.quantity,
        },
      });

      summary.entriesOpened += 1;
      return;
    }

    if (signal.action === "EXIT_POSITION") {
      if (!existingPosition) return; // no position to exit — duplicate-exit guard

      const { trade, orderId } = await this.deps.broker.closePosition(
        existingPosition.positionId,
        current.close,
        current.timestamp,
        signal.reason,
      );

      await this.deps.auditTrail.record({
        timestamp: current.timestamp,
        eventType: "POSITION_CLOSED",
        executionRunId: this.deps.executionRunId,
        strategyId: strategy.strategyId,
        strategyVersion: strategy.version,
        sourceType: strategy.sourceType,
        instrument: strategy.instrument,
        details: { positionId: existingPosition.positionId, orderId, exitPrice: current.close },
      });

      await this.deps.auditTrail.record({
        timestamp: current.timestamp,
        eventType: "REALISED_PNL",
        executionRunId: this.deps.executionRunId,
        strategyId: strategy.strategyId,
        strategyVersion: strategy.version,
        sourceType: strategy.sourceType,
        instrument: strategy.instrument,
        details: { tradeId: trade.tradeId, realisedPnl: trade.realisedPnl },
      });

      summary.exitsClosed += 1;
    }
  }
}
