import * as path from "node:path";
import { getHermesExecutionConfig } from "@/lib/hermes-execution/config";
import { BrokerFactory } from "@/lib/hermes-execution/broker-factory";
import {
  EtoroDemoBroker,
  EtoroNoInstrumentMatchError,
  EtoroAmbiguousInstrumentError,
  EtoroRateUnavailableError,
  EtoroReconciliationError,
  EtoroCleanupRequiredError,
} from "@/lib/hermes-execution/etoro/etoro-demo-broker";
import { JsonFileAuditTrail } from "@/lib/hermes-execution/json-file-audit-trail";
import type { OrderRequest } from "@/lib/hermes-execution/types";

const SMOKE_AUDIT_LOG_PATH = path.join(process.cwd(), ".data", "hermes-execution", "etoro-smoke-audit-log.json");

// This smoke test only ever proves connectivity + one order lifecycle. It is not a strategy
// signal, so it is explicitly modeled as a DEMO_ONLY source — it must never be mistaken for a
// Hermes-approved trade.
const SMOKE_TEST_STRATEGY_ID = "ETORO-SMOKE-TEST";

// Five explicit outcomes, five distinct exit codes — see docs/etoro-demo-adapter-phase-1.md for
// full meanings. PASSED is the only zero exit code.
type SmokeOutcome = "PASSED" | "FAILED" | "INCONCLUSIVE_MARKET_CLOSED" | "INCONCLUSIVE_API_LIMITATION" | "CLEANUP_REQUIRED";

const EXIT_CODES: Record<SmokeOutcome, number> = {
  PASSED: 0,
  FAILED: 1,
  INCONCLUSIVE_MARKET_CLOSED: 2,
  INCONCLUSIVE_API_LIMITATION: 3,
  CLEANUP_REQUIRED: 4,
};

export async function main(): Promise<void> {
  console.log("eToro Demo Broker — Smoke Test");
  console.log("===============================");

  const executionRunId = `smoke-etoro-${Date.now()}`;
  console.log(`Execution run id: ${executionRunId}`);

  // Stage 1: validate demo-only configuration. This command always targets eToro — it never
  // reads or depends on BROKER_PROVIDER, so it can run unchanged no matter which broker the rest
  // of the application currently defaults to.
  const config = getHermesExecutionConfig();
  console.log("Broker provider: etoro-demo (fixed for this command — BROKER_PROVIDER is not consulted)");

  if (config.etoro.env !== "demo") {
    console.error("ETORO_ENV must be exactly \"demo\" — no live/real route is ever selected by this command.");
    return finish("FAILED", undefined, "config");
  }
  if (!config.etoro.apiKey || !config.etoro.userKey) {
    console.error("ETORO_API_KEY and ETORO_USER_KEY must both be set.");
    return finish("FAILED", undefined, "config");
  }
  if (!config.etoro.testInstrument.trim()) {
    console.error("ETORO_DEMO_TEST_INSTRUMENT must be a non-empty search term.");
    return finish("FAILED", undefined, "config");
  }
  if (config.etoro.testAmount === undefined || !Number.isFinite(config.etoro.testAmount) || config.etoro.testAmount <= 0) {
    console.error("ETORO_DEMO_TEST_AMOUNT must be set to a positive finite number.");
    return finish("FAILED", undefined, "config");
  }
  console.log("Configuration valid (demo-only, no live route reachable).");

  const auditTrail = await JsonFileAuditTrail.createFresh(SMOKE_AUDIT_LOG_PATH);
  let broker: EtoroDemoBroker;

  // Stage 2 + 3: authenticate, retrieve demo portfolio/account state. BrokerFactory.create's
  // "etoro-demo" entry constructs EtoroDemoBroker and calls connect() before returning — the cast
  // is safe because an explicit `provider` was requested, so the concrete type is guaranteed.
  try {
    broker = (await BrokerFactory.create(config, auditTrail, executionRunId, {
      provider: "etoro-demo",
    })) as EtoroDemoBroker;
    console.log("Connected to eToro (credentials verified via demo portfolio read).");
  } catch (error) {
    console.error("Failed to connect to eToro Demo:", error instanceof Error ? error.message : error);
    return finish("FAILED", auditTrail, "connect", executionRunId);
  }

  const account = broker.getAccount();
  console.log(`Demo credit (eToro's virtual balance, clientPortfolio.credit): ${account.cashBalance}`);
  const existingPositions = broker.getOpenPositions().length;
  console.log(`Positions tracked by this broker instance at connect time: ${existingPositions}`);

  // Stage 4: resolve the configured instrument through eToro's own market-data search.
  const searchTerm = config.etoro.testInstrument;
  let resolved;
  try {
    resolved = await broker.resolveInstrument(searchTerm);
  } catch (error) {
    if (error instanceof EtoroNoInstrumentMatchError || error instanceof EtoroAmbiguousInstrumentError) {
      console.error(error.message);
      return finish("FAILED", auditTrail, "resolve-instrument", executionRunId);
    }
    console.error("Instrument resolution failed:", error instanceof Error ? error.message : error);
    return finish("FAILED", auditTrail, "resolve-instrument", executionRunId);
  }
  console.log(`Resolved instrument: ${resolved.displayName} (${resolved.symbol}), instrumentId=${resolved.instrumentId}`);

  // Stage 5: retrieve a current rate or tradability state.
  let openRate;
  try {
    openRate = await broker.getRate(searchTerm);
  } catch (error) {
    if (error instanceof EtoroRateUnavailableError) {
      const detail =
        error.reason === "absent"
          ? "it was absent from eToro's rates response entirely"
          : "eToro returned a rate entry for it but with no usable bid/ask";
      console.log(
        `No rate data available for ${resolved.displayName} (instrumentId=${resolved.instrumentId}) — ${detail}. ` +
          "Interpreting this as the market currently being closed or pricing temporarily unavailable " +
          "(eToro's API exposes no confirmed dedicated market-status field; this is a best-effort reading).",
      );
      return finish("INCONCLUSIVE_MARKET_CLOSED", auditTrail, "rate-unavailable", executionRunId);
    }
    console.error("Rate retrieval failed:", error instanceof Error ? error.message : error);
    return finish("FAILED", auditTrail, "rate-retrieval", executionRunId);
  }
  console.log(`Current rate: bid=${openRate.bid}, ask=${openRate.ask}`);

  // Stage 6: display the proposed amount and order details.
  const amount = config.etoro.testAmount;
  console.log(`Proposed order: BUY ${resolved.symbol}, amount=${amount} (currency=usd), leverage=1 (fixed, no leverage)`);

  const orderRequest: OrderRequest = {
    strategyId: SMOKE_TEST_STRATEGY_ID,
    strategyVersion: 1,
    sourceType: "DEMO_ONLY",
    instrument: searchTerm,
    side: "BUY",
    quantity: amount,
    price: openRate.ask,
    timestamp: new Date().toISOString(),
  };

  // Stage 7 + 8: submit one small DEMO market BUY order, and reconcile the resulting position.
  let positionId: string;
  try {
    const result = await broker.placeMarketOrder(orderRequest);
    positionId = result.position.positionId;
    console.log(
      `Order accepted: orderId=${result.orderId}, entryPrice=${result.position.entryPrice}, amount=${result.position.quantity}`,
    );
  } catch (error) {
    if (error instanceof EtoroReconciliationError) {
      console.error(error.message);
      if (error.reason === "no-identifier") {
        return finish("INCONCLUSIVE_API_LIMITATION", auditTrail, "order-reconciliation", executionRunId);
      }
      if (error.reason === "pending" || error.reason === "timeout") {
        // The order was genuinely accepted and may still be active (settling, or simply
        // unaccounted for within the poll window) — CLEANUP_REQUIRED, not FAILED, since "nothing
        // happened" isn't true here.
        return finish("CLEANUP_REQUIRED", auditTrail, "order-reconciliation", executionRunId);
      }
      return finish("FAILED", auditTrail, "order-reconciliation", executionRunId);
    }
    console.error("Order submission failed:", error instanceof Error ? error.message : error);
    return finish("FAILED", auditTrail, "order-submission", executionRunId);
  }

  // Stage 9: confirm the position appeared in the demo portfolio (placeMarketOrder already did
  // this internally via POSITION_CONFIRMED; this re-check is the smoke test's own independent
  // confirmation using the shared PaperBroker interface).
  const openAfterOrder = broker.getOpenPositions().some((p) => p.positionId === positionId);
  if (!openAfterOrder) {
    console.error(`Position ${positionId} not found among this broker instance's tracked positions after ordering.`);
    return finish("CLEANUP_REQUIRED", auditTrail, "post-order-verification", executionRunId);
  }
  console.log(`Confirmed: position ${positionId} is open in the demo portfolio.`);

  // Stage 10 + 11: close that exact position completely, then confirm it is no longer open.
  // Any error here means we opened a position we can no longer confirm is safely closed —
  // CLEANUP_REQUIRED, not FAILED, since a genuine failure implies "nothing happened," and here
  // something did.
  try {
    const closeRate = await broker.getRate(searchTerm);
    const closeResult = await broker.closePosition(positionId, closeRate.bid, new Date().toISOString(), "smoke-test-cleanup");
    console.log(
      `Position closed: orderId=${closeResult.orderId}, exitPrice=${closeResult.trade.exitPrice}, realisedPnl=${closeResult.trade.realisedPnl.toFixed(4)}`,
    );
  } catch (error) {
    if (error instanceof EtoroCleanupRequiredError) {
      console.error(error.message);
    } else {
      console.error("Failed to close smoke-test position:", error instanceof Error ? error.message : error);
    }
    return finish("CLEANUP_REQUIRED", auditTrail, "position-close", executionRunId);
  }

  const stillOpen = broker.getOpenPositions().some((p) => p.positionId === positionId);
  if (stillOpen) {
    console.error(`Position ${positionId} still appears open after closing — manual intervention required.`);
    return finish("CLEANUP_REQUIRED", auditTrail, "post-close-verification", executionRunId);
  }
  console.log("Confirmed: no smoke-test position remains open.");

  // Stage 12: final outcome.
  return finish("PASSED", auditTrail, undefined, executionRunId);
}

async function finish(
  outcome: SmokeOutcome,
  auditTrail: JsonFileAuditTrail | undefined,
  failedStage: string | undefined,
  executionRunId?: string,
): Promise<void> {
  if (auditTrail && executionRunId) {
    const eventType =
      outcome === "PASSED"
        ? "SMOKE_TEST_COMPLETED"
        : outcome === "CLEANUP_REQUIRED"
          ? "SMOKE_TEST_CLEANUP_REQUIRED"
          : outcome === "INCONCLUSIVE_MARKET_CLOSED" || outcome === "INCONCLUSIVE_API_LIMITATION"
            ? "SMOKE_TEST_INCONCLUSIVE"
            : "SMOKE_TEST_FAILED";
    await auditTrail.record({
      timestamp: new Date().toISOString(),
      eventType,
      executionRunId,
      details: failedStage ? { failedStage, outcome } : { outcome },
    });
  }
  console.log("");
  console.log(`ETORO SMOKE TEST OUTCOME: ${outcome}`);
  process.exitCode = EXIT_CODES[outcome];
}

// Only auto-runs when this file is executed directly (`tsx broker-etoro-smoke.ts`), not when
// imported elsewhere (e.g. its own test file, which imports `main` and calls it explicitly).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("eToro demo smoke test crashed:", error instanceof Error ? error.message : error);
    process.exitCode = EXIT_CODES.FAILED;
  });
}
