import "server-only";
import { getHermesExecutionConfig } from "./config";
import { FileSystemRegistryClient } from "./registry-client";
import { loadEnabledStrategies } from "./strategy-loader";
import { JsonFilePaperBrokerStore } from "./json-file-paper-broker-store";
import { JsonFileAuditTrail } from "./json-file-audit-trail";
import type { AuditEvent, CompletedTrade, PaperPosition } from "./types";

export interface HermesExecutionStatus {
  executionMode: string;
  demoExecutionModeEnabled: boolean;
  registryConfigured: boolean;
  registryPath: string | undefined;
  registryConnected: boolean;
  hermesApprovedCount: number;
  demoStrategyActive: boolean;
  openPositions: PaperPosition[];
  completedTrades: CompletedTrade[];
  realisedPnl: number;
  latestEvent: AuditEvent | null;
  /** Set only if reading configuration/status itself failed — the panel must render a clear
   * "unavailable" state from this rather than let the error propagate and break the page. */
  error?: string;
}

function emptyStatus(overrides: Partial<HermesExecutionStatus>): HermesExecutionStatus {
  return {
    executionMode: "paper",
    demoExecutionModeEnabled: false,
    registryConfigured: false,
    registryPath: undefined,
    registryConnected: false,
    hermesApprovedCount: 0,
    demoStrategyActive: false,
    openPositions: [],
    completedTrades: [],
    realisedPnl: 0,
    latestEvent: null,
    ...overrides,
  };
}

/** Read-only status snapshot for the Operations Centre panel. Never throws — any failure (bad
 * config, unreadable files) is captured into `.error` so the page always renders something useful
 * instead of crashing the whole system-health route. */
export async function getHermesExecutionStatus(): Promise<HermesExecutionStatus> {
  let config;
  try {
    config = getHermesExecutionConfig();
  } catch (error) {
    return emptyStatus({ error: error instanceof Error ? error.message : String(error) });
  }

  if (!config.registryPath) {
    return emptyStatus({
      executionMode: config.executionMode,
      demoExecutionModeEnabled: config.demoExecutionModeEnabled,
    });
  }

  try {
    const registryClient = new FileSystemRegistryClient(config.registryPath);
    const registryConnected = await registryClient.isConnected();
    const loadResult = await loadEnabledStrategies({
      registryClient,
      demoExecutionModeEnabled: config.demoExecutionModeEnabled,
      executionRunId: "system-health-status-check",
    });

    const brokerState = await new JsonFilePaperBrokerStore().load();
    const auditTrail = await JsonFileAuditTrail.loadExisting();
    const latestEvent = await auditTrail.getLatestEvent();

    const completedTrades = brokerState?.completedTrades ?? [];
    const openPositions = brokerState?.openPositions ?? [];
    const realisedPnl = completedTrades.reduce((sum, trade) => sum + trade.realisedPnl, 0);

    return {
      executionMode: config.executionMode,
      demoExecutionModeEnabled: config.demoExecutionModeEnabled,
      registryConfigured: true,
      registryPath: config.registryPath,
      registryConnected,
      hermesApprovedCount: loadResult.hermesApprovedCount,
      demoStrategyActive: loadResult.demoModeActive,
      openPositions,
      completedTrades,
      realisedPnl,
      latestEvent,
    };
  } catch (error) {
    return emptyStatus({
      executionMode: config.executionMode,
      demoExecutionModeEnabled: config.demoExecutionModeEnabled,
      registryConfigured: true,
      registryPath: config.registryPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
