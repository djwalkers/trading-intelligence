import type { RegistryClient } from "./registry-client";
import { mapRegistryStrategyToInternal } from "./internal-strategy-mapper";
import { getDemoStrategy } from "./demo-strategy";
import type { AuditEvent, InternalStrategy } from "./types";

export interface StrategyRejectionRecord {
  source: string;
  reason: string;
}

export interface StrategyLoadSummary {
  strategies: InternalStrategy[];
  hermesApprovedCount: number;
  demoModeActive: boolean;
  registryConnected: boolean;
  rejections: StrategyRejectionRecord[];
  /** STRATEGY_LOADED / STRATEGY_REJECTED audit events — the caller appends these to the audit trail. */
  events: AuditEvent[];
}

export interface LoadStrategiesOptions {
  registryClient: RegistryClient;
  demoExecutionModeEnabled: boolean;
  executionRunId: string;
  /** Injectable clock for deterministic tests; defaults to the real time. */
  now?: () => string;
}

/**
 * Combines HERMES_APPROVED strategies (read from the registry, then translated by
 * internal-strategy-mapper.ts) with the DEMO_ONLY strategy (only when demo mode is enabled) into
 * one enabled-strategy set. Never throws on a malformed or rejected individual strategy — a bad
 * document is recorded as a rejection and skipped, exactly like `registryConnected: false` /
 * `strategies: []` is a valid outcome, not a failure of this function.
 */
export async function loadEnabledStrategies(
  options: LoadStrategiesOptions,
): Promise<StrategyLoadSummary> {
  const { registryClient, demoExecutionModeEnabled, executionRunId } = options;
  const now = options.now ?? (() => new Date().toISOString());

  const events: AuditEvent[] = [];
  const rejections: StrategyRejectionRecord[] = [];
  const strategies: InternalStrategy[] = [];

  const registryConnected = await registryClient.isConnected();
  const { strategies: rawStrategies, rejected: registryRejections } =
    await registryClient.listActiveStrategies();

  for (const rejection of registryRejections) {
    rejections.push(rejection);
    events.push({
      timestamp: now(),
      eventType: "STRATEGY_REJECTED",
      executionRunId,
      details: { source: rejection.source, reason: rejection.reason, stage: "registry-validation" },
    });
  }

  for (const raw of rawStrategies) {
    const mapped = mapRegistryStrategyToInternal(raw);
    if ("rejection" in mapped) {
      rejections.push({ source: raw.strategyId, reason: mapped.rejection.reason });
      events.push({
        timestamp: now(),
        eventType: "STRATEGY_REJECTED",
        executionRunId,
        strategyId: raw.strategyId,
        strategyVersion: raw.version,
        sourceType: "HERMES_APPROVED",
        details: { reason: mapped.rejection.reason, stage: "internal-mapping" },
      });
      continue;
    }

    strategies.push(mapped.strategy);
    events.push({
      timestamp: now(),
      eventType: "STRATEGY_LOADED",
      executionRunId,
      strategyId: mapped.strategy.strategyId,
      strategyVersion: mapped.strategy.version,
      sourceType: "HERMES_APPROVED",
      instrument: mapped.strategy.instrument,
      details: {},
    });
  }

  const demoStrategy = getDemoStrategy(demoExecutionModeEnabled);
  if (demoStrategy) {
    strategies.push(demoStrategy);
    events.push({
      timestamp: now(),
      eventType: "STRATEGY_LOADED",
      executionRunId,
      strategyId: demoStrategy.strategyId,
      strategyVersion: demoStrategy.version,
      sourceType: "DEMO_ONLY",
      instrument: demoStrategy.instrument,
      details: { demoLabel: demoStrategy.demoLabel },
    });
  }

  return {
    strategies,
    hermesApprovedCount: strategies.filter((s) => s.sourceType === "HERMES_APPROVED").length,
    demoModeActive: demoStrategy !== null,
    registryConnected,
    rejections,
    events,
  };
}
