import type { Account, OrderRequest, PaperPosition, RiskCheck } from "./types";

/**
 * Milestone 4 — Portfolio & Risk Engine. Sits between MarketDecisionEngine and the execution
 * runner (see market-decision-runner.ts): Market Data -> Market Intelligence -> Market Decision
 * Engine -> PortfolioRiskEngine -> (execution runner) -> Broker. Deliberately separate from
 * risk-engine.ts (the existing per-strategy, per-order risk gate used by the older
 * ExecutionRunner/signal-engine pipeline — untouched here): that one reasons about a single
 * strategy's own rules (is it enabled, does this order fit its own maxPositionValue); this one
 * reasons about the account as a whole — cash, equity, existing exposure, trade cadence, broker
 * health — independent of which strategy proposed the trade.
 *
 * `maxOpenPositions` is deliberately named `portfolioMaxOpenPositions` here, not `maxOpenPositions`
 * — risk-engine.ts's `RiskEngineConfig` has its own, separately-configured `strategyMaxOpenPositions`
 * ceiling for the older pipeline. Same domain concept, two different scopes/sources of truth; the
 * distinct names keep that from reading as one shared limit.
 */
export interface PortfolioRiskConfig {
  portfolioMaxOpenPositions: number;
  maxDailyTrades: number;
  /** Total notional value (existing open positions + the proposed order) permitted at once. */
  maxPortfolioExposure: number;
}

export interface PortfolioRiskInput {
  account: Account;
  openPositions: PaperPosition[];
  /** Trades already executed today — sourced by the caller (this engine never tracks time or
   * counts trades itself, keeping it a pure function of its inputs). */
  dailyTradeCount: number;
  /** Whether the broker is currently reachable — sourced by the caller (e.g. the result of a
   * connectivity check already performed before this cycle began). */
  brokerAvailable: boolean;
  /** The BUY order under consideration. SELL decisions never reach this engine (see
   * market-decision-runner.ts) — closing an existing position is always permitted. */
  proposedOrder: OrderRequest;
  config: PortfolioRiskConfig;
}

export type PortfolioRiskDecision =
  | { permitted: true; checks: RiskCheck[]; accountEquity: number; portfolioExposure: number }
  | {
      permitted: false;
      checks: RiskCheck[];
      accountEquity: number;
      portfolioExposure: number;
      blockedReasons: string[];
    };

function positionNotional(position: PaperPosition): number {
  return position.quantity * position.entryPrice;
}

/**
 * Evaluates whether a proposed BUY order is permitted at the portfolio level. Every check is
 * always evaluated (no short-circuiting), so a blocked decision reports every reason at once —
 * mirroring risk-engine.ts's own convention. `accountEquity`/`portfolioExposure` are always
 * returned (permitted or not) for audit/display purposes.
 */
export const PortfolioRiskEngine = {
  evaluate(input: PortfolioRiskInput): PortfolioRiskDecision {
    const { account, openPositions, dailyTradeCount, brokerAvailable, proposedOrder, config } = input;

    const existingExposure = openPositions.reduce((sum, p) => sum + positionNotional(p), 0);
    const orderValue = proposedOrder.quantity * proposedOrder.price;
    const projectedExposure = existingExposure + orderValue;
    const accountEquity = account.cashBalance + existingExposure;

    const checks: RiskCheck[] = [];

    checks.push({
      name: "broker-available",
      passed: brokerAvailable,
      detail: brokerAvailable ? "Broker is available." : "Broker is currently unavailable.",
    });

    const withinMaxOpenPositions = openPositions.length < config.portfolioMaxOpenPositions;
    checks.push({
      name: "max-open-positions",
      passed: withinMaxOpenPositions,
      detail: withinMaxOpenPositions
        ? `${openPositions.length} open position(s) is below the configured maximum of ${config.portfolioMaxOpenPositions}.`
        : `${openPositions.length} open position(s) already at the configured maximum of ${config.portfolioMaxOpenPositions}.`,
    });

    const withinMaxDailyTrades = dailyTradeCount < config.maxDailyTrades;
    checks.push({
      name: "max-daily-trades",
      passed: withinMaxDailyTrades,
      detail: withinMaxDailyTrades
        ? `${dailyTradeCount} trade(s) today is below the configured maximum of ${config.maxDailyTrades}.`
        : `${dailyTradeCount} trade(s) today already at the configured maximum of ${config.maxDailyTrades}.`,
    });

    const cashSufficient = orderValue <= account.cashBalance;
    checks.push({
      name: "sufficient-cash",
      passed: cashSufficient,
      detail: cashSufficient
        ? `Order value ${orderValue.toFixed(2)} is within available cash ${account.cashBalance.toFixed(2)}.`
        : `Order value ${orderValue.toFixed(2)} exceeds available cash ${account.cashBalance.toFixed(2)}.`,
    });

    const withinMaxExposure = projectedExposure <= config.maxPortfolioExposure;
    checks.push({
      name: "max-portfolio-exposure",
      passed: withinMaxExposure,
      detail: withinMaxExposure
        ? `Projected exposure ${projectedExposure.toFixed(2)} is within the configured maximum of ${config.maxPortfolioExposure}.`
        : `Projected exposure ${projectedExposure.toFixed(2)} exceeds the configured maximum of ${config.maxPortfolioExposure}.`,
    });

    const failed = checks.filter((c) => !c.passed);
    if (failed.length === 0) {
      return { permitted: true, checks, accountEquity, portfolioExposure: existingExposure };
    }
    return {
      permitted: false,
      checks,
      accountEquity,
      portfolioExposure: existingExposure,
      blockedReasons: failed.map((c) => c.detail),
    };
  },
};
