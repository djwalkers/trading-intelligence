import { getHermesExecutionConfig } from "@/lib/hermes-execution/config";
import { HERMES_RUNTIME_AUDIT_LOG_PATH } from "@/lib/hermes-execution/audit-log-path";
import { JsonFileAuditTrail } from "@/lib/hermes-execution/json-file-audit-trail";
import { SystemSchedulerClock } from "@/lib/hermes-execution/runtime/scheduler-clock";
import { TradingRuntime, type AnalysisIntegrationDeps } from "@/lib/hermes-execution/runtime/trading-runtime";
import { buildHermesRuntimeWiring, buildRuntimeDependencies } from "@/lib/hermes-execution/runtime-config/runtime-dependency-factory";
import { buildRedactedStartupSummary } from "@/lib/hermes-execution/runtime-config/startup-summary";
import { TelegramAlertingAuditTrail, type AlertSender } from "@/lib/hermes-execution/telegram/telegram-alerting-audit-trail";
import { TelegramBot } from "@/lib/hermes-execution/telegram/telegram-bot";
import { HttpTelegramTransport } from "@/lib/hermes-execution/telegram/telegram-transport";
import { HermesGatewayAlertSender } from "@/lib/hermes-execution/telegram/hermes-gateway-alert-sender";
import { ChildProcessHermesCliRunner } from "@/lib/hermes-execution/hermes-agent/hermes-cli-runner";
import type { AuditTrail } from "@/lib/hermes-execution/audit-trail";
import type { PortfolioRiskConfig } from "@/lib/hermes-execution/portfolio-risk-engine";
import { buildAnalysisPersistenceConfig } from "@/lib/hermes-execution/analysis/analysis-persistence-config";
import { SupabaseAnalysisRepository } from "@/lib/hermes-execution/analysis/analysis-repository";
import { getServiceRoleClient } from "@/lib/supabase/service-role-client";
import { buildTradeApprovalConfig } from "@/lib/hermes-execution/trade-approval/config";
import { SupabaseTradeCandidateRepository } from "@/lib/hermes-execution/trade-approval/trade-candidate-repository";
import type { TradeCandidateRepository } from "@/lib/hermes-execution/trade-approval/trade-candidate-repository";
import { SupabaseTradePerformanceRepository } from "@/lib/hermes-execution/trade-performance/trade-performance-repository";
import { SupabaseTradeLifecycleStore } from "@/lib/hermes-execution/trade-lifecycle/supabase-trade-lifecycle-store";
import type { TradeLifecycleStore } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-store";
import { FileSystemRegistryClient } from "@/lib/hermes-execution/registry-client";

// Phase 2B — Decision Intelligence: Historical Analysis Persistence. Constructs
// AnalysisIntegrationDeps only when HERMES_SUPABASE_USER_ID and the Supabase service role are both
// configured — undefined (the default) means TradingRuntime behaves exactly as it did before this
// phase existed (see trading-runtime.ts's own AnalysisIntegrationDeps doc comment). A partial or
// missing configuration never fails startup; it only means this one, optional, read-only
// observability layer stays off.
function buildAnalysisIntegrationDeps(
  config: ReturnType<typeof getHermesExecutionConfig>,
): AnalysisIntegrationDeps | undefined {
  const persistenceConfig = buildAnalysisPersistenceConfig();
  if (!persistenceConfig.enabled || !persistenceConfig.ownerUserId) return undefined;

  const client = getServiceRoleClient();
  if (!client) return undefined;

  return {
    repository: new SupabaseAnalysisRepository(client, persistenceConfig.ownerUserId),
    runtimeMode: config.runtimeTrading.mode,
    brokerProvider: config.brokerProvider,
    marketProvider: config.marketDataProvider,
    timeframe: config.marketData.timeframe,
  };
}

// Milestone 8 — Deployment-Ready Runtime Configuration. Replaces Mission 7's hard-coded
// `const INSTRUMENT = "BTC"` / `const AMOUNT = 10` and inline dependency assembly with the shared
// runtime-config/ layer: validated configuration -> buildRuntimeDependencies() -> TradingRuntime.
// Nothing about decision/risk/execution/lifecycle/broker/market-data logic is reimplemented here —
// this file only ever loads config, calls the factory, and wires the result into TradingRuntime.
// Portfolio-risk thresholds remain CLI-local, unchanged since Milestone 4 — this milestone does not
// call for env-configurable portfolio risk limits, only for the previously hard-coded trading
// inputs (symbol/quantity/strategy/broker/mode) to become configuration, which they now are.
const PORTFOLIO_RISK_CONFIG: PortfolioRiskConfig = {
  portfolioMaxOpenPositions: 5,
  maxDailyTrades: 10,
  maxPortfolioExposure: 10_000,
};

// Phase 3.5 — Trade Review & Approval. Deliberately NOT optional the way buildAnalysisIntegrationDeps
// above is: automatic execution must remain off unconditionally, and every BUY/SELL decision this
// runtime makes becomes a TradeCandidate — with nowhere durable to put it, the runtime cannot
// safely start at all (a candidate that only exists in-process memory could never be reviewed from
// the Trade Approval page, which runs in a separate Next.js process — see
// docs/trade-candidate-lifecycle-phase-3-5.md's own architecture section). Reuses the exact same
// HERMES_SUPABASE_USER_ID + service-role configuration Phase 2B's analysis persistence already
// established — the same Supabase Auth user owns both a deployment's analysis rows and its trade
// candidates.
function buildTradeCandidateRepository(): TradeCandidateRepository | { error: string } {
  const persistenceConfig = buildAnalysisPersistenceConfig();
  if (!persistenceConfig.enabled || !persistenceConfig.ownerUserId) {
    return {
      error:
        "Trade candidate persistence requires HERMES_SUPABASE_USER_ID and the Supabase service role " +
        "to be configured. Automatic execution is never available in this pipeline — every BUY/SELL " +
        "decision must be reviewed and approved via the Trade Approval page, which requires durable " +
        "candidate storage.",
    };
  }
  const client = getServiceRoleClient();
  if (!client) {
    return { error: "Supabase service role client could not be constructed despite being configured." };
  }
  return new SupabaseTradeCandidateRepository(client, persistenceConfig.ownerUserId);
}

// Restart-Resilient Autonomy Phase — Phase 2 (Durable trade lifecycle persistence). Required, not
// optional, exactly like buildTradeCandidateRepository above and for the identical reason: this
// runtime must never silently fall back to the in-memory store in production — an open eToro
// position tracked only in-process memory is lost the moment PM2 restarts (the very defect this
// phase exists to fix). Reuses the exact same HERMES_SUPABASE_USER_ID + service-role configuration
// trade candidates already require.
function buildTradeLifecycleStore(): TradeLifecycleStore | { error: string } {
  const persistenceConfig = buildAnalysisPersistenceConfig();
  if (!persistenceConfig.enabled || !persistenceConfig.ownerUserId) {
    return {
      error:
        "Durable trade lifecycle persistence requires HERMES_SUPABASE_USER_ID and the Supabase service " +
        "role to be configured. This runtime never falls back to in-memory lifecycle storage — an open " +
        "position tracked only in process memory would be lost on the next restart.",
    };
  }
  const client = getServiceRoleClient();
  if (!client) {
    return { error: "Supabase service role client could not be constructed despite being configured." };
  }
  return new SupabaseTradeLifecycleStore(client, persistenceConfig.ownerUserId);
}

// Phase 4 — Trade Performance Engine. Optional, unlike buildTradeCandidateRepository above —
// measuring trade quality is a pure observability bolt-on (same category as analysis persistence),
// not a safety requirement; when it can't be configured, the runtime starts exactly as it did
// before this phase existed. Reuses the same HERMES_SUPABASE_USER_ID + service-role configuration
// analysis persistence and trade candidates already share.
function buildTradePerformanceRepository(): SupabaseTradePerformanceRepository | undefined {
  const persistenceConfig = buildAnalysisPersistenceConfig();
  if (!persistenceConfig.enabled || !persistenceConfig.ownerUserId) return undefined;
  const client = getServiceRoleClient();
  if (!client) return undefined;
  return new SupabaseTradePerformanceRepository(client, persistenceConfig.ownerUserId);
}

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

  // Restart-Resilient Autonomy Phase — Phase 7 (Audit durability). loadExisting, never createFresh:
  // this production audit log must not be destructively truncated on every PM2 restart (the
  // pre-existing behaviour this phase fixes) — a fresh file is only ever created the very first
  // time this path doesn't exist yet (loadExisting's own fallback).
  const baseAuditTrail = await JsonFileAuditTrail.loadExisting(HERMES_RUNTIME_AUDIT_LOG_PATH);

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
    // config.ts fails closed at config-build time whenever telegram.enabled is true — botToken is
    // therefore always present here. Still needed for the interactive command bot below (/status
    // /positions /trades ...), which is a genuinely different, two-way capability that requires the
    // real Telegram Bot API's own long-polling — untouched by the gateway change right below.
    const botToken = config.telegram.botToken as string;
    telegramTransport = new HttpTelegramTransport(botToken);

    // Prototype 1.0 — Hermes Telegram gateway bridge. Outbound EVENT alerts (trade opened/closed,
    // automatic exits, Hermes proposals, ...) are routed through the already-proven, already-
    // configured Hermes Agent gateway (`hermes send`) — never a second, direct Telegram Bot API
    // call for this path (see hermes-gateway-alert-sender.ts's own doc comment). Reuses
    // config.hermesAgent's own cliPath/telegramTarget/telegramSendTimeoutMs — this app holds no
    // separate gateway credential of its own.
    const alertSender: AlertSender = new HermesGatewayAlertSender(
      {
        cliPath: config.hermesAgent.cliPath,
        telegramTarget: config.hermesAgent.telegramTarget,
        sendTimeoutMs: config.hermesAgent.telegramSendTimeoutMs,
      },
      new ChildProcessHermesCliRunner(),
    );
    auditTrail = new TelegramAlertingAuditTrail(baseAuditTrail, alertSender);
    console.log(`Telegram alerts enabled — outbound notifications routed through the Hermes gateway (target: ${config.hermesAgent.telegramTarget}).`);
  }

  // Restart-Resilient Autonomy Phase — Phase 2. Required, not optional — see
  // buildTradeLifecycleStore's own doc comment. Built before buildRuntimeDependencies so it can be
  // injected as that factory's lifecycleStoreOverride, replacing its own default
  // InMemoryTradeLifecycleStore.
  const tradeLifecycleStore = buildTradeLifecycleStore();
  if ("error" in tradeLifecycleStore) {
    console.error("Startup validation failed — the runtime was not started:");
    console.error(`  - [tradeLifecycleStore] ${tradeLifecycleStore.error}`);
    process.exitCode = 1;
    return;
  }
  console.log("Durable trade lifecycle persistence enabled — open positions survive a restart (trade_lifecycle_records).");

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
    lifecycleStoreOverride: tradeLifecycleStore,
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

  // Prototype 1.0 — official Hermes Agent multi-instrument wiring. Shapes exactly the
  // TradingRuntimeDeps.instrument/instruments/universeScan fields for whichever path the SELECTED
  // strategy actually takes — see buildHermesRuntimeWiring's own doc comment. Startup visibility
  // here is deliberately explicit about decision provider/instrument universe/CLI path, never a
  // credential: `summary.decisionProvider`/`summary.universeScanEnabled` already redact everything
  // that needs redacting (see startup-summary.ts).
  const hermesWiring = buildHermesRuntimeWiring(deps);
  console.log(`Decision provider: ${summary.decisionProvider}`);
  console.log(
    hermesWiring.universeScan
      ? `Multi-instrument Hermes universe scanning ENABLED — instrument universe: ${hermesWiring.instruments!.join(", ")} ` +
          `(Hermes CLI: ${summary.hermesCliPath}).`
      : `Multi-instrument Hermes universe scanning disabled — running the single-instrument path for ${hermesWiring.instrument} ` +
          `(configured instrument universe ${JSON.stringify(summary.instrumentUniverse)} is only used by the official Hermes Agent strategy).`,
  );

  // Phase 2B — Decision Intelligence: Historical Analysis Persistence. Optional — see
  // buildAnalysisIntegrationDeps's own doc comment for exactly when this is undefined.
  const analysis = buildAnalysisIntegrationDeps(config);
  console.log(
    analysis
      ? "Market analysis persistence enabled — every cycle will be recorded to Supabase (market_analysis_runs)."
      : "Market analysis persistence disabled — set HERMES_SUPABASE_USER_ID and the Supabase service role to enable it.",
  );

  // Phase 3.5 — Trade Review & Approval. Required, not optional — see
  // buildTradeCandidateRepository's own doc comment.
  const tradeCandidateRepository = buildTradeCandidateRepository();
  if ("error" in tradeCandidateRepository) {
    console.error("Startup validation failed — the runtime was not started:");
    console.error(`  - [tradeCandidateRepository] ${tradeCandidateRepository.error}`);
    process.exitCode = 1;
    return;
  }
  console.log("Trade candidate persistence enabled — every BUY/SELL decision will be queued for review (trade_candidates).");
  const tradeApprovalConfig = buildTradeApprovalConfig();

  // Phase 4 — Trade Performance Engine. Optional — see buildTradePerformanceRepository's own doc
  // comment for exactly when this is undefined.
  const tradePerformanceRepository = buildTradePerformanceRepository();
  console.log(
    tradePerformanceRepository
      ? "Trade performance measurement enabled — every closed trade will be recorded to Supabase (trade_performance)."
      : "Trade performance measurement disabled — set HERMES_SUPABASE_USER_ID and the Supabase service role to enable it.",
  );

  // Restart-Resilient Autonomy Phase — Phase 3 (strategy-disabled exit trigger). Only meaningful
  // when a registry path is configured at all — buildRuntimeDependencies above already fails
  // closed on a missing HERMES_STRATEGY_REGISTRY_PATH, so config.registryPath is always defined by
  // this point, but this stays defensive rather than asserting it.
  const registryClient = config.registryPath ? new FileSystemRegistryClient(config.registryPath) : undefined;

  console.log(`Approval mode: ${config.approvalMode}`);
  console.log(`Kill switch: ${config.killSwitchEnabled ? "ENABLED" : "disabled"}`);
  if (config.killSwitchEnabled) {
    console.log("KILL SWITCH ENABLED — every reconciled open position will be closed automatically this run.");
  }
  // Restart-Resilient Autonomy Phase — kill-switch operational visibility (deployment safety
  // review). HERMES_KILL_SWITCH_ENABLED is read once here, at process startup, and cached for this
  // process's entire lifetime (TradingRuntimeDeps.killSwitchEnabled is a plain boolean, not a
  // live-reloaded value) — flipping the env var alone does NOT affect an already-running process.
  // No control endpoint exists to change this at runtime (deliberately out of this phase's scope);
  // the only way to apply a change is the PM2 restart below, which reloads env vars.
  console.log(
    `NOTE: HERMES_KILL_SWITCH_ENABLED is only read at process startup — a running process does not ` +
      `notice a later change to it. To apply a change, restart with updated environment: ` +
      `pm2 restart hermes-market-runtime --update-env`,
  );

  // Restart-Resilient Autonomy Phase — Phase 4 (Protection model). eToro's own documented Public
  // API for opening a demo position (POST /api/v2/trading/execution/demo/orders — see
  // etoro/etoro-client.ts's own placeDemoMarketOrder) has NO stop-loss/take-profit request field in
  // any confirmed request-body example or documented schema this adapter's own client is built
  // from — nothing was invented or guessed here. Protection is therefore LOCAL ONLY (Phase 3's own
  // exit monitor, evaluated once per scheduled cycle) and depends entirely on this runtime process
  // remaining up and running; it is not enforced by eToro itself the way a broker-native stop order
  // would be.
  if (config.brokerProvider === "etoro-demo") {
    console.log(
      "WARNING: eToro's demo order API has no documented native stop-loss/take-profit field — " +
        "protection for open positions is LOCAL ONLY (evaluated once per scheduled cycle, every " +
        `${config.scheduler.intervalMs}ms) and depends entirely on this runtime process remaining ` +
        "up. A position is unprotected for the duration of any outage or restart gap.",
    );
  }

  const runtime = new TradingRuntime({
    broker: deps.broker,
    marketDataProvider: deps.marketDataProvider,
    strategy: deps.strategy,
    instrument: hermesWiring.instrument,
    instruments: hermesWiring.instruments,
    universeScan: hermesWiring.universeScan,
    amount: deps.quantity,
    orderSizingMode: deps.orderSizingMode,
    brokerProvider: config.brokerProvider,
    portfolioRiskConfig: deps.portfolioRiskConfig,
    lifecycleService: deps.lifecycleService,
    lifecycleStore: deps.lifecycleStore,
    auditTrail,
    marketHoursPolicy: deps.marketHoursPolicy,
    clock: new SystemSchedulerClock(),
    intervalMs: config.scheduler.intervalMs,
    immediateFirstRun: config.scheduler.immediateFirstRun,
    shutdownTimeoutMs: config.scheduler.shutdownTimeoutMs,
    analysis,
    tradeCandidateRepository,
    tradeCandidateExpiryMs: tradeApprovalConfig.expiryMs,
    tradePerformance: tradePerformanceRepository
      ? { lifecycleStore: deps.lifecycleStore, repository: tradePerformanceRepository }
      : undefined,
    approvalMode: config.approvalMode,
    autoDemoMinConfidence: config.autoDemoMinConfidence,
    killSwitchEnabled: config.killSwitchEnabled,
    maxHoldingDurationMs: config.maxHoldingDurationMs,
    recoveryThresholdMs: config.recoveryThresholdMs,
    opposingExitMinHoldMs: config.opposingExitMinHoldMs,
    opposingExitRequiredConfirmations: config.opposingExitRequiredConfirmations,
    registryClient,
    demoExecutionModeEnabled: config.demoExecutionModeEnabled,
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
    console.log("Telegram bot started — listening for /status /positions /trades /pnl /reconciliation /pause /resume /run /help.");
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
