import { at } from "./array-utils";
import type {
  EntryRule,
  ExitRule,
  InternalStrategy,
  MappingRejection,
  RawRegistryStrategy,
} from "./types";

/**
 * Translates a raw Hermes Strategy Registry document into this engine's own InternalStrategy
 * shape — the one place that understands the Hermes JSON at all. Nothing downstream of this
 * function (signal engine, risk engine, paper broker, runner) ever sees a RawRegistryStrategy.
 *
 * The registry schema's entryDefinition/exitDefinition carry a free-text `rule` description plus
 * a generic `parameters` object (see strategy-registry/schemas/strategy.schema.json — that schema
 * is intentionally generic here, not a gap this file works around). This mapper defines Trading
 * Intelligence's own small, closed convention for what a *structured*, executable rule inside
 * `parameters` looks like. A strategy whose parameters don't match that convention is rejected
 * clearly, by name — never approximated, never silently dropped, never given a fabricated default.
 *
 * Convention (Trading Intelligence side only — no Hermes Lab file encodes this):
 *   entryDefinition.parameters = { ruleType: "CROSSES_ABOVE_MA", period: number }
 *   exitDefinition.parameters  = { rules: Array<
 *       { ruleType: "TAKE_PROFIT"; percent: number }
 *     | { ruleType: "STOP_LOSS"; percent: number }
 *     | { ruleType: "CROSSES_BELOW_MA"; period: number }
 *   > }
 */
export function mapRegistryStrategyToInternal(
  raw: RawRegistryStrategy,
): { strategy: InternalStrategy } | { rejection: MappingRejection } {
  const reject = (reason: string): { rejection: MappingRejection } => ({
    rejection: { strategyId: raw.strategyId, reason },
  });

  if (raw.promotionStatus.decision !== "ELIGIBLE") {
    return reject(
      `promotionStatus.decision is "${raw.promotionStatus.decision}", not "ELIGIBLE" — refusing to enable a strategy the registry itself has not certified.`,
    );
  }

  if (raw.supportedMarkets.length !== 1) {
    return reject(
      `Unsupported supportedMarkets: this phase only executes a strategy scoped to exactly one instrument (got ${JSON.stringify(raw.supportedMarkets)}).`,
    );
  }
  const instrument = at(raw.supportedMarkets, 0);

  const entryParams = raw.entryDefinition.parameters;
  if (
    !entryParams ||
    entryParams.ruleType !== "CROSSES_ABOVE_MA" ||
    typeof entryParams.period !== "number" ||
    !Number.isInteger(entryParams.period) ||
    entryParams.period < 1
  ) {
    return reject(
      `Unsupported entryDefinition.parameters (expected { ruleType: "CROSSES_ABOVE_MA", period: <positive integer> }, got ${JSON.stringify(entryParams)}).`,
    );
  }
  const entryRules: EntryRule[] = [{ type: "CROSSES_ABOVE_MA", period: entryParams.period }];

  const exitParams = raw.exitDefinition.parameters;
  const rawExitRules = exitParams && Array.isArray(exitParams.rules) ? exitParams.rules : undefined;
  if (!rawExitRules || rawExitRules.length === 0) {
    return reject(
      `Unsupported exitDefinition.parameters (expected { rules: [...] } with at least one recognised rule, got ${JSON.stringify(exitParams)}).`,
    );
  }

  const exitRules: ExitRule[] = [];
  for (const [index, entry] of rawExitRules.entries()) {
    const item = entry as Record<string, unknown>;
    if (item.ruleType === "TAKE_PROFIT" || item.ruleType === "STOP_LOSS") {
      if (typeof item.percent !== "number" || item.percent <= 0) {
        return reject(
          `exitDefinition.parameters.rules[${index}] ("${item.ruleType}") needs a positive numeric percent, got ${JSON.stringify(item.percent)}.`,
        );
      }
      exitRules.push({ type: item.ruleType, percent: item.percent });
    } else if (item.ruleType === "CROSSES_BELOW_MA") {
      if (typeof item.period !== "number" || !Number.isInteger(item.period) || item.period < 1) {
        return reject(
          `exitDefinition.parameters.rules[${index}] ("CROSSES_BELOW_MA") needs a positive integer period, got ${JSON.stringify(item.period)}.`,
        );
      }
      exitRules.push({ type: "CROSSES_BELOW_MA", period: item.period });
    } else {
      return reject(
        `Unsupported exit rule type "${String(item.ruleType)}" at exitDefinition.parameters.rules[${index}] (supported: TAKE_PROFIT, STOP_LOSS, CROSSES_BELOW_MA).`,
      );
    }
  }

  const maxPositionValue = raw.riskDefinition.maxPositionSize;
  if (typeof maxPositionValue !== "number" || maxPositionValue <= 0) {
    return reject(
      `riskDefinition.maxPositionSize must be a positive number for this engine to size an order (got ${JSON.stringify(maxPositionValue)}).`,
    );
  }

  const strategy: InternalStrategy = {
    strategyId: raw.strategyId,
    version: raw.version,
    sourceType: "HERMES_APPROVED",
    enabled: true,
    instrument,
    timeframe: raw.timeframe,
    entryRules,
    exitRules,
    riskRules: { maxPositionValue },
  };

  return { strategy };
}
