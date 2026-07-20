import * as path from "node:path";
import { getHermesExecutionConfig } from "@/lib/hermes-execution/config";
import { BrokerFactory } from "@/lib/hermes-execution/broker-factory";
import {
  HyperliquidTestnetBroker,
  HyperliquidOrderRestingError,
} from "@/lib/hermes-execution/hyperliquid/hyperliquid-testnet-broker";
import { JsonFileAuditTrail } from "@/lib/hermes-execution/json-file-audit-trail";
import type { OrderRequest, PaperPosition } from "@/lib/hermes-execution/types";

// A separate audit log from the execution:demo CLI's, so the two commands' histories never
// clobber each other on disk.
const SMOKE_AUDIT_LOG_PATH = path.join(process.cwd(), ".data", "hermes-execution", "smoke-audit-log.json");

// This smoke test only ever proves connectivity + one order lifecycle. It is not a strategy
// signal, so it is explicitly modeled as a DEMO_ONLY source — it must never be mistaken for a
// Hermes-approved trade.
const SMOKE_TEST_STRATEGY_ID = "HYPERLIQUID-SMOKE-TEST";

// Bounds the FrontendMarket order's worst-case fill price away from the current mid, in either
// direction, so it reliably fills like a market order without blowing through an unbounded price.
const SLIPPAGE_BUFFER = 0.05;

function sanitiseAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export async function main(): Promise<void> {
  console.log("Hyperliquid Testnet Broker — Smoke Test");
  console.log("========================================");

  const executionRunId = `smoke-${Date.now()}`;
  console.log(`Execution run id: ${executionRunId}`);

  // Step 1: validate configuration. This command always targets Hyperliquid — it never reads or
  // depends on BROKER_PROVIDER, so it can run unchanged no matter which broker the rest of the
  // application currently defaults to.
  const config = getHermesExecutionConfig();
  console.log("Broker provider: hyperliquid-testnet (fixed for this command — BROKER_PROVIDER is not consulted)");

  if (!config.hyperliquid.executionEnabled) {
    console.error("HYPERLIQUID_TESTNET_EXECUTION_ENABLED must be true to run this smoke test.");
    process.exitCode = 1;
    return;
  }
  if (!config.hyperliquid.privateKey || !config.hyperliquid.accountAddress) {
    console.error("HYPERLIQUID_TESTNET_PRIVATE_KEY and HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS must both be set.");
    process.exitCode = 1;
    return;
  }
  console.log("Configuration valid.");

  const auditTrail = await JsonFileAuditTrail.createFresh(SMOKE_AUDIT_LOG_PATH);
  let broker: HyperliquidTestnetBroker;

  let passed = true;
  let position: PaperPosition | undefined;

  // Step 2: connect to Hyperliquid testnet. BrokerFactory.create's "hyperliquid-testnet" entry
  // constructs HyperliquidTestnetBroker and calls connect() before returning — the cast is safe
  // because an explicit `provider` was requested, so the concrete type is guaranteed.
  try {
    broker = (await BrokerFactory.create(config, auditTrail, executionRunId, {
      provider: "hyperliquid-testnet",
    })) as HyperliquidTestnetBroker;
    console.log(`Connected to Hyperliquid testnet.`);
  } catch (error) {
    console.error("Failed to connect to Hyperliquid testnet:", error instanceof Error ? error.message : error);
    await recordOutcome(auditTrail, executionRunId, false, "connect");
    printFinalSummary(false);
    process.exitCode = 1;
    return;
  }

  // Step 3: display sanitised account information.
  const account = broker.getAccount();
  console.log(`Account address: ${sanitiseAddress(config.hyperliquid.accountAddress)}`);
  console.log(`Account value at connect (USD): ${account.startingCashBalance.toFixed(2)}`);
  console.log(`Withdrawable (USD): ${account.cashBalance.toFixed(2)}`);

  // Step 4: confirm the selected test instrument exists.
  const instrument = config.hyperliquid.testInstrument;
  if (!broker.hasInstrument(instrument)) {
    console.error(`Test instrument "${instrument}" was not found in Hyperliquid's asset universe.`);
    await recordOutcome(auditTrail, executionRunId, false, "confirm-instrument");
    printFinalSummary(false);
    process.exitCode = 1;
    return;
  }
  console.log(`Test instrument confirmed: ${instrument}`);

  // Step 5: submit one deliberately small test order.
  const midPrice = await broker.getMidPrice(instrument);
  const maxOrderValueUsd = config.hyperliquid.maxTestOrderValueUsd;
  const quantity = maxOrderValueUsd / midPrice;
  const entryLimitPrice = midPrice * (1 + SLIPPAGE_BUFFER); // buying — bound above mid

  console.log(`Mid price for ${instrument}: ${midPrice}`);
  console.log(`Test order: ~${quantity.toFixed(6)} ${instrument} (~$${maxOrderValueUsd} notional)`);

  const orderRequest: OrderRequest = {
    strategyId: SMOKE_TEST_STRATEGY_ID,
    strategyVersion: 1,
    sourceType: "DEMO_ONLY",
    instrument,
    side: "BUY",
    quantity,
    price: entryLimitPrice,
    timestamp: new Date().toISOString(),
  };

  try {
    const result = await broker.placeMarketOrder(orderRequest);
    position = result.position;
    // Step 6: confirm acknowledgement or fill (ORDER_ACKNOWLEDGED/ORDER_FILLED are already
    // recorded to the audit trail by the broker itself).
    console.log(
      `Order filled: oid=${result.orderId}, entryPrice=${position.entryPrice}, qty=${position.quantity}`,
    );
  } catch (error) {
    if (error instanceof HyperliquidOrderRestingError) {
      // Step 7: cancel the order if still open.
      console.log(`Order did not fill immediately (oid=${error.oid}) — cancelling.`);
      try {
        await broker.cancelOrder(error.coin, error.oid);
        console.log("Resting order cancelled.");
      } catch (cancelError) {
        console.error("Failed to cancel resting order:", cancelError instanceof Error ? cancelError.message : cancelError);
      }
      // No position was ever opened, so there is nothing to close — but a resting order that had
      // to be cancelled means this run did not complete a full fill lifecycle.
      await recordOutcome(auditTrail, executionRunId, false, "order-did-not-fill");
      printFinalSummary(false);
      process.exitCode = 1;
      return;
    }
    console.error("Order submission failed:", error instanceof Error ? error.message : error);
    await recordOutcome(auditTrail, executionRunId, false, "order-submission");
    printFinalSummary(false);
    process.exitCode = 1;
    return;
  }

  // Step 8: close any position created by the smoke test.
  try {
    const closeMidPrice = await broker.getMidPrice(instrument);
    const closeLimitPrice = closeMidPrice * (1 - SLIPPAGE_BUFFER); // selling to close — bound below mid
    const closeResult = await broker.closePosition(
      position.positionId,
      closeLimitPrice,
      new Date().toISOString(),
      "smoke-test-cleanup",
    );
    console.log(
      `Position closed: oid=${closeResult.orderId}, exitPrice=${closeResult.trade.exitPrice}, realisedPnl=${closeResult.trade.realisedPnl.toFixed(4)}`,
    );
  } catch (error) {
    if (error instanceof HyperliquidOrderRestingError) {
      console.log(`Close order did not fill immediately (oid=${error.oid}) — cancelling.`);
      try {
        await broker.cancelOrder(error.coin, error.oid);
        console.log("Resting close order cancelled — a position may still be open; manual follow-up required.");
      } catch (cancelError) {
        console.error("Failed to cancel resting close order:", cancelError instanceof Error ? cancelError.message : cancelError);
      }
    } else {
      console.error("Failed to close smoke-test position:", error instanceof Error ? error.message : error);
    }
    passed = false;
  }

  // Step 9: verify no smoke-test position remains open.
  const stillOpen = broker.getOpenPositions().some((p) => p.instrument === instrument);
  if (stillOpen) {
    console.error(`A position on ${instrument} is still open after cleanup — manual intervention required.`);
    passed = false;
  } else {
    console.log("Confirmed: no smoke-test position remains open.");
  }

  // Step 10: final pass/fail summary.
  await recordOutcome(auditTrail, executionRunId, passed, passed ? undefined : "post-close-verification");
  printFinalSummary(passed);
  if (!passed) process.exitCode = 1;
}

async function recordOutcome(
  auditTrail: JsonFileAuditTrail,
  executionRunId: string,
  passed: boolean,
  failedStep: string | undefined,
): Promise<void> {
  await auditTrail.record({
    timestamp: new Date().toISOString(),
    eventType: passed ? "SMOKE_TEST_COMPLETED" : "SMOKE_TEST_FAILED",
    executionRunId,
    details: failedStep ? { failedStep } : {},
  });
}

function printFinalSummary(passed: boolean): void {
  console.log("");
  console.log(passed ? "SMOKE TEST PASSED" : "SMOKE TEST FAILED");
}

// Only auto-runs when this file is executed directly (`tsx broker-testnet-smoke.ts`), not when
// imported elsewhere (e.g. its own test file, which imports `main` and calls it explicitly).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Hyperliquid testnet smoke test crashed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
