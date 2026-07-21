import * as path from "node:path";
import { getHermesExecutionConfig } from "@/lib/hermes-execution/config";
import { JsonFileAuditTrail } from "@/lib/hermes-execution/json-file-audit-trail";
import { SystemSchedulerClock } from "@/lib/hermes-execution/runtime/scheduler-clock";
import { TradingRuntime } from "@/lib/hermes-execution/runtime/trading-runtime";
import { buildRuntimeDependencies } from "@/lib/hermes-execution/runtime-config/runtime-dependency-factory";
import { buildRedactedStartupSummary } from "@/lib/hermes-execution/runtime-config/startup-summary";
import { TelegramAlertingAuditTrail, type AlertSender } from "@/lib/hermes-execution/telegram/telegram-alerting-audit-trail";
import { TelegramBot } from "@/lib/hermes-execution/telegram/telegram-bot";
import { HttpTelegramTransport } from "@/lib/hermes-execution/telegram/telegram-transport";
import type { AuditTrail } from "@/lib/hermes-execution/audit-trail";
import type { PortfolioRiskConfig } from "@/lib/hermes-execution/portfolio-risk-engine";

// Milestone 8 — Deployment-Ready Runtime Configuration. Replaces Mission 7's hard-coded
// `const INSTRUMENT = "BTC"` / `const AMOUNT = 10` and inline dependency assembly with the shared
// runtime-config/ layer: validated configuration -> buildRuntimeDependencies() -> TradingRuntime.
// Nothing about decision/risk/execution/lifecycle/broker/market-data logic is reimplemented here —
// this file only ever loads config, calls the factory, and wires the result into TradingRuntime.
const AUDIT_LOG_PATH = path.join(process.cwd(), ".data", "hermes-execution", "market-runtime-audit-log.json");

// Portfolio-risk thresholds remain CLI-local, unchanged since Milestone 4 — this milestone does not
// call for env-configurable portfolio risk limits, only for the previously hard-coded trading
// inputs (symbol/quantity/strategy/broker/mode) to become configuration, which they now are.
const PORTFOLIO_RISK_CONFIG: PortfolioRiskConfig = {
  portfolioMaxOpenPositions: 5,
  maxDailyTrades: 10,
  maxPortfolioExposure: 10_000,
};

function printFinalStatus(runtime: TradingRuntime): void {
  const status = runtime.getStatus();
  console.log("");
  console.log("Final runtime status");
  console.log("---------------------");
  console.log(JSON.stringify(status, null, 2));
}

export async function main(): Promise<void> {
  console.log("Hermes Trading Runtime — 24/7 Scheduler & Runtime Control");
  console.log("===========================================================");

  const config = getHermesExecutionConfig();

  if (!config.scheduler.enabled) {
    console.log(
      "HERMES_SCHEDULER_ENABLED is not set — nothing to run. Set it to true to start the continuous runtime. " +
        "This is the correct, expected state of a default configuration, not a failure.",
    );
    return;
  }

  const executionRunId = `market-runtime-${Date.now()}`;
  console.log(`Execution run id: ${executionRunId}`);

  const baseAuditTrail = await JsonFileAuditTrail.createFresh(AUDIT_LOG_PATH);

  // Prototype V1 — minimum Telegram integration. When enabled, every alert-worthy audit event (see
  // telegram-alerting-audit-trail.ts's own formatAlert) is also sent to the one configured chat id,
  // through the exact same AuditTrail instance the runtime/lifecycle pipeline already writes to —
  // no separate notification path, no duplicated trading/decision logic. The alert sender only ever
  // needs the Telegram transport + chat id (never TradingRuntime itself), so it has no ordering
  // dependency on the runtime constructed below; the interactive TelegramBot (commands) is
  // constructed later, once the runtime and lifecycle store it reports on actually exist.
  let auditTrail: AuditTrail = baseAuditTrail;
  let telegramTransport: HttpTelegramTransport | undefined;
  if (config.telegram.enabled) {
    // config.ts fails closed at config-build time whenever telegram.enabled is true — botToken and
    // allowedChatId are therefore always present here.
    const botToken = config.telegram.botToken as string;
    const allowedChatId = config.telegram.allowedChatId as string;
    telegramTransport = new HttpTelegramTransport(botToken);
    const alertSender: AlertSender = { sendAlert: (text) => telegramTransport!.sendMessage(allowedChatId, text) };
    auditTrail = new TelegramAlertingAuditTrail(baseAuditTrail, alertSender);
    console.log("Telegram alerts enabled.");
  }

  // Startup validation happens entirely inside this call, before anything scheduler-related is
  // ever touched: strategy loading, mode/broker/market-data compatibility, broker construction,
  // and (for eToro) symbol resolution. Every problem found is collected and reported together,
  // rather than crashing on the first one.
  const built = await buildRuntimeDependencies({
    config,
    auditTrail,
    executionRunId,
    resetBrokerState: false, // a continuous runtime persists its paper account/positions across restarts
    portfolioRiskConfig: PORTFOLIO_RISK_CONFIG,
  });

  if (!built.ok) {
    console.error("Startup validation failed — the runtime was not started:");
    for (const problem of built.problems) console.error(`  - [${problem.field}] ${problem.message}`);
    process.exitCode = 1;
    return;
  }
  const deps = built.dependencies;
  console.log(`Using strategy: ${deps.strategy.strategyId} v${deps.strategy.version} (${deps.strategy.sourceType})`);

  const summary = buildRedactedStartupSummary(config, deps.strategy);
  console.log("");
  console.log("Startup summary (redacted — no credentials included)");
  console.log("------------------------------------------------------");
  console.log(JSON.stringify(summary, null, 2));

  const runtime = new TradingRuntime({
    broker: deps.broker,
    marketDataProvider: deps.marketDataProvider,
    strategy: deps.strategy,
    instrument: deps.symbol,
    amount: deps.quantity,
    portfolioRiskConfig: deps.portfolioRiskConfig,
    lifecycleService: deps.lifecycleService,
    auditTrail,
    marketHoursPolicy: deps.marketHoursPolicy,
    clock: new SystemSchedulerClock(),
    intervalMs: config.scheduler.intervalMs,
    immediateFirstRun: config.scheduler.immediateFirstRun,
    shutdownTimeoutMs: config.scheduler.shutdownTimeoutMs,
  });

  let telegramBot: TelegramBot | undefined;
  if (telegramTransport) {
    // Reuses config.telegram.allowedChatId/botToken validated above — `!` here is safe for the same
    // config-build-time reason as the alertSender construction above.
    telegramBot = new TelegramBot({
      transport: telegramTransport,
      allowedChatId: config.telegram.allowedChatId as string,
      runtime,
      lifecycleStore: deps.lifecycleStore,
    });
    telegramBot.start();
    console.log("Telegram bot started — listening for /status /positions /trades /pnl /pause /resume /run /help.");
  }

  await runtime.start();
  console.log("");
  console.log("Runtime started. Press Ctrl+C (SIGINT) to stop gracefully.");

  // Signal handling deliberately lives here, outside TradingRuntime itself, so the runtime stays
  // testable with zero knowledge of process signals. `shuttingDown` de-duplicates: SIGINT and
  // SIGTERM (or the same signal delivered twice, e.g. an impatient double Ctrl+C) both funnel
  // through the same guarded shutdown exactly once — a second signal while shutdown is already in
  // progress is a no-op here, not a second concurrent runtime.stop() call (which would throw, since
  // STOPPING has no valid transition to itself).
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal} — stopping gracefully (waiting for any active cycle to finish)...`);
    runtime
      .stop()
      .then(() => telegramBot?.stop())
      .then(() => {
        printFinalStatus(runtime);
        process.exit(0);
      })
      .catch((error: unknown) => {
        console.error("Error during graceful shutdown:", error instanceof Error ? error.message : error);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Only auto-runs when this file is executed directly (`tsx market-runtime.ts`), not when imported
// elsewhere.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Trading runtime crashed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
