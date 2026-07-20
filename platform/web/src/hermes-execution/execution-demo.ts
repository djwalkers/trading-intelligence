import * as path from "node:path";
import { getHermesExecutionConfig } from "@/lib/hermes-execution/config";
import { FileSystemRegistryClient } from "@/lib/hermes-execution/registry-client";
import { loadEnabledStrategies } from "@/lib/hermes-execution/strategy-loader";
import { loadFixtureCandles } from "@/lib/hermes-execution/load-fixture-candles";
import { FixtureMarketDataProvider } from "@/lib/hermes-execution/fixture-market-data-provider";
import { LocalPaperBroker } from "@/lib/hermes-execution/paper-broker";
import { JsonFilePaperBrokerStore } from "@/lib/hermes-execution/json-file-paper-broker-store";
import { JsonFileAuditTrail } from "@/lib/hermes-execution/json-file-audit-trail";
import { ExecutionRunner } from "@/lib/hermes-execution/execution-runner";
import type { AuditEvent } from "@/lib/hermes-execution/types";

const FIXTURE_PATH = path.join(process.cwd(), "src", "hermes-execution", "fixtures", "demo-candles.json");

function formatEventLine(event: AuditEvent): string {
  const parts = [`[${event.eventType}]`];
  if (event.strategyId) parts.push(`${event.strategyId} v${event.strategyVersion} (${event.sourceType})`);
  if (event.instrument) parts.push(event.instrument);

  switch (event.eventType) {
    case "CANDLE_PROCESSED":
      parts.push(`close=${event.details.close}`);
      break;
    case "SIGNAL_GENERATED":
      parts.push(`-> ${event.details.action}: ${event.details.reason}`);
      break;
    case "RISK_REJECTED":
      parts.push(`reasons=${JSON.stringify(event.details.reasons)}`);
      break;
    case "ORDER_SUBMITTED":
      parts.push(`${event.details.side} qty=${event.details.quantity} @ ${event.details.price}`);
      break;
    case "POSITION_OPENED":
      parts.push(`${event.details.positionId} entryPrice=${event.details.entryPrice} qty=${event.details.quantity}`);
      break;
    case "POSITION_CLOSED":
      parts.push(`${event.details.positionId} exitPrice=${event.details.exitPrice}`);
      break;
    case "REALISED_PNL":
      parts.push(`${event.details.tradeId} realisedPnl=${event.details.realisedPnl}`);
      break;
    case "STRATEGY_LOADED":
      break;
    case "STRATEGY_REJECTED":
      parts.push(`reason=${event.details.reason}`);
      break;
    default:
      break;
  }
  return parts.join(" ");
}

async function main(): Promise<void> {
  console.log("Hermes Execution MVP — Demo Replay");
  console.log("===================================");

  const config = getHermesExecutionConfig();
  console.log(`Execution mode: ${config.executionMode}`);

  if (config.executionMode !== "paper") {
    // Fails closed: no unsupported mode ever proceeds, there is no live fallback.
    console.error(`Unsupported execution mode "${config.executionMode}" — refusing to run.`);
    process.exitCode = 1;
    return;
  }

  if (!config.registryPath) {
    console.error(
      "HERMES_STRATEGY_REGISTRY_PATH is not set — cannot connect to the Hermes Strategy Registry. " +
        "Set it to an absolute path, e.g. HERMES_STRATEGY_REGISTRY_PATH=/path/to/hermes-lab/strategy-registry",
    );
    process.exitCode = 1;
    return;
  }

  const registryClient = new FileSystemRegistryClient(config.registryPath);
  const registryConnected = await registryClient.isConnected();
  console.log(`Registry connected: ${registryConnected} (${config.registryPath})`);

  const executionRunId = `run-${Date.now()}`;
  const loadResult = await loadEnabledStrategies({
    registryClient,
    demoExecutionModeEnabled: config.demoExecutionModeEnabled,
    executionRunId,
  });

  console.log(`${loadResult.hermesApprovedCount} Hermes-approved strategies loaded`);
  console.log(`Demo execution mode: ${config.demoExecutionModeEnabled ? "enabled" : "disabled"}`);
  console.log(`Demo strategy loaded: ${loadResult.demoModeActive}`);
  if (loadResult.rejections.length > 0) {
    console.log(`Rejected strategy documents: ${loadResult.rejections.length}`);
    for (const rejection of loadResult.rejections) {
      console.log(`  - ${rejection.source}: ${rejection.reason}`);
    }
  }

  if (loadResult.strategies.length === 0) {
    console.log(
      "No enabled strategies — nothing to replay. Set DEMO_EXECUTION_MODE=true to exercise the demo strategy.",
    );
    return;
  }

  const candles = await loadFixtureCandles(FIXTURE_PATH);
  console.log(`Fixture replay started: ${candles.length} candles loaded from ${FIXTURE_PATH}`);

  const marketData = new FixtureMarketDataProvider(candles);
  const brokerStore = new JsonFilePaperBrokerStore();
  // resetState: true — every demo run replays from a fresh account, so the outcome is identical
  // and reproducible no matter what a previous run left on disk.
  const broker = await LocalPaperBroker.create(brokerStore, config.paperStartingCash, { resetState: true });
  const startingCashBalance = broker.getAccount().cashBalance;

  const auditTrail = await JsonFileAuditTrail.createFresh();

  const runner = new ExecutionRunner({
    strategies: loadResult.strategies,
    marketData,
    broker,
    auditTrail,
    riskConfig: {
      demoExecutionModeEnabled: config.demoExecutionModeEnabled,
      maxOpenPositions: config.maxOpenPositions,
    },
    executionRunId,
  });

  const runSummary = await runner.run();

  console.log("");
  console.log("Execution trace");
  console.log("----------------");
  for (const event of await auditTrail.getEvents()) {
    console.log(formatEventLine(event));
  }

  const finalAccount = broker.getAccount();
  const completedTrades = broker.getCompletedTrades();
  const openPositions = broker.getOpenPositions();
  const realisedPnl = completedTrades.reduce((sum, trade) => sum + trade.realisedPnl, 0);

  console.log("");
  console.log("Replay completed successfully.");
  console.log("");
  console.log("Summary");
  console.log("-------");
  console.log(`Starting balance: ${startingCashBalance.toFixed(2)}`);
  console.log(`Ending balance: ${finalAccount.cashBalance.toFixed(2)}`);
  console.log(`Completed trade count: ${completedTrades.length}`);
  console.log(`Realised P/L: ${realisedPnl.toFixed(2)}`);
  console.log(`Open position count: ${openPositions.length}`);
  console.log(`Candles processed: ${runSummary.candlesProcessed}`);
  console.log(`Entries opened: ${runSummary.entriesOpened}`);
  console.log(`Exits closed: ${runSummary.exitsClosed}`);
  console.log(`Risk rejections: ${runSummary.riskRejections}`);

  if (completedTrades.length === 0) {
    console.error(
      "No completed trade was produced in this replay — this phase is not considered successful without one.",
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Hermes execution demo failed:", error);
  process.exitCode = 1;
});
