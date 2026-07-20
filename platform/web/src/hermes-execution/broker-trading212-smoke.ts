import * as path from "node:path";
import { getHermesExecutionConfig } from "@/lib/hermes-execution/config";
import { BrokerFactory } from "@/lib/hermes-execution/broker-factory";
import {
  Trading212DemoBroker,
  Trading212OrderPendingError,
} from "@/lib/hermes-execution/trading212/trading212-demo-broker";
import { JsonFileAuditTrail } from "@/lib/hermes-execution/json-file-audit-trail";
import type { OrderRequest, PaperPosition } from "@/lib/hermes-execution/types";

// A separate audit log from every other smoke/demo CLI's, so none of their histories clobber
// each other on disk.
const SMOKE_AUDIT_LOG_PATH = path.join(process.cwd(), ".data", "hermes-execution", "trading212-smoke-audit-log.json");

// This smoke test only ever proves connectivity + one order lifecycle. It is not a strategy
// signal, so it is explicitly modeled as a DEMO_ONLY source — it must never be mistaken for a
// Hermes-approved trade.
const SMOKE_TEST_STRATEGY_ID = "TRADING212-SMOKE-TEST";

// Trading212 documents that a market order placed while its exchange is closed is queued rather
// than filled or rejected ("the order will be queued to execute when the market next opens") —
// confirmed against a live GET /equity/metadata/exchanges call. That means a Trading212OrderPendingError
// is not always a genuine failure: PASSED/FAILED alone can't say "the adapter worked but the
// market happened to be shut." INCONCLUSIVE_MARKET_CLOSED is the third, distinct outcome for that
// case; any other pending-order timeout (session confirmed OPEN, or session state UNKNOWN) still
// fails loudly, since that is NOT explained by documented market-hours behaviour.
type SmokeOutcome = "PASSED" | "FAILED" | "INCONCLUSIVE_MARKET_CLOSED";

export async function main(): Promise<void> {
  console.log("Trading212 Demo Broker — Smoke Test");
  console.log("====================================");

  const executionRunId = `smoke-t212-${Date.now()}`;
  console.log(`Execution run id: ${executionRunId}`);

  // Step 1: validate configuration. This command always targets Trading212 — it never reads or
  // depends on BROKER_PROVIDER, so it can run unchanged no matter which broker the rest of the
  // application currently defaults to.
  const config = getHermesExecutionConfig();
  console.log("Broker provider: trading212-demo (fixed for this command — BROKER_PROVIDER is not consulted)");

  if (!config.trading212.executionEnabled) {
    console.error("TRADING212_DEMO_EXECUTION_ENABLED must be true to run this smoke test.");
    process.exitCode = 1;
    return;
  }
  if (!config.trading212.apiKey || !config.trading212.apiSecret) {
    console.error("TRADING212_API_KEY and TRADING212_API_SECRET must both be set.");
    process.exitCode = 1;
    return;
  }
  console.log("Configuration valid.");

  const auditTrail = await JsonFileAuditTrail.createFresh(SMOKE_AUDIT_LOG_PATH);

  let outcome: SmokeOutcome = "PASSED";
  let position: PaperPosition | undefined;
  let broker: Trading212DemoBroker;

  // Step 2: connect to the Demo account. BrokerFactory.create's "trading212-demo" entry
  // constructs Trading212DemoBroker and calls connect() before returning — the cast is safe
  // because an explicit `provider` was requested, so the concrete type is guaranteed.
  try {
    broker = (await BrokerFactory.create(config, auditTrail, executionRunId, {
      provider: "trading212-demo",
    })) as Trading212DemoBroker;
    console.log("Connected to Trading212 Demo account.");
  } catch (error) {
    console.error("Failed to connect to Trading212 Demo:", error instanceof Error ? error.message : error);
    await recordOutcome(auditTrail, executionRunId, "FAILED", "connect");
    printFinalSummary("FAILED");
    process.exitCode = 1;
    return;
  }

  // Step 3: display account balance.
  const account = broker.getAccount();
  console.log(`Cash available (free): ${account.cashBalance.toFixed(2)}`);
  console.log(`Cash total at connect: ${account.startingCashBalance.toFixed(2)}`);

  const instrument = config.trading212.testInstrument;
  if (!broker.hasInstrument(instrument)) {
    console.error(`Test instrument "${instrument}" was not found in Trading212's instrument list.`);
    await recordOutcome(auditTrail, executionRunId, "FAILED", "confirm-instrument");
    printFinalSummary("FAILED");
    process.exitCode = 1;
    return;
  }
  console.log(`Test instrument confirmed: ${instrument}`);

  // Step 4: submit one deliberately tiny demo order. Trading212's real metadata response has no
  // minimum-order-quantity field to derive this from (confirmed against the live API — see
  // docs/trading212-demo-adapter-phase-1.md), so the test order size is an explicit, validated
  // config value (TRADING212_DEMO_TEST_QUANTITY) instead.
  const quantity = config.trading212.testOrderQuantity;
  console.log(`Test order size: ${quantity} ${instrument} (TRADING212_DEMO_TEST_QUANTITY)`);

  const orderRequest: OrderRequest = {
    strategyId: SMOKE_TEST_STRATEGY_ID,
    strategyVersion: 1,
    sourceType: "DEMO_ONLY",
    instrument,
    side: "BUY",
    quantity,
    price: 0, // unused by this adapter — Trading212 has no limit-price concept for market orders
    timestamp: new Date().toISOString(),
  };

  try {
    const result = await broker.placeMarketOrder(orderRequest);
    position = result.position;
    // Step 5: verify acknowledgement/fill (ORDER_ACKNOWLEDGED/ORDER_FILLED are already recorded
    // to the audit trail by the broker itself).
    console.log(
      `Order filled: orderId=${result.orderId}, entryPrice=${position.entryPrice.toFixed(4)}, qty=${position.quantity}`,
    );
  } catch (error) {
    if (error instanceof Trading212OrderPendingError) {
      const marketClosed = await reportPendingOrder(broker, error, "Order");
      try {
        await broker.cancelOrder(error.ticker, error.orderId);
        console.log("Pending order cancelled.");
      } catch (cancelError) {
        console.error("Failed to cancel pending order:", cancelError instanceof Error ? cancelError.message : cancelError);
      }
      const stepOutcome: SmokeOutcome = marketClosed ? "INCONCLUSIVE_MARKET_CLOSED" : "FAILED";
      await recordOutcome(auditTrail, executionRunId, stepOutcome, "order-did-not-fill");
      printFinalSummary(stepOutcome);
      process.exitCode = stepOutcome === "FAILED" ? 1 : 2;
      return;
    }
    console.error("Order submission failed:", error instanceof Error ? error.message : error);
    await recordOutcome(auditTrail, executionRunId, "FAILED", "order-submission");
    printFinalSummary("FAILED");
    process.exitCode = 1;
    return;
  }

  // Step 6: close the position.
  try {
    const closeResult = await broker.closePosition(position.positionId, 0, new Date().toISOString(), "smoke-test-cleanup");
    console.log(
      `Position closed: orderId=${closeResult.orderId}, exitPrice=${closeResult.trade.exitPrice.toFixed(4)}, realisedPnl=${closeResult.trade.realisedPnl.toFixed(4)}`,
    );
  } catch (error) {
    if (error instanceof Trading212OrderPendingError) {
      const marketClosed = await reportPendingOrder(broker, error, "Close order");
      try {
        await broker.cancelOrder(error.ticker, error.orderId);
        console.log("Pending close order cancelled — a position may still be open; manual follow-up required.");
      } catch (cancelError) {
        console.error("Failed to cancel pending close order:", cancelError instanceof Error ? cancelError.message : cancelError);
      }
      outcome = marketClosed ? "INCONCLUSIVE_MARKET_CLOSED" : "FAILED";
    } else {
      console.error("Failed to close smoke-test position:", error instanceof Error ? error.message : error);
      outcome = "FAILED";
    }
  }

  // Step 7: verify no position remains. A position still open here is expected (not a new
  // failure) when the close order is the one queued behind a closed market; anything else means
  // cleanup genuinely didn't work.
  const stillOpen = broker.getOpenPositions().some((p) => p.instrument === instrument);
  if (stillOpen) {
    console.error(`A position on ${instrument} is still open after cleanup — manual intervention required.`);
    if (outcome !== "INCONCLUSIVE_MARKET_CLOSED") outcome = "FAILED";
  } else {
    console.log("Confirmed: no smoke-test position remains open.");
  }

  // Step 8: final outcome summary.
  await recordOutcome(auditTrail, executionRunId, outcome, outcome === "PASSED" ? undefined : "post-close-verification");
  printFinalSummary(outcome);
  if (outcome === "FAILED") process.exitCode = 1;
  else if (outcome === "INCONCLUSIVE_MARKET_CLOSED") process.exitCode = 2;
}

/** Explains a Trading212OrderPendingError using the instrument's real trading-hours schedule
 * (Trading212DemoBroker.describeMarketSession) rather than guessing. Returns true only when the
 * market is confirmed closed — the one case Trading212's own docs describe as expected queuing
 * behaviour, not a failure. Any other session state (OPEN or UNKNOWN) means the stall is NOT
 * explained by market hours, so the caller should still treat it as a genuine failure. */
async function reportPendingOrder(
  broker: Trading212DemoBroker,
  error: Trading212OrderPendingError,
  label: "Order" | "Close order",
): Promise<boolean> {
  const session = await broker.describeMarketSession(error.ticker);
  if (session === "CLOSED") {
    console.log(
      `${label} ${error.orderId} on ${error.ticker} is still NEW because ${error.ticker}'s market is currently ` +
        `closed — Trading212 queues market orders until the exchange reopens (documented behaviour). This is ` +
        `expected, not a failure.`,
    );
    return true;
  }
  console.log(
    `${label} ${error.orderId} on ${error.ticker} did not fill within the poll window (market session: ${session}) ` +
      `— not explained by market hours.`,
  );
  return false;
}

async function recordOutcome(
  auditTrail: JsonFileAuditTrail,
  executionRunId: string,
  outcome: SmokeOutcome,
  failedStep: string | undefined,
): Promise<void> {
  const eventType =
    outcome === "PASSED"
      ? "SMOKE_TEST_COMPLETED"
      : outcome === "INCONCLUSIVE_MARKET_CLOSED"
        ? "SMOKE_TEST_INCONCLUSIVE"
        : "SMOKE_TEST_FAILED";
  await auditTrail.record({
    timestamp: new Date().toISOString(),
    eventType,
    executionRunId,
    details: failedStep ? { failedStep } : {},
  });
}

function printFinalSummary(outcome: SmokeOutcome): void {
  console.log("");
  if (outcome === "PASSED") console.log("SMOKE TEST PASSED");
  else if (outcome === "INCONCLUSIVE_MARKET_CLOSED") console.log("SMOKE TEST INCONCLUSIVE — MARKET CLOSED");
  else console.log("SMOKE TEST FAILED");
}

// Only auto-runs when this file is executed directly (`tsx broker-trading212-smoke.ts`), not when
// imported elsewhere (e.g. its own test file, which imports `main` and calls it explicitly).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Trading212 demo smoke test crashed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
