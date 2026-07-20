import type { Account, InternalStrategy, OrderRequest, PaperPosition, RiskCheck, RiskDecision } from "./types";

export interface RiskEngineConfig {
  demoExecutionModeEnabled: boolean;
  maxOpenPositions: number;
}

/**
 * The smallest useful pre-trade risk layer, invoked only for an order that would OPEN a new
 * position (exits go straight from the signal engine to the broker — see execution-runner.ts;
 * this MVP never risk-gates closing a position, only opening one). Every check is always
 * evaluated (no short-circuiting) so a REJECTED decision can report every reason at once, mirroring
 * the existing Bot Runner's BotRiskCheck convention (src/lib/bot/types.ts).
 */
export function evaluateRisk(
  strategy: InternalStrategy,
  order: OrderRequest,
  account: Account,
  openPositions: PaperPosition[],
  config: RiskEngineConfig,
): RiskDecision {
  const checks: RiskCheck[] = [];

  checks.push({
    name: "strategy-enabled",
    passed: strategy.enabled,
    detail: strategy.enabled ? "Strategy is enabled." : "Strategy is not enabled.",
  });

  const sourcePermitted =
    strategy.sourceType === "HERMES_APPROVED" ||
    (strategy.sourceType === "DEMO_ONLY" && config.demoExecutionModeEnabled);
  checks.push({
    name: "strategy-source-permitted",
    passed: sourcePermitted,
    detail: sourcePermitted
      ? `Source ${strategy.sourceType} is permitted in the current mode.`
      : `Source ${strategy.sourceType} is not permitted unless DEMO_EXECUTION_MODE=true.`,
  });

  const hasDuplicatePosition = openPositions.some(
    (p) => p.strategyId === strategy.strategyId && p.instrument === order.instrument,
  );
  checks.push({
    name: "no-duplicate-position",
    passed: !hasDuplicatePosition,
    detail: hasDuplicatePosition
      ? `Strategy ${strategy.strategyId} already has an open position on ${order.instrument}.`
      : "No existing open position for this strategy and instrument.",
  });

  checks.push({
    name: "quantity-positive",
    passed: order.quantity > 0,
    detail: order.quantity > 0 ? `Quantity ${order.quantity} is positive.` : `Quantity ${order.quantity} must be positive.`,
  });

  const orderValue = order.quantity * order.price;
  const cashSufficient = orderValue <= account.cashBalance;
  checks.push({
    name: "sufficient-cash",
    passed: cashSufficient,
    detail: cashSufficient
      ? `Order value ${orderValue.toFixed(2)} is within available cash ${account.cashBalance.toFixed(2)}.`
      : `Order value ${orderValue.toFixed(2)} exceeds available cash ${account.cashBalance.toFixed(2)}.`,
  });

  const withinMaxPositionValue = orderValue <= strategy.riskRules.maxPositionValue;
  checks.push({
    name: "max-position-value",
    passed: withinMaxPositionValue,
    detail: withinMaxPositionValue
      ? `Order value ${orderValue.toFixed(2)} is within the strategy's max position value ${strategy.riskRules.maxPositionValue}.`
      : `Order value ${orderValue.toFixed(2)} exceeds the strategy's max position value ${strategy.riskRules.maxPositionValue}.`,
  });

  const withinMaxOpenPositions = openPositions.length < config.maxOpenPositions;
  checks.push({
    name: "max-open-positions",
    passed: withinMaxOpenPositions,
    detail: withinMaxOpenPositions
      ? `${openPositions.length} open position(s) is below the configured maximum of ${config.maxOpenPositions}.`
      : `${openPositions.length} open position(s) already at the configured maximum of ${config.maxOpenPositions}.`,
  });

  const takeProfitValid = order.takeProfitPercent === undefined || (order.takeProfitPercent > 0 && order.takeProfitPercent < 100);
  const stopLossValid = order.stopLossPercent === undefined || (order.stopLossPercent > 0 && order.stopLossPercent < 100);
  checks.push({
    name: "valid-take-profit-stop-loss",
    passed: takeProfitValid && stopLossValid,
    detail:
      takeProfitValid && stopLossValid
        ? "Take-profit/stop-loss percentages (if set) are within (0, 100)."
        : `Invalid take-profit (${order.takeProfitPercent}) or stop-loss (${order.stopLossPercent}) percentage.`,
  });

  const failed = checks.filter((c) => !c.passed);
  if (failed.length === 0) {
    return { decision: "APPROVED", checks };
  }
  return { decision: "REJECTED", checks, reasons: failed.map((c) => c.detail) };
}
